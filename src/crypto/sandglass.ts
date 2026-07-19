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
/**
 * The memory-hard core: fill the 512 KiB buffer from the 256-bit seed and run
 * the 4-chain walk, returning the pre-finalize state (h + the 4 accumulators).
 * sandglassHash wraps this with the SHA-256 seed/finalize. Kept as its own
 * function so `walkStateForTest` can assert the walk is keyed on the FULL seed
 * (a keying regression here — e.g. folding the seed to 32 bits — would change
 * this state for seeds that used to collide, and the regression test would fail).
 */
function fillAndWalk(seed: Uint8Array): [number, number, number, number, number] {
  // The 8 words of the 256-bit seed.
  const sw = new Uint32Array(8);
  for (let i = 0; i < 8; i++) sw[i] = readU32be(seed, i * 4);

  // Phase 1 — fill. One seed word is injected on EVERY step (cyclically), so the
  // buffer — and therefore the entire walk that reads it — is keyed by all 256
  // seed bits, not by a low-entropy fold.
  //
  // This is the fix for a time-memory tradeoff: if the fill depended on only a
  // 32-bit state, there would be just 2^32 distinct walks, reusable across every
  // block forever. A farm could precompute a table (state -> walk result) and
  // skip the memory-hard walk entirely, defeating the whole design. With the full
  // seed mixed in, a precomputation table would need ~2^256 entries — infeasible.
  // Still chained (h_i depends on h_{i-1}), so there's no closed form / jump-ahead.
  let h = mix((sw[0]! ^ GOLDEN) >>> 0);
  for (let i = 0; i < W; i++) {
    h = mix((h + GOLDEN + sw[i & 7]!) >>> 0);
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

  return [h, a0, a1, a2, a3];
}

export function sandglassHash(headerBytes: Uint8Array): Uint8Array {
  const seed = sha256(headerBytes); // 32 bytes
  const [h, a0, a1, a2, a3] = fillAndWalk(seed);

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

/**
 * Test-only: the pre-finalize walk state (h + the 4 accumulators) for a seed.
 * Lets tests assert the memory-hard walk is keyed on the full 256-bit seed (two
 * seeds that only collided under the old 32-bit fold must now yield DIFFERENT
 * walk state). Not used in production.
 */
export function walkStateForTest(seed: Uint8Array): [number, number, number, number, number] {
  return fillAndWalk(seed);
}

/** Exposed for test-vector generation and cross-checks. */
export const SANDGLASS_PARAMS = { W, STEPS, CHAINS } as const;
