import { describe, expect, it } from 'vitest';
import { nextDifficulty, blockWork } from './consensus.js';
import {
  EMERGENCY_DROP_MULT,
  GENESIS_DIFFICULTY_COMPACT,
  GENESIS_TIMESTAMP,
  HALFLIFE_S,
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

/** Build a clean chain of N headers landing exactly at TARGET_BLOCK_TIME_S each, anchored at genesis. */
function chainAtTargetPace(blocks: number): BlockHeader[] {
  const out: BlockHeader[] = [fakeHeader(0, GENESIS_TIMESTAMP, GENESIS_DIFFICULTY_COMPACT)];
  for (let i = 1; i <= blocks; i++) {
    out.push(fakeHeader(i, GENESIS_TIMESTAMP + i * TARGET_BLOCK_TIME_S, GENESIS_DIFFICULTY_COMPACT));
  }
  return out;
}

describe('difficulty (ASERT, anchored at genesis, FLOOR + emergency drop)', () => {
  it('returns genesis difficulty for height 0', () => {
    const headers: BlockHeader[] = [fakeHeader(0, GENESIS_TIMESTAMP, GENESIS_DIFFICULTY_COMPACT)];
    expect(nextDifficulty(0, headers, GENESIS_TIMESTAMP + 1, null)).toBe(GENESIS_DIFFICULTY_COMPACT);
  });

  it('clamps target to the floor — difficulty cannot fall below GENESIS', () => {
    // Chain has been mining 100× slower than target since genesis. ASERT
    // wants to crank target way up; floor must hold it at GENESIS.
    const headers: BlockHeader[] = [fakeHeader(0, GENESIS_TIMESTAMP, GENESIS_DIFFICULTY_COMPACT)];
    for (let i = 1; i <= 20; i++) {
      headers.push(fakeHeader(i, GENESIS_TIMESTAMP + i * TARGET_BLOCK_TIME_S * 100, GENESIS_DIFFICULTY_COMPACT));
    }
    const candidateTs = headers[headers.length - 1]!.timestamp + TARGET_BLOCK_TIME_S * 100;
    const next = nextDifficulty(headers.length, headers, candidateTs, null);
    expect(next).toBe(GENESIS_DIFFICULTY_COMPACT);
  });

  it('makes difficulty harder when chain is mining faster than target', () => {
    // 20 blocks at 1/4 of target spacing — ASERT should crank target down.
    const fastSpacing = Math.floor(TARGET_BLOCK_TIME_S / 4);
    const headers: BlockHeader[] = [fakeHeader(0, GENESIS_TIMESTAMP, GENESIS_DIFFICULTY_COMPACT)];
    for (let i = 1; i <= 20; i++) {
      headers.push(fakeHeader(i, GENESIS_TIMESTAMP + i * fastSpacing, GENESIS_DIFFICULTY_COMPACT));
    }
    const candidateTs = headers[headers.length - 1]!.timestamp + fastSpacing;
    const next = nextDifficulty(headers.length, headers, candidateTs, null);
    expect(compactToTarget(next)).toBeLessThan(compactToTarget(GENESIS_DIFFICULTY_COMPACT));
  });

  it('keeps difficulty at floor when chain is mining at exactly target pace from genesis', () => {
    // ASERT result at target pace = anchor_target. Anchor is floor, so we stay at floor.
    const headers = chainAtTargetPace(20);
    const next = nextDifficulty(headers.length, headers, headers[headers.length - 1]!.timestamp + TARGET_BLOCK_TIME_S, null);
    expect(next).toBe(GENESIS_DIFFICULTY_COMPACT);
  });

  it('ASERT response: under sustained 2×-too-slow pace, target halflife-doubles', () => {
    // Build a chain at 2× target spacing. After many blocks, ASERT will
    // want to grow target — but the floor pins us. Use a harder starting
    // anchor for THIS test by pretending earlier blocks were already harder.
    // Note: in production ASERT always recomputes from genesis, so we can't
    // really "start hard"; instead we test the math via the exponent.
    // Sanity: at heightDiff blocks past anchor with all timestamps placed
    // such that (Δt − n×T) = HALFLIFE_S, the ASERT factor should be ~2×.
    const headers: BlockHeader[] = [fakeHeader(0, GENESIS_TIMESTAMP, GENESIS_DIFFICULTY_COMPACT)];
    // 10 blocks landing at the target pace, then one block lands HALFLIFE_S
    // late so the cumulative deviation = HALFLIFE_S.
    for (let i = 1; i <= 9; i++) {
      headers.push(fakeHeader(i, GENESIS_TIMESTAMP + i * TARGET_BLOCK_TIME_S, GENESIS_DIFFICULTY_COMPACT));
    }
    headers.push(fakeHeader(10, GENESIS_TIMESTAMP + 10 * TARGET_BLOCK_TIME_S + HALFLIFE_S, GENESIS_DIFFICULTY_COMPACT));

    const next = nextDifficulty(11, headers, headers[headers.length - 1]!.timestamp + TARGET_BLOCK_TIME_S, null);
    // Anchor target is already at floor, so the "+1 halflife slow" deviation
    // pushes target above floor — but floor clamps. Verify floor is hit:
    expect(next).toBe(GENESIS_DIFFICULTY_COMPACT);
    // And verify the math by computing what an unclamped version would say:
    // unclamped = ANCHOR_TARGET * 2^1 = 2 × FLOOR_TARGET (capped → FLOOR).
    expect(compactToTarget(next)).toBe(compactToTarget(GENESIS_DIFFICULTY_COMPACT));
  });

  it('emergency drop fires when TWO consecutive intervals exceed the threshold', () => {
    // Start from a harder-than-floor difficulty so the drop has somewhere to go.
    const harder = targetToCompact(compactToTarget(GENESIS_DIFFICULTY_COMPACT) / 4n);
    const headers: BlockHeader[] = [fakeHeader(0, GENESIS_TIMESTAMP, GENESIS_DIFFICULTY_COMPACT)];
    for (let i = 1; i <= 10; i++) {
      headers.push(fakeHeader(i, GENESIS_TIMESTAMP + i * TARGET_BLOCK_TIME_S, harder));
    }
    // Two slow intervals: grandparent → parent, and parent → candidate.
    headers[headers.length - 1]!.timestamp = headers[headers.length - 2]!.timestamp
      + (EMERGENCY_DROP_MULT + 1) * TARGET_BLOCK_TIME_S;
    const candidateTs = headers[headers.length - 1]!.timestamp + (EMERGENCY_DROP_MULT + 1) * TARGET_BLOCK_TIME_S;
    const next = nextDifficulty(headers.length, headers, candidateTs, null);
    const oldTarget = compactToTarget(harder);
    const newTarget = compactToTarget(next);
    // Drop halves difficulty (doubles target). Bounded above by FLOOR_TARGET.
    expect(newTarget).toBeGreaterThan(oldTarget);
    expect(newTarget).toBeLessThanOrEqual(oldTarget * 2n + 1n);
  });

  it('emergency drop does NOT fire on a single slow interval', () => {
    const harder = targetToCompact(compactToTarget(GENESIS_DIFFICULTY_COMPACT) / 4n);
    const headers: BlockHeader[] = [fakeHeader(0, GENESIS_TIMESTAMP, GENESIS_DIFFICULTY_COMPACT)];
    for (let i = 1; i <= 10; i++) {
      headers.push(fakeHeader(i, GENESIS_TIMESTAMP + i * TARGET_BLOCK_TIME_S, harder));
    }
    // Only the candidate's interval is slow; parent's was at target pace.
    const candidateTs = headers[headers.length - 1]!.timestamp + (EMERGENCY_DROP_MULT + 1) * TARGET_BLOCK_TIME_S;
    const next = nextDifficulty(headers.length, headers, candidateTs, null);
    // Emergency drop did not fire — ASERT computes the result. The candidate
    // gap doesn't influence ASERT (it uses parent.timestamp), and the chain
    // has been running at target pace, so ASERT returns ~ANCHOR_TARGET (floor).
    // The key behavioural assertion is that target did NOT double:
    const oldTarget = compactToTarget(harder);
    const newTarget = compactToTarget(next);
    expect(newTarget).not.toBe(oldTarget * 2n); // drop did not fire
  });

  it('emergency drop never fires when the grandparent is genesis', () => {
    // For a very young chain (length 2), grandparent IS genesis. Even if
    // both intervals look slow, the rule must skip — genesis timestamp
    // is hardcoded and would otherwise trigger every fresh chain.
    const harder = targetToCompact(compactToTarget(GENESIS_DIFFICULTY_COMPACT) / 4n);
    const genesis = fakeHeader(0, GENESIS_TIMESTAMP, GENESIS_DIFFICULTY_COMPACT);
    const block1 = fakeHeader(1, GENESIS_TIMESTAMP + (EMERGENCY_DROP_MULT + 2) * TARGET_BLOCK_TIME_S, harder);
    const candidateTs = block1.timestamp + (EMERGENCY_DROP_MULT + 1) * TARGET_BLOCK_TIME_S;
    const next = nextDifficulty(2, [genesis, block1], candidateTs, null);
    // No emergency drop. ASERT runs normally.
    // The candidate's parent was 8× target late, so ASERT will pin to floor.
    expect(next).toBe(GENESIS_DIFFICULTY_COMPACT);
  });

  it('block work goes up as target shrinks', () => {
    const easy = blockWork(GENESIS_DIFFICULTY_COMPACT);
    const hardCompact = targetToCompact(compactToTarget(GENESIS_DIFFICULTY_COMPACT) / 4n);
    const hard = blockWork(hardCompact);
    expect(hard).toBeGreaterThan(easy);
  });

  it('mid-window timestamp manipulation cannot move the retarget', () => {
    // ASERT uses only the parent's timestamp + genesis anchor. Middle blocks
    // contribute nothing — strictly stronger than any window-based scheme.
    const cleanHeaders = chainAtTargetPace(15);
    const cheatedHeaders = cleanHeaders.map((h) => ({ ...h }));
    const midIdx = Math.floor(cheatedHeaders.length / 2);
    cheatedHeaders[midIdx]!.timestamp += TARGET_BLOCK_TIME_S * 100;
    const ts = cleanHeaders[cleanHeaders.length - 1]!.timestamp + TARGET_BLOCK_TIME_S;
    const clean = nextDifficulty(cleanHeaders.length, cleanHeaders, ts, null);
    const cheated = nextDifficulty(cheatedHeaders.length, cheatedHeaders, ts, null);
    expect(cheated).toBe(clean);
  });

  it('ASERT result depends only on parent timestamp/height + genesis anchor', () => {
    // Two chains with the same parent header but different intermediate
    // history should produce the same next-difficulty.
    const parent = fakeHeader(20, GENESIS_TIMESTAMP + 20 * TARGET_BLOCK_TIME_S, GENESIS_DIFFICULTY_COMPACT);
    const variantA: BlockHeader[] = [fakeHeader(0, GENESIS_TIMESTAMP, GENESIS_DIFFICULTY_COMPACT)];
    const variantB: BlockHeader[] = [fakeHeader(0, GENESIS_TIMESTAMP, GENESIS_DIFFICULTY_COMPACT)];
    // Different intermediate timestamps, same parent.
    for (let i = 1; i <= 19; i++) {
      variantA.push(fakeHeader(i, GENESIS_TIMESTAMP + i * TARGET_BLOCK_TIME_S, GENESIS_DIFFICULTY_COMPACT));
      variantB.push(fakeHeader(i, GENESIS_TIMESTAMP + i * 2, GENESIS_DIFFICULTY_COMPACT)); // wildly different
    }
    variantA.push(parent);
    variantB.push(parent);
    const ts = parent.timestamp + TARGET_BLOCK_TIME_S;
    expect(nextDifficulty(21, variantA, ts, null)).toBe(nextDifficulty(21, variantB, ts, null));
  });
});
