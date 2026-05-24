import { argon2id } from 'hash-wasm';

/**
 * Memory-hard PoW hash. Replaces SHA-256 for the proof-of-work target check.
 *
 * Block IDs / prevHash links still use sha256() (see crypto/hash.ts) — this
 * function is only called from the miner grind loop and from consensus
 * verification. 32 MB per-hash with 1 iteration puts the bottleneck on RAM
 * bandwidth, which is the closest browser-friendly analogue to ASIC
 * resistance. 32 MB is chosen to spill out of mid-range GPU L2 caches
 * (RTX 4070-class and below) so GPU mining can't trivially run hundreds of
 * lanes from cache — keeping browser CPUs competitive.
 *
 * Per-verify cost on a typical laptop: ~40–125 ms.
 */

// Network-wide fixed salt. The version suffix gives a clean hard-fork path:
// bump to "...v3" to invalidate the old chain.
const SALT = new TextEncoder().encode('browsercoin-pow-v2');

export const POW_PARAMS = {
  memorySize: 32 * 1024, // KiB → 32 MB
  iterations: 1,
  parallelism: 1,
  hashLength: 32,
} as const;

export async function powHash(headerBytes: Uint8Array): Promise<Uint8Array> {
  const out = await argon2id({
    password: headerBytes,
    salt: SALT,
    parallelism: POW_PARAMS.parallelism,
    iterations: POW_PARAMS.iterations,
    memorySize: POW_PARAMS.memorySize,
    hashLength: POW_PARAMS.hashLength,
    outputType: 'binary',
  });
  return out as Uint8Array;
}
