import { describe, it, expect } from 'vitest';
import vectors from './sandglass.vectors.json';
import { sandglassHash, walkStateForTest } from './sandglass.js';
import { sha256 } from './hash.js';
import { hexToBytes, bytesToHex } from '../util/binary.js';

// Deliberately re-implemented here (NOT imported) to reproduce the OLD, broken
// 32-bit seed fold for the regression guard below.
function mix32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}
function u32be(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}
/** The vulnerable pre-fix fill state: the whole 256-bit seed folded to 32 bits. */
function oldFold32(seed: Uint8Array): number {
  let h = 0x9e3779b9;
  for (let i = 0; i < 8; i++) h = mix32((h ^ u32be(seed, i * 4)) >>> 0);
  return h >>> 0;
}
function headerWithNonce(nonce: number): Uint8Array {
  const b = new Uint8Array(148); // nonce lives at bytes 112..116 (encodeHeader layout)
  b[112] = (nonce >>> 24) & 0xff;
  b[113] = (nonce >>> 16) & 0xff;
  b[114] = (nonce >>> 8) & 0xff;
  b[115] = nonce & 0xff;
  return b;
}

describe('sandglass v3 PoW hash', () => {
  it('reproduces the frozen test vectors bit-for-bit', () => {
    // Consensus anchor: any implementation of the hash must match these exact
    // digests. A single wrong bit fails here — this is the "can't silently ship
    // a broken port" guard.
    expect(vectors.length).toBeGreaterThanOrEqual(5);
    for (const v of vectors) {
      expect(bytesToHex(sandglassHash(hexToBytes(v.headerHex)))).toBe(v.digestHex);
    }
  });

  it('is deterministic — same input yields the same digest', () => {
    const b = hexToBytes(vectors[0]!.headerHex);
    expect(bytesToHex(sandglassHash(b))).toBe(bytesToHex(sandglassHash(b)));
  });

  it('produces a 32-byte digest', () => {
    expect(sandglassHash(hexToBytes(vectors[0]!.headerHex)).length).toBe(32);
  });

  it('avalanches — a one-nonce change gives an unrelated digest', () => {
    // vectors[0] and vectors[1] differ only in nonce
    expect(vectors[0]!.digestHex).not.toBe(vectors[1]!.digestHex);
  });

  it('keeps the WALK keyed on the FULL 256-bit seed (guards against 32-bit-fold regression)', () => {
    // The original bug: the whole seed was folded to 32 bits before the expensive
    // fill+walk, leaving only 2^32 distinct walks (a reusable precompute table).
    // NOTE: the *digest* differs for such seeds either way (the finalize hashes
    // the full seed), so this must inspect the PRE-FINALIZE walk state — that's
    // exactly what the attack reused. Find two DISTINCT seeds colliding under the
    // old 32-bit fold; under a regression they'd produce IDENTICAL walk state and
    // this fails. A 32-bit birthday collision appears within a few × 2^16 tries.
    const seen = new Map<number, Uint8Array>();
    let seedA: Uint8Array | null = null;
    let seedB: Uint8Array | null = null;
    for (let nonce = 0; nonce < 400_000 && seedB === null; nonce++) {
      const seed = sha256(headerWithNonce(nonce));
      const fold = oldFold32(seed);
      const prev = seen.get(fold);
      if (prev) { seedA = prev; seedB = seed; } else seen.set(fold, seed);
    }
    expect(seedB, 'expected a 32-bit fold collision within the search budget').not.toBeNull();
    // Same old-fold, different full seeds → the memory-hard walk state MUST differ.
    expect(walkStateForTest(seedA!)).not.toEqual(walkStateForTest(seedB!));
    // Sanity: the two seeds really do collide under the (now-dead) 32-bit fold.
    expect(oldFold32(seedA!)).toBe(oldFold32(seedB!));
  });
});
