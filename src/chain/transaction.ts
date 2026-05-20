import { sign as edSign, verify as edVerify, type PrivateKey, type PublicKey, type Signature } from '../crypto/keys.js';
import { sha256 } from '../crypto/hash.js';
import { concat, u32be, u64be, readU32be, readU64be, bytesToHex } from '../util/binary.js';
import { CHAIN_ID } from './genesis.js';

export interface Transaction {
  from: PublicKey;     // 32 bytes
  to: PublicKey;       // 32 bytes
  amount: bigint;      // wei
  fee: bigint;         // wei
  nonce: number;       // per-sender, monotonically increasing
  signature: Signature; // 64 bytes
}

/** Length of the un-signed preimage we sign over. Keeps signing/verify in sync. */
export const TX_PREIMAGE_LEN = 4 /*chainId*/ + 32 /*from*/ + 32 /*to*/ + 8 /*amount*/ + 8 /*fee*/ + 4 /*nonce*/;

/** Length of a fully encoded transaction on the wire. */
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

export function encodeTx(tx: Transaction): Uint8Array {
  return concat(txPreimage(tx), tx.signature);
}

export function decodeTx(buf: Uint8Array, off = 0): { tx: Transaction; next: number } {
  if (buf.length - off < TX_ENCODED_LEN) throw new Error('tx truncated');
  // We skip the chain-id prefix on decode — callers re-derive it on verify.
  const chainId = readU32be(buf, off);
  if (chainId !== CHAIN_ID) throw new Error(`tx chain id mismatch (got ${chainId})`);
  let p = off + 4;
  const from = buf.slice(p, p + 32); p += 32;
  const to = buf.slice(p, p + 32); p += 32;
  const amount = readU64be(buf, p); p += 8;
  const fee = readU64be(buf, p); p += 8;
  const nonce = readU32be(buf, p); p += 4;
  const signature = buf.slice(p, p + 64); p += 64;
  return { tx: { from, to, amount, fee, nonce, signature }, next: p };
}

export function txHash(tx: Transaction): Uint8Array {
  return sha256(encodeTx(tx));
}

export function signTx(unsigned: Omit<Transaction, 'signature'>, privKey: PrivateKey): Transaction {
  const sig = edSign(txPreimage(unsigned), privKey);
  return { ...unsigned, signature: sig };
}

/** Verify signature only — does NOT check the sender's balance or nonce against state. */
export function verifyTxSignature(tx: Transaction): boolean {
  if (tx.from.length !== 32 || tx.to.length !== 32 || tx.signature.length !== 64) return false;
  return edVerify(tx.signature, txPreimage(tx), tx.from);
}

/** Structural sanity checks: amounts non-negative, no self-send, etc. */
export function validateTxStructure(tx: Transaction): string | null {
  if (tx.amount < 0n) return 'amount negative';
  if (tx.fee < 0n) return 'fee negative';
  if (tx.amount === 0n && tx.fee === 0n) return 'tx has no value';
  if (tx.nonce < 0 || !Number.isInteger(tx.nonce)) return 'nonce invalid';
  if (bytesToHex(tx.from) === bytesToHex(tx.to)) return 'self-send forbidden';
  if (!verifyTxSignature(tx)) return 'bad signature';
  return null;
}
