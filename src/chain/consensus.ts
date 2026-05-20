import { powHash } from '../crypto/pow.js';
import { compactToTarget, hashMeetsTarget, targetToCompact } from '../util/binary.js';
import { encodeHeader, type BlockHeader } from './block.js';
import {
  DIFFICULTY_WINDOW,
  GENESIS_DIFFICULTY_COMPACT,
  MAX_RETARGET_FACTOR,
  MAX_TARGET,
  TARGET_BLOCK_TIME_S,
} from './genesis.js';

/**
 * True if the header's PoW hash is below its claimed target.
 *
 * Uses memory-hard Argon2id (not the block-ID sha256). One verify costs
 * ~10-30 ms on a laptop — acceptable since blocks arrive every ~150 s.
 */
export async function checkPoW(header: BlockHeader): Promise<boolean> {
  const target = compactToTarget(header.difficulty);
  if (target <= 0n || target > MAX_TARGET) return false;
  const h = await powHash(encodeHeader(header));
  return hashMeetsTarget(h, target);
}

/**
 * Decide the difficulty (compact form) that the block at `nextHeight` should use.
 *
 * Per-block retargeting with a sliding window. Every block adjusts difficulty
 * based on the average block time over the last `DIFFICULTY_WINDOW` blocks,
 * clamped to ±MAX_RETARGET_FACTOR× per step.
 *
 * Why per-block instead of Bitcoin-style periodic batches: browser hashrate
 * varies 100× across user devices and swings hard when tabs join/leave. A
 * periodic batch retarget (Bitcoin's 2016 cadence) would leave the chain mining
 * at the wrong speed for ages before correcting. Per-block makes the chain
 * self-calibrate within ~5–10 blocks of any hashrate change.
 *
 * `previousHeaders` must contain at least the most recent DIFFICULTY_WINDOW
 * headers (sorted ascending), OR be the entire chain so far if shorter.
 */
export function nextDifficulty(nextHeight: number, previousHeaders: BlockHeader[]): number {
  if (nextHeight === 0) return GENESIS_DIFFICULTY_COMPACT;
  const prev = previousHeaders[previousHeaders.length - 1]!;

  // Need at least 2 *non-genesis* blocks to measure a real block-time delta.
  // Genesis has a hardcoded past timestamp so it never participates in the
  // calculation. With genesis at index 0, that means chain length ≥ 3.
  if (previousHeaders.length < 3) return prev.difficulty;

  // Sliding window: last DIFFICULTY_WINDOW headers.
  let lookback = Math.min(DIFFICULTY_WINDOW, previousHeaders.length);
  let first = previousHeaders[previousHeaders.length - lookback]!;

  // If genesis is the start of the window, drop it — its hardcoded 2023
  // timestamp would make the apparent block-time span look like "years"
  // and the formula would incorrectly soften difficulty.
  if (first.height === 0) {
    lookback -= 1;
    first = previousHeaders[previousHeaders.length - lookback]!;
  }

  const actualSpan = Math.max(1, prev.timestamp - first.timestamp);
  const blockCount = Math.max(1, prev.height - first.height);
  const expectedSpan = TARGET_BLOCK_TIME_S * blockCount;

  const prevTarget = compactToTarget(prev.difficulty);

  // new_target = prev_target * actual / expected. Clamp [/MAX_RETARGET_FACTOR, *MAX_RETARGET_FACTOR].
  const clampedActual = Math.max(
    Math.floor(expectedSpan / MAX_RETARGET_FACTOR),
    Math.min(expectedSpan * MAX_RETARGET_FACTOR, actualSpan),
  );
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
  // (2^256) / (target + 1) — +1 avoids div-by-zero and matches Bitcoin's formula.
  return (1n << 256n) / (target + 1n);
}

/**
 * Median of the previous 11 block timestamps. Bitcoin's "median-time-past" rule
 * prevents miners from grinding low timestamps to make difficulty easier.
 */
export function medianTimePast(previousHeaders: BlockHeader[]): number {
  const take = previousHeaders.slice(-11);
  if (take.length === 0) return 0;
  const ts = take.map((h) => h.timestamp).sort((a, b) => a - b);
  return ts[Math.floor(ts.length / 2)]!;
}
