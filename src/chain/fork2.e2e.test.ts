import { describe, it, expect, vi } from 'vitest';

// Test-scoped fork parameters: a LOW fork height so we can actually mine across
// the Argon2id → Sandglass boundary (the real height is 40k, unmineable in a
// test). This mock only affects this test file; production constants are
// untouched. ANCHOR_TIMESTAMP is set to the fork block's on-pace timestamp
// (genesis + FORK×spacing, matching the test miner) so the ASERT re-anchor sees
// zero deviation and difficulty holds steady at the anchor. ANCHOR_ATTEMPTS is
// kept just above the ~128-attempt floor so Sandglass blocks mine in a few
// seconds yet the anchor is still harder than the floor (no clamp interference).
// vi.hoisted so the value is available inside the (also-hoisted) vi.mock factory.
const { TEST_FORK_HEIGHT } = vi.hoisted(() => ({ TEST_FORK_HEIGHT: 3 }));
vi.mock('./genesis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./genesis.js')>();
  return {
    ...actual,
    SANDGLASS_FORK_HEIGHT: TEST_FORK_HEIGHT,
    SANDGLASS_ANCHOR_ATTEMPTS: 256,
    SANDGLASS_ANCHOR_TIMESTAMP: actual.GENESIS_TIMESTAMP + TEST_FORK_HEIGHT * actual.TARGET_BLOCK_TIME_S,
  };
});

import { Blockchain } from './blockchain.js';
import { emptyMine } from './testutil.js';
import { generateKeyPair } from '../crypto/keys.js';
import { SANDGLASS_ANCHOR_DIFFICULTY_COMPACT } from './consensus.js';
import { powHash } from '../crypto/pow.js';
import { sandglassHash } from '../crypto/sandglass.js';
import { encodeHeader, hashHeader, type Block } from './block.js';
import { bytesToHex } from '../util/binary.js';
import { SANDGLASS_FORK_HEIGHT } from './genesis.js';

/** Did the block's PoW actually verify under Sandglass (vs Argon2id)? */
async function verifiedBySandglass(b: Block): Promise<boolean> {
  const bytes = encodeHeader(b.header);
  return bytesToHex(await powHash(bytes)) === bytesToHex(sandglassHash(bytes));
}

describe('fork #2 — end-to-end across the Argon2id → Sandglass boundary', () => {
  it('mines a mixed chain, resets difficulty at the fork, and a fresh node re-validates it', async () => {
    expect(SANDGLASS_FORK_HEIGHT).toBe(TEST_FORK_HEIGHT); // mock is live

    const miner = generateKeyPair();
    const chain = new Blockchain();
    const blocks: Block[] = [];
    const TOTAL = 5; // heights 1..5; fork at height 3

    for (let h = 1; h <= TOTAL; h++) {
      const b = await emptyMine(chain, miner.publicKey);
      const err = await chain.addBlock(b);
      expect(err, `addBlock at height ${h}`).toBeNull();
      blocks.push(b);

      const expectSandglass = b.header.height >= SANDGLASS_FORK_HEIGHT;
      expect(await verifiedBySandglass(b), `algo at height ${b.header.height}`).toBe(expectSandglass);
      // eslint-disable-next-line no-console
      console.log(
        `  height ${b.header.height}: ${expectSandglass ? 'Sandglass' : 'Argon2id '} ` +
          `difficulty=0x${b.header.difficulty.toString(16)}`,
      );
    }

    expect(chain.height).toBe(TOTAL);

    // Difficulty resets to the Sandglass anchor at the fork block and holds
    // (on-pace mining → ASERT deviation 0) for the blocks after it.
    for (let h = SANDGLASS_FORK_HEIGHT; h <= TOTAL; h++) {
      expect(blocks[h - 1]!.header.difficulty, `sandglass difficulty at height ${h}`).toBe(
        SANDGLASS_ANCHOR_DIFFICULTY_COMPACT,
      );
    }
    // Pre-fork blocks used a different (Argon2id-era) difficulty.
    expect(blocks[0]!.header.difficulty).not.toBe(SANDGLASS_ANCHOR_DIFFICULTY_COMPACT);

    // A second, fresh node validates the whole mixed chain in order — this is
    // the "another node syncs across the fork" check.
    const node2 = new Blockchain();
    for (const b of blocks) {
      const err = await node2.addBlock(b);
      expect(err, `node2 addBlock at height ${b.header.height}`).toBeNull();
    }
    expect(node2.height).toBe(TOTAL);
    expect(bytesToHex(hashHeader(node2.tip.block.header))).toBe(bytesToHex(hashHeader(chain.tip.block.header)));
    // eslint-disable-next-line no-console
    console.log(`  ✓ fresh node re-validated all ${TOTAL} blocks across the fork`);
  }, 180_000);
});
