import type { Block } from './block.js';

/** Network identity baked into tx signatures to prevent cross-chain replay. */
export const CHAIN_ID = 0xc01dfeed;

/** Smallest unit: 1 BRC = 1e8 wei. */
export const COIN = 100_000_000n;

/** Initial block reward (50 BRC), halved every HALVING_INTERVAL blocks. */
export const INITIAL_REWARD = 50n * COIN;
export const HALVING_INTERVAL = 210_000;

/**
 * Hard cap on any single monetary value in a transaction. Post-Bitcoin-2010
 * defense-in-depth — bigint can't overflow, but capping fields makes the
 * "impossible" attack literally inexpressible. Equal to max supply (21M),
 * so no tx can claim more value than will ever exist on the chain.
 */
export const MAX_MONEY = 21_000_000n * COIN;

/** Target one block every 2.5 minutes (150 s) — 4x faster than Bitcoin. */
export const TARGET_BLOCK_TIME_S = 150;

/**
 * Legacy lookback size. v3/v4 retargets used a window of this many blocks.
 * v5 switched to ASERT (anchor-based exponential), which doesn't need a
 * window — but callers still use this value as "how many recent headers
 * to fetch" so that the MTP validity check and emergency-drop lookback
 * have plenty of headroom. Kept at 50 because the existing fetch budget
 * is fine; could be shrunk to MTP_WINDOW alone if a hot path needed it.
 */
export const DIFFICULTY_WINDOW = 50;

/**
 * Number of historical timestamps used to compute MTP (median-time-past).
 * MTP is applied to per-block timestamp validity: a block's timestamp
 * must exceed the median of the last MTP_WINDOW headers. This bounds
 * how far back a miner can lie about their own block's time.
 */
export const MTP_WINDOW = 11;

/**
 * ASERT half-life, in seconds. Controls how fast difficulty responds
 * to deviations from target pace: under sustained 2×-too-slow blocks,
 * the target doubles in HALFLIFE_S seconds (difficulty halves).
 *
 * 600 s = 10 min = 4 target block-times. Empirically tuned (see the
 * halflife-sweep simulation) for our hashrate range: short enough to
 * track minute-scale swings when tabs join/leave, long enough not to
 * react to single-block noise. BCH uses 2 days because its hashrate
 * barely moves; our network is much more volatile.
 */
export const HALFLIFE_S = 600;

/**
 * Emergency drop: safety net for long stalls. Fires only when BOTH the
 * candidate's gap from its parent AND the parent's gap from its grandparent
 * exceed EMERGENCY_DROP_MULT × TARGET_BLOCK_TIME_S — see consensus.ts. The
 * grandparent gate prevents a single attacker block from invoking the rule
 * on demand for a discount. When fired, target doubles (clamped at floor).
 */
export const EMERGENCY_DROP_MULT = 6;

/**
 * Reject blocks whose timestamp is more than 10 minutes in the future.
 * Tighter than Bitcoin's 2h because the smaller window is what bounds a
 * lone miner's ability to fabricate two consecutive "slow" intervals and
 * fire the emergency drop (see consensus.ts). 10 min still leaves ample
 * room for clock skew across browser tabs.
 */
export const MAX_FUTURE_TIME_S = 10 * 60;

/** Max serialized block size (browser-friendly cap). */
export const MAX_BLOCK_BYTES = 256 * 1024;

/** Mempool size cap. */
export const MAX_MEMPOOL_TXS = 5_000;

/** Min fee per byte (in wei). Cheap but non-zero to discourage spam. */
export const MIN_FEE_PER_BYTE = 1n;

/**
 * Initial difficulty target = the difficulty floor. ASERT can move target
 * up (harder) but never above this value, so any miner that can mine block 1
 * can also mine at the floor — the chain can't deadlock on hashrate loss.
 *
 * Compact 0x20020000 → target = 0x20000 << 232 = 2^249, giving expected
 * ~128 attempts per block. At 70 H/s that's ~1.8 s/block at floor; at
 * 10 H/s ~13 s/block; at 1 H/s ~2 min/block. Even a heavily throttled
 * single tab keeps the chain alive.
 *
 * Higher than the v3/v4 value (1 bit ≈ 4 attempts) because that floor
 * was too low — sub-second mining at the floor polluted the retarget
 * window. 6 bits is high enough to bootstrap smoothly via ASERT, low
 * enough not to stall.
 *
 * Must equal targetToCompact(compactToTarget(GENESIS_DIFFICULTY_COMPACT))
 * (canonical normalized form).
 */
export const GENESIS_DIFFICULTY_COMPACT = 0x20020000;

/** Maximum hash value treated as "infinity" target — used in chain-work math. */
export const MAX_TARGET = (1n << 256n) - 1n;

/** Coinbase reward at a given height (account-model implicit coinbase). */
export function blockReward(height: number): bigint {
  const halvings = Math.floor(height / HALVING_INTERVAL);
  if (halvings >= 64) return 0n; // subsidy exhausted
  return INITIAL_REWARD >> BigInt(halvings);
}

/**
 * Genesis block. Mined offline at "build time" (well — at first launch).
 * Zero prev-hash, height 0, no transactions, no miner reward credited.
 *
 * Timestamp is the ASERT anchor: every retarget in the chain is computed
 * relative to genesis. If genesis is set significantly before the first
 * mined block, ASERT sees a large "schedule deficit" and holds difficulty
 * at floor while the chain catches up, producing many sub-second blocks
 * during bootstrap. So this should be set ≈ deploy time at each fork.
 */
export const GENESIS: Block = {
  header: {
    height: 0,
    prevHash: new Uint8Array(32),
    txRoot: new Uint8Array(32),
    stateRoot: new Uint8Array(32),
    timestamp: 1779700000, // ~2026-05-24 19:06 UTC — far enough in the past that test clocks and deploy clocks both run forward from it
    difficulty: GENESIS_DIFFICULTY_COMPACT,
    nonce: 0,
    miner: new Uint8Array(32),
  },
  transactions: [],
};

/** Convenience: genesis timestamp exposed for ASERT (anchor time). */
export const GENESIS_TIMESTAMP = GENESIS.header.timestamp;
