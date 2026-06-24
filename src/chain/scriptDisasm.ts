/**
 * Human-readable rendering of redeem scripts. Pure, side-effect-free helpers
 * shared by the explorer, the in-app script builder, and (via copy-paste) the
 * developer docs. NEVER used by consensus — `script.ts` is the only authority on
 * what a script *does*; this module only describes what it *looks like*.
 *
 * Two layers:
 *   • tokenize/disassemble — turn raw bytecode into named opcodes + pushes,
 *     mirroring the parser in `script.ts` (same push encoding, same bounds).
 *   • explainScript — best-effort pattern match of the common templates
 *     (hashlock, timelock, single-sig, multisig) into one plain-English line.
 */
import { Op, LOCKTIME_THRESHOLD } from './script.js';
import { bytesToHex } from '../util/binary.js';

const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSH_MAX = 0x4b; // largest direct-push opcode

/** value → canonical OP_ name, built once from the Op table. */
const OP_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(Op).map(([name, value]) => [value, name]),
);

export interface ScriptToken {
  /** The opcode byte (for a push, the push opcode itself). */
  op: number;
  /** 'OP_SHA256', 'OP_1', 'PUSH', or 'UNKNOWN'. */
  name: string;
  /** Push payload, present only for data pushes. */
  data?: Uint8Array;
}

export interface Disassembly {
  tokens: ScriptToken[];
  /** True if the bytecode ran out mid-instruction (malformed / truncated). */
  truncated: boolean;
}

/**
 * Walk the bytecode into tokens. Mirrors `script.ts`'s reader: 0x01..0x4b push
 * that many literal bytes; OP_PUSHDATA1/2 take a 1/2-byte little-endian length;
 * everything else is a bare opcode.
 */
export function tokenize(script: Uint8Array): Disassembly {
  const tokens: ScriptToken[] = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i]!;
    i += 1;
    if (op >= 0x01 && op <= OP_PUSH_MAX) {
      if (i + op > script.length) return { tokens, truncated: true };
      tokens.push({ op, name: 'PUSH', data: script.slice(i, i + op) });
      i += op;
    } else if (op === OP_PUSHDATA1) {
      if (i + 1 > script.length) return { tokens, truncated: true };
      const len = script[i]!; i += 1;
      if (i + len > script.length) return { tokens, truncated: true };
      tokens.push({ op, name: 'PUSH', data: script.slice(i, i + len) });
      i += len;
    } else if (op === OP_PUSHDATA2) {
      if (i + 2 > script.length) return { tokens, truncated: true };
      const len = script[i]! | (script[i + 1]! << 8); i += 2;
      if (i + len > script.length) return { tokens, truncated: true };
      tokens.push({ op, name: 'PUSH', data: script.slice(i, i + len) });
      i += len;
    } else {
      tokens.push({ op, name: OP_NAMES.get(op) ?? 'UNKNOWN' });
    }
  }
  return { tokens, truncated: false };
}

/** One assembly-style string per token, e.g. `OP_SHA256`, `PUSH(32) d3cc9d…`. */
export function disassemble(script: Uint8Array): string[] {
  const { tokens, truncated } = tokenize(script);
  const out = tokens.map((t) => {
    if (t.name === 'PUSH') {
      const hex = bytesToHex(t.data!);
      const shown = hex.length > 20 ? hex.slice(0, 20) + '…' : hex;
      return `PUSH(${t.data!.length}) ${shown || '∅'}`;
    }
    if (t.name === 'UNKNOWN') return `UNKNOWN(0x${t.op.toString(16).padStart(2, '0')})`;
    return t.name;
  });
  if (truncated) out.push('… (truncated)');
  return out;
}

export type ScriptTemplate = 'hashlock' | 'timelock' | 'signature' | 'multisig' | 'empty' | 'custom';

export interface ScriptExplanation {
  template: ScriptTemplate;
  /** Short label for a badge, e.g. "Hash lock". */
  title: string;
  /** One-sentence plain-English description of the spend condition. */
  summary: string;
}

const HASH_OPS: Record<number, string> = {
  [Op.OP_SHA256]: 'SHA-256',
  [Op.OP_HASH256]: 'double-SHA-256',
  [Op.OP_RIPEMD160]: 'RIPEMD-160',
  [Op.OP_HASH160]: 'HASH-160',
};

/** Decode a minimal little-endian script number (for locktime display). */
function readScriptNum(data: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < data.length; i++) n |= data[i]! << (8 * i);
  return n >>> 0;
}

/**
 * Best-effort recognition of the spend condition. Returns a friendly summary
 * for the common templates and falls back to "custom" (still fully disassembled
 * elsewhere) for anything it doesn't recognise.
 */
export function explainScript(script: Uint8Array): ScriptExplanation {
  if (script.length === 0) {
    return { template: 'empty', title: 'Empty', summary: 'Empty script — nothing to satisfy.' };
  }
  const { tokens } = tokenize(script);

  // Hashlock: <HASHOP> <push hash> OP_EQUAL
  if (
    tokens.length === 3 &&
    tokens[0]!.op in HASH_OPS &&
    tokens[1]!.name === 'PUSH' &&
    tokens[2]!.op === Op.OP_EQUAL
  ) {
    const alg = HASH_OPS[tokens[0]!.op]!;
    const h = bytesToHex(tokens[1]!.data!);
    return {
      template: 'hashlock',
      title: 'Hash lock',
      summary: `Spendable by anyone who reveals the secret whose ${alg} hash is ${h.slice(0, 16)}…. Used for atomic swaps and payment channels.`,
    };
  }

  // Single-sig: <push pubkey> OP_CHECKSIG
  if (tokens.length === 2 && tokens[0]!.name === 'PUSH' && tokens[1]!.op === Op.OP_CHECKSIG) {
    const k = bytesToHex(tokens[0]!.data!);
    return {
      template: 'signature',
      title: 'Signature lock',
      summary: `Spendable only by the holder of public key ${k.slice(0, 16)}… (an Ed25519 signature over the spend).`,
    };
  }

  // Timelock: anything containing OP_CHECKLOCKTIMEVERIFY.
  const cltvIdx = tokens.findIndex((t) => t.op === Op.OP_CHECKLOCKTIMEVERIFY);
  if (cltvIdx >= 0) {
    const pushBefore = cltvIdx > 0 && tokens[cltvIdx - 1]!.name === 'PUSH' ? tokens[cltvIdx - 1]! : null;
    let when = 'a set point';
    if (pushBefore) {
      const n = readScriptNum(pushBefore.data!);
      when = n >= LOCKTIME_THRESHOLD
        ? `${new Date(n * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}`
        : `block height ${n}`;
    }
    return {
      template: 'timelock',
      title: 'Time lock',
      summary: `Cannot be spent until ${when}${pushBefore ? '' : ' (see CLTV operand)'}, then governed by the rest of the script. Used for vaults and vesting.`,
    };
  }

  // Multisig: ... OP_CHECKMULTISIG (M-of-N where M,N are OP_1..OP_16).
  const lastReal = tokens[tokens.length - 1];
  if (lastReal && lastReal.op === Op.OP_CHECKMULTISIG) {
    const nTok = tokens[tokens.length - 2];
    const n = nTok ? opSmallInt(nTok.op) : null;
    const mTok = tokens[0];
    const m = mTok ? opSmallInt(mTok.op) : null;
    if (m !== null && n !== null) {
      return {
        template: 'multisig',
        title: `${m}-of-${n} multisig`,
        summary: `Requires ${m} valid signature${m === 1 ? '' : 's'} from a set of ${n} listed keys. Used for escrow and shared custody.`,
      };
    }
    return { template: 'multisig', title: 'Multisig', summary: 'Requires signatures from a quorum of listed keys.' };
  }

  return {
    template: 'custom',
    title: 'Custom script',
    summary: 'A custom spending condition — see the opcodes below for exactly what must be satisfied.',
  };
}

/** OP_1..OP_16 → 1..16, OP_0 → 0, else null. */
function opSmallInt(op: number): number | null {
  if (op === Op.OP_0) return 0;
  if (op >= Op.OP_1 && op <= Op.OP_16) return op - Op.OP_1 + 1;
  return null;
}
