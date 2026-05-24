import { powHash } from '../crypto/pow.js';
import { compactToTarget, hashMeetsTarget, targetToCompact } from '../util/binary.js';
import { encodeHeader, type BlockHeader } from './block.js';
import {
  DIFFICULTY_WINDOW,
  EMERGENCY_DROP_MULT,
  GENESIS_DIFFICULTY_COMPACT,
  MAX_RETARGET_FACTOR_DOWN,
  MAX_RETARGET_FACTOR_UP,
  MAX_TARGET,
  MTP_WINDOW,
  TARGET_BLOCK_TIME_S,
} from './genesis.js';

/**
 * True if the header's PoW hash is below its claimed target.
 *
 * Uses memory-hard Argon2id (not the block-ID sha256). One verify costs
 * ~40–125 ms on a laptop — acceptable since blocks arrive every ~150 s.
 */
export async function checkPoW(header: BlockHeader): Promise<boolean> {
  const target = compactToTarget(header.difficulty);
  if (target <= 0n || target > MAX_TARGET) return false;
  const h = await powHash(encodeHeader(header));
  return hashMeetsTarget(h, target);
}

/**
 * Decide the difficulty (compact form) that the block at `nextHeight` should
 * use. Caller passes the candidate block's intended timestamp so the
 * emergency-drop rule can fire.
 *
 * Per-block retargeting with a sliding window. Defenses against hashrate
 * gaming and timestamp manipulation:
 *   1. The "actual span" is measured between two MEDIAN-TIME-PAST values —
 *      one at the window start and one at the window end — instead of raw
 *      header timestamps. A miner who lies on a single timestamp moves MTP
 *      by less than 1/11 of the lie.
 *   2. The retarget step is asymmetric: target may shrink by at most
 *      MAX_RETARGET_FACTOR_UP per block (difficulty rises slowly) but may
 *      grow by up to MAX_RETARGET_FACTOR_DOWN per block (difficulty falls
 *      quickly). An attacker who spikes hashrate can't pin difficulty high
 *      after they leave.
 *   3. Emergency drop: if the candidate's timestamp is more than
 *      EMERGENCY_DROP_MULT × target seconds past the parent's timestamp,
 *      the chain is treated as stalled and difficulty halves immediately.
 *
 * `previousHeaders` should contain the parent chain headers, sorted
 * ascending. The function reads up to DIFFICULTY_WINDOW + MTP_WINDOW − 1
 * of them.
 */
export function nextDifficulty(
  nextHeight: number,
  previousHeaders: BlockHeader[],
  candidateTimestamp?: number,
): number {
  if (nextHeight === 0) return GENESIS_DIFFICULTY_COMPACT;
  const prev = previousHeaders[previousHeaders.length - 1]!;
  const prevTarget = compactToTarget(prev.difficulty);

  // Emergency drop fires even before we have a full window. Useful at chain
  // bootstrap when hashrate is wildly underestimated.
  if (
    candidateTimestamp !== undefined &&
    candidateTimestamp - prev.timestamp > EMERGENCY_DROP_MULT * TARGET_BLOCK_TIME_S
  ) {
    let dropped = prevTarget * 2n;
    if (dropped > MAX_TARGET) dropped = MAX_TARGET;
    return targetToCompact(dropped);
  }

  // Need at least 2 *non-genesis* blocks to measure a real block-time delta.
  // Genesis has a hardcoded past timestamp so it never participates.
  if (previousHeaders.length < 3) return prev.difficulty;

  // Sliding window: last DIFFICULTY_WINDOW headers (after skipping genesis if
  // it would land at the window start).
  let lookback = Math.min(DIFFICULTY_WINDOW, previousHeaders.length);
  let firstIdx = previousHeaders.length - lookback;
  let first = previousHeaders[firstIdx]!;
  if (first.height === 0) {
    firstIdx += 1;
    lookback -= 1;
    first = previousHeaders[firstIdx]!;
  }

  const blockCount = Math.max(1, prev.height - first.height);
  const expectedSpan = TARGET_BLOCK_TIME_S * blockCount;

  // MTP at both ends of the window. The "...UpTo" helper takes the median of
  // up to MTP_WINDOW headers ending at and including a given index.
  const endMTP = mtpUpTo(previousHeaders, previousHeaders.length - 1);
  const startMTP = mtpUpTo(previousHeaders, firstIdx);
  const actualSpan = Math.max(1, endMTP - startMTP);

  // Clamp actualSpan so the resulting target moves at most:
  //   * by /MAX_RETARGET_FACTOR_UP when blocks are too fast (target shrinks)
  //   * by *MAX_RETARGET_FACTOR_DOWN when blocks are too slow (target grows)
  const minActual = Math.floor(expectedSpan / MAX_RETARGET_FACTOR_UP);
  const maxActual = expectedSpan * MAX_RETARGET_FACTOR_DOWN;
  const clampedActual = Math.max(minActual, Math.min(maxActual, actualSpan));

  let newTarget = (prevTarget * BigInt(clampedActual)) / BigInt(expectedSpan);
  if (newTarget > MAX_TARGET) newTarget = MAX_TARGET;
  if (newTarget < 1n) newTarget = 1n;
  return targetToCompact(newTarget);
}

/**
 * Chain "work" = sum over blocks of (2^256 / target). Higher work = harder to forge.
 * Fork-choice picks the chain with the highest cumulative work.
 */
export function blockWork(difficultyCompact: number): bigint {
  const target = compactToTarget(difficultyCompact);
  if (target <= 0n) return 0n;
  return (1n << 256n) / (target + 1n);
}

/**
 * Median of the previous MTP_WINDOW block timestamps ending at `endIdx`
 * (inclusive). Bitcoin's "median-time-past" rule prevents miners from
 * grinding individual timestamps to game difficulty or pass timestamp
 * validation.
 */
function mtpUpTo(headers: BlockHeader[], endIdx: number): number {
  const start = Math.max(0, endIdx - MTP_WINDOW + 1);
  const ts: number[] = [];
  for (let i = start; i <= endIdx; i++) ts.push(headers[i]!.timestamp);
  ts.sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)]!;
}

/** Public wrapper for block-validation use. Reads the most recent MTP_WINDOW headers. */
export function medianTimePast(previousHeaders: BlockHeader[]): number {
  if (previousHeaders.length === 0) return 0;
  return mtpUpTo(previousHeaders, previousHeaders.length - 1);
}
