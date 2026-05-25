import setupArgon2idWasm from 'argon2id/lib/setup.js';
import { SIMD_WASM_BASE64, NO_SIMD_WASM_BASE64 } from './argon2id-wasm.js';

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
 * Per-hash cost on a typical laptop: ~40–125 ms.
 *
 * Why the openpgpjs/argon2id library (instead of hash-wasm): hash-wasm
 * instantiates a fresh WebAssembly.Memory of ~32 MB on every call. Under
 * heavy contention (many miner workers, many nonces) the browser's
 * process-wide WASM memory pool fragments and `WebAssembly.instantiate`
 * rejects allocations with a RangeError. openpgpjs/argon2id allocates one
 * WebAssembly.Memory at module-load time and reuses it for every
 * subsequent hash — the per-call allocation is gone entirely, so the OOM
 * class is gone with it. Byte-for-byte output equivalence with hash-wasm
 * was verified before the swap (RFC 9106 compliance on both sides), so
 * the existing chain stays valid.
 *
 * The wasm bytes are inlined as base64 (~11 KB of source) via
 * `argon2id-wasm.ts`. This sidesteps the fetch-vs-fs-vs-Vite-?init
 * difference between browser, worker, and vitest contexts — same path
 * everywhere, no platform branching in the hot module.
 */

// Network-wide fixed salt. The version suffix gives a clean hard-fork path:
// bump to "...v5" to invalidate the old chain.
//
// v3 (2026-05): emergency-drop / difficulty-floor consensus fix. v2 chains
// allowed difficulty to crash to MAX_TARGET after a stall, enabling free
// reorgs.
// v4 (2026-05): retarget uses raw timestamps instead of MTP-of-windows. v3
// chains oscillated between overshoot (~18 bits) and floor (1 bit) for a
// single-miner network because the MTP median snapped between clusters of
// burst-mined blocks. See consensus.ts for the new rules.
const SALT = new TextEncoder().encode('browsercoin-pow-v4');

export const POW_PARAMS = {
  memorySize: 32 * 1024, // KiB → 32 MB
  iterations: 1,
  parallelism: 1,
  hashLength: 32,
} as const;

interface Argon2idParams {
  password: Uint8Array;
  salt: Uint8Array;
  parallelism: number;
  passes: number;
  memorySize: number;
  tagLength: number;
  ad?: Uint8Array;
  secret?: Uint8Array;
}

// Lazy singleton per JS context (main thread or worker). The Argon2id lib's
// setupWasm allocates one ~65 MB WebAssembly.Memory at init time and reuses
// it for every subsequent hash; that single allocation is what eliminates
// the per-nonce OOM the previous hash-wasm-based implementation hit.
let argon2idPromise: Promise<(p: Argon2idParams) => Uint8Array> | null = null;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function loadArgon2id(): Promise<(p: Argon2idParams) => Uint8Array> {
  if (argon2idPromise) return argon2idPromise;
  const simdBytes = base64ToBytes(SIMD_WASM_BASE64);
  const noSimdBytes = base64ToBytes(NO_SIMD_WASM_BASE64);
  argon2idPromise = setupArgon2idWasm(
    (imp: WebAssembly.Imports) => WebAssembly.instantiate(simdBytes as BufferSource, imp),
    (imp: WebAssembly.Imports) => WebAssembly.instantiate(noSimdBytes as BufferSource, imp),
  );
  return argon2idPromise;
}

export async function powHash(headerBytes: Uint8Array): Promise<Uint8Array> {
  const argon2id = await loadArgon2id();
  return argon2id({
    password: headerBytes,
    salt: SALT,
    parallelism: POW_PARAMS.parallelism,
    passes: POW_PARAMS.iterations,
    memorySize: POW_PARAMS.memorySize,
    tagLength: POW_PARAMS.hashLength,
  });
}
