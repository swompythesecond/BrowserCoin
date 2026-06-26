import { sha256 } from '../crypto/hash.js';
import { bytesToHex, hexToBytes, concat, u32be, u64be } from '../util/binary.js';
import { merkleRoot } from '../util/merkle.js';
import { blockReward } from './genesis.js';
import { evalScript, scriptHash as hashScript, type ScriptContext } from './script.js';
import {
  redeemSighash,
  txHash,
  txKind,
  TxKind,
  type Transaction,
} from './transaction.js';

export interface Account {
  balance: bigint;
  nonce: number; // next expected tx nonce (starts at 0)
}

/**
 * A script-locked commitment: `amount` BRC redeemable by anyone who can satisfy
 * the script whose hash is `scriptHash`. Created by a Lock tx, deleted when
 * spent by a Redeem tx. Keyed in `State.locks` by lock-id hex (the Lock's hash).
 */
export interface Lock {
  amount: bigint;
  scriptHash: Uint8Array; // 32 bytes
  createdHeight: number;
}

/**
 * Full chain state: account balances/nonces plus the set of live script locks.
 * Pre-fork chains only ever have an empty `locks` map (Lock/Redeem txs are
 * rejected), so the state root stays byte-identical to the legacy format —
 * see `stateRoot`.
 */
export interface State {
  accounts: Map<string, Account>; // address-hex → Account (empty accounts not stored)
  locks: Map<string, Lock>;       // lock-id-hex → Lock
}

/** Everything a Redeem needs from its including block to be validated. */
export interface ApplyContext {
  scriptsActive: boolean;
  blockHeight: number;
  blockMtp: number;
  /** Locks created earlier in THIS block — not yet spendable (see applyRedeem). */
  locksCreatedThisBlock: Set<string>;
}

export function emptyState(): State {
  return { accounts: new Map(), locks: new Map() };
}

export function getAccount(state: State, address: string): Account {
  return state.accounts.get(address) ?? { balance: 0n, nonce: 0 };
}

export function getLock(state: State, lockIdHex: string): Lock | undefined {
  return state.locks.get(lockIdHex);
}

export function cloneState(s: State): State {
  const accounts = new Map<string, Account>();
  for (const [k, v] of s.accounts) accounts.set(k, { balance: v.balance, nonce: v.nonce });
  const locks = new Map<string, Lock>();
  for (const [k, v] of s.locks) locks.set(k, { amount: v.amount, scriptHash: v.scriptHash, createdHeight: v.createdHeight });
  return { accounts, locks };
}

// --- persistence rows (snapshots) ------------------------------------------
/** Account row: [addressHex, balance(decimal), nonce]. */
export type StateRow = [string, string, number];
/** Lock row: [lockIdHex, amount(decimal), scriptHashHex, createdHeight]. */
export type LockRow = [string, string, string, number];

export function serializeState(s: State): StateRow[] {
  const out: StateRow[] = [];
  for (const [k, v] of s.accounts) out.push([k, v.balance.toString(), v.nonce]);
  return out;
}

export function serializeLocks(s: State): LockRow[] {
  const out: LockRow[] = [];
  for (const [k, v] of s.locks) out.push([k, v.amount.toString(), bytesToHex(v.scriptHash), v.createdHeight]);
  return out;
}

/** Rebuild state from rows. Inverse of serializeState + serializeLocks. */
export function deserializeState(rows: StateRow[], lockRows: LockRow[] = []): State {
  const accounts = new Map<string, Account>();
  for (const [k, b, n] of rows) accounts.set(k, { balance: BigInt(b), nonce: n });
  const locks = new Map<string, Lock>();
  for (const [id, amt, sh, h] of lockRows) locks.set(id, { amount: BigInt(amt), scriptHash: hexToBytes(sh), createdHeight: h });
  return { accounts, locks };
}

/**
 * Deterministic root of state. When there are no locks the root is exactly the
 * legacy account-merkle-root (so pre-fork and script-free post-fork blocks hash
 * identically). Once locks exist the root commits to both maps:
 * sha256(accountsRoot || locksRoot).
 */
export function stateRoot(state: State): Uint8Array {
  const accountsRoot = accountsMerkleRoot(state);
  if (state.locks.size === 0) return accountsRoot;
  return sha256(concat(accountsRoot, locksMerkleRoot(state)));
}

function accountsMerkleRoot(state: State): Uint8Array {
  const keys = [...state.accounts.keys()].sort();
  if (keys.length === 0) return new Uint8Array(32);
  const leaves: Uint8Array[] = [];
  for (const k of keys) {
    const a = state.accounts.get(k)!;
    if (a.balance === 0n && a.nonce === 0) continue;
    leaves.push(concat(hexToFixed32(k), u64be(a.balance), u32be(a.nonce)));
  }
  return merkleRoot(leaves);
}

function locksMerkleRoot(state: State): Uint8Array {
  const keys = [...state.locks.keys()].sort();
  const leaves: Uint8Array[] = [];
  for (const k of keys) {
    const l = state.locks.get(k)!;
    leaves.push(concat(hexToFixed32(k), u64be(l.amount), l.scriptHash, u32be(l.createdHeight)));
  }
  return merkleRoot(leaves);
}

function hexToFixed32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Apply a single transaction to state, mutating in place. Returns null on
 * success or an error string. Caller clones state if rollback may be needed.
 * Coinbase rewards are NOT applied here — see applyBlockTxs.
 */
export function applyTx(state: State, tx: Transaction, ctx: ApplyContext): string | null {
  switch (txKind(tx)) {
    case TxKind.Lock:
      if (!ctx.scriptsActive) return 'lock tx before fork activation';
      return applyLock(state, tx, ctx);
    case TxKind.Redeem:
      if (!ctx.scriptsActive) return 'redeem tx before fork activation';
      return applyRedeem(state, tx, ctx);
    default:
      return applyTransfer(state, tx);
  }
}

function applyTransfer(state: State, tx: Transaction): string | null {
  const fromHex = bytesToHex(tx.from);
  const toHex = bytesToHex(tx.to);

  const sender = getAccount(state, fromHex);
  const total = tx.amount + tx.fee;
  if (sender.balance < total) return 'insufficient balance';
  if (tx.nonce !== sender.nonce) return `bad nonce (expected ${sender.nonce}, got ${tx.nonce})`;

  sender.balance -= total;
  sender.nonce += 1;
  if (sender.balance === 0n && sender.nonce === 0) {
    state.accounts.delete(fromHex);
  } else {
    state.accounts.set(fromHex, sender);
  }

  const recipient = getAccount(state, toHex);
  recipient.balance += tx.amount;
  state.accounts.set(toHex, recipient);

  return null;
}

/** Lock: debit `from` (amount + fee), move `amount` into a new script lock. */
function applyLock(state: State, tx: Transaction, ctx: ApplyContext): string | null {
  const fromHex = bytesToHex(tx.from);
  const sender = getAccount(state, fromHex);
  const total = tx.amount + tx.fee;
  if (sender.balance < total) return 'insufficient balance';
  if (tx.nonce !== sender.nonce) return `bad nonce (expected ${sender.nonce}, got ${tx.nonce})`;

  const lockId = bytesToHex(txHash(tx));
  if (state.locks.has(lockId)) return 'lock id already exists';

  sender.balance -= total;
  sender.nonce += 1;
  if (sender.balance === 0n && sender.nonce === 0) {
    state.accounts.delete(fromHex);
  } else {
    state.accounts.set(fromHex, sender);
  }

  state.locks.set(lockId, {
    amount: tx.amount,
    scriptHash: tx.scriptHash!,
    createdHeight: ctx.blockHeight,
  });
  ctx.locksCreatedThisBlock.add(lockId);
  return null;
}

/** Redeem: satisfy a lock's script, delete it, pay `to` (lock.amount − fee). */
function applyRedeem(state: State, tx: Transaction, ctx: ApplyContext): string | null {
  const lockId = bytesToHex(tx.lockId!);
  const lock = state.locks.get(lockId);
  if (!lock) return 'unknown or already-spent lock';
  // v1 rule: a lock is only spendable in a block AFTER the one that created it.
  if (ctx.locksCreatedThisBlock.has(lockId)) return 'lock not spendable in its creation block';

  const redeemScript = tx.redeemScript!;
  if (compareScriptHash(hashScript(redeemScript), lock.scriptHash) !== 0) return 'redeem script does not match lock';
  if (tx.amount !== lock.amount) return 'redeem amount mismatch';
  if (tx.fee > lock.amount) return 'redeem fee exceeds locked amount';

  const sctx: ScriptContext = {
    sighash: redeemSighash(tx),
    blockHeight: ctx.blockHeight,
    blockMtp: ctx.blockMtp,
  };
  const r = evalScript(redeemScript, tx.witness ?? [], sctx);
  if (!r.ok) return `script failed: ${r.error}`;

  state.locks.delete(lockId);
  const payout = lock.amount - tx.fee;
  if (payout > 0n) {
    const toHex = bytesToHex(tx.to);
    const recipient = getAccount(state, toHex);
    recipient.balance += payout;
    state.accounts.set(toHex, recipient);
  }
  return null;
}

function compareScriptHash(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 1;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return 1;
  return 0;
}

/**
 * Apply all transactions in a block and credit the miner with reward + Σ fees.
 * Mutates `state`. Returns null on success or an error string. On error, state
 * is in an inconsistent partial-apply condition — callers should always clone
 * state before calling this for validation.
 */
export function applyBlockTxs(
  state: State,
  height: number,
  miner: Uint8Array,
  txs: Transaction[],
  block: { scriptsActive: boolean; blockMtp: number } = { scriptsActive: false, blockMtp: 0 },
): string | null {
  const ctx: ApplyContext = {
    scriptsActive: block.scriptsActive,
    blockHeight: height,
    blockMtp: block.blockMtp,
    locksCreatedThisBlock: new Set(),
  };
  let totalFees = 0n;
  for (const tx of txs) {
    const err = applyTx(state, tx, ctx);
    if (err) return `tx ${bytesToHex(txHash(tx)).slice(0, 8)}…: ${err}`;
    totalFees += tx.fee;
  }
  const minerHex = bytesToHex(miner);
  const acct = getAccount(state, minerHex);
  acct.balance += blockReward(height) + totalFees;
  state.accounts.set(minerHex, acct);
  return null;
}
