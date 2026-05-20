import { describe, expect, it } from 'vitest';
import { Blockchain } from '../chain/blockchain.js';
import { hashHeader, type Block } from '../chain/block.js';
import { emptyMine } from '../chain/testutil.js';
import { generateKeyPair } from '../crypto/keys.js';
import { bytesToHex } from '../util/binary.js';

/**
 * Regression test for the bug the user hit: two browsers mined independent chains
 * from genesis, then connected — neither could reconcile, so heights diverged
 * forever. The fix is an orphan pool that walks back link-by-link to a common
 * ancestor and then drains forward. This test reimplements that algorithm
 * inline (the network-layer impl is in src/net/peer.ts) so we can verify the
 * algorithm itself without spinning up PeerJS.
 */

/** Inline simulation of peer.ts's orphan-pool / drainOrphans logic. */
async function syncFrom(receiver: Blockchain, sender: Blockchain): Promise<void> {
  const orphans = new Map<string, Block>();
  const fifo: Block[] = [sender.tip.block];

  while (fifo.length) {
    const block = fifo.shift()!;
    const ownHash = bytesToHex(hashHeader(block.header));
    if (receiver.hasBlock(ownHash)) continue;
    const err = await receiver.addBlock(block);
    if (err === null) {
      // drain forward
      let cursor: string | undefined = ownHash;
      while (cursor) {
        const waiting = orphans.get(cursor);
        if (!waiting) break;
        orphans.delete(cursor);
        const e2 = await receiver.addBlock(waiting);
        if (e2 !== null) break;
        cursor = bytesToHex(hashHeader(waiting.header));
      }
      continue;
    }
    if (err === 'parent block unknown') {
      orphans.set(bytesToHex(block.header.prevHash), block);
      // request parent from sender
      const parentEntry = sender.getBlock(bytesToHex(block.header.prevHash));
      if (parentEntry) fifo.push(parentEntry.block);
      continue;
    }
    throw new Error(`unexpected add error: ${err}`);
  }
}

describe('peer sync (orphan-pool reconciliation)', () => {
  it('reconciles two divergent solo-mined chains', async () => {
    const minerA = generateKeyPair();
    const minerB = generateKeyPair();
    const chainA = new Blockchain();
    const chainB = new Blockchain();

    // Both started from genesis and mined independently.
    for (let i = 0; i < 3; i++) await chainA.addBlock(await emptyMine(chainA, minerA.publicKey));
    for (let i = 0; i < 5; i++) await chainB.addBlock(await emptyMine(chainB, minerB.publicKey));

    expect(chainA.height).toBe(3);
    expect(chainB.height).toBe(5);
    expect(bytesToHex(chainA.tip.hash)).not.toBe(bytesToHex(chainB.tip.hash));

    // A learns about B's tip via "hello" and starts the orphan-pool walk.
    await syncFrom(chainA, chainB);

    expect(chainA.height).toBe(5);
    expect(bytesToHex(chainA.tip.hash)).toBe(bytesToHex(chainB.tip.hash));
  });

  it('lighter chain ignores sync from heavier-but-equal-height peer', async () => {
    // Both at height 2 with equal difficulty → first-seen wins, no reorg.
    const minerA = generateKeyPair();
    const minerB = generateKeyPair();
    const chainA = new Blockchain();
    const chainB = new Blockchain();
    for (let i = 0; i < 2; i++) await chainA.addBlock(await emptyMine(chainA, minerA.publicKey));
    for (let i = 0; i < 2; i++) await chainB.addBlock(await emptyMine(chainB, minerB.publicKey));

    const originalTipA = bytesToHex(chainA.tip.hash);
    await syncFrom(chainA, chainB);
    // A should now know about B's branch but stay on its own tip (equal work).
    expect(chainA.height).toBe(2);
    expect(bytesToHex(chainA.tip.hash)).toBe(originalTipA);
  });

  it('reorgs onto the heavier branch when it arrives', async () => {
    const minerA = generateKeyPair();
    const minerB = generateKeyPair();
    const chainA = new Blockchain();
    const chainB = new Blockchain();
    for (let i = 0; i < 4; i++) await chainA.addBlock(await emptyMine(chainA, minerA.publicKey));
    for (let i = 0; i < 7; i++) await chainB.addBlock(await emptyMine(chainB, minerB.publicKey));

    await syncFrom(chainA, chainB);

    expect(chainA.height).toBe(7);
    expect(bytesToHex(chainA.tip.hash)).toBe(bytesToHex(chainB.tip.hash));
  });
});
