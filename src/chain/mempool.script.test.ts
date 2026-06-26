import { describe, expect, it } from 'vitest';
import { Mempool } from './mempool.js';
import { emptyState, type State, type Lock } from './state.js';
import { TxKind, lockIdOf, redeemSighash, signLock, type Transaction } from './transaction.js';
import { Op } from './script.js';
import { generateKeyPair } from '../crypto/keys.js';
import { sha256 } from '../crypto/hash.js';
import { concat, bytesToHex } from '../util/binary.js';
import { COIN } from './genesis.js';

const ZERO32 = new Uint8Array(32);
function push(d: Uint8Array): Uint8Array { return concat(new Uint8Array([d.length]), d); }
function op(c: number): Uint8Array { return new Uint8Array([c]); }
function hashLockScript(preimage: Uint8Array): Uint8Array {
  return concat(op(Op.OP_SHA256), push(sha256(preimage)), op(Op.OP_EQUAL));
}
const ACTIVE = { scriptsActive: true, blockHeight: 100, blockMtp: 1_800_000_000 };

function stateWithAccount(addr: string, balance: bigint): State {
  const s = emptyState();
  s.accounts.set(addr, { balance, nonce: 0 });
  return s;
}

function makeRedeem(lockId: Uint8Array, to: Uint8Array, amount: bigint, fee: bigint, rs: Uint8Array, witness: Uint8Array[]): Transaction {
  const base: Transaction = {
    kind: TxKind.Redeem, from: ZERO32, to, amount, fee, nonce: 0,
    signature: new Uint8Array(0), lockId, redeemScript: rs, witness: [],
  };
  redeemSighash(base); // (no-op binding check; witness below has none to bind)
  base.witness = witness;
  return base;
}

describe('mempool: lock admission + selection', () => {
  it('admits a lock and only selects it when scripts are active', () => {
    const alice = generateKeyPair();
    const rs = hashLockScript(new TextEncoder().encode('x'));
    const state = stateWithAccount(alice.address, 100n * COIN);
    const mp = new Mempool();
    const lock = signLock(
      { from: alice.publicKey, to: ZERO32, amount: 10n * COIN, fee: 1000n, nonce: 0, scriptHash: sha256(rs) },
      alice.privateKey,
    );
    expect(mp.add(lock, state)).toBeNull();
    // No script context (or inactive) → lock is held back.
    expect(mp.selectForBlock(state, 1 << 20)).toHaveLength(0);
    // Active context → lock is selectable.
    expect(mp.selectForBlock(state, 1 << 20, ACTIVE)).toHaveLength(1);
  });
});

describe('mempool: redeem admission + selection', () => {
  const preimage = new TextEncoder().encode('secret');
  const rs = hashLockScript(preimage);
  const bob = generateKeyPair();

  function stateWithLock(amount: bigint): { state: State; lockId: Uint8Array } {
    const state = emptyState();
    // Reconstruct the same lockId a real Lock tx would produce, then seed it.
    const funder = generateKeyPair();
    const lockTx = signLock(
      { from: funder.publicKey, to: ZERO32, amount, fee: 0n, nonce: 0, scriptHash: sha256(rs) },
      funder.privateKey,
    );
    const lockId = lockIdOf(lockTx);
    const lock: Lock = { amount, scriptHash: sha256(rs), createdHeight: 1 };
    state.locks.set(bytesToHex(lockId), lock);
    return { state, lockId };
  }

  it('admits a redeem against a confirmed lock and selects it when active', () => {
    const { state, lockId } = stateWithLock(5n * COIN);
    const mp = new Mempool();
    const redeem = makeRedeem(lockId, bob.publicKey, 5n * COIN, 1000n, rs, [preimage]);
    expect(mp.add(redeem, state)).toBeNull();
    expect(mp.selectForBlock(state, 1 << 20, ACTIVE)).toHaveLength(1);
    // Inactive selection never includes redeems.
    expect(mp.selectForBlock(state, 1 << 20)).toHaveLength(0);
  });

  it('rejects a redeem for an unknown lock', () => {
    const mp = new Mempool();
    const redeem = makeRedeem(sha256(new TextEncoder().encode('nope')), bob.publicKey, 5n * COIN, 1000n, rs, [preimage]);
    expect(mp.add(redeem, emptyState())).toBe('unknown or unconfirmed lock');
  });

  it('keeps only one redeem per lock (highest fee wins)', () => {
    const { state, lockId } = stateWithLock(5n * COIN);
    const mp = new Mempool();
    const cheap = makeRedeem(lockId, bob.publicKey, 5n * COIN, 1000n, rs, [preimage]);
    const pricier = makeRedeem(lockId, generateKeyPair().publicKey, 5n * COIN, 5000n, rs, [preimage]);
    expect(mp.add(cheap, state)).toBeNull();
    expect(mp.add(pricier, state)).toBeNull();
    expect(mp.size()).toBe(1);
    expect(mp.list()[0]!.fee).toBe(5000n);
    // A lower-fee replacement is refused.
    const cheaper = makeRedeem(lockId, bob.publicKey, 5n * COIN, 1500n, rs, [preimage]);
    expect(mp.add(cheaper, state)).toBe('lock already being redeemed');
  });

  it('does not select a redeem whose script fails', () => {
    const { state, lockId } = stateWithLock(5n * COIN);
    const mp = new Mempool();
    const bad = makeRedeem(lockId, bob.publicKey, 5n * COIN, 1000n, rs, [new TextEncoder().encode('wrong')]);
    expect(mp.add(bad, state)).toBeNull(); // admitted (cheap structural check)
    expect(mp.selectForBlock(state, 1 << 20, ACTIVE)).toHaveLength(0); // but never selected
  });
});
