/**
 * Helpers for assembling redeem scripts from templates. Pure byte construction —
 * mirrors the push encoding the interpreter in `script.ts` expects. Used by the
 * in-app script builder (and handy in the dev docs).
 */
import { Op } from './script.js';
import { concat } from '../util/binary.js';

/** Encode a single data push using the smallest valid push opcode. */
export function pushData(data: Uint8Array): Uint8Array {
  if (data.length <= 0x4b) return concat(new Uint8Array([data.length]), data);
  if (data.length <= 0xff) return concat(new Uint8Array([Op.OP_PUSHDATA1, data.length]), data);
  // OP_PUSHDATA2: 2-byte little-endian length (matches script.ts reader).
  return concat(new Uint8Array([Op.OP_PUSHDATA2, data.length & 0xff, (data.length >> 8) & 0xff]), data);
}

/**
 * Hash lock: `OP_SHA256 <hash> OP_EQUAL`. Spendable by anyone who can present a
 * preimage whose SHA-256 equals `sha256Hash`.
 */
export function hashlockScript(sha256Hash: Uint8Array): Uint8Array {
  return concat(new Uint8Array([Op.OP_SHA256]), pushData(sha256Hash), new Uint8Array([Op.OP_EQUAL]));
}
