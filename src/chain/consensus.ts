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
 * Hard floor on difficulty (= ceiling on target). The target produced by
 * `nextDifficulty` is clamped to this — neither the emergency drop nor the
 * normal retarget can take the chain below GENESIS's difficulty. Without
 * this clamp, repeated stalls let target run all the way up to MAX_TARGET
 * (every random hash meets the target), at which point block production
 * costs nothing and arbitrary reorgs become free. The floor matches the
 * bootstrap difficulty: anything that can mine block 1 of the chain can
 * also mine at the floor, so this never deadlocks the network.
 */
const FLOOR_TARGET = compactToTarget(GENESIS_DIFFICULTY_COMPACT);

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
 * Per-block retargeting with a sliding window. Design choices:
 *   1. Span is measured with RAW timestamps (first vs last header in the
 *      window), not MTP-of-windows. The v3 MTP-on-span approach broke for
 *      bursty block times: when most of the MTP window was an old cluster,
 *      the median was *also* an old cluster, so actualSpan kept reporting
 *      "blocks are sub-second apart" even when recent blocks were taking
 *      hours. The retarget then bounced between overshoot and floor. Raw
 *      timestamps don't have that pathology — they track reality. MTP is
 *      still applied as a per-block validity check (see
 *      `medianTimePast` / `addBlockInternal`), which combined with the
 *      tight MAX_FUTURE_TIME_S bounds single-block timestamp manipulation
 *      to a small fraction of one block's worth of work.
 *   2. Symmetric retarget caps: target may move by at most a factor of
 *      MAX_RETARGET_FACTOR_{UP,DOWN} per block (both = 2). A wider down
 *      step would let one slow block trigger a cascade.
 *   3. Two-interval emergency drop: both the candidate's gap from its
 *      parent AND the parent's gap from its grandparent must exceed
 *      EMERGENCY_DROP_MULT × target before target doubles. A lone miner
 *      can't fabricate the grandparent's timestamp, so they can't farm
 *      cheap one-off blocks via timestamp games.
 *   4. Floor: target is clamped to FLOOR_TARGET (genesis difficulty), so
 *      no combination of stalls can drop block-production cost below the
 *      bootstrap value. Stops the "thin chain" / cheap-reorg attack.
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

  // Emergency drop — fires only when BOTH the candidate's gap from its parent
  // AND the parent's gap from its grandparent exceed the threshold. The
  // grandparent timestamp is consensus history that no single miner controls,
  // so this gates the rule against one-off "set my timestamp to parent+901s"
  // discount-mining. Genesis is never counted as a grandparent (its hardcoded
  // timestamp would always trip the rule).
  if (candidateTimestamp !== undefined && previousHeaders.length >= 2) {
    const grand = previousHeaders[previousHeaders.length - 2]!;
    if (grand.height > 0) {
      const slowParent = prev.timestamp - grand.timestamp > EMERGENCY_DROP_MULT * TARGET_BLOCK_TIME_S;
      const slowCandidate = candidateTimestamp - prev.timestamp > EMERGENCY_DROP_MULT * TARGET_BLOCK_TIME_S;
      if (slowParent && slowCandidate) {
        let dropped = prevTarget * 2n;
        if (dropped > FLOOR_TARGET) dropped = FLOOR_TARGET;
        return targetToCompact(dropped);
      }
    }
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

  // Raw timestamp span. See the function header for why MTP smoothing is
  // applied to per-block validity but NOT to the span calc.
  const actualSpan = Math.max(1, prev.timestamp - first.timestamp);

  // Clamp actualSpan so the resulting target moves at most a factor of
  // MAX_RETARGET_FACTOR_{UP,DOWN} per block.
  const minActual = Math.floor(expectedSpan / MAX_RETARGET_FACTOR_UP);
  const maxActual = expectedSpan * MAX_RETARGET_FACTOR_DOWN;
  const clampedActual = Math.max(minActual, Math.min(maxActual, actualSpan));

  let newTarget = (prevTarget * BigInt(clampedActual)) / BigInt(expectedSpan);
  if (newTarget > FLOOR_TARGET) newTarget = FLOOR_TARGET;
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
