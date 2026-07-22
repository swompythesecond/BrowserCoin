import { describe, it, expect, vi } from 'vitest';

// Test-scoped fork parameters. fork #2 activates at height 3 and fork #3
// re-anchors at height 6, so a short mined chain crosses BOTH boundaries. The
// real heights (33,550 / 35,550) are unmineable in a test. ANCHOR_ATTEMPTS is
// kept just above the ~128-attempt floor so blocks mine in seconds.
//
// This file exists because fork3.test.ts only exercises the pure nextDifficulty
// function. ALL of the new state — the per-block anchor inheritance, the
// validator/miner agreement, reorgs across the anchor height, and the seeding
// paths — lives in Blockchain, and none of it was covered. Fork #2 shipped
// because its two halves were each tested in isolation from the other; this is
// the test that would have caught that.
const { TEST_FORK2_HEIGHT, TEST_ANCHOR_HEIGHT } = vi.hoisted(() => ({
  TEST_FORK2_HEIGHT: 3,
  TEST_ANCHOR_HEIGHT: 6,
}));
vi.mock('./genesis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./genesis.js')>();
  return {
    ...actual,
    SANDGLASS_FORK_HEIGHT: TEST_FORK2_HEIGHT,
    SANDGLASS_ANCHOR_ATTEMPTS: 256,
    SANDGLASS_ANCHOR_TIMESTAMP: actual.GENESIS_TIMESTAMP + TEST_FORK2_HEIGHT * actual.TARGET_BLOCK_TIME_S,
    SANDGLASS2_ANCHOR_HEIGHT: TEST_ANCHOR_HEIGHT,
  };
});

import { Blockchain } from './blockchain.js';
import { emptyMine } from './testutil.js';
import { generateKeyPair } from '../crypto/keys.js';
import { hashHeader, type Block } from './block.js';
import { bytesToHex } from '../util/binary.js';
import { SANDGLASS2_ANCHOR_HEIGHT, TARGET_BLOCK_TIME_S } from './genesis.js';

/** Mine `count` blocks onto `chain`, asserting each is accepted. */
async function mine(chain: Blockchain, miner: Uint8Array, count: number, gap?: number): Promise<Block[]> {
  const out: Block[] = [];
  for (let i = 0; i < count; i++) {
    const ts = gap === undefined ? undefined : chain.tip.block.header.timestamp + gap;
    const b = await emptyMine(chain, miner, ts);
    const err = await chain.addBlock(b);
    expect(err, `addBlock at height ${b.header.height}`).toBeNull();
    out.push(b);
  }
  return out;
}

describe('fork #3 — end-to-end through Blockchain', () => {
  it('mines across the anchor, carries difficulty over, and re-validates on a fresh node', async () => {
    expect(SANDGLASS2_ANCHOR_HEIGHT).toBe(TEST_ANCHOR_HEIGHT); // mock is live

    const miner = generateKeyPair();
    const chain = new Blockchain();
    const blocks = await mine(chain, miner.publicKey, TEST_ANCHOR_HEIGHT + 4);

    const anchor = blocks[TEST_ANCHOR_HEIGHT - 1]!;
    const first = blocks[TEST_ANCHOR_HEIGHT]!;
    expect(anchor.header.height).toBe(TEST_ANCHOR_HEIGHT);
    expect(first.header.height).toBe(TEST_ANCHOR_HEIGHT + 1);

    // THE defining property: the first block above the anchor carries the
    // anchor's own difficulty, because the drift term is 0 by construction.
    expect(first.header.difficulty).toBe(anchor.header.difficulty);

    // Miner and validator must agree. The miner used expectedNextDifficulty();
    // addBlock re-derived it independently and accepted every block above — so
    // if those two assembled different inputs, this loop would already have
    // failed with `bad difficulty`.
    for (const b of blocks) expect(b.header.difficulty).toBeGreaterThan(0);

    // A fresh node re-validates the whole chain in order, which is the real
    // "another tab syncs across the fork" path and exercises anchor inheritance
    // from scratch rather than from the mining node's cache.
    const node2 = new Blockchain();
    for (const b of blocks) {
      const err = await node2.addBlock(b);
      expect(err, `node2 addBlock at height ${b.header.height}`).toBeNull();
    }
    expect(bytesToHex(hashHeader(node2.tip.block.header))).toBe(
      bytesToHex(hashHeader(chain.tip.block.header)),
    );
  }, 180_000);

  it('keeps per-branch anchors across a reorg through the anchor height', async () => {
    const miner = generateKeyPair();

    // Two independently-mined chains that diverge BELOW the anchor height, so
    // each ends up with its own distinct block at the anchor height and thus its
    // own ASERT anchor. Different timestamps make the branches differ.
    const a = new Blockchain();
    await mine(a, miner.publicKey, TEST_ANCHOR_HEIGHT + 2, TARGET_BLOCK_TIME_S);

    const b = new Blockchain();
    const bBlocks = await mine(b, miner.publicKey, TEST_ANCHOR_HEIGHT + 4, TARGET_BLOCK_TIME_S - 1);

    const aAnchorHash = bytesToHex(hashHeader(a.tip.block.header));
    const bAnchor = bBlocks[TEST_ANCHOR_HEIGHT - 1]!;

    // Feed branch B into the node that already holds branch A. B is longer, so
    // the node must accept every block and reorg onto it. Any per-branch anchor
    // confusion shows up immediately as `bad difficulty`.
    for (const blk of bBlocks) {
      const err = await a.addBlock(blk);
      expect(err, `cross-feed at height ${blk.header.height}`).toBeNull();
    }
    expect(a.height).toBe(TEST_ANCHOR_HEIGHT + 4);
    expect(bytesToHex(hashHeader(a.tip.block.header))).toBe(bytesToHex(hashHeader(b.tip.block.header)));
    expect(bytesToHex(hashHeader(a.tip.block.header))).not.toBe(aAnchorHash);

    // Both anchor blocks now coexist in the same node at the same height, each
    // owning its branch. The reorged tip must still validate a new child.
    expect(bAnchor.header.height).toBe(TEST_ANCHOR_HEIGHT);
    const next = await emptyMine(a, miner.publicKey);
    expect(await a.addBlock(next)).toBeNull();
  }, 180_000);

  it('rejects a seeded block whose height does not follow its parent', async () => {
    // Guards inheritAnchor, which keys the ASERT anchor off header.height alone:
    // a corrupt restore row claiming the anchor height at the wrong depth would
    // otherwise become that branch's anchor for the whole chain.
    const miner = generateKeyPair();
    const chain = new Blockchain();
    const blocks = await mine(chain, miner.publicKey, 3);

    const victim = new Blockchain();
    expect(victim.seedHistoricalBlock(blocks[0]!, null)).toBeNull();
    // blocks[2] links to blocks[1], which the victim never received.
    expect(victim.seedHistoricalBlock(blocks[2]!, null)).toBe('parent block unknown');

    // And a block whose prevHash resolves but whose height lies.
    const forged: Block = {
      ...blocks[1]!,
      header: { ...blocks[1]!.header, height: TEST_ANCHOR_HEIGHT },
    };
    expect(victim.seedHistoricalBlock(forged, null)).toBe('height not parent+1');
  }, 120_000);
});
