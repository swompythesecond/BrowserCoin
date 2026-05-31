import { describe, expect, it } from 'vitest';
import { Blockchain } from './blockchain.js';
import { Mempool } from './mempool.js';
import { signTx, txHash } from './transaction.js';
import { generateKeyPair } from '../crypto/keys.js';
import { buildBlock, emptyMine } from './testutil.js';
import { bytesToHex } from '../util/binary.js';

/**
 * Mempool ↔ chain reconciliation: a tx must never be lost. It only leaves the
 * mempool when it confirms on the *canonical* chain, and a reorg that displaces
 * a block returns its txs to the pool so they can be re-mined.
 *
 * Kept in its own file (not chain.test.ts) so the Argon2id PoW these tests mine
 * doesn't push that file's single-worker CPU burst past vitest's RPC heartbeat.
 */

/**
 * Wire a mempool to a chain exactly like Node/api do via `onTipChanged`.
 * Returns the mempool for assertions.
 */
function wireMempool(chain: Blockchain): Mempool {
  const mp = new Mempool();
  chain.onTipChanged(({ confirmed, restored }) => {
    for (const tx of restored) mp.add(tx, chain.tipState);
    mp.removeMany(confirmed);
  });
  return mp;
}

describe('mempool ↔ chain reconciliation (no lost txs)', () => {
  it('evicts a tx only when it confirms on the canonical chain', async () => {
    const chain = new Blockchain();
    const mp = wireMempool(chain);
    const alice = generateKeyPair();
    const bob = generateKeyPair();

    // Fund alice, then queue a transfer in the mempool.
    const h1 = await emptyMine(chain, alice.publicKey);
    await chain.addBlock(h1);
    const tx = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    expect(mp.add(tx, chain.tipState)).toBeNull();
    const txHex = bytesToHex(txHash(tx));
    expect(mp.has(txHex)).toBe(true);

    // Confirm it in a canonical block — now it should leave the mempool.
    await chain.addBlock(await buildBlock(chain, alice.publicKey, [tx]));
    expect(mp.has(txHex)).toBe(false);
  });

  it('does NOT evict a tx that appears only in a losing fork block', async () => {
    const chain = new Blockchain();
    const mp = wireMempool(chain);
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const minerB = generateKeyPair();

    // Fund alice at h1, then extend the canonical chain to height 3 (empty).
    const h1 = await emptyMine(chain, alice.publicKey);
    await chain.addBlock(h1);
    await chain.addBlock(await emptyMine(chain, minerB.publicKey));
    await chain.addBlock(await emptyMine(chain, minerB.publicKey));
    expect(chain.height).toBe(3);

    const tx = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    expect(mp.add(tx, chain.tipState)).toBeNull();
    const txHex = bytesToHex(txHash(tx));

    // Build a SHORTER fork from h1 that contains the tx — it loses fork choice
    // (height 2 < 3), so the tip never moves to it and the tx must stay pooled.
    const sandbox = new Blockchain();
    await sandbox.addBlock(h1);
    const forkWithTx = await buildBlock(sandbox, minerB.publicKey, [tx]);
    const err = await chain.addBlock(forkWithTx);
    expect(err).toBeNull();        // accepted as a fork…
    expect(chain.height).toBe(3);  // …but not canonical
    expect(mp.has(txHex)).toBe(true); // so the tx is NOT lost from the mempool
  });

  it('restores displaced txs to the mempool on a reorg', async () => {
    const chain = new Blockchain();
    const mp = wireMempool(chain);
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const minerB = generateKeyPair();

    // Fund alice at h1.
    const h1 = await emptyMine(chain, alice.publicKey);
    await chain.addBlock(h1);

    // Branch A: a height-2 block that confirms alice's tx (becomes the tip).
    const tx = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    mp.add(tx, chain.tipState);
    const a2 = await buildBlock(chain, alice.publicKey, [tx]);
    await chain.addBlock(a2);
    const txHex = bytesToHex(txHash(tx));
    expect(chain.height).toBe(2);
    expect(mp.has(txHex)).toBe(false); // confirmed on branch A → evicted

    // Branch B: a heavier (height-3) branch from h1 WITHOUT the tx. Submitting
    // it triggers a reorg that displaces a2 — the tx must come back to pending.
    const sandbox = new Blockchain();
    await sandbox.addBlock(h1);
    const b2 = await emptyMine(sandbox, minerB.publicKey);
    await sandbox.addBlock(b2);
    const b3 = await emptyMine(sandbox, minerB.publicKey);
    await sandbox.addBlock(b3);

    await chain.addBlock(b2); // height 2, equal work → tip stays on a2
    expect(mp.has(txHex)).toBe(false);
    await chain.addBlock(b3); // height 3 → reorg onto branch B
    expect(chain.height).toBe(3);
    expect(mp.has(txHex)).toBe(true); // displaced tx restored — not lost
  });
});
