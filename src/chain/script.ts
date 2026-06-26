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
 *   3. A complete-enough opcode set. The language ships the classic Bitcoin
 *      opcode menu minus the disabled/structural ones, so the things people
 *      actually build (swaps, multisig, vaults, escrow, and variations) are
 *      expressible without ever needing another hard fork just to add an
 *      everyday opcode. Future *checks* ride the reserved OP_NOP slots as soft
 *      forks; only value-producing opcodes need a hard fork, which is why the
 *      value-producing set is shipped in full up front.
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
import { sha256, ripemd160, hash160 } from '../crypto/hash.js';
import { verify as edVerify } from '../crypto/keys.js';
import { compareBytes } from '../util/binary.js';

// ---------------------------------------------------------------------------
// Opcodes. Numbering follows Bitcoin where an analogue exists, purely for
// familiarity — there is no wire compatibility with Bitcoin.
// ---------------------------------------------------------------------------
export const Op = {
  // Push value.
  OP_0: 0x00, // push empty array (also the canonical "false")
  // 0x01..0x4b: push that many literal bytes (handled numerically, no const)
  OP_PUSHDATA1: 0x4c, // next byte = length, then <length> bytes
  OP_PUSHDATA2: 0x4d, // next 2 bytes (LE) = length, then <length> bytes
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
  OP_TOALTSTACK: 0x6b,
  OP_FROMALTSTACK: 0x6c,
  OP_2DUP: 0x6e,
  OP_IFDUP: 0x73,
  OP_DEPTH: 0x74,
  OP_DROP: 0x75,
  OP_DUP: 0x76,
  OP_NIP: 0x77,
  OP_OVER: 0x78,
  OP_PICK: 0x79,
  OP_ROLL: 0x7a,
  OP_ROT: 0x7b,
  OP_SWAP: 0x7c,
  OP_TUCK: 0x7d,
  // Splice (size only — the rest are disabled in Bitcoin and stay out here too).
  OP_SIZE: 0x82,
  // Comparison.
  OP_EQUAL: 0x87,
  OP_EQUALVERIFY: 0x88,
  // Arithmetic (operands limited to MAX_NUM_BYTES; OP_MUL/DIV/MOD stay disabled).
  OP_1ADD: 0x8b,
  OP_1SUB: 0x8c,
  OP_NEGATE: 0x8f,
  OP_ABS: 0x90,
  OP_NOT: 0x91,
  OP_0NOTEQUAL: 0x92,
  OP_ADD: 0x93,
  OP_SUB: 0x94,
  OP_BOOLAND: 0x9a,
  OP_BOOLOR: 0x9b,
  OP_NUMEQUAL: 0x9c,
  OP_NUMEQUALVERIFY: 0x9d,
  OP_NUMNOTEQUAL: 0x9e,
  OP_LESSTHAN: 0x9f,
  OP_GREATERTHAN: 0xa0,
  OP_LESSTHANOREQUAL: 0xa1,
  OP_GREATERTHANOREQUAL: 0xa2,
  OP_MIN: 0xa3,
  OP_MAX: 0xa4,
  OP_WITHIN: 0xa5,
  // Crypto / hashing.
  OP_RIPEMD160: 0xa6,
  OP_SHA256: 0xa8,
  OP_HASH160: 0xa9,
  OP_HASH256: 0xaa,
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
const OP_PUSHDATA2 = Op.OP_PUSHDATA2;
const OP_PUSH_MAX = 0x4b; // largest direct-push opcode (push 0x01..0x4b bytes)

/** Opcodes intentionally treated as no-ops, reserved for future soft forks. */
const RESERVED_NOPS: ReadonlySet<number> = new Set([
  Op.OP_NOP, Op.OP_NOP1, Op.OP_NOP3, Op.OP_NOP4, Op.OP_NOP5,
  Op.OP_NOP6, Op.OP_NOP7, Op.OP_NOP8, Op.OP_NOP9, Op.OP_NOP10,
]);

// ---------------------------------------------------------------------------
// Limits. Chosen to match Bitcoin's so we never need a hard fork just to fit a
// slightly bigger script: RAISING any of these later would be a hard fork
// (old nodes would reject a script new nodes accept), while lowering them is a
// soft fork. So they are set generously up front.
// ---------------------------------------------------------------------------
export const MAX_SCRIPT_BYTES = 10_000;
export const MAX_WITNESS_ITEMS = 100;
export const MAX_PUSH_BYTES = 520; // also caps witness item size
export const MAX_STACK_SIZE = 1000; // main stack + alt stack combined
export const MAX_OPS = 201; // non-push opcodes, like Bitcoin
export const MAX_MULTISIG_KEYS = 20;
/** Max byte length of an integer operand to the arithmetic opcodes (like Bitcoin). */
export const MAX_NUM_BYTES = 4;
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

/**
 * Truthiness (Bitcoin's CastToBool): any non-zero byte is true, EXCEPT a lone
 * sign bit on the most-significant byte (negative zero), which is false.
 */
function isTruthy(item: Uint8Array): boolean {
  for (let i = 0; i < item.length; i++) {
    if (item[i] !== 0) {
      // Negative zero: only the sign bit of the top byte is set.
      if (i === item.length - 1 && item[i] === 0x80) return false;
      return true;
    }
  }
  return false;
}

/**
 * Decode a stack item as a signed integer using Bitcoin's CScriptNum encoding:
 * little-endian, sign-magnitude (high bit of the most-significant byte is the
 * sign), empty array is 0, strict minimal encoding required. Returns null on any
 * over-long or non-minimal encoding so callers can fail closed.
 */
function decodeNum(item: Uint8Array, maxBytes: number): bigint | null {
  if (item.length > maxBytes) return null;
  if (item.length === 0) return 0n;
  const top = item[item.length - 1]!;
  // Minimal-encoding check: the top byte must carry magnitude, unless it is a
  // sign byte made necessary by the second-from-top byte's high bit.
  if ((top & 0x7f) === 0) {
    if (item.length <= 1 || (item[item.length - 2]! & 0x80) === 0) return null;
  }
  let result = 0n;
  for (let i = 0; i < item.length; i++) result |= BigInt(item[i]!) << (8n * BigInt(i));
  const signBit = 1n << (8n * BigInt(item.length) - 1n);
  if (result & signBit) result = -(result - signBit);
  return result;
}

/** Encode a signed integer as a minimal little-endian sign-magnitude stack item. */
export function encodeNum(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(0);
  const neg = value < 0n;
  let abs = neg ? -value : value;
  const bytes: number[] = [];
  while (abs > 0n) {
    bytes.push(Number(abs & 0xffn));
    abs >>= 8n;
  }
  if ((bytes[bytes.length - 1]! & 0x80) !== 0) bytes.push(neg ? 0x80 : 0x00);
  else if (neg) bytes[bytes.length - 1]! |= 0x80;
  return Uint8Array.from(bytes);
}

const ONE = encodeNum(1n);
const ZERO = encodeNum(0n);
const boolItem = (b: boolean): Uint8Array => (b ? ONE : ZERO);

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
  const alt: Uint8Array[] = [];
  // Seed the stack from the witness (pure data, never executed as code).
  for (const item of witness) {
    if (item.length > MAX_PUSH_BYTES) return { ok: false, error: 'witness item too large' };
    stack.push(item);
  }

  // condStack tracks IF/ELSE nesting; we execute only when every entry is true.
  const condStack: boolean[] = [];
  const executing = (): boolean => {
    for (let i = 0; i < condStack.length; i++) if (!condStack[i]) return false;
    return true;
  };

  let opCount = 0;
  let pc = 0;
  const fail = (error: string): ScriptResult => ({ ok: false, error });
  const overflowed = (): boolean => stack.length + alt.length > MAX_STACK_SIZE;

  if (overflowed()) return fail('stack overflow');

  while (pc < redeemScript.length) {
    const op = redeemScript[pc]!;
    pc += 1;
    const exec = executing();

    // --- Push opcodes. Parsed even when not executing, to advance the pc. ---
    if (op <= OP_PUSH_MAX || op === OP_PUSHDATA1 || op === OP_PUSHDATA2) {
      let len: number;
      if (op === OP_PUSHDATA1) {
        if (pc >= redeemScript.length) return fail('truncated pushdata length');
        len = redeemScript[pc]!;
        pc += 1;
      } else if (op === OP_PUSHDATA2) {
        if (pc + 1 >= redeemScript.length) return fail('truncated pushdata length');
        len = redeemScript[pc]! | (redeemScript[pc + 1]! << 8);
        pc += 2;
      } else {
        len = op; // OP_0 → 0; direct push 0x01..0x4b → that many bytes
      }
      if (len > MAX_PUSH_BYTES) return fail('push too large');
      if (pc + len > redeemScript.length) return fail('truncated push');
      const data = redeemScript.slice(pc, pc + len);
      pc += len;
      if (exec) {
        stack.push(data);
        if (overflowed()) return fail('stack overflow');
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

    // Helpers for the numeric opcodes.
    const popNum = (): bigint | null => {
      const it = stack.pop();
      if (it === undefined) return null;
      return decodeNum(it, MAX_NUM_BYTES);
    };

    switch (op) {
      case Op.OP_1: case Op.OP_2: case Op.OP_3: case Op.OP_4:
      case Op.OP_5: case Op.OP_6: case Op.OP_7: case Op.OP_8:
      case Op.OP_9: case Op.OP_10: case Op.OP_11: case Op.OP_12:
      case Op.OP_13: case Op.OP_14: case Op.OP_15: case Op.OP_16: {
        stack.push(encodeNum(BigInt(op - 0x50)));
        if (overflowed()) return fail('stack overflow');
        break;
      }
      case Op.OP_VERIFY: {
        if (stack.length < 1) return fail('OP_VERIFY: empty stack');
        if (!isTruthy(stack.pop()!)) return fail('OP_VERIFY failed');
        break;
      }

      // --- stack manipulation ---
      case Op.OP_TOALTSTACK: {
        if (stack.length < 1) return fail('OP_TOALTSTACK: empty stack');
        alt.push(stack.pop()!);
        break;
      }
      case Op.OP_FROMALTSTACK: {
        if (alt.length < 1) return fail('OP_FROMALTSTACK: empty alt stack');
        stack.push(alt.pop()!);
        break;
      }
      case Op.OP_DROP: {
        if (stack.length < 1) return fail('OP_DROP: empty stack');
        stack.pop();
        break;
      }
      case Op.OP_2DUP: {
        if (stack.length < 2) return fail('OP_2DUP: need 2 items');
        stack.push(stack[stack.length - 2]!, stack[stack.length - 1]!);
        if (overflowed()) return fail('stack overflow');
        break;
      }
      case Op.OP_DUP: {
        if (stack.length < 1) return fail('OP_DUP: empty stack');
        stack.push(stack[stack.length - 1]!);
        if (overflowed()) return fail('stack overflow');
        break;
      }
      case Op.OP_IFDUP: {
        if (stack.length < 1) return fail('OP_IFDUP: empty stack');
        if (isTruthy(stack[stack.length - 1]!)) {
          stack.push(stack[stack.length - 1]!);
          if (overflowed()) return fail('stack overflow');
        }
        break;
      }
      case Op.OP_DEPTH: {
        stack.push(encodeNum(BigInt(stack.length)));
        if (overflowed()) return fail('stack overflow');
        break;
      }
      case Op.OP_NIP: {
        if (stack.length < 2) return fail('OP_NIP: need 2 items');
        stack.splice(stack.length - 2, 1);
        break;
      }
      case Op.OP_OVER: {
        if (stack.length < 2) return fail('OP_OVER: need 2 items');
        stack.push(stack[stack.length - 2]!);
        if (overflowed()) return fail('stack overflow');
        break;
      }
      case Op.OP_PICK:
      case Op.OP_ROLL: {
        if (stack.length < 1) return fail('OP_PICK/ROLL: empty stack');
        const n = decodeNum(stack.pop()!, MAX_NUM_BYTES);
        if (n === null || n < 0n || n >= BigInt(stack.length)) return fail('OP_PICK/ROLL: bad index');
        const idx = stack.length - 1 - Number(n);
        if (op === Op.OP_PICK) {
          stack.push(stack[idx]!);
          if (overflowed()) return fail('stack overflow');
        } else {
          const [item] = stack.splice(idx, 1);
          stack.push(item!);
        }
        break;
      }
      case Op.OP_ROT: {
        if (stack.length < 3) return fail('OP_ROT: need 3 items');
        const a = stack[stack.length - 3]!;
        stack.splice(stack.length - 3, 1);
        stack.push(a);
        break;
      }
      case Op.OP_SWAP: {
        if (stack.length < 2) return fail('OP_SWAP: need 2 items');
        const a = stack[stack.length - 1]!;
        stack[stack.length - 1] = stack[stack.length - 2]!;
        stack[stack.length - 2] = a;
        break;
      }
      case Op.OP_TUCK: {
        if (stack.length < 2) return fail('OP_TUCK: need 2 items');
        stack.splice(stack.length - 2, 0, stack[stack.length - 1]!);
        if (overflowed()) return fail('stack overflow');
        break;
      }
      case Op.OP_SIZE: {
        if (stack.length < 1) return fail('OP_SIZE: empty stack');
        stack.push(encodeNum(BigInt(stack[stack.length - 1]!.length)));
        if (overflowed()) return fail('stack overflow');
        break;
      }

      // --- comparison ---
      case Op.OP_EQUAL:
      case Op.OP_EQUALVERIFY: {
        if (stack.length < 2) return fail('OP_EQUAL: need 2 items');
        const a = stack.pop()!;
        const b = stack.pop()!;
        const eq = a.length === b.length && compareBytes(a, b) === 0;
        if (op === Op.OP_EQUALVERIFY) {
          if (!eq) return fail('OP_EQUALVERIFY failed');
        } else {
          stack.push(boolItem(eq));
        }
        break;
      }

      // --- arithmetic (unary) ---
      case Op.OP_1ADD: case Op.OP_1SUB: case Op.OP_NEGATE:
      case Op.OP_ABS: case Op.OP_NOT: case Op.OP_0NOTEQUAL: {
        const a = popNum();
        if (a === null) return fail('arithmetic: bad number');
        let r: bigint;
        switch (op) {
          case Op.OP_1ADD: r = a + 1n; break;
          case Op.OP_1SUB: r = a - 1n; break;
          case Op.OP_NEGATE: r = -a; break;
          case Op.OP_ABS: r = a < 0n ? -a : a; break;
          case Op.OP_NOT: r = a === 0n ? 1n : 0n; break;
          default: r = a === 0n ? 0n : 1n; break; // OP_0NOTEQUAL
        }
        stack.push(encodeNum(r));
        break;
      }

      // --- arithmetic (binary) ---
      case Op.OP_ADD: case Op.OP_SUB: case Op.OP_BOOLAND: case Op.OP_BOOLOR:
      case Op.OP_NUMEQUAL: case Op.OP_NUMEQUALVERIFY: case Op.OP_NUMNOTEQUAL:
      case Op.OP_LESSTHAN: case Op.OP_GREATERTHAN: case Op.OP_LESSTHANOREQUAL:
      case Op.OP_GREATERTHANOREQUAL: case Op.OP_MIN: case Op.OP_MAX: {
        if (stack.length < 2) return fail('arithmetic: need 2 numbers');
        const b = popNum();
        const a = popNum();
        if (a === null || b === null) return fail('arithmetic: bad number');
        let r: bigint;
        switch (op) {
          case Op.OP_ADD: r = a + b; break;
          case Op.OP_SUB: r = a - b; break;
          case Op.OP_BOOLAND: r = (a !== 0n && b !== 0n) ? 1n : 0n; break;
          case Op.OP_BOOLOR: r = (a !== 0n || b !== 0n) ? 1n : 0n; break;
          case Op.OP_NUMNOTEQUAL: r = a !== b ? 1n : 0n; break;
          case Op.OP_LESSTHAN: r = a < b ? 1n : 0n; break;
          case Op.OP_GREATERTHAN: r = a > b ? 1n : 0n; break;
          case Op.OP_LESSTHANOREQUAL: r = a <= b ? 1n : 0n; break;
          case Op.OP_GREATERTHANOREQUAL: r = a >= b ? 1n : 0n; break;
          case Op.OP_MIN: r = a < b ? a : b; break;
          case Op.OP_MAX: r = a > b ? a : b; break;
          default: r = a === b ? 1n : 0n; break; // NUMEQUAL / NUMEQUALVERIFY
        }
        if (op === Op.OP_NUMEQUALVERIFY) {
          if (r === 0n) return fail('OP_NUMEQUALVERIFY failed');
        } else {
          stack.push(encodeNum(r));
        }
        break;
      }
      case Op.OP_WITHIN: {
        if (stack.length < 3) return fail('OP_WITHIN: need 3 numbers');
        const max = popNum();
        const min = popNum();
        const x = popNum();
        if (x === null || min === null || max === null) return fail('OP_WITHIN: bad number');
        stack.push(boolItem(min <= x && x < max));
        break;
      }

      // --- hashing ---
      case Op.OP_RIPEMD160: {
        if (stack.length < 1) return fail('OP_RIPEMD160: empty stack');
        stack.push(ripemd160(stack.pop()!));
        break;
      }
      case Op.OP_SHA256: {
        if (stack.length < 1) return fail('OP_SHA256: empty stack');
        stack.push(sha256(stack.pop()!));
        break;
      }
      case Op.OP_HASH160: {
        if (stack.length < 1) return fail('OP_HASH160: empty stack');
        stack.push(hash160(stack.pop()!));
        break;
      }
      case Op.OP_HASH256: {
        if (stack.length < 1) return fail('OP_HASH256: empty stack');
        stack.push(sha256(sha256(stack.pop()!)));
        break;
      }

      // --- signatures ---
      case Op.OP_CHECKSIG:
      case Op.OP_CHECKSIGVERIFY: {
        if (stack.length < 2) return fail('OP_CHECKSIG: need sig + pubkey');
        const pubkey = stack.pop()!;
        const sig = stack.pop()!;
        const valid = pubkey.length === 32 && sig.length === 64 && edVerify(sig, ctx.sighash, pubkey);
        if (op === Op.OP_CHECKSIGVERIFY) {
          if (!valid) return fail('OP_CHECKSIGVERIFY failed');
        } else {
          stack.push(boolItem(valid));
        }
        break;
      }
      case Op.OP_CHECKMULTISIG: {
        const r = opCheckMultisig(stack, ctx);
        if (r) return fail(r);
        break;
      }

      // --- locktime ---
      case Op.OP_CHECKLOCKTIMEVERIFY: {
        if (stack.length < 1) return fail('OP_CLTV: empty stack');
        const req = decodeNum(stack[stack.length - 1]!, 5); // heights + unix timestamps
        if (req === null) return fail('OP_CLTV: bad number');
        if (req < 0n) return fail('OP_CLTV: negative locktime');
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
  const n = decodeNum(stack.pop()!, 4);
  if (n === null || n < 1n || n > BigInt(MAX_MULTISIG_KEYS)) return 'OP_CHECKMULTISIG: bad n';
  const nn = Number(n);
  if (stack.length < nn + 1) return 'OP_CHECKMULTISIG: not enough pubkeys';
  const pubkeys: Uint8Array[] = [];
  for (let i = 0; i < nn; i++) pubkeys.unshift(stack.pop()!); // restores pub_1..pub_n order

  const m = decodeNum(stack.pop()!, 4);
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
