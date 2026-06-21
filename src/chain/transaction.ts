import { sign as edSign, verify as edVerify, type PrivateKey, type PublicKey, type Signature } from '../crypto/keys.js';
import { sha256 } from '../crypto/hash.js';
import { concat, u32be, u64be, u16be, readU32be, readU64be, readU16be, bytesToHex } from '../util/binary.js';
import { CHAIN_ID, MAX_MONEY } from './genesis.js';
import { MAX_SCRIPT_BYTES, MAX_WITNESS_ITEMS, MAX_PUSH_BYTES } from './script.js';

/**
 * Transaction kinds. `Transfer` is the original plain payment and its wire
 * encoding is byte-for-byte unchanged — existing blocks, hashes and signatures
 * remain valid. `Lock` and `Redeem` are the script-fork additions and only
 * become valid once the fork activates (see genesis.ts / blockchain.ts).
 */
export enum TxKind {
  Transfer = 0,
  Lock = 1,
  Redeem = 2,
}

/**
 * One transaction. A single "fat" interface (rather than a union) so that all
 * the existing transfer-only code paths keep compiling unchanged: `kind`
 * defaults to Transfer, and the script fields are only populated for Lock /
 * Redeem. Field meaning by kind:
 *
 *   Transfer: from→to moves `amount` (+`fee`), signed by `from`, ordered by `nonce`.
 *   Lock:     `from` locks `amount` (paying `fee`) under `scriptHash`, signed by
 *             `from`, ordered by `nonce`. `to` is unused.
 *   Redeem:   spends the lock `lockId`, paying `to` (`amount` − `fee`), authorized
 *             by `witness` satisfying `redeemScript`. `from`/`nonce`/`signature`
 *             are unused (replay protection comes from the lock being spent once).
 */
export interface Transaction {
  kind?: TxKind; // undefined ⇒ Transfer (keeps legacy construction working)
  from: PublicKey;     // 32 bytes
  to: PublicKey;       // 32 bytes
  amount: bigint;      // wei
  fee: bigint;         // wei
  nonce: number;       // per-sender, monotonically increasing
  signature: Signature; // 64 bytes
  // --- script extension (Lock / Redeem only) ---
  scriptHash?: Uint8Array;   // Lock: sha256(redeemScript)
  lockId?: Uint8Array;       // Redeem: the lock being spent (= txHash of the Lock)
  redeemScript?: Uint8Array; // Redeem: revealed script (must hash to lock.scriptHash)
  witness?: Uint8Array[];    // Redeem: stack inputs satisfying the script
}

export function txKind(tx: Transaction): TxKind {
  return tx.kind ?? TxKind.Transfer;
}
export function isTransfer(tx: Transaction): boolean { return txKind(tx) === TxKind.Transfer; }
export function isLock(tx: Transaction): boolean { return txKind(tx) === TxKind.Lock; }
export function isRedeem(tx: Transaction): boolean { return txKind(tx) === TxKind.Redeem; }

/** First-4-bytes tags used to self-identify Lock / Redeem encodings on the wire. */
const LOCK_TAG = 0x4c4f434b; // 'LOCK'
const REDEEM_TAG = 0x52444d31; // 'RDM1'

// ===========================================================================
// Transfer (legacy — UNCHANGED encoding)
// ===========================================================================

/** Length of the un-signed transfer preimage we sign over. */
export const TX_PREIMAGE_LEN = 4 /*chainId*/ + 32 /*from*/ + 32 /*to*/ + 8 /*amount*/ + 8 /*fee*/ + 4 /*nonce*/;

/** Length of a fully encoded transfer on the wire. */
export const TX_ENCODED_LEN = TX_PREIMAGE_LEN + 64; // + signature

/** Bytes that get hashed/signed — chain id + (from, to, amount, fee, nonce). */
export function txPreimage(tx: Omit<Transaction, 'signature'>): Uint8Array {
  return concat(
    u32be(CHAIN_ID),
    tx.from,
    tx.to,
    u64be(tx.amount),
    u64be(tx.fee),
    u32be(tx.nonce),
  );
}

function encodeTransfer(tx: Transaction): Uint8Array {
  return concat(txPreimage(tx), tx.signature);
}

function decodeTransfer(buf: Uint8Array, off: number): { tx: Transaction; next: number } {
  if (buf.length - off < TX_ENCODED_LEN) throw new Error('tx truncated');
  const chainId = readU32be(buf, off);
  if (chainId !== CHAIN_ID) throw new Error(`tx chain id mismatch (got ${chainId})`);
  let p = off + 4;
  const from = buf.slice(p, p + 32); p += 32;
  const to = buf.slice(p, p + 32); p += 32;
  const amount = readU64be(buf, p); p += 8;
  const fee = readU64be(buf, p); p += 8;
  const nonce = readU32be(buf, p); p += 4;
  const signature = buf.slice(p, p + 64); p += 64;
  return { tx: { kind: TxKind.Transfer, from, to, amount, fee, nonce, signature }, next: p };
}

// ===========================================================================
// Lock
// ===========================================================================

const ZERO32 = new Uint8Array(32);

/** Preimage the Lock's creator signs over (and which `from` is checked against). */
export function lockPreimage(tx: Omit<Transaction, 'signature'>): Uint8Array {
  return concat(
    u32be(LOCK_TAG),
    u32be(CHAIN_ID),
    tx.from,
    u64be(tx.amount),
    u64be(tx.fee),
    u32be(tx.nonce),
    tx.scriptHash ?? ZERO32,
  );
}

function encodeLock(tx: Transaction): Uint8Array {
  return concat(lockPreimage(tx), tx.signature);
}

function decodeLock(buf: Uint8Array, off: number): { tx: Transaction; next: number } {
  let p = off + 4; // skip LOCK_TAG
  const chainId = readU32be(buf, p); p += 4;
  if (chainId !== CHAIN_ID) throw new Error(`lock chain id mismatch (got ${chainId})`);
  const from = buf.slice(p, p + 32); p += 32;
  const amount = readU64be(buf, p); p += 8;
  const fee = readU64be(buf, p); p += 8;
  const nonce = readU32be(buf, p); p += 4;
  const scriptHash = buf.slice(p, p + 32); p += 32;
  const signature = buf.slice(p, p + 64); p += 64;
  return {
    tx: { kind: TxKind.Lock, from, to: new Uint8Array(32), amount, fee, nonce, signature, scriptHash },
    next: p,
  };
}

// ===========================================================================
// Redeem
// ===========================================================================

/**
 * The 32-byte message that every witness signature is verified against. It
 * commits to which lock is spent and exactly where the value goes, so a valid
 * signature cannot be replayed to redirect funds to a different destination.
 */
export function redeemSighash(tx: Transaction): Uint8Array {
  return sha256(concat(
    u32be(REDEEM_TAG),
    u32be(CHAIN_ID),
    tx.lockId ?? ZERO32,
    tx.to,
    u64be(tx.amount),
    u64be(tx.fee),
    tx.redeemScript ?? new Uint8Array(0),
  ));
}

function encodeRedeem(tx: Transaction): Uint8Array {
  const redeemScript = tx.redeemScript ?? new Uint8Array(0);
  const witness = tx.witness ?? [];
  const parts: Uint8Array[] = [
    u32be(REDEEM_TAG),
    tx.lockId ?? ZERO32,
    tx.to,
    u64be(tx.amount),
    u64be(tx.fee),
    u16be(redeemScript.length),
    redeemScript,
    new Uint8Array([witness.length]),
  ];
  for (const w of witness) {
    parts.push(u16be(w.length), w);
  }
  return concat(...parts);
}

function decodeRedeem(buf: Uint8Array, off: number): { tx: Transaction; next: number } {
  let p = off + 4; // skip REDEEM_TAG
  const lockId = buf.slice(p, p + 32); p += 32;
  const to = buf.slice(p, p + 32); p += 32;
  const amount = readU64be(buf, p); p += 8;
  const fee = readU64be(buf, p); p += 8;
  const scriptLen = readU16be(buf, p); p += 2;
  if (scriptLen > MAX_SCRIPT_BYTES) throw new Error('redeem script too long');
  const redeemScript = buf.slice(p, p + scriptLen); p += scriptLen;
  const witnessCount = buf[p]!; p += 1;
  if (witnessCount > MAX_WITNESS_ITEMS) throw new Error('too many witness items');
  const witness: Uint8Array[] = [];
  for (let i = 0; i < witnessCount; i++) {
    const wlen = readU16be(buf, p); p += 2;
    if (wlen > MAX_PUSH_BYTES) throw new Error('witness item too large');
    witness.push(buf.slice(p, p + wlen)); p += wlen;
  }
  return {
    tx: { kind: TxKind.Redeem, from: new Uint8Array(32), to, amount, fee, nonce: 0, signature: new Uint8Array(0), lockId, redeemScript, witness },
    next: p,
  };
}

// ===========================================================================
// Dispatch
// ===========================================================================

export function encodeTx(tx: Transaction): Uint8Array {
  switch (txKind(tx)) {
    case TxKind.Lock: return encodeLock(tx);
    case TxKind.Redeem: return encodeRedeem(tx);
    default: return encodeTransfer(tx);
  }
}

export function decodeTx(buf: Uint8Array, off = 0): { tx: Transaction; next: number } {
  if (buf.length - off < 4) throw new Error('tx truncated');
  const tag = readU32be(buf, off);
  if (tag === CHAIN_ID) return decodeTransfer(buf, off);
  if (tag === LOCK_TAG) return decodeLock(buf, off);
  if (tag === REDEEM_TAG) return decodeRedeem(buf, off);
  throw new Error(`unknown tx tag 0x${tag.toString(16)}`);
}

export function txHash(tx: Transaction): Uint8Array {
  return sha256(encodeTx(tx));
}

/** Actual encoded byte length of any tx kind (transfers are always TX_ENCODED_LEN). */
export function encodedTxLen(tx: Transaction): number {
  return encodeTx(tx).length;
}

// ===========================================================================
// Construction helpers
// ===========================================================================

export function signTx(unsigned: Omit<Transaction, 'signature'>, privKey: PrivateKey): Transaction {
  const sig = edSign(txPreimage(unsigned), privKey);
  return { ...unsigned, kind: TxKind.Transfer, signature: sig };
}

/** Build + sign a Lock tx. `scriptHash` must be sha256(redeemScript). */
export function signLock(unsigned: Omit<Transaction, 'signature' | 'kind'>, privKey: PrivateKey): Transaction {
  const base = { ...unsigned, kind: TxKind.Lock as const };
  const sig = edSign(lockPreimage(base), privKey);
  return { ...base, signature: sig };
}

/** The lock id used to reference a Lock later (its tx hash). */
export function lockIdOf(lockTx: Transaction): Uint8Array {
  return txHash(lockTx);
}

// ===========================================================================
// Verification / validation
// ===========================================================================

/** Verify the signature on a Transfer or Lock. Redeems carry no `from` signature. */
export function verifyTxSignature(tx: Transaction): boolean {
  if (isLock(tx)) {
    if (tx.from.length !== 32 || tx.signature.length !== 64 || (tx.scriptHash?.length ?? 0) !== 32) return false;
    return edVerify(tx.signature, lockPreimage(tx), tx.from);
  }
  if (tx.from.length !== 32 || tx.to.length !== 32 || tx.signature.length !== 64) return false;
  return edVerify(tx.signature, txPreimage(tx), tx.from);
}

/**
 * Structural sanity checks (no state, no script execution). Script execution for
 * Redeems happens in state.applyTx where the lock + block context are available.
 */
export function validateTxStructure(tx: Transaction): string | null {
  switch (txKind(tx)) {
    case TxKind.Lock: return validateLockStructure(tx);
    case TxKind.Redeem: return validateRedeemStructure(tx);
    default: return validateTransferStructure(tx);
  }
}

function validateTransferStructure(tx: Transaction): string | null {
  if (tx.amount < 0n) return 'amount negative';
  if (tx.fee < 0n) return 'fee negative';
  if (tx.amount > MAX_MONEY) return 'amount exceeds MAX_MONEY';
  if (tx.fee > MAX_MONEY) return 'fee exceeds MAX_MONEY';
  if (tx.amount + tx.fee > MAX_MONEY) return 'amount + fee exceeds MAX_MONEY';
  if (tx.amount === 0n && tx.fee === 0n) return 'tx has no value';
  if (tx.nonce < 0 || !Number.isInteger(tx.nonce)) return 'nonce invalid';
  if (bytesToHex(tx.from) === bytesToHex(tx.to)) return 'self-send forbidden';
  if (!verifyTxSignature(tx)) return 'bad signature';
  return null;
}

function validateLockStructure(tx: Transaction): string | null {
  if (tx.from.length !== 32) return 'lock: bad from';
  if ((tx.scriptHash?.length ?? 0) !== 32) return 'lock: bad scriptHash';
  if (tx.amount < 0n || tx.fee < 0n) return 'lock: negative value';
  if (tx.amount > MAX_MONEY || tx.fee > MAX_MONEY) return 'lock: value exceeds MAX_MONEY';
  if (tx.amount + tx.fee > MAX_MONEY) return 'lock: amount + fee exceeds MAX_MONEY';
  if (tx.amount === 0n) return 'lock: nothing to lock';
  if (tx.nonce < 0 || !Number.isInteger(tx.nonce)) return 'lock: nonce invalid';
  if (!verifyTxSignature(tx)) return 'lock: bad signature';
  return null;
}

function validateRedeemStructure(tx: Transaction): string | null {
  if (tx.to.length !== 32) return 'redeem: bad destination';
  if ((tx.lockId?.length ?? 0) !== 32) return 'redeem: bad lockId';
  if (tx.amount < 0n || tx.fee < 0n) return 'redeem: negative value';
  if (tx.amount > MAX_MONEY) return 'redeem: amount exceeds MAX_MONEY';
  if (tx.fee > tx.amount) return 'redeem: fee exceeds claimed amount';
  const rs = tx.redeemScript;
  if (!rs || rs.length === 0) return 'redeem: empty script';
  if (rs.length > MAX_SCRIPT_BYTES) return 'redeem: script too long';
  const w = tx.witness ?? [];
  if (w.length > MAX_WITNESS_ITEMS) return 'redeem: too many witness items';
  for (const item of w) if (item.length > MAX_PUSH_BYTES) return 'redeem: witness item too large';
  return null;
}
