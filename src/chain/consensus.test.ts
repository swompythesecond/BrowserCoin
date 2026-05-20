import { describe, expect, it } from 'vitest';
import { nextDifficulty, blockWork } from './consensus.js';
import {
  DIFFICULTY_WINDOW,
  GENESIS_DIFFICULTY_COMPACT,
  TARGET_BLOCK_TIME_S,
} from './genesis.js';
import type { BlockHeader } from './block.js';
import { compactToTarget, targetToCompact } from '../util/binary.js';

function fakeHeader(height: number, timestamp: number, difficulty: number): BlockHeader {
  return {
    height,
    prevHash: new Uint8Array(32),
    txRoot: new Uint8Array(32),
    stateRoot: new Uint8Array(32),
    timestamp,
    difficulty,
    nonce: 0,
    miner: new Uint8Array(32),
  };
}

describe('difficulty (per-block sliding window)', () => {
  it('keeps difficulty unchanged when blocks land exactly at target', () => {
    const headers: BlockHeader[] = [];
    for (let i = 0; i <= 100; i++) headers.push(fakeHeader(i, 1_000 + i * 150, GENESIS_DIFFICULTY_COMPACT));
    const next = nextDifficulty(101, headers);
    // Window had perfectly-paced blocks → ratio = 1 → target unchanged.
    expect(next).toBe(GENESIS_DIFFICULTY_COMPACT);
  });

  it('makes difficulty harder (smaller target) when blocks are too fast', () => {
    const window = DIFFICULTY_WINDOW;
    const headers: BlockHeader[] = [];
    for (let i = 0; i < window; i++) {
      // Blocks arrive at half the target rate — chain wants to slow miners down.
      headers.push(fakeHeader(i, 1_000 + i * (TARGET_BLOCK_TIME_S / 2), GENESIS_DIFFICULTY_COMPACT));
    }
    const next = nextDifficulty(window, headers);
    const oldTarget = compactToTarget(GENESIS_DIFFICULTY_COMPACT);
    const newTarget = compactToTarget(next);
    expect(newTarget).toBeLessThan(oldTarget);
  });

  it('makes difficulty easier (larger target) when blocks are too slow', () => {
    const window = DIFFICULTY_WINDOW;
    const headers: BlockHeader[] = [];
    for (let i = 0; i < window; i++) {
      // Blocks arrive at half speed — chain wants to make it easier.
      headers.push(fakeHeader(i, 1_000 + i * TARGET_BLOCK_TIME_S * 2, GENESIS_DIFFICULTY_COMPACT));
    }
    const next = nextDifficulty(window, headers);
    const oldTarget = compactToTarget(GENESIS_DIFFICULTY_COMPACT);
    const newTarget = compactToTarget(next);
    expect(newTarget).toBeGreaterThan(oldTarget);
  });

  it('clamps retarget to ±4x even under extreme timestamps', () => {
    const window = DIFFICULTY_WINDOW;
    const headers: BlockHeader[] = [];
    for (let i = 0; i < window; i++) {
      // 100x faster than expected — should clamp to 4x harder.
      headers.push(fakeHeader(i, 1_000 + i, GENESIS_DIFFICULTY_COMPACT));
    }
    const next = nextDifficulty(window, headers);
    const oldTarget = compactToTarget(GENESIS_DIFFICULTY_COMPACT);
    const newTarget = compactToTarget(next);
    // newTarget should be >= oldTarget / 4 (i.e. not made impossibly hard).
    expect(newTarget * 5n).toBeGreaterThan(oldTarget);
  });

  it('first retarget does NOT make difficulty easier because of stale genesis timestamp', () => {
    // Regression: genesis has a hardcoded 2023 timestamp so the chain is
    // reproducible. If the retarget formula naively measures the elapsed-time
    // span between genesis and the latest block, the apparent "actual span"
    // is years even when blocks were mined milliseconds apart — and the
    // formula incorrectly concludes the chain is *too slow* and lowers
    // difficulty. The fix is to skip genesis when it lands in the window.
    const window = DIFFICULTY_WINDOW;
    const headers: BlockHeader[] = [];
    // Genesis with hardcoded past timestamp.
    headers.push(fakeHeader(0, 1_700_000_000, GENESIS_DIFFICULTY_COMPACT));
    // Subsequent blocks mined "now" (2026-ish) at sub-second intervals.
    const now = 1_779_000_000;
    for (let i = 1; i < window; i++) {
      headers.push(fakeHeader(i, now + i, GENESIS_DIFFICULTY_COMPACT));
    }
    const next = nextDifficulty(window, headers);
    const oldTarget = compactToTarget(GENESIS_DIFFICULTY_COMPACT);
    const newTarget = compactToTarget(next);
    // Blocks came every ~1 sec but target is 150 sec → difficulty MUST get HARDER.
    expect(newTarget).toBeLessThan(oldTarget);
  });

  it('retargets every block, not only at boundaries', () => {
    // Build 5 normally-spaced blocks, then ask difficulty for the 6th — the
    // adjustment should still fire even though height 6 isn't a 20-block
    // boundary. This is the per-block-vs-batch distinction.
    const headers: BlockHeader[] = [];
    headers.push(fakeHeader(0, 1_700_000_000, GENESIS_DIFFICULTY_COMPACT)); // genesis
    // 5 mined blocks, each 1 sec apart (way too fast).
    const start = 1_779_000_000;
    for (let i = 1; i <= 5; i++) headers.push(fakeHeader(i, start + i, GENESIS_DIFFICULTY_COMPACT));
    const next = nextDifficulty(6, headers);
    // Old "boundary every 20" rule would return GENESIS_DIFFICULTY at height 6.
    // Per-block rule must adjust — and since blocks were way too fast, it must harden.
    const oldTarget = compactToTarget(GENESIS_DIFFICULTY_COMPACT);
    const newTarget = compactToTarget(next);
    expect(newTarget).toBeLessThan(oldTarget);
  });

  it('holds difficulty for the first two mined blocks (not enough data)', () => {
    // Chain with genesis + 1 mined block — only one real timestamp, can't
    // measure a delta. Must return previous difficulty unchanged.
    const headers: BlockHeader[] = [
      fakeHeader(0, 1_700_000_000, GENESIS_DIFFICULTY_COMPACT),
      fakeHeader(1, 1_779_000_000, GENESIS_DIFFICULTY_COMPACT),
    ];
    const next = nextDifficulty(2, headers);
    expect(next).toBe(GENESIS_DIFFICULTY_COMPACT);
  });

  it('block work goes up as target shrinks', () => {
    const easy = blockWork(GENESIS_DIFFICULTY_COMPACT);
    const hardCompact = targetToCompact(compactToTarget(GENESIS_DIFFICULTY_COMPACT) / 4n);
    const hard = blockWork(hardCompact);
    expect(hard).toBeGreaterThan(easy);
  });
});
