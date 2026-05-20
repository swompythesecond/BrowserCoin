import { sha256 as nobleSha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '../util/binary.js';

/**
 * Synchronous SHA-256 — used inside the mining hot loop and anywhere callers
 * don't want to await. Backed by @noble/hashes (pure JS, audited, ~constant-time).
 *
 * We deliberately do NOT use crypto.subtle.digest here because it's async-only;
 * paying the microtask cost per nonce attempt would kill mining throughput.
 */
export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function sha256d(data: Uint8Array): Uint8Array {
  return nobleSha256(nobleSha256(data));
}

export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}
