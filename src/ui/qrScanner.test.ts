import { describe, expect, it } from 'vitest';
import { parseScannedAddress } from './qrScanner.js';

const ADDR = 'a'.repeat(64);
const MIXED = 'ABCDEF' + '0'.repeat(58); // 64 hex chars, upper + lower

describe('parseScannedAddress', () => {
  it('extracts the address from a share URL', () => {
    expect(parseScannedAddress(`https://browsercoin.org/?to=${ADDR}`)).toBe(ADDR);
  });

  it('accepts a bare 64-hex address', () => {
    expect(parseScannedAddress(ADDR)).toBe(ADDR);
  });

  it('lowercases the address', () => {
    expect(parseScannedAddress(`https://x/?to=${MIXED}`)).toBe(MIXED.toLowerCase());
    expect(parseScannedAddress(MIXED)).toBe(MIXED.toLowerCase());
  });

  it('trims surrounding whitespace', () => {
    expect(parseScannedAddress(`  ${ADDR}  `)).toBe(ADDR);
  });

  it('returns null for junk text', () => {
    expect(parseScannedAddress('hello world')).toBeNull();
  });

  it('returns null for a wrong-length hex string', () => {
    expect(parseScannedAddress('abc123')).toBeNull();
    expect(parseScannedAddress('a'.repeat(63))).toBeNull();
    expect(parseScannedAddress('a'.repeat(65))).toBeNull();
  });

  it('returns null for a URL without a to param', () => {
    expect(parseScannedAddress('https://browsercoin.org/wallet')).toBeNull();
  });

  it('returns null when the to param is not a valid address', () => {
    expect(parseScannedAddress('https://browsercoin.org/?to=notanaddress')).toBeNull();
  });
});
