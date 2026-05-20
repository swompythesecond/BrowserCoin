import { sha256 } from '../crypto/hash.js';
import { bytesToHex, concat, u32be, u64be } from '../util/binary.js';
import { merkleRoot } from '../util/merkle.js';
import { blockReward } from './genesis.js';
import type { Transaction } from './transaction.js';

export interface Account {
  balance: bigint;
  nonce: number; // next expected tx nonce (starts at 0)
}

/** Map address-hex → Account. Empty accounts are NOT stored. */
export type State = Map<string, Account>;

export function emptyState(): State {
  return new Map();
}

export function getAccount(state: State, address: string): Account {
  return state.get(address) ?? { balance: 0n, nonce: 0 };
}

export function cloneState(s: State): State {
  const out: State = new Map();
  for (const [k, v] of s) out.set(k, { balance: v.balance, nonce: v.nonce });
  return out;
}

/** Deterministic root of state: sort accounts by address, hash each, merkle. */
export function stateRoot(state: State): Uint8Array {
  const keys = [...state.keys()].sort();
  if (keys.length === 0) return new Uint8Array(32);
  const leaves: Uint8Array[] = [];
  for (const k of keys) {
    const a = state.get(k)!;
    // Skip zero-balance, zero-nonce accounts (shouldn't be in the map anyway).
    if (a.balance === 0n && a.nonce === 0) continue;
    leaves.push(concat(
      hexToFixed32(k),
      u64be(a.balance),
      u32be(a.nonce),
    ));
  }
  return merkleRoot(leaves);
}

function hexToFixed32(hex: string): Uint8Array {
  // We already know addresses are 32 bytes (64 hex chars). No allocation guard needed.
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Apply a single transaction to state, mutating in place. Returns null on success,
 * or an error string. Caller is responsible for cloning state if rollback may be needed.
 *
 * Coinbase rewards are NOT applied here — see applyBlock for that.
 */
export function applyTx(state: State, tx: Transaction): string | null {
  const fromHex = bytesToHex(tx.from);
  const toHex = bytesToHex(tx.to);

  const sender = getAccount(state, fromHex);
  const total = tx.amount + tx.fee;
  if (sender.balance < total) return 'insufficient balance';
  if (tx.nonce !== sender.nonce) return `bad nonce (expected ${sender.nonce}, got ${tx.nonce})`;

  sender.balance -= total;
  sender.nonce += 1;
  if (sender.balance === 0n && sender.nonce !== 0) {
    state.set(fromHex, sender);
  } else if (sender.balance === 0n) {
    state.delete(fromHex);
  } else {
    state.set(fromHex, sender);
  }

  const recipient = getAccount(state, toHex);
  recipient.balance += tx.amount;
  state.set(toHex, recipient);

  return null;
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
): string | null {
  let totalFees = 0n;
  for (const tx of txs) {
    const err = applyTx(state, tx);
    if (err) return `tx ${bytesToHex(tx.from).slice(0, 8)}…/${tx.nonce}: ${err}`;
    totalFees += tx.fee;
  }
  const minerHex = bytesToHex(miner);
  const acct = getAccount(state, minerHex);
  acct.balance += blockReward(height) + totalFees;
  state.set(minerHex, acct);
  return null;
}
