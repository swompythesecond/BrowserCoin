import { describe, it, expect } from 'vitest';
import { powHash } from '../crypto/pow.js';
import { sandglassHash } from '../crypto/sandglass.js';
import { nextDifficulty, SANDGLASS_ANCHOR_DIFFICULTY_COMPACT } from './consensus.js';
import { encodeHeader, type BlockHeader } from './block.js';
import {
  SANDGLASS_FORK_HEIGHT,
  SANDGLASS_ANCHOR_TIMESTAMP,
  TARGET_BLOCK_TIME_S,
} from './genesis.js';
import { bytesToHex, compactToTarget } from '../util/binary.js';

function hdr(over: Partial<BlockHeader>): BlockHeader {
  return {
    height: 1,
    prevHash: new Uint8Array(32).fill(1),
    txRoot: new Uint8Array(32).fill(2),
    stateRoot: new Uint8Array(32).fill(3),
    timestamp: SANDGLASS_ANCHOR_TIMESTAMP,
    difficulty: 0x20020000,
    nonce: 0,
    miner: new Uint8Array(32).fill(4),
    ...over,
  };
}

describe('fork #2 — PoW algorithm gating (by height)', () => {
  it('uses Sandglass for the fork block and beyond', async () => {
    for (const height of [SANDGLASS_FORK_HEIGHT, SANDGLASS_FORK_HEIGHT + 1, SANDGLASS_FORK_HEIGHT + 5000]) {
      const bytes = encodeHeader(hdr({ height }));
      expect(bytesToHex(await powHash(bytes))).toBe(bytesToHex(sandglassHash(bytes)));
    }
  });

  it('uses Argon2id (not Sandglass) below the fork height', async () => {
    const bytes = encodeHeader(hdr({ height: SANDGLASS_FORK_HEIGHT - 1 }));
    // The Argon2id path must produce a different digest than Sandglass would,
    // proving the branch selected the old algorithm for pre-fork history.
    expect(bytesToHex(await powHash(bytes))).not.toBe(bytesToHex(sandglassHash(bytes)));
  });
});

describe('fork #2 — difficulty reset and re-anchor', () => {
  it('resets to the Sandglass anchor difficulty at the fork block', () => {
    const parent = hdr({ height: SANDGLASS_FORK_HEIGHT - 1, timestamp: SANDGLASS_ANCHOR_TIMESTAMP });
    expect(nextDifficulty(SANDGLASS_FORK_HEIGHT, [parent], SANDGLASS_ANCHOR_TIMESTAMP)).toBe(
      SANDGLASS_ANCHOR_DIFFICULTY_COMPACT,
    );
  });

  it('holds the anchor difficulty when post-fork blocks are on pace', () => {
    // Parent 10 blocks past the fork, exactly on the 150 s schedule from the
    // anchor → ASERT deviation 0 → difficulty unchanged from the anchor.
    const onPaceParent = hdr({
      height: SANDGLASS_FORK_HEIGHT + 10,
      timestamp: SANDGLASS_ANCHOR_TIMESTAMP + 10 * TARGET_BLOCK_TIME_S,
      difficulty: SANDGLASS_ANCHOR_DIFFICULTY_COMPACT,
    });
    const d = nextDifficulty(
      SANDGLASS_FORK_HEIGHT + 11,
      [onPaceParent],
      SANDGLASS_ANCHOR_TIMESTAMP + 11 * TARGET_BLOCK_TIME_S,
    );
    expect(d).toBe(SANDGLASS_ANCHOR_DIFFICULTY_COMPACT);
  });

  it('eases difficulty (raises target) when post-fork blocks run slow', () => {
    // Parent well behind schedule → ASERT should make the next target EASIER
    // (larger) than the anchor.
    const slowParent = hdr({
      height: SANDGLASS_FORK_HEIGHT + 10,
      timestamp: SANDGLASS_ANCHOR_TIMESTAMP + 10 * TARGET_BLOCK_TIME_S + 4 * 3600, // 4h behind
      difficulty: SANDGLASS_ANCHOR_DIFFICULTY_COMPACT,
    });
    const d = nextDifficulty(SANDGLASS_FORK_HEIGHT + 11, [slowParent], slowParent.timestamp + TARGET_BLOCK_TIME_S);
    expect(compactToTarget(d)).toBeGreaterThan(compactToTarget(SANDGLASS_ANCHOR_DIFFICULTY_COMPACT));
  });

  it('tightens difficulty (lowers target) when post-fork blocks run fast', () => {
    const fastParent = hdr({
      height: SANDGLASS_FORK_HEIGHT + 100,
      timestamp: SANDGLASS_ANCHOR_TIMESTAMP + 100 * TARGET_BLOCK_TIME_S - 3 * 3600, // 3h ahead
      difficulty: SANDGLASS_ANCHOR_DIFFICULTY_COMPACT,
    });
    const d = nextDifficulty(SANDGLASS_FORK_HEIGHT + 101, [fastParent], fastParent.timestamp + 1);
    expect(compactToTarget(d)).toBeLessThan(compactToTarget(SANDGLASS_ANCHOR_DIFFICULTY_COMPACT));
  });

  it('CLAMPS post-fork difficulty within 4x of the reset during the settling window', () => {
    const anchorTarget = compactToTarget(SANDGLASS_ANCHOR_DIFFICULTY_COMPACT);
    // Extreme EARLY arrival (would explode difficulty → chain stall without the
    // clamp): parent far ahead of the anchor schedule, still inside the window.
    const wayAheadParent = hdr({
      height: SANDGLASS_FORK_HEIGHT + 5,
      timestamp: SANDGLASS_ANCHOR_TIMESTAMP - 24 * 3600, // arrived a full day EARLY
      difficulty: SANDGLASS_ANCHOR_DIFFICULTY_COMPACT,
    });
    const dHard = nextDifficulty(SANDGLASS_FORK_HEIGHT + 6, [wayAheadParent], SANDGLASS_ANCHOR_TIMESTAMP - 24 * 3600 + 1);
    // Capped near 4× reset — NOT exploded to a near-zero (unmineable) target.
    // (compactToTarget round-trips lose a few low bits, so allow a wide band.)
    expect(compactToTarget(dHard)).toBeGreaterThan(anchorTarget / 8n); // far above exploded
    expect(compactToTarget(dHard)).toBeLessThan(anchorTarget); // still harder than reset

    // Extreme LATE arrival (would slam to floor → instant-block storm): parent far
    // behind the anchor schedule, still inside the window.
    const wayBehindParent = hdr({
      height: SANDGLASS_FORK_HEIGHT + 5,
      timestamp: SANDGLASS_ANCHOR_TIMESTAMP + 24 * 3600,
      difficulty: SANDGLASS_ANCHOR_DIFFICULTY_COMPACT,
    });
    const dEasy = nextDifficulty(SANDGLASS_FORK_HEIGHT + 6, [wayBehindParent], SANDGLASS_ANCHOR_TIMESTAMP + 24 * 3600 + TARGET_BLOCK_TIME_S);
    // Capped near reset/4 — NOT collapsed to the floor (instant-block storm).
    expect(compactToTarget(dEasy)).toBeLessThan(anchorTarget * 8n); // far below floor
    expect(compactToTarget(dEasy)).toBeGreaterThan(anchorTarget); // still easier than reset
  });
});
