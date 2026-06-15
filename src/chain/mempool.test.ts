import { describe, expect, it } from 'vitest';
import { Mempool } from './mempool.js';
import { signTx, TX_ENCODED_LEN } from './transaction.js';
import { generateKeyPair } from '../crypto/keys.js';
import { COIN, MEMPOOL_TX_TTL_MS, TARGET_BLOCK_TIME_S } from './genesis.js';
import type { State } from './state.js';
import { Blockchain } from './blockchain.js';
import { buildBlock, emptyMine } from './testutil.js';

const GRACE_MS = TARGET_BLOCK_TIME_S * 1000;
const BIG_BUDGET = 1 << 20; // plenty of room — these tests never hit the size cap

/** Build a state keyed by address-hex (addresses ARE pubkeys in our chain). */
function stateWith(entries: Array<{ addr: string; balance: bigint; nonce: number }>): State {
  const s: State = new Map();
  for (const e of entries) s.set(e.addr, { balance: e.balance, nonce: e.nonce });
  return s;
}

describe('mempool unminable eviction', () => {
  it('never selects a nonce-gapped run and evicts it after the grace window', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    // On-chain nonce is 5, but the pool only holds 6..21 — the predecessor (5)
    // is missing, so the whole run is wedged. (Mirrors the stuck faucet.)
    const state = stateWith([{ addr: alice.address, balance: 1000n * COIN, nonce: 5 }]);
    const mp = new Mempool();
    const t0 = 1_000_000;
    for (let n = 6; n <= 21; n++) {
      const tx = signTx(
        { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: n },
        alice.privateKey,
      );
      expect(mp.add(tx, state, t0)).toBeNull();
    }
    expect(mp.size()).toBe(16);

    // Gap at the bottom → nothing is mineable, so a miner builds empty blocks.
    expect(mp.selectForBlock(state, BIG_BUDGET)).toHaveLength(0);

    // Within grace: a predecessor might still be propagating — keep them.
    expect(mp.pruneUnminable(state, t0 + 1000)).toBe(0);
    expect(mp.size()).toBe(16);

    // Past grace: the run is dead weight and gets discarded.
    expect(mp.pruneUnminable(state, t0 + GRACE_MS + 1)).toBe(16);
    expect(mp.size()).toBe(0);
  });

  it('selects only the fundable prefix and evicts the unaffordable tail', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    // Each tx costs amount(1) + fee(200) = 201. Balance funds exactly 3.
    const state = stateWith([{ addr: alice.address, balance: 650n, nonce: 0 }]);
    const mp = new Mempool();
    for (let n = 0; n < 10; n++) {
      const tx = signTx(
        { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: n },
        alice.privateKey,
      );
      // add() checks balance per-tx against the full on-chain balance, so all 10
      // are admitted even though the account can only fund 3 — the gap this fix closes.
      expect(mp.add(tx, state, 0)).toBeNull();
    }
    expect(mp.size()).toBe(10);

    // Balance-aware selection stops at the overdraw.
    expect(mp.selectForBlock(state, BIG_BUDGET)).toHaveLength(3);

    // The 7 unfundable txs are evicted past grace; the 3 mineable ones stay.
    expect(mp.pruneUnminable(state, GRACE_MS + 1)).toBe(7);
    expect(mp.size()).toBe(3);
    expect(mp.selectForBlock(state, BIG_BUDGET)).toHaveLength(3);
  });

  it('evicts a nonce-too-low tx immediately (no grace needed)', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const mp = new Mempool();
    // Admit nonce 0 against a fresh account...
    const tx = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    const admitState = stateWith([{ addr: alice.address, balance: 1000n * COIN, nonce: 0 }]);
    expect(mp.add(tx, admitState, 0)).toBeNull();

    // ...then the slot is consumed on-chain (nonce advances to 1). The pending
    // nonce-0 tx can never apply, so it's reaped on the same tip change, no wait.
    const advanced = stateWith([{ addr: alice.address, balance: 1000n * COIN, nonce: 1 }]);
    expect(mp.pruneUnminable(advanced, 0)).toBe(1);
    expect(mp.size()).toBe(0);
  });

  it('reaps a perfectly mineable tx once it exceeds the TTL backstop', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const state = stateWith([{ addr: alice.address, balance: 1000n * COIN, nonce: 0 }]);
    const mp = new Mempool();
    const tx = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    expect(mp.add(tx, state, 0)).toBeNull();

    // Mineable, so the unminable path leaves it alone right up to the TTL.
    expect(mp.selectForBlock(state, BIG_BUDGET)).toHaveLength(1);
    expect(mp.pruneUnminable(state, MEMPOOL_TX_TTL_MS - 1)).toBe(0);

    // At the TTL it's reaped regardless — a sender that abandoned it can resend.
    expect(mp.pruneUnminable(state, MEMPOOL_TX_TTL_MS)).toBe(1);
    expect(mp.size()).toBe(0);
  });

  it('leaves a healthy contiguous, funded queue fully intact', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const state = stateWith([{ addr: alice.address, balance: 1000n * COIN, nonce: 0 }]);
    const mp = new Mempool();
    for (let n = 0; n < 5; n++) {
      const tx = signTx(
        { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: n },
        alice.privateKey,
      );
      expect(mp.add(tx, state, 0)).toBeNull();
    }
    expect(mp.selectForBlock(state, BIG_BUDGET)).toHaveLength(5);
    // Well past the grace (but under the TTL) the queue is untouched.
    expect(mp.pruneUnminable(state, GRACE_MS + 1)).toBe(0);
    expect(mp.size()).toBe(5);
  });
});

describe('mempool block selection ordering', () => {
  it('keeps a sender in nonce order even when a later nonce pays a much higher fee', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const state = stateWith([{ addr: alice.address, balance: 1000n * COIN, nonce: 0 }]);
    const mp = new Mempool();
    // nonce 0 pays a low fee, nonce 1 pays a far higher one. Sorting the flat tx
    // list by fee-per-byte would float nonce 1 ahead of nonce 0 — a nonce gap the
    // block path rejects. The selector must hand a sender's txs back in nonce order.
    const tx0 = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    const tx1 = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 100_000n, nonce: 1 },
      alice.privateKey,
    );
    // Add the high-fee tx first so insertion order can't mask the bug.
    expect(mp.add(tx1, state, 0)).toBeNull();
    expect(mp.add(tx0, state, 0)).toBeNull();

    expect(mp.selectForBlock(state, BIG_BUDGET).map((t) => t.nonce)).toEqual([0, 1]);
  });

  it('truncates a sender at its nonce-leading prefix when maxBytes runs out', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const state = stateWith([{ addr: alice.address, balance: 1000n * COIN, nonce: 0 }]);
    const mp = new Mempool();
    for (let n = 0; n < 3; n++) {
      const tx = signTx(
        { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: n },
        alice.privateKey,
      );
      expect(mp.add(tx, state, 0)).toBeNull();
    }
    // Budget fits exactly two txs. We must get the leading prefix [0, 1] — never a
    // middle slice like [0, 2] or [1, 2], which would gap the sender's nonces.
    const picked = mp.selectForBlock(state, TX_ENCODED_LEN * 2);
    expect(picked.map((t) => t.nonce)).toEqual([0, 1]);
  });

  it('returns a set a real block can apply (nonce order survives the block path)', async () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const miner = generateKeyPair();
    const chain = new Blockchain();
    // Give Alice an on-chain balance + nonce 0 via a coinbase block.
    await chain.addBlock(await emptyMine(chain, alice.publicKey));

    const mp = new Mempool();
    const tx0 = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    const tx1 = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 100_000n, nonce: 1 },
      alice.privateKey,
    );
    expect(mp.add(tx1, chain.tipState, 0)).toBeNull();
    expect(mp.add(tx0, chain.tipState, 0)).toBeNull();

    // Feed the selector's output straight into a block, exactly as a miner would.
    // Before the fix this came back [nonce 1, nonce 0] and the block failed to apply.
    const picked = mp.selectForBlock(chain.tipState, BIG_BUDGET);
    expect(picked.map((t) => t.nonce)).toEqual([0, 1]);
    const block = await buildBlock(chain, miner.publicKey, picked);
    expect(await chain.addBlock(block)).toBeNull();
  });
});
