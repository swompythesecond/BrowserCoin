import { describe, expect, it } from 'vitest';
import { Blockchain } from './blockchain.js';
import { Mempool } from './mempool.js';
import { blockReward, COIN, MAX_MONEY } from './genesis.js';
import { signTx, validateTxStructure } from './transaction.js';
import { generateKeyPair } from '../crypto/keys.js';
import { getAccount } from './state.js';
import { checkPoW } from './consensus.js';
import { buildBlock, emptyMine } from './testutil.js';

describe('blockchain', () => {
  it('starts at genesis with height 0', () => {
    const chain = new Blockchain();
    expect(chain.height).toBe(0);
    expect(chain.tipState.size).toBe(0);
  });

  it('accepts an empty mined block and credits the miner', async () => {
    const chain = new Blockchain();
    const miner = generateKeyPair();
    const b = await emptyMine(chain, miner.publicKey);
    const err = await chain.addBlock(b);
    expect(err).toBeNull();
    expect(chain.height).toBe(1);
    const acct = getAccount(chain.tipState, miner.address);
    expect(acct.balance).toBe(blockReward(1));
    expect(acct.nonce).toBe(0);
  });

  it('rejects a block with bad PoW', async () => {
    const chain = new Blockchain();
    const miner = generateKeyPair();
    const b = await emptyMine(chain, miner.publicKey);
    // At low test difficulty, bumping nonce by 1 has a non-trivial chance of
    // still being valid — walk until we find a nonce whose hash misses target.
    let bad = { ...b, header: { ...b.header, nonce: (b.header.nonce + 1) >>> 0 } };
    while (await checkPoW(bad.header)) {
      bad = { ...bad, header: { ...bad.header, nonce: (bad.header.nonce + 1) >>> 0 } };
    }
    const err = await chain.addBlock(bad);
    expect(err).toMatch(/PoW invalid/);
  });

  it('rejects a tampered tx list (txRoot mismatch)', async () => {
    const chain = new Blockchain();
    const miner = generateKeyPair();
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    // Mine a block crediting Alice.
    const b1 = await emptyMine(chain, alice.publicKey);
    await chain.addBlock(b1);

    const tx = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n * COIN, fee: 0n, nonce: 0 },
      alice.privateKey,
    );
    const b2 = await buildBlock(chain, miner.publicKey, [tx]);
    // Replace tx after PoW — txRoot now mismatches.
    const tampered = { ...b2, transactions: [] };
    const err = await chain.addBlock(tampered);
    expect(err).toMatch(/txRoot mismatch/);
  });

  it('applies a valid signed transfer and updates balances', async () => {
    const chain = new Blockchain();
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    // Mine block to fund Alice.
    await chain.addBlock(await emptyMine(chain, alice.publicKey));
    const reward = blockReward(1);

    const tx = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 10n * COIN, fee: 100n, nonce: 0 },
      alice.privateKey,
    );
    await chain.addBlock(await buildBlock(chain, alice.publicKey, [tx]));

    const aliceAcct = getAccount(chain.tipState, alice.address);
    const bobAcct = getAccount(chain.tipState, bob.address);
    // Alice paid amount + fee, but earned both block rewards + fee.
    expect(bobAcct.balance).toBe(10n * COIN);
    expect(aliceAcct.balance).toBe(reward + blockReward(2) - 10n * COIN);
    expect(aliceAcct.nonce).toBe(1);
  });

  it('rejects double-spend (replayed nonce)', async () => {
    // State layer rejects replayed nonce via applyTx — buildBlock surfaces that error.
    const chain = new Blockchain();
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await chain.addBlock(await emptyMine(chain, alice.publicKey));

    const tx = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n * COIN, fee: 0n, nonce: 0 },
      alice.privateKey,
    );
    await chain.addBlock(await buildBlock(chain, alice.publicKey, [tx]));
    // Alice's nonce is now 1. Replaying nonce 0 must fail.
    await expect(buildBlock(chain, alice.publicKey, [tx])).rejects.toThrow(/bad nonce/);
  });

  it('rejects spending more than balance', async () => {
    const chain = new Blockchain();
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const tx = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n * COIN, fee: 0n, nonce: 0 },
      alice.privateKey,
    );
    await expect(buildBlock(chain, alice.publicKey, [tx])).rejects.toThrow(/insufficient balance/);
  });

  it('rejects txs that exceed MAX_MONEY (defense-in-depth vs Bitcoin 2010 overflow bug)', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    // amount alone exceeds MAX_MONEY
    const tooMuchAmount = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: MAX_MONEY + 1n, fee: 0n, nonce: 0 },
      alice.privateKey,
    );
    expect(validateTxStructure(tooMuchAmount)).toMatch(/amount exceeds MAX_MONEY/);

    // fee alone exceeds MAX_MONEY
    const tooMuchFee = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: MAX_MONEY + 1n, nonce: 0 },
      alice.privateKey,
    );
    expect(validateTxStructure(tooMuchFee)).toMatch(/fee exceeds MAX_MONEY/);

    // amount + fee exceeds MAX_MONEY (each individually under cap)
    const halfPlus = (MAX_MONEY / 2n) + 1n;
    const sumOverflow = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: halfPlus, fee: halfPlus, nonce: 0 },
      alice.privateKey,
    );
    expect(validateTxStructure(sumOverflow)).toMatch(/amount \+ fee exceeds MAX_MONEY/);

    // The exact-MAX-MONEY edge case is permitted.
    const atCap = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: MAX_MONEY, fee: 0n, nonce: 0 },
      alice.privateKey,
    );
    expect(validateTxStructure(atCap)).toBeNull();
  });

  it('rejects a block containing a tx with a forged signature', async () => {
    const chain = new Blockchain();
    const alice = generateKeyPair();
    const eve = generateKeyPair();
    const bob = generateKeyPair();
    await chain.addBlock(await emptyMine(chain, alice.publicKey));

    // Eve claims to be Alice but signs with her own key. State apply doesn't check
    // signatures (that's the chain's job) so buildBlock will successfully PoW a block.
    const forged = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n * COIN, fee: 0n, nonce: 0 },
      eve.privateKey,
    );
    const block = await buildBlock(chain, alice.publicKey, [forged]);
    const err = await chain.addBlock(block);
    expect(err).toMatch(/bad signature/);
  });
});

describe('mempool', () => {
  it('accepts valid txs and orders by fee per byte', async () => {
    const chain = new Blockchain();
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const carol = generateKeyPair();
    // Fund alice & bob with empty mines.
    await chain.addBlock(await emptyMine(chain, alice.publicKey));
    await chain.addBlock(await emptyMine(chain, bob.publicKey));

    const mp = new Mempool();
    const txLow = signTx(
      { from: alice.publicKey, to: carol.publicKey, amount: 1n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    const txHigh = signTx(
      { from: bob.publicKey, to: carol.publicKey, amount: 1n, fee: 5000n, nonce: 0 },
      bob.privateKey,
    );
    expect(mp.add(txLow, chain.tipState)).toBeNull();
    expect(mp.add(txHigh, chain.tipState)).toBeNull();

    const picked = mp.selectForBlock(chain.tipState, 1024 * 1024);
    expect(picked.length).toBe(2);
    expect(picked[0]!.fee).toBe(5000n); // higher fee first
  });

  it('rejects nonce too low', async () => {
    const chain = new Blockchain();
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await chain.addBlock(await emptyMine(chain, alice.publicKey));

    // Land a tx so Alice's nonce moves to 1.
    const tx0 = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    await chain.addBlock(await buildBlock(chain, alice.publicKey, [tx0]));

    // Try to admit the same nonce again into mempool.
    const mp = new Mempool();
    const err = mp.add(tx0, chain.tipState);
    expect(err).toMatch(/nonce too low/);
  });

  it('assigns sequential nonces so rapid sends all become mineable', async () => {
    const chain = new Blockchain();
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await chain.addBlock(await emptyMine(chain, alice.publicKey));

    // Simulate a wallet sending 5 txs before any confirms: each new tx takes
    // its nonce from nextNonceFor (on-chain nonce + what's already pending).
    const mp = new Mempool();
    for (let i = 0; i < 5; i++) {
      const nonce = mp.nextNonceFor(alice.address, getAccount(chain.tipState, alice.address).nonce);
      const tx = signTx(
        { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce },
        alice.privateKey,
      );
      expect(mp.add(tx, chain.tipState)).toBeNull();
    }
    expect(mp.size()).toBe(5);

    // All five are nonce-contiguous (0..4) → all selectable in one block.
    const picked = mp.selectForBlock(chain.tipState, 1024 * 1024);
    expect(picked.length).toBe(5);
    expect(picked.map((t) => t.nonce).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);

    // And the block they form actually validates (sequential nonces).
    const block = await buildBlock(chain, alice.publicKey, picked);
    expect(await chain.addBlock(block)).toBeNull();
  });

  it('replaces a same-nonce tx only when the new one pays more (RBF)', async () => {
    const chain = new Blockchain();
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await chain.addBlock(await emptyMine(chain, alice.publicKey));

    const mp = new Mempool();
    const cheap = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    const pricier = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 2n, fee: 5000n, nonce: 0 },
      alice.privateKey,
    );
    expect(mp.add(cheap, chain.tipState)).toBeNull();
    // Higher fee for the same nonce replaces; pool never holds two.
    expect(mp.add(pricier, chain.tipState)).toBeNull();
    expect(mp.size()).toBe(1);
    // A lower/equal-fee collision is rejected, not stacked.
    expect(mp.add(cheap, chain.tipState)).toMatch(/nonce already pending/);
    expect(mp.size()).toBe(1);
    expect(mp.list()[0]!.fee).toBe(5000n);
  });

  it('prunes txs whose nonce slot was taken by a confirmed tx', async () => {
    const chain = new Blockchain();
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await chain.addBlock(await emptyMine(chain, alice.publicKey));

    const mp = new Mempool();
    const pending = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    expect(mp.add(pending, chain.tipState)).toBeNull();

    // A *different* tx confirms Alice's nonce 0 on-chain (e.g. mined elsewhere).
    const confirmed = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 7n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    expect(await chain.addBlock(await buildBlock(chain, alice.publicKey, [confirmed]))).toBeNull();
    expect(getAccount(chain.tipState, alice.address).nonce).toBe(1);

    // The still-pending nonce-0 tx is now dead; pruneUnminable evicts it.
    expect(mp.pruneUnminable(chain.tipState)).toBe(1);
    expect(mp.size()).toBe(0);
  });
});

describe('fork-choice', () => {
  it('picks the heavier branch when two compete', async () => {
    const chain = new Blockchain();
    const minerA = generateKeyPair();
    const minerB = generateKeyPair();

    // Build branch A: 2 blocks
    const a1 = await emptyMine(chain, minerA.publicKey);
    await chain.addBlock(a1);
    const a2 = await emptyMine(chain, minerA.publicKey);
    await chain.addBlock(a2);
    expect(chain.height).toBe(2);

    // Build branch B starting from genesis: 3 blocks, one longer.
    // We add them via the same `chain` object — fork-choice should switch over.
    // Trick: build them against a *separate* throwaway chain, then submit.
    const sandbox = new Blockchain();
    const b1 = await emptyMine(sandbox, minerB.publicKey);
    await sandbox.addBlock(b1);
    const b2 = await emptyMine(sandbox, minerB.publicKey);
    await sandbox.addBlock(b2);
    const b3 = await emptyMine(sandbox, minerB.publicKey);
    await sandbox.addBlock(b3);

    await chain.addBlock(b1);
    await chain.addBlock(b2);
    await chain.addBlock(b3);

    expect(chain.height).toBe(3);
  });
});
