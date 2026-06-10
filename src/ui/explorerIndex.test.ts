import { describe, expect, it } from 'vitest';
import { Blockchain } from '../chain/blockchain.js';
import { blockReward } from '../chain/genesis.js';
import { signTx, txHash } from '../chain/transaction.js';
import { generateKeyPair } from '../crypto/keys.js';
import { buildBlock, emptyMine } from '../chain/testutil.js';
import { bytesToHex } from '../util/binary.js';
import { ExplorerIndex } from './explorerIndex.js';

/**
 * The explorer index mirrors the canonical chain incrementally. The invariant
 * worth defending is: after any sequence of tip moves (extensions or reorgs),
 * the incremental index is indistinguishable from one rebuilt from scratch.
 */

function wireIndex(chain: Blockchain): ExplorerIndex {
  const idx = new ExplorerIndex(chain);
  chain.onTipChanged((d) => idx.apply(d));
  idx.ensureFresh();
  return idx;
}

/** Observable index state for the given addresses, bigints stringified. */
function observe(idx: ExplorerIndex, addresses: string[], maxHeight: number): unknown {
  return {
    addresses: addresses.map((a) => {
      const s = idx.getAddress(a);
      if (!s) return null;
      return {
        received: s.received.toString(),
        sent: s.sent.toString(),
        feesPaid: s.feesPaid.toString(),
        minedRewards: s.minedRewards.toString(),
        blocksMined: s.blocksMined,
        txCount: s.txCount,
        refs: s.refs.map((r) => ({ ...r })),
      };
    }),
    heights: Array.from({ length: maxHeight }, (_, i) => idx.hashAtHeight(i + 1) ?? null),
    totalTx: idx.totalTxCount(),
    addressCount: idx.addressCount(),
  };
}

describe('explorer index', () => {
  it('indexes extensions incrementally: aggregates, tx locations, heights', async () => {
    const chain = new Blockchain();
    const idx = wireIndex(chain);
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const minerB = generateKeyPair();

    await chain.addBlock(await emptyMine(chain, alice.publicKey));
    const tx = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 5n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    await chain.addBlock(await buildBlock(chain, minerB.publicKey, [tx]));

    const a = idx.getAddress(alice.address)!;
    expect(a.blocksMined).toBe(1);
    expect(a.minedRewards).toBe(blockReward(1));
    expect(a.sent).toBe(5n);
    expect(a.feesPaid).toBe(200n);
    expect(a.txCount).toBe(1);
    expect(a.refs.map((r) => r.dir)).toEqual(['mined', 'out']);

    const b = idx.getAddress(bob.address)!;
    expect(b.received).toBe(5n);
    expect(b.txCount).toBe(1);

    const m = idx.getAddress(minerB.address)!;
    expect(m.minedRewards).toBe(blockReward(2) + 200n);

    const loc = idx.findTx(bytesToHex(txHash(tx)))!;
    expect(loc.height).toBe(2);
    expect(idx.hashAtHeight(2)).toBe(loc.blockHash);
    expect(idx.totalTxCount()).toBe(1);

    // The incremental result must equal a from-scratch rebuild.
    const fresh = wireIndex(chain);
    const addrs = [alice.address, bob.address, minerB.address];
    expect(observe(idx, addrs, chain.height)).toEqual(observe(fresh, addrs, chain.height));
  });

  it('unwinds a reorg exactly: displaced txs and rewards disappear', async () => {
    const chain = new Blockchain();
    const idx = wireIndex(chain);
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const minerB = generateKeyPair();

    const h1 = await emptyMine(chain, alice.publicKey);
    await chain.addBlock(h1);

    // Branch A: alice's tx confirms at height 2.
    const tx = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 5n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    await chain.addBlock(await buildBlock(chain, alice.publicKey, [tx]));
    expect(idx.findTx(bytesToHex(txHash(tx)))).toBeDefined();
    expect(idx.getAddress(bob.address)!.received).toBe(5n);

    // Branch B: heavier branch from h1 without the tx → reorg displaces it.
    const sandbox = new Blockchain();
    await sandbox.addBlock(h1);
    const b2 = await emptyMine(sandbox, minerB.publicKey);
    await sandbox.addBlock(b2);
    const b3 = await emptyMine(sandbox, minerB.publicKey);
    await sandbox.addBlock(b3);
    await chain.addBlock(b2);
    await chain.addBlock(b3);
    expect(chain.height).toBe(3);

    // The tx is gone from the index, bob's entry is garbage-collected, and
    // alice keeps only her h1 coinbase.
    expect(idx.findTx(bytesToHex(txHash(tx)))).toBeUndefined();
    expect(idx.getAddress(bob.address)).toBeUndefined();
    const a = idx.getAddress(alice.address)!;
    expect(a.sent).toBe(0n);
    expect(a.feesPaid).toBe(0n);
    expect(a.blocksMined).toBe(1);
    expect(a.refs.map((r) => r.dir)).toEqual(['mined']);

    const fresh = wireIndex(chain);
    const addrs = [alice.address, bob.address, minerB.address];
    expect(observe(idx, addrs, chain.height)).toEqual(observe(fresh, addrs, chain.height));
  });

  it('ensureFresh rebuilds after blocks arrive without tip events', async () => {
    const chain = new Blockchain();
    const miner = generateKeyPair();
    const idx = new ExplorerIndex(chain); // NOT subscribed to onTipChanged
    idx.ensureFresh();
    expect(idx.getAddress(miner.address)).toBeUndefined();

    await chain.addBlock(await emptyMine(chain, miner.publicKey));
    // The index missed the event; ensureFresh must notice and rebuild.
    idx.ensureFresh();
    expect(idx.getAddress(miner.address)!.blocksMined).toBe(1);
  });
});
