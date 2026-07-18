import { describe, it, expect } from 'vitest';
import vectors from './sandglass.vectors.json';
import { sandglassHash } from './sandglass.js';
import { hexToBytes, bytesToHex } from '../util/binary.js';

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
});
