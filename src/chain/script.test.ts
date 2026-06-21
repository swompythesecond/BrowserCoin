import { describe, it, expect } from 'vitest';
import { generateKeyPair, sign } from '../crypto/keys.js';
import { sha256 } from '../crypto/hash.js';
import { concat } from '../util/binary.js';
import {
  Op,
  evalScript,
  encodeNum,
  scriptHash,
  type ScriptContext,
  MAX_SCRIPT_BYTES,
  MAX_WITNESS_ITEMS,
} from './script.js';

// --- tiny assembler helpers -------------------------------------------------
function push(data: Uint8Array): Uint8Array {
  if (data.length <= 0x4b) return concat(new Uint8Array([data.length]), data);
  if (data.length <= 255) return concat(new Uint8Array([Op.OP_PUSHDATA1, data.length]), data);
  throw new Error('push too large for test helper');
}
function op(code: number): Uint8Array {
  return new Uint8Array([code]);
}
function asm(...parts: Uint8Array[]): Uint8Array {
  return concat(...parts);
}

const SIGHASH = sha256(new TextEncoder().encode('spend-1'));
const OTHER_SIGHASH = sha256(new TextEncoder().encode('spend-2'));

function ctx(over: Partial<ScriptContext> = {}): ScriptContext {
  return { sighash: SIGHASH, blockHeight: 1000, blockMtp: 1_700_000_000, ...over };
}

describe('script: basics', () => {
  it('OP_1 alone succeeds (truthy top)', () => {
    expect(evalScript(op(Op.OP_1), [], ctx()).ok).toBe(true);
  });

  it('OP_0 alone fails (falsy top)', () => {
    expect(evalScript(op(Op.OP_0), [], ctx()).ok).toBe(false);
  });

  it('empty stack at end fails', () => {
    expect(evalScript(new Uint8Array(0), [], ctx()).ok).toBe(false);
  });

  it('OP_EQUAL on equal items', () => {
    const a = new Uint8Array([1, 2, 3]);
    const s = asm(push(a), op(Op.OP_EQUAL));
    expect(evalScript(s, [a], ctx()).ok).toBe(true);
    expect(evalScript(s, [new Uint8Array([9])], ctx()).ok).toBe(false);
  });
});

describe('script: hash lock', () => {
  const preimage = new TextEncoder().encode('the secret password');
  const h = sha256(preimage);
  const redeem = asm(op(Op.OP_SHA256), push(h), op(Op.OP_EQUAL));

  it('correct preimage unlocks', () => {
    expect(evalScript(redeem, [preimage], ctx()).ok).toBe(true);
  });
  it('wrong preimage fails', () => {
    expect(evalScript(redeem, [new TextEncoder().encode('nope')], ctx()).ok).toBe(false);
  });
});

describe('script: checksig (ownership)', () => {
  const kp = generateKeyPair();
  const redeem = asm(push(kp.publicKey), op(Op.OP_CHECKSIG));

  it('valid signature unlocks', () => {
    const sig = sign(SIGHASH, kp.privateKey);
    expect(evalScript(redeem, [sig], ctx()).ok).toBe(true);
  });
  it('signature over a different sighash fails', () => {
    const sig = sign(OTHER_SIGHASH, kp.privateKey);
    expect(evalScript(redeem, [sig], ctx()).ok).toBe(false);
  });
  it('wrong key fails', () => {
    const other = generateKeyPair();
    const sig = sign(SIGHASH, other.privateKey);
    expect(evalScript(redeem, [sig], ctx()).ok).toBe(false);
  });
});

describe('script: 2-of-3 multisig', () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const c = generateKeyPair();
  const redeem = asm(
    op(Op.OP_2),
    push(a.publicKey), push(b.publicKey), push(c.publicKey),
    op(Op.OP_3),
    op(Op.OP_CHECKMULTISIG),
  );

  it('two valid sigs in key order unlock', () => {
    const w = [sign(SIGHASH, a.privateKey), sign(SIGHASH, b.privateKey)];
    expect(evalScript(redeem, w, ctx()).ok).toBe(true);
  });
  it('first and third signers unlock', () => {
    const w = [sign(SIGHASH, a.privateKey), sign(SIGHASH, c.privateKey)];
    expect(evalScript(redeem, w, ctx()).ok).toBe(true);
  });
  it('sigs out of key order fail (must match left-to-right)', () => {
    const w = [sign(SIGHASH, b.privateKey), sign(SIGHASH, a.privateKey)];
    expect(evalScript(redeem, w, ctx()).ok).toBe(false);
  });
  it('only one valid sig fails', () => {
    const w = [sign(SIGHASH, a.privateKey), sign(OTHER_SIGHASH, b.privateKey)];
    expect(evalScript(redeem, w, ctx()).ok).toBe(false);
  });
});

describe('script: CLTV time/height lock', () => {
  const kp = generateKeyPair();
  // <N> CLTV DROP <pubkey> CHECKSIG
  function vault(n: bigint): Uint8Array {
    return asm(
      push(encodeNum(n)),
      op(Op.OP_CHECKLOCKTIMEVERIFY),
      op(Op.OP_DROP),
      push(kp.publicKey),
      op(Op.OP_CHECKSIG),
    );
  }
  const sig = sign(SIGHASH, kp.privateKey);

  it('height lock: spend allowed at/after height', () => {
    expect(evalScript(vault(1000n), [sig], ctx({ blockHeight: 1000 })).ok).toBe(true);
    expect(evalScript(vault(1000n), [sig], ctx({ blockHeight: 1001 })).ok).toBe(true);
  });
  it('height lock: spend rejected before height', () => {
    expect(evalScript(vault(1000n), [sig], ctx({ blockHeight: 999 })).ok).toBe(false);
  });
  it('timestamp lock compares against blockMtp', () => {
    const t = 1_800_000_000n; // above LOCKTIME_THRESHOLD → time-based
    expect(evalScript(vault(t), [sig], ctx({ blockMtp: 1_800_000_000 })).ok).toBe(true);
    expect(evalScript(vault(t), [sig], ctx({ blockMtp: 1_799_999_999 })).ok).toBe(false);
  });
});

describe('script: HTLC (atomic swap building block)', () => {
  const alice = generateKeyPair(); // refund after timeout
  const bob = generateKeyPair();   // claim with preimage
  const preimage = new TextEncoder().encode('atomic-swap-secret');
  const h = sha256(preimage);
  const timeout = 2000n;

  // IF  SHA256 <h> EQUALVERIFY <bob> CHECKSIG
  // ELSE <timeout> CLTV DROP <alice> CHECKSIG
  // ENDIF
  const redeem = asm(
    op(Op.OP_IF),
    op(Op.OP_SHA256), push(h), op(Op.OP_EQUALVERIFY), push(bob.publicKey), op(Op.OP_CHECKSIG),
    op(Op.OP_ELSE),
    push(encodeNum(timeout)), op(Op.OP_CHECKLOCKTIMEVERIFY), op(Op.OP_DROP), push(alice.publicKey), op(Op.OP_CHECKSIG),
    op(Op.OP_ENDIF),
  );

  it('claim path: bob with preimage', () => {
    const sigB = sign(SIGHASH, bob.privateKey);
    const witness = [sigB, preimage, encodeNum(1n)]; // selector 1 → IF branch
    expect(evalScript(redeem, witness, ctx({ blockHeight: 10 })).ok).toBe(true);
  });
  it('claim path fails with wrong preimage', () => {
    const sigB = sign(SIGHASH, bob.privateKey);
    const witness = [sigB, new TextEncoder().encode('wrong'), encodeNum(1n)];
    expect(evalScript(redeem, witness, ctx({ blockHeight: 10 })).ok).toBe(false);
  });
  it('refund path: alice after timeout', () => {
    const sigA = sign(SIGHASH, alice.privateKey);
    const witness = [sigA, encodeNum(0n)]; // selector 0 → ELSE branch
    expect(evalScript(redeem, witness, ctx({ blockHeight: 2000 })).ok).toBe(true);
  });
  it('refund path fails before timeout', () => {
    const sigA = sign(SIGHASH, alice.privateKey);
    const witness = [sigA, encodeNum(0n)];
    expect(evalScript(redeem, witness, ctx({ blockHeight: 1999 })).ok).toBe(false);
  });
});

describe('script: limits and malleability', () => {
  it('rejects oversized script', () => {
    const big = new Uint8Array(MAX_SCRIPT_BYTES + 1);
    expect(evalScript(big, [], ctx()).ok).toBe(false);
  });
  it('rejects too many witness items', () => {
    const w = Array.from({ length: MAX_WITNESS_ITEMS + 1 }, () => new Uint8Array([1]));
    expect(evalScript(op(Op.OP_1), w, ctx()).ok).toBe(false);
  });
  it('rejects unbalanced OP_IF', () => {
    const s = asm(op(Op.OP_1), op(Op.OP_IF), op(Op.OP_1));
    expect(evalScript(s, [], ctx()).ok).toBe(false);
  });
  it('rejects OP_ELSE without OP_IF', () => {
    expect(evalScript(op(Op.OP_ELSE), [], ctx()).ok).toBe(false);
  });
  it('rejects truncated push', () => {
    const s = new Uint8Array([0x05, 0x01, 0x02]); // says 5 bytes, only 2 follow
    expect(evalScript(s, [], ctx()).ok).toBe(false);
  });
  it('rejects unknown opcode', () => {
    expect(evalScript(new Uint8Array([0xff]), [], ctx()).ok).toBe(false);
  });
  it('rejects non-minimal CLTV number (leading zero)', () => {
    const s = asm(push(new Uint8Array([0x00, 0x10])), op(Op.OP_CHECKLOCKTIMEVERIFY), op(Op.OP_DROP), op(Op.OP_1));
    expect(evalScript(s, [], ctx({ blockHeight: 9999 })).ok).toBe(false);
  });
});

describe('script: scriptHash', () => {
  it('is sha256 of the script bytes', () => {
    const s = asm(op(Op.OP_1));
    expect(scriptHash(s)).toEqual(sha256(s));
  });
});
