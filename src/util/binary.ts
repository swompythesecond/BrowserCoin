/** Hex / binary helpers — small, dependency-free. */

const HEX_CHARS = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    s += HEX_CHARS[b >>> 4]! + HEX_CHARS[b & 0x0f]!;
  }
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (hex.length % 2 !== 0) throw new Error('invalid hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const h = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(h)) throw new Error('invalid hex char');
    out[i] = h;
  }
  return out;
}

export function concat(...arrs: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function u16be(n: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = (n >>> 8) & 0xff;
  b[1] = n & 0xff;
  return b;
}

export function readU16be(b: Uint8Array, off: number): number {
  return ((b[off]! << 8) | b[off + 1]!) & 0xffff;
}

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

export function readU32be(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

export function u64be(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return b;
}

export function readU64be(b: Uint8Array, off: number): bigint {
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(b[off + i]!);
  return n;
}

/** Compact difficulty: 4-byte (exponent, 3-byte mantissa) — similar idea to Bitcoin's "bits". */
export function compactToTarget(compact: number): bigint {
  const exp = (compact >>> 24) & 0xff;
  const mant = BigInt(compact & 0x00ff_ffff);
  if (exp <= 3) return mant >> BigInt(8 * (3 - exp));
  return mant << BigInt(8 * (exp - 3));
}

export function targetToCompact(target: bigint): number {
  if (target <= 0n) return 0;
  let exp = 0;
  let t = target;
  while (t > 0xff_ffffn) {
    t >>= 8n;
    exp++;
  }
  let mant = Number(t);
  exp += 3;
  // If high bit of mantissa is set, shift down so it's not interpreted as a sign bit.
  if (mant & 0x80_0000) {
    mant >>= 8;
    exp += 1;
  }
  return ((exp & 0xff) << 24) | (mant & 0x00ff_ffff);
}

/** Compare two equal-length byte arrays lexicographically (big-endian numeric order). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

/** Test if a hash byte-array meets a numeric target (hash < target). */
export function hashMeetsTarget(hash: Uint8Array, target: bigint): boolean {
  let h = 0n;
  for (let i = 0; i < hash.length; i++) h = (h << 8n) | BigInt(hash[i]!);
  return h < target;
}
