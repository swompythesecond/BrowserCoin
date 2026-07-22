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

/**
 * How far below the tip the local state snapshot is taken on restore. This is a
 * LOCAL, per-tab, regenerable performance cache — NOT a consensus checkpoint: it
 * is derived from already-validated blocks, never constrains fork choice, and is
 * discarded on any anomaly (see `Blockchain.seedFromSnapshot`). The depth bounds
 * the tail replayed on load to ≤ this many blocks. Sync only overlaps 5 blocks
 * (serverSync), so real reorgs are tiny; 100 gives ~20× headroom before a reorg
 * could reach the snapshot anchor.
 */
export const SNAPSHOT_DEPTH = 100;

/** Mempool size cap. */
export const MAX_MEMPOOL_TXS = 5_000;

/** Min fee per byte (in wei). Cheap but non-zero to discourage spam. */
export const MIN_FEE_PER_BYTE = 1n;

/**
 * Drop pending txs older than this — a backstop so a wedged or abandoned tx
 * (e.g. a nonce-gapped sender whose missing predecessor never arrives) can't
 * pin the pool and masquerade as "pending" forever. Provably-unminable txs are
 * evicted sooner (see `Mempool.pruneUnminable`); this catches everything else.
 */
export const MEMPOOL_TX_TTL_MS = 30 * 60 * 1000; // 30 min

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

/**
 * Script hard-fork (fork #1) activation time, in unix seconds.
 *
 * This is a TIME-GATED rule extension on the SAME chain — it does NOT reset
 * balances or history. Lock/Redeem (script) transactions become valid once a
 * block's median-time-past (BIP113-style, computed from the chain itself, not a
 * wall clock) reaches this value. Before then they are rejected, so upgraded and
 * non-upgraded nodes agree pre-fork; at the date the network flips together.
 *
 * IMPORTANT: do NOT bump POW salt or BROWSERCOIN_NETWORK / CHAIN_VERSION for
 * this fork — those wipe IDB / invalidate PoW and would reset the chain.
 *
 * Announced switch date: 2026-07-05 16:00:00 UTC.
 */
export const FORK1_ACTIVATION_TIME = 1783267200; // 2026-07-05T16:00:00Z

// ─── Fork #2: Sandglass v3 proof-of-work ────────────────────────────────────
//
// Swaps the PoW hash from Argon2id (32 MB, GPU-dominated) to Sandglass v3
// (memory-latency-bound, browser-competitive) at a fixed HEIGHT. Same chain,
// same balances, same history — blocks below the fork keep verifying with
// Argon2id; blocks at/after it use Sandglass. See src/crypto/sandglass.ts.
//
// Why HEIGHT-gated, not time-gated like fork #1: the PoW verifier worker is
// stateless (it only receives the header bytes, never the surrounding chain),
// so it cannot compute median-time-past. Height is in the header's first 4
// bytes — deterministic, in-band, and not manipulable by a single miner — so
// the algorithm choice is unambiguous for every verifier. Coordination for the
// "refresh your tab" flag-day is by announcing the height ≈ its expected date;
// clients auto-update on page load, and at the fork height the network flips
// together (un-refreshed tabs reject the first Sandglass block and stall until
// reloaded — same UX as fork #1's date flip).
//
// TODO(deploy): set these three to real values just before shipping.
//   1. FORK_HEIGHT — pick current tip + enough lead (~575 blocks/day) for
//      users to refresh. Announce the height and its estimated date.
//   2. ANCHOR_TIMESTAMP — the estimated unix time the chain reaches FORK_HEIGHT.
//      Used only as the ASERT re-anchor point; a rough estimate is fine (ASERT
//      absorbs a small offset within a halflife).
//   3. ANCHOR_ATTEMPTS — expected hash attempts per block right after the fork
//      = (honest Sandglass hashrate in H/s) × TARGET_BLOCK_TIME_S. Determines
//      the reset difficulty. ERR LOW (easier): too-easy self-corrects in
//      minutes as ASERT ramps difficulty up; too-hard risks a slow-block stall.
// Announced activation (community vote): 2026-07-22 14:00 CEST (= 12:00 UTC).
// Height-gated at SANDGLASS_FORK_HEIGHT (the real trigger); the date/time is the
// estimate of when the chain reaches it (~576 blocks/day). Set from mainnet
// height 32,024 on 2026-07-19 20:18 UTC + ~1,526 blocks of lead. DEPLOY THE
// FRONTEND WELL BEFORE this height so tabs auto-update and flip together.
export const SANDGLASS_FORK_HEIGHT = 33_550;

// ASERT re-anchor point for the reset (see consensus.ts). ≈ the estimated time
// the chain reaches SANDGLASS_FORK_HEIGHT. Set to 2026-07-22 12:00 UTC (14:00 CEST).
//
// ⚠️ Only a SOFT estimate because of the safety band below. The raw ASERT
// re-anchor is asymmetric and dangerous: if the chain reaches the fork height
// EARLIER than this timestamp, difficulty explodes and the whole network stalls
// (and can't self-heal); LATER is benign (a floor-difficulty burst). The clamp
// neutralizes both tails during the settling window, so an estimate off by hours
// is safe. If the chain is visibly ahead of schedule as the fork nears, biasing
// this a few hours EARLIER costs nothing (a small benign burst).
export const SANDGLASS_ANCHOR_TIMESTAMP = 1784721600;

// After the fork, the ASERT re-anchor difficulty is clamped to within 4× of the
// reset (each direction) for this many blocks, so a wrong anchor-timestamp
// estimate can neither stall the chain nor cause an instant-block storm while the
// timestamp offset drains out. ~2000 blocks ≈ 3.5 days — far longer than any
// plausible transient. See nextDifficulty in consensus.ts.
export const SANDGLASS_ANCHOR_CLAMP_BLOCKS = 2000;

// ⚠️ VERIFY BEFORE DEPLOY. Expected hash ATTEMPTS per block right after the fork
// = (honest Sandglass hashrate in H/s) × 150. This sets the reset difficulty.
// The GPU farms leave at the fork (Sandglass kills their edge), so the post-fork
// network is browsers/CPUs — a MUCH lower, unknown hashrate. ERR LOW (easier):
// too-easy just means a brief spell of fast blocks that ASERT ramps up out of
// within ~10-30 min; too-hard risks a slow-block stall. 5,000,000 ≈ ~33 kH/s of
// honest miners; raise it if you expect more, lower it if fewer.
export const SANDGLASS_ANCHOR_ATTEMPTS = 5_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// Fork #3 — difficulty repair.
//
// WHAT WENT WRONG. Fork #2 re-anchored ASERT at a HARDCODED GUESS of when the
// chain would reach SANDGLASS_FORK_HEIGHT (SANDGLASS_ANCHOR_TIMESTAMP, written
// three days early). Anchor-ASERT amplifies anchor-time error exponentially, so
// a wrong guess meant an instant difficulty explosion — and to contain that,
// SANDGLASS_ANCHOR_CLAMP_BLOCKS bounded the resulting TARGET for 2000 blocks.
// That clamp is the bug. Anchor-ASERT derives its target from the TOTAL drift
// accumulated since the anchor: it is an integrator. Bounding its output while
// the drift keeps accumulating behind it is textbook integral windup. Live
// numbers: the reset landed ~10x too easy, difficulty pinned at the clamp
// ceiling (4x reset) from block ~33,600 on, blocks ran ~60s instead of 150s, and
// the drift wound up to −12.4 h by height 34,039 — an unclamped demand of ~2.6e22x
// the reset difficulty. At SANDGLASS_FORK_HEIGHT + CLAMP_BLOCKS the clamp expires
// and that entire accumulated error discharges in one retarget, making the next
// block unmineable. The emergency drop cannot rescue it: its grandparent gate
// reads frozen history that no future candidate can change. Permanent stall.
//
// THE FIX. Not a new mechanism — the removal of one. From
// SANDGLASS2_ANCHOR_HEIGHT + 1 on, difficulty is plain, unbounded ASERT
// re-anchored on the REAL header of block SANDGLASS2_ANCHOR_HEIGHT: its actual
// mined timestamp AND its actual difficulty, both read from the chain, neither
// guessed. That is exactly what makes the genesis anchor safe (it held 149.2
// s/block over 33k blocks), and it is the property fork #2 threw away. With a
// truthful anchor there is nothing to contain, so there is no clamp, no settling
// band, no expiry, and therefore no cliff — difficulty simply tracks hashrate
// however volatile it gets.
//
// The height below is the ONLY constant this fork introduces. There is
// deliberately no reset difficulty: fork #2 had one because it switched PoW
// algorithms and the old difficulty was meaningless in the new units; nothing
// changes here, so the anchor block's own difficulty carries over and ASERT
// takes it from there. A starting point that is 2-3x off target is what ASERT
// exists to fix, and it does so within ~10-30 min. Note the anchor difficulty is
// forced by consensus, not chosen by its miner, so there is no grinding vector;
// its timestamp is miner-influenced only within MAX_FUTURE_TIME_S, and any such
// offset is absorbed into the steady-state drift rather than biasing the pace.
//
// NOTE: the fork-#2 path in nextDifficulty (reset + re-anchor + clamp) must stay
// exactly as-is forever. Heights 33,550..35,550 were mined under it and have to
// keep validating on resync. It is history, not live code.
//
// ANCHOR HEIGHT = the last block the old rules can still produce. Blocks at or
// below it are byte-for-byte unchanged, so there is no divergence before the
// boundary and no split: the old chain simply halts here on its own, with or
// without this fork.
export const SANDGLASS2_ANCHOR_HEIGHT = 35_550;
