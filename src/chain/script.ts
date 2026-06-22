/**
 * BrowserCoin Script — a tiny, non-Turing-complete stack machine for spend
 * conditions (hash locks, time locks, multisig, and compositions of them).
 *
 * Design goals, in priority order:
 *   1. Determinism. Every browser MUST agree on the result of evaluating a
 *      script, byte-for-byte. No floats, no wall-clock, no iteration order
 *      dependence. All "time" comes from the block context passed in.
 *   2. Guaranteed termination with no DoS surface. There are NO loops and NO
 *      backward jumps in the language, so a script's cost is bounded by its
 *      length. Hard caps on script size, stack depth, push size and op count
 *      give belt-and-suspenders bounds. There is no "gas".
 *   3. Smallness. The opcode set is exactly what the headline use cases need
 *      (atomic swaps, multisig, vaults, escrow) and nothing more.
 *
 * Model (P2SH-style): a coin is locked under sha256(redeemScript). To spend it
 * the redeemer reveals the redeemScript plus a `witness` — an ordered list of
 * data items (signatures, hash preimages, branch selectors) pushed onto the
 * stack before the script runs. The caller is responsible for checking that
 * sha256(redeemScript) matches the committed hash BEFORE calling evalScript.
 *
 * Signatures are Ed25519 over `ctx.sighash` (a 32-byte commitment to the redeem
 * transaction's spend details — see transaction.ts). This binds a witness to a
 * specific spend so a valid signature can't be replayed to redirect funds.
 */
import { sha256 } from '../crypto/hash.js';
import { verify as edVerify } from '../crypto/keys.js';
import { compareBytes } from '../util/binary.js';

// ---------------------------------------------------------------------------
// Opcodes. Numbering loosely follows Bitcoin where an analogue exists, purely
// for familiarity — there is no wire compatibility with Bitcoin.
// ---------------------------------------------------------------------------
export const Op = {
  // Push value.
  OP_0: 0x00, // push empty array (also the canonical "false")
  // 0x01..0x4b: push that many literal bytes (handled numerically, no const)
  OP_PUSHDATA1: 0x4c, // next byte = length, then <length> bytes
  OP_1: 0x51,
  OP_2: 0x52,
  OP_3: 0x53,
  OP_4: 0x54,
  OP_5: 0x55,
  OP_6: 0x56,
  OP_7: 0x57,
  OP_8: 0x58,
  OP_9: 0x59,
  OP_10: 0x5a,
  OP_11: 0x5b,
  OP_12: 0x5c,
  OP_13: 0x5d,
  OP_14: 0x5e,
  OP_15: 0x5f,
  OP_16: 0x60,
  // Flow control.
  OP_IF: 0x63,
  OP_ELSE: 0x67,
  OP_ENDIF: 0x68,
  OP_VERIFY: 0x69,
  // Stack ops.
  OP_DROP: 0x75,
  OP_DUP: 0x76,
  OP_SWAP: 0x7c,
  // Bitwise / comparison.
  OP_EQUAL: 0x87,
  OP_EQUALVERIFY: 0x88,
  // Crypto.
  OP_SHA256: 0xa8,
  OP_CHECKSIG: 0xac,
  OP_CHECKSIGVERIFY: 0xad,
  OP_CHECKMULTISIG: 0xae,
  // Locktime.
  OP_CHECKLOCKTIMEVERIFY: 0xb1, // (Bitcoin's OP_NOP2 slot)
  // Reserved no-ops (the OP_NOP family). These do NOTHING today, on purpose:
  // reserving them now means a FUTURE upgrade can give one a VERIFY-style
  // meaning as a SOFT fork instead of a hard fork. Old nodes keep treating it
  // as a no-op and accept the spend; new nodes enforce the added check (which
  // can only abort a spend, never enable one). That is exactly how Bitcoin
  // shipped CLTV and CSV. Any opcode NOT reserved here still fails closed, so
  // we don't accidentally accept genuinely-unknown bytecode.
  OP_NOP: 0x61,
  OP_NOP1: 0xb0,
  OP_NOP3: 0xb2, // reserved for a future relative-timelock (CSV-style) soft fork
  OP_NOP4: 0xb3,
  OP_NOP5: 0xb4,
  OP_NOP6: 0xb5,
  OP_NOP7: 0xb6,
  OP_NOP8: 0xb7,
  OP_NOP9: 0xb8,
  OP_NOP10: 0xb9,
} as const;

const OP_PUSHDATA1 = Op.OP_PUSHDATA1;
const OP_PUSH_MAX = 0x4b; // largest direct-push opcode (push 0x01..0x4b bytes)

/** Opcodes intentionally treated as no-ops, reserved for future soft forks. */
const RESERVED_NOPS: ReadonlySet<number> = new Set([
  Op.OP_NOP, Op.OP_NOP1, Op.OP_NOP3, Op.OP_NOP4, Op.OP_NOP5,
  Op.OP_NOP6, Op.OP_NOP7, Op.OP_NOP8, Op.OP_NOP9, Op.OP_NOP10,
]);

// ---------------------------------------------------------------------------
// Limits. Chosen comfortably above what the real scripts need, low enough that
// the absolute worst case is trivially cheap to evaluate.
// ---------------------------------------------------------------------------
export const MAX_SCRIPT_BYTES = 1024;
export const MAX_WITNESS_ITEMS = 64;
export const MAX_PUSH_BYTES = 255; // also caps witness item size
export const MAX_STACK_SIZE = 256;
export const MAX_OPS = 201; // non-push opcodes, like Bitcoin
export const MAX_MULTISIG_KEYS = 16;
/** Locktimes below this are block heights; at or above, unix timestamps. */
export const LOCKTIME_THRESHOLD = 500_000_000;

/** Everything the interpreter needs to know about the spend it is authorizing. */
export interface ScriptContext {
  /** 32-byte message that OP_CHECKSIG / OP_CHECKMULTISIG verify signatures over. */
  sighash: Uint8Array;
  /** Height of the block that would include the redeeming transaction. */
  blockHeight: number;
  /** Median-time-past at that block (used for timestamp-style CLTV). */
  blockMtp: number;
}

export interface ScriptResult {
  ok: boolean;
  error?: string;
}

/** The committed hash for a redeem script: sha256(script). */
export function scriptHash(script: Uint8Array): Uint8Array {
  return sha256(script);
}

/** Truthiness: any non-zero byte is true; empty (or all-zero) is false. */
function isTruthy(item: Uint8Array): boolean {
  for (let i = 0; i < item.length; i++) if (item[i] !== 0) return true;
  return false;
}

/**
 * Decode a stack item as a non-negative big-endian integer with a strict
 * minimal encoding (no leading zero bytes; the empty array is 0). Returns null
 * on any malleable/oversized encoding so callers can fail closed.
 */
function decodeNum(item: Uint8Array, maxBytes: number): bigint | null {
  if (item.length > maxBytes) return null;
  if (item.length === 0) return 0n;
  if (item[0] === 0) return null; // non-minimal (leading zero)
  let n = 0n;
  for (let i = 0; i < item.length; i++) n = (n << 8n) | BigInt(item[i]!);
  return n;
}

/** Encode a non-negative integer as a minimal big-endian stack item. */
export function encodeNum(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('encodeNum: negative');
  if (n === 0n) return new Uint8Array(0);
  const bytes: number[] = [];
  let v = n;
  while (v > 0n) {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return new Uint8Array(bytes);
}

/**
 * Evaluate `witness` (initial stack) followed by `redeemScript`. Returns
 * ok:true iff execution completed with a truthy value on top of the stack.
 *
 * The caller MUST have already verified sha256(redeemScript) === committed hash.
 */
export function evalScript(
  redeemScript: Uint8Array,
  witness: Uint8Array[],
  ctx: ScriptContext,
): ScriptResult {
  if (redeemScript.length > MAX_SCRIPT_BYTES) return { ok: false, error: 'script too long' };
  if (witness.length > MAX_WITNESS_ITEMS) return { ok: false, error: 'too many witness items' };

  const stack: Uint8Array[] = [];
  // Seed the stack from the witness (pure data, never executed as code).
  for (const item of witness) {
    if (item.length > MAX_PUSH_BYTES) return { ok: false, error: 'witness item too large' };
    stack.push(item);
  }
  if (stack.length > MAX_STACK_SIZE) return { ok: false, error: 'stack overflow' };

  // condStack tracks IF/ELSE nesting; we execute only when every entry is true.
  const condStack: boolean[] = [];
  const executing = (): boolean => {
    for (let i = 0; i < condStack.length; i++) if (!condStack[i]) return false;
    return true;
  };

  let opCount = 0;
  let pc = 0;
  const fail = (error: string): ScriptResult => ({ ok: false, error });

  while (pc < redeemScript.length) {
    const op = redeemScript[pc]!;
    pc += 1;
    const exec = executing();

    // --- Push opcodes. Parsed even when not executing, to advance the pc. ---
    if (op <= OP_PUSH_MAX || op === OP_PUSHDATA1) {
      let len: number;
      if (op === OP_PUSHDATA1) {
        if (pc >= redeemScript.length) return fail('truncated pushdata length');
        len = redeemScript[pc]!;
        pc += 1;
      } else {
        len = op; // OP_0 → 0; direct push 0x01..0x4b → that many bytes
      }
      if (len > MAX_PUSH_BYTES) return fail('push too large');
      if (pc + len > redeemScript.length) return fail('truncated push');
      const data = redeemScript.slice(pc, pc + len);
      pc += len;
      if (exec) {
        stack.push(data);
        if (stack.length > MAX_STACK_SIZE) return fail('stack overflow');
      }
      continue;
    }

    // --- Flow control runs even when not executing (to balance IF/ENDIF). ---
    if (op === Op.OP_IF) {
      let v = false;
      if (exec) {
        if (stack.length < 1) return fail('OP_IF: empty stack');
        v = isTruthy(stack.pop()!);
      }
      condStack.push(v);
      continue;
    }
    if (op === Op.OP_ELSE) {
      if (condStack.length === 0) return fail('OP_ELSE without OP_IF');
      condStack[condStack.length - 1] = !condStack[condStack.length - 1];
      continue;
    }
    if (op === Op.OP_ENDIF) {
      if (condStack.length === 0) return fail('OP_ENDIF without OP_IF');
      condStack.pop();
      continue;
    }

    // Everything below is skipped while in a non-taken branch.
    if (!exec) continue;

    if (++opCount > MAX_OPS) return fail('op count exceeded');

    // Reserved no-ops: consume the opcode and do nothing (soft-fork upgrade slot).
    if (RESERVED_NOPS.has(op)) continue;

    switch (op) {
      case Op.OP_1:
      case Op.OP_2:
      case Op.OP_3:
      case Op.OP_4:
      case Op.OP_5:
      case Op.OP_6:
      case Op.OP_7:
      case Op.OP_8:
      case Op.OP_9:
      case Op.OP_10:
      case Op.OP_11:
      case Op.OP_12:
      case Op.OP_13:
      case Op.OP_14:
      case Op.OP_15:
      case Op.OP_16: {
        stack.push(encodeNum(BigInt(op - 0x50)));
        if (stack.length > MAX_STACK_SIZE) return fail('stack overflow');
        break;
      }
      case Op.OP_VERIFY: {
        if (stack.length < 1) return fail('OP_VERIFY: empty stack');
        if (!isTruthy(stack.pop()!)) return fail('OP_VERIFY failed');
        break;
      }
      case Op.OP_DROP: {
        if (stack.length < 1) return fail('OP_DROP: empty stack');
        stack.pop();
        break;
      }
      case Op.OP_DUP: {
        if (stack.length < 1) return fail('OP_DUP: empty stack');
        stack.push(stack[stack.length - 1]!);
        if (stack.length > MAX_STACK_SIZE) return fail('stack overflow');
        break;
      }
      case Op.OP_SWAP: {
        if (stack.length < 2) return fail('OP_SWAP: need 2 items');
        const a = stack[stack.length - 1]!;
        stack[stack.length - 1] = stack[stack.length - 2]!;
        stack[stack.length - 2] = a;
        break;
      }
      case Op.OP_EQUAL:
      case Op.OP_EQUALVERIFY: {
        if (stack.length < 2) return fail('OP_EQUAL: need 2 items');
        const a = stack.pop()!;
        const b = stack.pop()!;
        const eq = a.length === b.length && compareBytes(a, b) === 0;
        if (op === Op.OP_EQUALVERIFY) {
          if (!eq) return fail('OP_EQUALVERIFY failed');
        } else {
          stack.push(eq ? encodeNum(1n) : encodeNum(0n));
        }
        break;
      }
      case Op.OP_SHA256: {
        if (stack.length < 1) return fail('OP_SHA256: empty stack');
        stack.push(sha256(stack.pop()!));
        break;
      }
      case Op.OP_CHECKSIG:
      case Op.OP_CHECKSIGVERIFY: {
        if (stack.length < 2) return fail('OP_CHECKSIG: need sig + pubkey');
        const pubkey = stack.pop()!;
        const sig = stack.pop()!;
        const valid = pubkey.length === 32 && sig.length === 64 && edVerify(sig, ctx.sighash, pubkey);
        if (op === Op.OP_CHECKSIGVERIFY) {
          if (!valid) return fail('OP_CHECKSIGVERIFY failed');
        } else {
          stack.push(valid ? encodeNum(1n) : encodeNum(0n));
        }
        break;
      }
      case Op.OP_CHECKMULTISIG: {
        const r = opCheckMultisig(stack, ctx);
        if (r) return fail(r);
        break;
      }
      case Op.OP_CHECKLOCKTIMEVERIFY: {
        if (stack.length < 1) return fail('OP_CLTV: empty stack');
        const req = decodeNum(stack[stack.length - 1]!, 5); // up to 5 bytes (heights + timestamps)
        if (req === null) return fail('OP_CLTV: bad number');
        // Height-based vs time-based must agree on which clock to compare against.
        const chainVal = req < BigInt(LOCKTIME_THRESHOLD)
          ? BigInt(ctx.blockHeight)
          : BigInt(ctx.blockMtp);
        if (chainVal < req) return fail('OP_CLTV: locktime not reached');
        // BIP65 semantics: leave the value on the stack (script usually DROPs it).
        break;
      }
      default:
        return fail(`unknown opcode 0x${op.toString(16)}`);
    }
  }

  if (condStack.length !== 0) return fail('unbalanced OP_IF/OP_ENDIF');
  if (stack.length === 0) return fail('empty stack at end');
  if (!isTruthy(stack[stack.length - 1]!)) return { ok: false, error: 'top of stack is false' };
  return { ok: true };
}

/**
 * m-of-n multisig. Stack layout (bottom→top), matching how the items are pushed:
 *   <sig_1> ... <sig_m> <m> <pub_1> ... <pub_n> <n>
 * We deliberately do NOT replicate Bitcoin's spurious extra-element bug. Each
 * signature must match a distinct pubkey, scanned left-to-right (a later sig
 * cannot reuse an earlier pubkey), which forces sigs to be in pubkey order.
 */
function opCheckMultisig(stack: Uint8Array[], ctx: ScriptContext): string | null {
  if (stack.length < 1) return 'OP_CHECKMULTISIG: empty stack';
  const n = decodeNum(stack.pop()!, 1);
  if (n === null || n < 1n || n > BigInt(MAX_MULTISIG_KEYS)) return 'OP_CHECKMULTISIG: bad n';
  const nn = Number(n);
  if (stack.length < nn + 1) return 'OP_CHECKMULTISIG: not enough pubkeys';
  const pubkeys: Uint8Array[] = [];
  for (let i = 0; i < nn; i++) pubkeys.unshift(stack.pop()!); // restores pub_1..pub_n order

  const m = decodeNum(stack.pop()!, 1);
  if (m === null || m < 1n || m > n) return 'OP_CHECKMULTISIG: bad m';
  const mm = Number(m);
  if (stack.length < mm) return 'OP_CHECKMULTISIG: not enough signatures';
  const sigs: Uint8Array[] = [];
  for (let i = 0; i < mm; i++) sigs.unshift(stack.pop()!); // restores sig_1..sig_m order

  // Match each signature to a pubkey, advancing through the pubkey list.
  let keyIdx = 0;
  for (const sig of sigs) {
    let matched = false;
    while (keyIdx < pubkeys.length) {
      const pk = pubkeys[keyIdx]!;
      keyIdx += 1;
      if (pk.length === 32 && sig.length === 64 && edVerify(sig, ctx.sighash, pk)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      stack.push(encodeNum(0n));
      return null;
    }
  }
  stack.push(encodeNum(1n));
  return null;
}
