import type { Block } from './block.js';

/** Network identity baked into tx signatures to prevent cross-chain replay. */
export const CHAIN_ID = 0xc01dfeed;

/** Smallest unit: 1 BROWSER = 1e8 wei. */
export const COIN = 100_000_000n;

/** Initial block reward (50 BROWSER), halved every HALVING_INTERVAL blocks. */
export const INITIAL_REWARD = 50n * COIN;
export const HALVING_INTERVAL = 210_000;

/** Target one block every 2.5 minutes (150 s) — 4x faster than Bitcoin. */
export const TARGET_BLOCK_TIME_S = 150;

/**
 * Sliding-window size for per-block difficulty retargeting (see consensus.ts).
 * Every block compares average block-time over the last DIFFICULTY_WINDOW
 * blocks against TARGET_BLOCK_TIME_S and adjusts by up to ±MAX_RETARGET_FACTOR.
 *
 * Bitcoin retargets every 2016 blocks because its global hashrate barely
 * moves. BrowserCoin's hashrate swings 100× when one tab joins or closes, so
 * we retarget every block over a short window. This is what most modern
 * altcoins (Monero, ZEC, etc.) do.
 */
export const DIFFICULTY_WINDOW = 20;

/** Bound the retarget change to ±4x per interval, like Bitcoin. */
export const MAX_RETARGET_FACTOR = 4;

/** Reject blocks whose timestamp is more than 2 hours in the future. */
export const MAX_FUTURE_TIME_S = 2 * 60 * 60;

/** Max serialized block size (browser-friendly cap). */
export const MAX_BLOCK_BYTES = 256 * 1024;

/** Mempool size cap. */
export const MAX_MEMPOOL_TXS = 5_000;

/** Min fee per byte (in wei). Cheap but non-zero to discourage spam. */
export const MIN_FEE_PER_BYTE = 1n;

/**
 * Initial difficulty target. Picked for memory-hard Argon2id (16 MB) PoW,
 * which runs at ~50-100 h/s/tab in browsers and ~100 h/s in Node tests.
 *
 * Compact 0x20400000 → target = 0x400000 << 232 = 2^254, giving
 * P(success) = 1/4 (~4 expected attempts). At ~10 ms/hash that lands the
 * first block in ~40 ms — a few real-world seconds is fine for browser
 * bootstrap, and per-block retarget pulls difficulty up toward
 * TARGET_BLOCK_TIME_S as miners join. SHA-256-era difficulties (e.g.
 * 0x1f00ffff with ~65k expected attempts) would take ~11 min per block.
 *
 * Must equal targetToCompact(compactToTarget(GENESIS_DIFFICULTY_COMPACT))
 * (canonical normalized form) so per-window retargets that hit the target
 * pace return identically.
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
