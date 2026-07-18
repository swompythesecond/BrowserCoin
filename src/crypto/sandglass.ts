import { sha256 } from './hash.js';

/**
 * Sandglass v3 — memory-latency-bound proof-of-work hash (fork #2 PoW).
 *
 * Replaces Argon2id for blocks at/after SANDGLASS_FORK_HEIGHT. Where Argon2id
 * is memory-*capacity*-hard (32 MB/hash, which GPUs beat ~10-30× on bandwidth),
 * Sandglass is memory-*latency*-hard: a small 512 KiB buffer walked by a long
 * chain of dependent random reads. Each read's address depends on the value
 * just read, so the work is a serial pointer-chase that a GPU's parallelism
 * cannot accelerate — measured across 90+ devices, a browser tab matches a
 * hand-optimized native miner and an RTX 5090 to within ~10%, and beats every
 * GPU per joule. See the sandglass-v3 test bench for the full data.
 *
 * Construction (the walk is bit-identical to the benchmarked kernel; only the
 * seed and finalization are wrapped in SHA-256 to make it consensus-grade):
 *   1. seed   = SHA-256(header)                    — unpredictable per nonce
 *   2. fill   = 512 KiB buffer, chained lowbias32 from the seed (no closed
 *               form → no lazy evaluation / precomputation)
 *   3. walk   = 4 interleaved dependent read-modify-write chains, 2,097,152
 *               steps total. 4 chains let a CPU's out-of-order core overlap
 *               4 outstanding cache misses; a GPU (already latency-hiding
 *               across thousands of lanes) gains nothing.
 *   4. digest = SHA-256(seed ‖ h ‖ chain states) → 256-bit output
 *
 * The internal mixer (lowbias32) is non-cryptographic — that's fine: the
 * memory-hardness comes from the walk, and the SHA-256 wrapping makes the
 * input and output cryptographically bound (same shape as yescrypt/RandomX,
 * which wrap non-crypto cores in a real hash). ~40-125 ms per verify on a
 * laptop, comparable to the Argon2id it replaces, so the 150 s block budget
 * and multi-block sync path are unaffected.
 *
 * Deterministic across JS engines: only Math.imul + uint32 ops + SHA-256, so
 * every browser/worker/node computes the identical digest. Frozen test vectors
 * (sandglass.vectors.json) pin the exact bytes; any implementation must match.
 */

const W = 1 << 17; // 131,072 u32 words = 512 KiB
const MASK = W - 1;
const STEPS = 1 << 21; // 2,097,152 total dependent steps
const CHAINS = 4;
const PER = STEPS / CHAINS; // 524,288 steps per chain
const GOLDEN = 0x9e3779b9;

/** lowbias32 32-bit finalizer (well-known). Matches the bench kernel exactly. */
function mix(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

// One reused 512 KiB scratch per JS context (main thread or worker), allocated
// once at module load — the same "no per-call allocation" discipline that keeps
// the Argon2id path OOM-free. Sandglass is synchronous and single-threaded per
// context, so the shared buffer is never re-entered.
const buf = new Uint32Array(W);

function readU32be(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}
function writeU32be(b: Uint8Array, off: number, v: number): void {
  b[off] = (v >>> 24) & 0xff;
  b[off + 1] = (v >>> 16) & 0xff;
  b[off + 2] = (v >>> 8) & 0xff;
  b[off + 3] = v & 0xff;
}

/**
 * Sandglass v3 PoW hash. Input is the full encoded block header; output is a
 * 32-byte digest compared against the block's target (hashMeetsTarget), exactly
 * like the Argon2id powHash it replaces.
 */
export function sandglassHash(headerBytes: Uint8Array): Uint8Array {
  const seed = sha256(headerBytes); // 32 bytes

  // Initial fill state: fold all 8 seed words through the mixer so the whole
  // 256-bit seed influences the (deterministic) buffer, not just 32 bits.
  let h = GOLDEN;
  for (let i = 0; i < 8; i++) h = mix((h ^ readU32be(seed, i * 4)) >>> 0);

  // Phase 1 — fill (chained, no shortcut).
  for (let i = 0; i < W; i++) {
    h = mix((h + GOLDEN) >>> 0);
    buf[i] = h;
  }

  // Init 4 chains from h (same derivation as the bench kernel).
  let x = h;
  x = mix((x ^ 1) >>> 0); let a0 = mix((x ^ GOLDEN) >>> 0); let i0 = x & MASK;
  x = mix((x ^ 2) >>> 0); let a1 = mix((x ^ GOLDEN) >>> 0); let i1 = x & MASK;
  x = mix((x ^ 3) >>> 0); let a2 = mix((x ^ GOLDEN) >>> 0); let i2 = x & MASK;
  x = mix((x ^ 4) >>> 0); let a3 = mix((x ^ GOLDEN) >>> 0); let i3 = x & MASK;

  // Phase 2 — 4 interleaved dependent read-modify-write walks.
  for (let s = 0; s < PER; s++) {
    a0 = mix((a0 ^ buf[i0]!) >>> 0); buf[i0] = (a0 + s) >>> 0; i0 = a0 & MASK;
    a1 = mix((a1 ^ buf[i1]!) >>> 0); buf[i1] = (a1 + s) >>> 0; i1 = a1 & MASK;
    a2 = mix((a2 ^ buf[i2]!) >>> 0); buf[i2] = (a2 + s) >>> 0; i2 = a2 & MASK;
    a3 = mix((a3 ^ buf[i3]!) >>> 0); buf[i3] = (a3 + s) >>> 0; i3 = a3 & MASK;
  }

  // Phase 3 — finalize. The 4 chain accumulators transitively depend on the
  // full walk over the whole buffer, so hashing them (plus h and the seed)
  // binds the output to the memory-hard work.
  const fin = new Uint8Array(32 + 4 + 16);
  fin.set(seed, 0);
  writeU32be(fin, 32, h);
  writeU32be(fin, 36, a0);
  writeU32be(fin, 40, a1);
  writeU32be(fin, 44, a2);
  writeU32be(fin, 48, a3);
  return sha256(fin);
}

/** Exposed for test-vector generation and cross-checks. */
export const SANDGLASS_PARAMS = { W, STEPS, CHAINS } as const;
