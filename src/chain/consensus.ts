import { powHash } from '../crypto/pow.js';
import { compactToTarget, hashMeetsTarget, targetToCompact } from '../util/binary.js';
import { encodeHeader, type BlockHeader } from './block.js';
import {
  EMERGENCY_DROP_MULT,
  GENESIS_DIFFICULTY_COMPACT,
  GENESIS_TIMESTAMP,
  HALFLIFE_S,
  MAX_TARGET,
  MTP_WINDOW,
  SANDGLASS2_ANCHOR_HEIGHT,
  SANDGLASS_ANCHOR_ATTEMPTS,
  SANDGLASS_ANCHOR_CLAMP_BLOCKS,
  SANDGLASS_ANCHOR_TIMESTAMP,
  SANDGLASS_FORK_HEIGHT,
  TARGET_BLOCK_TIME_S,
} from './genesis.js';

/**
 * Hard floor on difficulty (= ceiling on target). ASERT can move target
 * up (harder) but never above this value. Anchored to GENESIS's difficulty
 * because anything that can mine block 1 can also mine at the floor —
 * the chain can't deadlock on hashrate loss.
 */
const FLOOR_TARGET = compactToTarget(GENESIS_DIFFICULTY_COMPACT);

/** ASERT anchor target — bigint cache of GENESIS's target. */
const ANCHOR_TARGET = compactToTarget(GENESIS_DIFFICULTY_COMPACT);

/**
 * Fork #2 (Sandglass) difficulty reset. Switching the PoW algorithm changes the
 * network's attempts-per-second, so the Argon2id-era difficulty would be wrong
 * for Sandglass — the first Sandglass block resets to this anchor and ASERT
 * re-anchors here (see nextDifficulty). Derived from the expected attempts/block
 * so it's a canonical compact; chain-work = 2^256/target ≈ attempts.
 */
const SANDGLASS_ANCHOR_TARGET = (1n << 256n) / BigInt(SANDGLASS_ANCHOR_ATTEMPTS);
export const SANDGLASS_ANCHOR_DIFFICULTY_COMPACT = targetToCompact(SANDGLASS_ANCHOR_TARGET);

/**
 * BCH aserti3-2d implementation. Computes the next-block target as
 *
 *   target = anchor_target * 2^((Δt − heightDiff × T) / halflife)
 *
 * using a 16-bit fixed-point cubic polynomial approximation of 2^x in the
 * fractional part. Anchor-based exponential math has no window / median
 * pathology — it tracks the true wall-clock pace from the anchor forward
 * regardless of how blocks cluster within that span. Equivalent to BCH's
 * spec from the Nov 2020 fork; constants are the same.
 *
 *   `parentHeight`, `parentTime` come from the block before the candidate.
 *   `heightDiff` is (parent.height − anchor.height + 1), i.e. the count
 *   of blocks the chain *should* have produced by candidate time.
 */
function asertTarget(
  parentHeight: number,
  parentTime: number,
  anchorHeight: number,
  anchorTime: number,
  anchorTarget: bigint,
): bigint {
  // heightDiff is the number of *intervals* between anchor and parent, NOT
  // (parent.height − anchor.height + 1). BCH's reference uses
  // parent.height − anchor.height (with a pprev-time adjustment to absorb the
  // off-by-one). Anchoring directly at a block (genesis, or the fork block for
  // fork #2) we don't have a pprev, so the natural form is
  // heightDiff = parent.height − anchor.height. At exact target pace this gives
  // deviation = 0 → target unchanged → equilibrium is a fixed point at the anchor.
  const heightDiff = BigInt(parentHeight - anchorHeight);
  const timeDiff = BigInt(parentTime - anchorTime);
  // exponent = ((timeDiff − heightDiff × target_spacing) << 16) / halflife
  const numerator = (timeDiff - heightDiff * BigInt(TARGET_BLOCK_TIME_S)) << 16n;
  const exponent = numerator / BigInt(HALFLIFE_S);

  // Split into integer shifts and 16-bit fractional remainder. JS BigInt
  // `>>` is arithmetic, so for a negative exponent the bottom 16 bits are
  // not directly usable as an unsigned fraction — normalize explicitly.
  let shifts = exponent >> 16n;
  let frac = Number(((exponent % 65536n) + 65536n) % 65536n);
  if (frac >= 65536) {
    frac -= 65536;
    shifts += 1n;
  }

  // 2^(frac/65536) ≈ 1 + (cubic polynomial in frac) — BCH-spec constants
  // (https://upgradespecs.bitcoincashnode.org/2020-11-15-asert/). Precision
  // is ~0.3 ppm, well below any practical concern.
  const factor =
    65536n +
    ((195766423245049n * BigInt(frac) +
      971821376n * BigInt(frac) * BigInt(frac) +
      5127n * BigInt(frac) * BigInt(frac) * BigInt(frac) +
      (1n << 47n)) >>
      48n);

  let target = anchorTarget * factor;
  if (shifts < 0n) target = target >> -shifts;
  else target = target << shifts;
  target = target >> 16n; // remove the fixed-point shift

  if (target <= 0n) target = 1n;
  if (target > FLOOR_TARGET) target = FLOOR_TARGET;
  return target;
}

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
 * use. Caller passes the candidate block's intended timestamp for the
 * emergency-drop check.
 *
 * Retarget rule (v5): ASERT. The next target is computed as
 * `anchor_target × 2^((Δt − n × T) / halflife)`, where Δt is wall-clock since
 * the anchor and n is the height count since the anchor. This is the same
 * algorithm BCH adopted in Nov 2020.
 *
 * Three anchoring regimes, by height:
 *   • ≤ SANDGLASS_FORK_HEIGHT      — anchored at genesis (hardcoded).
 *   • 33,551..35,550               — fork #2: anchored at the fork block with a
 *     hardcoded ESTIMATED timestamp and a target clamp. Frozen history; this is
 *     the combination that stalled the chain (see genesis.ts). Never reuse it.
 *   • > SANDGLASS2_ANCHOR_HEIGHT   — fork #3: anchored on the REAL header of
 *     block 35,550, supplied by the caller. No clamp, no estimate.
 *
 * Why this works where the previous attempts didn't:
 *   • No sliding window → no clustering pathology. The v3 window medians
 *     snapped between clusters of burst-mined blocks, oscillating
 *     between overshoot and floor.
 *   • Exponential (not linear) response → smooth at all hashrate scales.
 *     Sim shows tracking error < 2 bits across 100× hashrate range.
 *   • Anchor-based → robust against single-block timestamp manipulation,
 *     bounded by HALFLIFE_S / MAX_FUTURE_TIME_S ratio.
 *   • Provably stable: equilibrium is a fixed point at any hashrate.
 *
 * Defenses kept from v3/v4:
 *   • Floor at GENESIS difficulty — chain can't deadlock if hashrate dies.
 *   • Two-interval emergency drop — safety net for long stalls; gated by
 *     the grandparent timestamp so it can't be invoked at will by a single
 *     attacker block.
 *
 * `previousHeaders` is passed only for the emergency-drop grandparent lookup —
 * its LENGTH must never affect the result. ASERT uses just the parent header
 * (last element) plus the anchor.
 *
 * `sandglass2Anchor` is REQUIRED (pass `null` below the fork-#3 height) rather
 * than optional, and is never recovered from `previousHeaders`. Both properties
 * are deliberate: an optional parameter lets a missed call site type-check, and
 * a lookback-window fallback would silently rescue it for exactly
 * RETARGET_LOOKBACK blocks before failing — and the two consensus paths pass
 * different window sizes (60 for block validation, MTP_WINDOW for fast sync), so
 * such a fallback would partition full nodes from fast-syncing tabs. Requiring
 * the argument turns that entire class into a compile error.
 */
export function nextDifficulty(
  nextHeight: number,
  previousHeaders: BlockHeader[],
  candidateTimestamp: number | undefined,
  sandglass2Anchor: BlockHeader | null,
): number {
  if (nextHeight === 0) return GENESIS_DIFFICULTY_COMPACT;

  // Fork #2: hard difficulty reset at the first Sandglass block. Unconditional
  // (bypasses the emergency-drop / ASERT below) so the algorithm switch starts
  // from a known difficulty matched to expected honest Sandglass hashrate. A
  // reset without the re-anchor below would be snapped straight back by the
  // genesis-anchored schedule, so both are required together.
  if (nextHeight === SANDGLASS_FORK_HEIGHT) return SANDGLASS_ANCHOR_DIFFICULTY_COMPACT;

  const prev = previousHeaders[previousHeaders.length - 1]!;
  const prevTarget = compactToTarget(prev.difficulty);

  // Emergency drop — fires only when BOTH the candidate's gap from its parent
  // AND the parent's gap from its grandparent exceed the threshold. The
  // grandparent timestamp is consensus history that no single miner controls,
  // so this gates the rule against one-off "set my timestamp to parent+901s"
  // discount-mining. Genesis is never counted as a grandparent (its hardcoded
  // timestamp would always trip the rule).
  //
  // ⚠️ KNOWN DEFECT, deliberately NOT fixed in fork #3 — do not "clean this up"
  // without reading this first.
  //
  // This rule was added 2026-05-21 (0dff511) for the v3 retarget: a 50-block
  // sliding window of MEDIANS, under which a stall genuinely could not
  // self-correct (one late block barely moves a median, and you cannot produce
  // the further blocks needed to move it because you are stalled). A manual
  // escape hatch was correct for that algorithm. ASERT (094718d) replaced the
  // window and recovers from a stall in ONE step — the late block's timestamp
  // goes straight into the drift term — but this rule was carried across
  // unexamined. Above the fork-#3 anchor it is now strictly harmful: it returns
  // early, preempting unbounded ASERT, and eases by a fixed 2× per block where
  // ASERT would ease exponentially. Measured at 3 h blocks: this returns 1.0e7
  // attempts where fork-#3 ASERT returns 127 — 78,741× harder, turning one
  // recovery block into ~17. Separately, the grandparent gate means it cannot
  // fire during a stall at all (it reads frozen history), so it no longer opens
  // in the emergency it is named for.
  //
  // It is kept because REMOVING it is the more dangerous change today: when it
  // does fire, a pre-fork-#3 and a post-fork-#3 build compute the SAME value, so
  // it cannot cause a chain split. Gating it above the anchor would make the two
  // builds disagree on a block both consider mineable — a real split, in exactly
  // the slow-chain scenario that is already the main risk. Fix it when there is
  // time to test it, not on a one-day fork deadline.
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

  // Fork #3: plain ASERT, re-anchored on the REAL header of block
  // SANDGLASS2_ANCHOR_HEIGHT — its actual mined timestamp and its actual
  // difficulty, both read from the chain, neither estimated. At the first block
  // above the anchor the drift term is therefore exactly 0 and difficulty simply
  // carries over unchanged; the chain resumes at the pace it was already running
  // and ASERT corrects it from there. Nothing here can be "off", so there is
  // nothing to contain: no clamp, no settling band, no expiry, no windup, no
  // future cliff. Difficulty is free to track hashrate in both directions, which
  // is the whole reason ASERT is here. Same shape as the genesis-anchored path
  // below — that one has held target pace for 33k blocks.
  if (nextHeight > SANDGLASS2_ANCHOR_HEIGHT) {
    // Assertion, not a recovery path: the parameter is required, so a missing or
    // wrong-height anchor is a caller bug the compiler could not catch (a `null`
    // passed where a header belongs). Never fall back to a guess — producing a
    // plausible-but-wrong difficulty is precisely what made fork #2 unrecoverable.
    const anchor = sandglass2Anchor;
    if (anchor === null || anchor.height !== SANDGLASS2_ANCHOR_HEIGHT) {
      throw new Error(
        `fork #3 anchor header (height ${SANDGLASS2_ANCHOR_HEIGHT}) missing or wrong ` +
        `(got ${anchor === null ? 'null' : `height ${anchor.height}`}) for block ${nextHeight}`,
      );
    }
    return targetToCompact(
      asertTarget(
        prev.height,
        prev.timestamp,
        anchor.height,
        anchor.timestamp,
        compactToTarget(anchor.difficulty),
      ),
    );
  }

  // ASERT. Pre-fork blocks anchor at genesis; fork-#2 blocks anchor at the fork
  // block (hardcoded height/time/target constants, so the anchor never needs to
  // be fetched from the recent-header window).
  //
  // ⚠️ FROZEN HISTORY. This branch now only ever runs for heights
  // 33,551..SANDGLASS2_ANCHOR_HEIGHT, which are already mined. The clamp below
  // is the fork-#3 bug (see genesis.ts) — do NOT "fix" it here; these blocks
  // must keep validating exactly as they were accepted.
  if (nextHeight > SANDGLASS_FORK_HEIGHT) {
    let t = asertTarget(prev.height, prev.timestamp, SANDGLASS_FORK_HEIGHT, SANDGLASS_ANCHOR_TIMESTAMP, SANDGLASS_ANCHOR_TARGET);

    // Safety band for the settling window right after the fork. The re-anchor
    // uses a hardcoded ESTIMATE of when the chain reaches the fork height. If the
    // chain arrives EARLIER than that estimate (the likely direction — pre-fork
    // hashrate tends to run ahead of schedule), the raw ASERT target collapses
    // and difficulty explodes, stalling the whole upgraded network — and it
    // cannot self-heal (see the emergency-drop grandparent gate, which can't fire
    // across the fork). Symmetrically, arriving much later would slam difficulty
    // to the floor and produce an instant-block storm. So for the first
    // SANDGLASS_ANCHOR_CLAMP_BLOCKS blocks we clamp the target to within 4× of the
    // reset in each direction: block times stay in ~[T/4, 4T] (no stall, no
    // storm) while the timestamp offset drains out, after which the chain's own
    // timestamps dominate and unclamped ASERT is safe. This makes the anchor
    // timestamp a soft estimate rather than a chain-bricking landmine.
    if (nextHeight <= SANDGLASS_FORK_HEIGHT + SANDGLASS_ANCHOR_CLAMP_BLOCKS) {
      const hardest = SANDGLASS_ANCHOR_TARGET / 4n; // difficulty ≤ 4× reset
      const easiest = SANDGLASS_ANCHOR_TARGET * 4n; // difficulty ≥ reset/4
      if (t < hardest) t = hardest;
      else if (t > easiest) t = easiest;
    }
    return targetToCompact(t);
  }
  return targetToCompact(asertTarget(prev.height, prev.timestamp, 0, GENESIS_TIMESTAMP, ANCHOR_TARGET));
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
