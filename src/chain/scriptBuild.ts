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
 * Bare hash lock: `OP_SHA256 <hash> OP_EQUAL`. Spendable by **anyone** who can
 * present a preimage whose SHA-256 equals `sha256Hash` — and because a redeem
 * reveals that preimage publicly, a watcher can copy it and redirect the coins
 * by paying a higher fee. DEMONSTRATION ONLY: never use it to pay a specific
 * party. Use {@link hashlockSigScript} for anything real.
 */
export function hashlockScript(sha256Hash: Uint8Array): Uint8Array {
  return concat(new Uint8Array([Op.OP_SHA256]), pushData(sha256Hash), new Uint8Array([Op.OP_EQUAL]));
}

/**
 * Hash-locked payment (HTLC leaf): `OP_SHA256 <hash> OP_EQUALVERIFY <pubkey>
 * OP_CHECKSIG`. Spendable only by the holder of `pubkey` who ALSO reveals the
 * preimage. The signature commits to the spend (destination, amount, fee via the
 * redeem sighash), so revealing the preimage no longer lets a front-runner
 * redirect the funds — this is the safe building block for atomic swaps.
 * Witness order: `[signature, preimage]`.
 */
export function hashlockSigScript(sha256Hash: Uint8Array, pubkey: Uint8Array): Uint8Array {
  return concat(
    new Uint8Array([Op.OP_SHA256]),
    pushData(sha256Hash),
    new Uint8Array([Op.OP_EQUALVERIFY]),
    pushData(pubkey),
    new Uint8Array([Op.OP_CHECKSIG]),
  );
}

/** Minimal little-endian script-number encoding (Bitcoin CScriptNum), for locktimes etc. */
export function encodeScriptNum(n: number): Uint8Array {
  if (n === 0) return new Uint8Array(0);
  const neg = n < 0;
  let v = Math.abs(n);
  const bytes: number[] = [];
  while (v > 0) { bytes.push(v & 0xff); v = Math.floor(v / 256); }
  if (bytes[bytes.length - 1]! & 0x80) bytes.push(neg ? 0x80 : 0x00);
  else if (neg) bytes[bytes.length - 1]! |= 0x80;
  return new Uint8Array(bytes);
}

/**
 * Full atomic-swap HTLC. Two spend paths:
 *   • claim  — recipient reveals the secret AND signs (`witness = [sig, preimage, 1]`)
 *   • refund — after `locktime`, the sender signs    (`witness = [sig, 0]`)
 *
 * ```
 * OP_IF
 *   OP_SHA256 <h> OP_EQUALVERIFY <recipientPubkey> OP_CHECKSIG
 * OP_ELSE
 *   <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <senderPubkey> OP_CHECKSIG
 * OP_ENDIF
 * ```
 * `locktime` is a block height (< 500,000,000) or a unix timestamp (≥), compared
 * against the redeeming block's height / median-time-past. Sharing one `h` across
 * two chains makes an atomic swap: claiming on one chain reveals the secret that
 * unlocks the other.
 */
export function htlcScript(
  sha256Hash: Uint8Array,
  recipientPubkey: Uint8Array,
  locktime: number,
  senderPubkey: Uint8Array,
): Uint8Array {
  return concat(
    new Uint8Array([Op.OP_IF]),
    new Uint8Array([Op.OP_SHA256]), pushData(sha256Hash), new Uint8Array([Op.OP_EQUALVERIFY]),
    pushData(recipientPubkey), new Uint8Array([Op.OP_CHECKSIG]),
    new Uint8Array([Op.OP_ELSE]),
    pushData(encodeScriptNum(locktime)), new Uint8Array([Op.OP_CHECKLOCKTIMEVERIFY, Op.OP_DROP]),
    pushData(senderPubkey), new Uint8Array([Op.OP_CHECKSIG]),
    new Uint8Array([Op.OP_ENDIF]),
  );
}
