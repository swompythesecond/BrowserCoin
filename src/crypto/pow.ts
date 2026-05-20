import { argon2id } from 'hash-wasm';

/**
 * Memory-hard PoW hash. Replaces SHA-256 for the proof-of-work target check.
 *
 * Block IDs / prevHash links still use sha256() (see crypto/hash.ts) — this
 * function is only called from the miner grind loop and from consensus
 * verification. GPUs choke on the 16 MB per-hash memory footprint, which is
 * the whole point.
 */

const SALT = new Uint8Array([
  // "wwwcoin-pow-v1" + two NUL bytes — 16 bytes total. Network-wide fixed salt
  // is safe in PoW (no shared secret to crack). The version suffix gives us a
  // clean hard-fork path: bump to "...v2" to invalidate the old chain.
  0x77, 0x77, 0x77, 0x63, 0x6f, 0x69, 0x6e, 0x2d,
  0x70, 0x6f, 0x77, 0x2d, 0x76, 0x31, 0x00, 0x00,
]);

export const POW_PARAMS = {
  memorySize: 16 * 1024, // KiB → 16 MB
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
