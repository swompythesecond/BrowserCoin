import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '../util/binary.js';
import { sha256 } from './hash.js';

// @noble/ed25519 v2 ships without a SHA-512 implementation; sync APIs require
// wiring one up. We use @noble/hashes for this. Variadic arg shape matches the
// Sha512FnSync interface.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

export type PrivateKey = Uint8Array; // 32 bytes
export type PublicKey = Uint8Array;  // 32 bytes
export type Signature = Uint8Array;  // 64 bytes

export interface KeyPair {
  privateKey: PrivateKey;
  publicKey: PublicKey;
  address: string; // hex of pubkey — addresses ARE pubkeys in our chain (account model)
}

export function generateKeyPair(): KeyPair {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    address: bytesToHex(publicKey),
  };
}

export function fromPrivateKey(privateKey: PrivateKey): KeyPair {
  if (privateKey.length !== 32) throw new Error('private key must be 32 bytes');
  const publicKey = ed.getPublicKey(privateKey);
  return { privateKey, publicKey, address: bytesToHex(publicKey) };
}

export function sign(message: Uint8Array, privateKey: PrivateKey): Signature {
  return ed.sign(message, privateKey) as Uint8Array;
}

export function verify(signature: Signature, message: Uint8Array, publicKey: PublicKey): boolean {
  try {
    return ed.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Short, human-friendly fingerprint of an address — first 8 bytes of sha256(pubkey),
 * hex-encoded. Useful for display in tables. NOT used for cryptographic checks.
 */
export function addressFingerprint(publicKey: PublicKey): string {
  return bytesToHex(sha256(publicKey).slice(0, 8));
}

export function addressFromHex(hex: string): PublicKey {
  const b = hexToBytes(hex);
  if (b.length !== 32) throw new Error('address must be 32 bytes');
  return b;
}
