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
 * Sliding-window size for per-block difficulty retargeting (see consensus.ts).
 * Every block compares average block-time over the last DIFFICULTY_WINDOW
 * blocks against TARGET_BLOCK_TIME_S and adjusts within the asymmetric caps.
 *
 * Bitcoin retargets every 2016 blocks because its global hashrate barely
 * moves. BrowserCoin's hashrate swings 100× when one tab joins or closes, so
 * we retarget every block over a short window. 50 blocks (~2 h at target)
 * gives reasonable statistical convergence without being too laggy.
 */
export const DIFFICULTY_WINDOW = 50;

/**
 * Number of historical timestamps used to compute MTP. Retargeting uses MTP
 * (not raw timestamps) on both ends of the window so that miner-supplied
 * timestamps can't be ground in either direction to game difficulty.
 */
export const MTP_WINDOW = 11;

/**
 * Asymmetric retarget step caps, per block.
 *
 * Rising difficulty (target shrinks) is clamped tighter than falling
 * difficulty (target grows). The asymmetry is the main defense against
 * "hashrate gaming": an attacker who briefly applies hashrate can only push
 * difficulty up by 2× per block, but when they leave the chain can drop
 * difficulty by 4× per block — so honest miners aren't stuck for long at
 * attacker-inflated difficulty.
 */
export const MAX_RETARGET_FACTOR_UP = 2;   // target / 2 (difficulty *2) per block
export const MAX_RETARGET_FACTOR_DOWN = 4; // target * 4 (difficulty /4) per block

/**
 * Emergency drop: if the candidate block's timestamp is more than this many
 * target intervals past the parent's timestamp, the chain is presumed stalled
 * and the next block may use prev.difficulty / 2 without the normal window
 * calculation. Prevents indefinite stalls when a large miner suddenly leaves.
 */
export const EMERGENCY_DROP_MULT = 6;

/** Reject blocks whose timestamp is more than 30 minutes in the future. */
export const MAX_FUTURE_TIME_S = 30 * 60;

/** Max serialized block size (browser-friendly cap). */
export const MAX_BLOCK_BYTES = 256 * 1024;

/** Mempool size cap. */
export const MAX_MEMPOOL_TXS = 5_000;

/** Min fee per byte (in wei). Cheap but non-zero to discourage spam. */
export const MIN_FEE_PER_BYTE = 1n;

/**
 * Initial difficulty target. Sized for memory-hard Argon2id PoW (see
 * POW_PARAMS in src/crypto/pow.ts — currently 32 MB / 1 iter, ~40–125 ms
 * per hash on a laptop). Bootstrap blocks land in a few hundred ms;
 * per-block retarget then pulls difficulty up toward TARGET_BLOCK_TIME_S
 * as real miners join.
 *
 * Compact 0x20400000 → target = 0x400000 << 232 = 2^254, giving
 * P(success) = 1/4 (~4 expected attempts).
 *
 * Must equal targetToCompact(compactToTarget(GENESIS_DIFFICULTY_COMPACT))
 * (canonical normalized form) so per-window retargets that hit the target
 * pace return identically. Mantissa's high bit must be clear (>=0x800000
 * normalizes to a higher exponent).
 */
export const GENESIS_DIFFICULTY_COMPACT = 0x20400000;

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
 * Tests and the initial chain construct this deterministically.
 */
export const GENESIS: Block = {
  header: {
    height: 0,
    prevHash: new Uint8Array(32),
    txRoot: new Uint8Array(32),
    stateRoot: new Uint8Array(32),
    timestamp: 1700000000, // fixed past timestamp so chain is reproducible
    difficulty: GENESIS_DIFFICULTY_COMPACT,
    nonce: 0,
    miner: new Uint8Array(32),
  },
  transactions: [],
};
