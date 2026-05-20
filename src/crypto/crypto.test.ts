import { describe, expect, it } from 'vitest';
import { fromPrivateKey, generateKeyPair, sign, verify } from './keys.js';
import { sha256 } from './hash.js';

describe('crypto', () => {
  it('generates 32-byte keypair and round-trips signatures', () => {
    const kp = generateKeyPair();
    expect(kp.privateKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.address.length).toBe(64); // hex of 32 bytes

    const msg = new TextEncoder().encode('hello BrowserCoin');
    const sig = sign(msg, kp.privateKey);
    expect(sig.length).toBe(64);
    expect(verify(sig, msg, kp.publicKey)).toBe(true);
  });

  it('rejects signatures from a different key', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const msg = new TextEncoder().encode('hi');
    const sig = sign(msg, a.privateKey);
    expect(verify(sig, msg, b.publicKey)).toBe(false);
  });

  it('rejects tampered messages', () => {
    const kp = generateKeyPair();
    const sig = sign(new TextEncoder().encode('hi'), kp.privateKey);
    expect(verify(sig, new TextEncoder().encode('hj'), kp.publicKey)).toBe(false);
  });

  it('restores keypair from private key', () => {
    const kp = generateKeyPair();
    const restored = fromPrivateKey(kp.privateKey);
    expect(restored.address).toBe(kp.address);
  });

  it('sha256 produces 32 bytes', () => {
    const h = sha256(new Uint8Array([1, 2, 3]));
    expect(h.length).toBe(32);
  });
});
