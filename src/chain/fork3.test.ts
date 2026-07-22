import { describe, it, expect } from 'vitest';
import { nextDifficulty } from './consensus.js';
import { type BlockHeader } from './block.js';
import {
  HALFLIFE_S,
  SANDGLASS2_ANCHOR_HEIGHT,
  SANDGLASS_ANCHOR_ATTEMPTS,
  SANDGLASS_ANCHOR_CLAMP_BLOCKS,
  SANDGLASS_FORK_HEIGHT,
  TARGET_BLOCK_TIME_S,
} from './genesis.js';
import { compactToTarget, targetToCompact } from '../util/binary.js';

/** What the live chain is actually pinned at post-fork-#2: 20M attempts/block.
 *  Meaningfully harder than the genesis floor, so difficulty has room to move
 *  in BOTH directions — a floor-level anchor would mask the downward case. */
const LIVE_DIFFICULTY = targetToCompact((1n << 256n) / 20_000_000n);

/** Arbitrary "real" mined time for the anchor block — the point is that no
 *  constant anywhere has to predict it. Deliberately NOT on the fork-#2
 *  schedule, and deliberately not a round number. */
const ANCHOR_TIME = 1_784_800_123;

function hdr(over: Partial<BlockHeader>): BlockHeader {
  return {
    height: SANDGLASS2_ANCHOR_HEIGHT,
    prevHash: new Uint8Array(32).fill(1),
    txRoot: new Uint8Array(32).fill(2),
    stateRoot: new Uint8Array(32).fill(3),
    timestamp: ANCHOR_TIME,
    difficulty: LIVE_DIFFICULTY,
    nonce: 0,
    miner: new Uint8Array(32).fill(4),
    ...over,
  };
}

const anchor = hdr({ height: SANDGLASS2_ANCHOR_HEIGHT, timestamp: ANCHOR_TIME });

/** Attempts/block implied by a compact difficulty (chain-work per block). */
function attempts(compact: number): number {
  return Number((1n << 256n) / (compactToTarget(compact) + 1n));
}

// Both come off the anchor block itself. Fork #3 introduces no difficulty
// constant at all — the chain already knows what it was mining at.
const ANCHOR_DIFFICULTY = anchor.difficulty;
const ANCHOR_ATTEMPTS = attempts(ANCHOR_DIFFICULTY);

/**
 * Walk `count` blocks past the anchor at a fixed inter-block gap, retargeting
 * each block, and return the difficulty the next block would carry. This is the
 * whole point of the fix: the loop feeds real timestamps back in, exactly as a
 * live chain does.
 */
function runAtPace(gapSeconds: number, count: number): number {
  let prev = anchor;
  let difficulty = ANCHOR_DIFFICULTY;
  for (let i = 1; i <= count; i++) {
    const height = SANDGLASS2_ANCHOR_HEIGHT + i;
    difficulty = nextDifficulty(height, [prev], prev.timestamp + gapSeconds, anchor);
    prev = hdr({ height, timestamp: prev.timestamp + gapSeconds, difficulty });
  }
  return difficulty;
}

describe('fork #3 — anchoring on the real block instead of a guess', () => {
  it('carries the anchor block difficulty over unchanged, whenever it mined', () => {
    // The defining property. Both anchor inputs are read from the chain, so the
    // ASERT drift term at the first block above the anchor is 0 by construction
    // and difficulty simply continues — there is no estimate that could be
    // "off". Fork #2 got this wrong by hardcoding a predicted timestamp; here the
    // assertion holds for an anchor mined at any time, at any difficulty.
    for (const t of [ANCHOR_TIME, ANCHOR_TIME - 86_400, ANCHOR_TIME + 3 * 86_400]) {
      // Every value here must be a CANONICAL compact encoding. The carry-over
      // identity is target->compact->target, which is only lossless for compacts
      // targetToCompact can itself emit (0x1e007fff, for instance, round-trips
      // to 0x1d7fff00). Real anchors always are canonical — block 35,550's
      // difficulty is produced by targetToCompact in this very file — but the
      // dependency is worth stating, so assert it rather than assuming it.
      for (const d of [LIVE_DIFFICULTY, 0x1e00ffff, 0x1d00abcd]) {
        expect(targetToCompact(compactToTarget(d)), `0x${d.toString(16)} is canonical`).toBe(d);
        const a = hdr({ height: SANDGLASS2_ANCHOR_HEIGHT, timestamp: t, difficulty: d });
        expect(nextDifficulty(SANDGLASS2_ANCHOR_HEIGHT + 1, [a], t + 60, a)).toBe(d);
      }
    }
  });

  it('leaves every block at or below the anchor height on the old rules', () => {
    // Byte-for-byte identical consensus below the boundary is what makes this
    // deployable without a split: the old chain halts here on its own.
    // Fork-#2 heights still hit the fork-#2 clamp ceiling (4x the fork-#2 reset)
    // when far ahead of schedule — including the anchor height itself.
    // Give the parent a difficulty the fork-#2 rules would NOT produce here, so
    // the two code paths give provably different answers: fork #3 would carry
    // this value over unchanged, fork #2 must clamp to its own ceiling.
    const floorish = 0x20020000;
    const wayAhead = hdr({
      height: SANDGLASS2_ANCHOR_HEIGHT - 1,
      timestamp: ANCHOR_TIME,
      difficulty: floorish,
    });
    const d = nextDifficulty(SANDGLASS2_ANCHOR_HEIGHT, [wayAhead], ANCHOR_TIME + 60, anchor);
    expect(d).not.toBe(floorish);
    // It is the fork-#2 clamp ceiling: 4x the fork-#2 reset difficulty.
    expect(attempts(d) / (SANDGLASS_ANCHOR_ATTEMPTS * 4)).toBeCloseTo(1, 2);
    // Which is only reachable because the anchor height is still inside the old
    // clamp window — i.e. the last block the old rules can produce.
    expect(SANDGLASS2_ANCHOR_HEIGHT).toBeLessThanOrEqual(
      SANDGLASS_FORK_HEIGHT + SANDGLASS_ANCHOR_CLAMP_BLOCKS,
    );
  });

  it('refuses to retarget without the anchor rather than guessing one', () => {
    // A silently-wrong difficulty is the failure mode that produced this fork.
    expect(() =>
      nextDifficulty(SANDGLASS2_ANCHOR_HEIGHT + 500, [hdr({ height: SANDGLASS2_ANCHOR_HEIGHT + 499 })], ANCHOR_TIME, null),
    ).toThrow(/anchor header/);
  });

  it('rejects an anchor at the wrong height instead of searching for one', () => {
    // There is deliberately no lookback-window fallback: it would have rescued a
    // wrong-variable call site for exactly RETARGET_LOOKBACK blocks and then
    // failed on every node at once, and the two consensus paths pass different
    // window sizes, so it could partition full nodes from fast-syncing tabs.
    const wrong = hdr({ height: SANDGLASS2_ANCHOR_HEIGHT - 1, timestamp: ANCHOR_TIME });
    const prev = hdr({ height: SANDGLASS2_ANCHOR_HEIGHT + 1, timestamp: ANCHOR_TIME + TARGET_BLOCK_TIME_S });
    expect(() =>
      nextDifficulty(SANDGLASS2_ANCHOR_HEIGHT + 2, [anchor, prev], prev.timestamp + 60, wrong),
    ).toThrow(/anchor header/);
  });

  it('does not let the lookback window size change the answer', () => {
    // previousHeaders is for the emergency-drop grandparent lookup only. Block
    // validation passes 60 headers, fast sync passes MTP_WINDOW — if length ever
    // affected the result those two paths would diverge on the same chain.
    const prev = hdr({ height: SANDGLASS2_ANCHOR_HEIGHT + 1, timestamp: ANCHOR_TIME + TARGET_BLOCK_TIME_S });
    const short = nextDifficulty(SANDGLASS2_ANCHOR_HEIGHT + 2, [prev], prev.timestamp + 60, anchor);
    const long = nextDifficulty(SANDGLASS2_ANCHOR_HEIGHT + 2, [anchor, prev], prev.timestamp + 60, anchor);
    expect(short).toBe(long);
  });
});

describe('fork #3 — no ceiling', () => {
  it('lets difficulty climb far past the old 4x clamp when blocks run fast', () => {
    // The live failure: blocks at ~60s pinned against a 4x ceiling forever.
    // Unbounded ASERT must sail straight through it.
    const d = runAtPace(60, 200);
    const ratio = attempts(d) / ANCHOR_ATTEMPTS;
    expect(ratio).toBeGreaterThan(4);
  });

  it('is symmetric — difficulty falls when blocks run slow', () => {
    const d = runAtPace(600, 100);
    expect(attempts(d)).toBeLessThan(ANCHOR_ATTEMPTS);
  });

  it('has no cliff at the old clamp-expiry boundary', () => {
    // Fork #2's clamp expired at FORK_HEIGHT + CLAMP_BLOCKS and discharged every
    // second of accumulated drift in a single retarget. Run a live-like chain
    // (constant hashrate, difficulty feeding back into solve times) well past the
    // same relative offset: nothing may happen there, because there is no longer
    // any stored drift to discharge.
    const hashrate = (ANCHOR_ATTEMPTS * 10) / TARGET_BLOCK_TIME_S;
    let prev = anchor;
    let difficulty = ANCHOR_DIFFICULTY;
    const jumps: number[] = [];
    for (let i = 1; i <= SANDGLASS_ANCHOR_CLAMP_BLOCKS + 200; i++) {
      const height = SANDGLASS2_ANCHOR_HEIGHT + i;
      const ts = prev.timestamp + Math.max(1, Math.round(attempts(difficulty) / hashrate));
      const next = nextDifficulty(height, [prev], ts, anchor);
      const ratio = attempts(next) / attempts(difficulty);
      jumps.push(Math.max(ratio, 1 / ratio));
      difficulty = next;
      prev = hdr({ height, timestamp: ts, difficulty });
    }
    // A single block of drift can move target by at most one block-time worth
    // of halflife, and in steady state far less.
    expect(Math.max(...jumps)).toBeLessThan(1.2);
    // The old expiry offset is an ordinary block, indistinguishable from its
    // neighbours — this is the assertion fork #2 would have failed.
    const atExpiry = jumps[SANDGLASS_ANCHOR_CLAMP_BLOCKS - 1]!;
    expect(atExpiry).toBeLessThan(1.05);
  });
});

describe('fork #3 — convergence', () => {
  it('pulls block time back to target from a 10x-too-easy start', () => {
    // Reproduces the actual bug conditions: anchor set for far less hashrate
    // than the network has. Simulate a constant-hashrate network and let it run.
    const hashrate = ANCHOR_ATTEMPTS * 10 / TARGET_BLOCK_TIME_S; // H/s
    let prev = anchor;
    let difficulty = ANCHOR_DIFFICULTY;
    const gaps: number[] = [];
    for (let i = 1; i <= 400; i++) {
      const height = SANDGLASS2_ANCHOR_HEIGHT + i;
      // Expected solve time at this difficulty for a fixed hashrate.
      const gap = Math.max(1, Math.round(attempts(difficulty) / hashrate));
      gaps.push(gap);
      const ts = prev.timestamp + gap;
      difficulty = nextDifficulty(height, [prev], ts, anchor);
      prev = hdr({ height, timestamp: ts, difficulty });
    }
    const settled = gaps.slice(-100);
    const mean = settled.reduce((s, g) => s + g, 0) / settled.length;
    expect(mean).toBeGreaterThan(TARGET_BLOCK_TIME_S * 0.85);
    expect(mean).toBeLessThan(TARGET_BLOCK_TIME_S * 1.15);
  });

  it('recovers target pace within a few halflives of a 10x hashrate jump', () => {
    let prev = anchor;
    let difficulty = ANCHOR_DIFFICULTY;
    let hashrate = ANCHOR_ATTEMPTS / TARGET_BLOCK_TIME_S;
    const gaps: number[] = [];
    for (let i = 1; i <= 600; i++) {
      if (i === 200) hashrate *= 10; // the volatility case
      const height = SANDGLASS2_ANCHOR_HEIGHT + i;
      const gap = Math.max(1, Math.round(attempts(difficulty) / hashrate));
      gaps.push(gap);
      const ts = prev.timestamp + gap;
      difficulty = nextDifficulty(height, [prev], ts, anchor);
      prev = hdr({ height, timestamp: ts, difficulty });
    }
    const settled = gaps.slice(-100);
    const mean = settled.reduce((s, g) => s + g, 0) / settled.length;
    expect(mean).toBeGreaterThan(TARGET_BLOCK_TIME_S * 0.85);
    expect(mean).toBeLessThan(TARGET_BLOCK_TIME_S * 1.15);
    // And it got there fast — well inside a handful of halflives.
    const recoveryBlocks = gaps.slice(200).findIndex((g) => g > TARGET_BLOCK_TIME_S * 0.8);
    expect(recoveryBlocks).toBeGreaterThanOrEqual(0);
    expect(recoveryBlocks * TARGET_BLOCK_TIME_S).toBeLessThan(10 * HALFLIFE_S);
  });
});
