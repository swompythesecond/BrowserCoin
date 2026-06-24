import { describe, it, expect } from 'vitest';
import { evalScript, type ScriptContext } from './script.js';
import { hashlockScript, hashlockSigScript, htlcScript } from './scriptBuild.js';
import { sha256 } from '../crypto/hash.js';
import { generateKeyPair, sign } from '../crypto/keys.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const ctx = (sighash: Uint8Array): ScriptContext => ({ sighash, blockHeight: 100, blockMtp: 1_000_000 });

/**
 * These tests encode the front-running property that a public review surfaced:
 * a *bare* hash lock is anyone-can-take, so directed payments must additionally
 * require a signature (the HTLC leaf `hashlockSigScript`).
 */
describe('hash-locked payment (signature-gated, the safe form)', () => {
  it('redeems with the recipient key + secret, bound to a specific spend', () => {
    const kp = generateKeyPair();
    const preimage = sha256(utf8('the secret'));
    const script = hashlockSigScript(sha256(preimage), kp.publicKey);
    const sighash = sha256(utf8('pay bob'));
    const sig = sign(sighash, kp.privateKey);
    expect(evalScript(script, [sig, preimage], ctx(sighash)).ok).toBe(true);
  });

  it('a front-runner CANNOT reuse the revealed signature for a different destination', () => {
    const kp = generateKeyPair();
    const preimage = sha256(utf8('the secret'));
    const script = hashlockSigScript(sha256(preimage), kp.publicKey);
    const sigForBob = sign(sha256(utf8('pay bob')), kp.privateKey);
    // Mallory copies the now-public preimage + signature but aims at her own spend.
    const r = evalScript(script, [sigForBob, preimage], ctx(sha256(utf8('pay mallory'))));
    expect(r.ok).toBe(false);
  });

  it('a front-runner without the private key cannot forge a valid signature', () => {
    const kp = generateKeyPair();
    const mallory = generateKeyPair();
    const preimage = sha256(utf8('the secret'));
    const script = hashlockSigScript(sha256(preimage), kp.publicKey);
    const mallorySighash = sha256(utf8('pay mallory'));
    const forged = sign(mallorySighash, mallory.privateKey); // wrong key
    expect(evalScript(script, [forged, preimage], ctx(mallorySighash)).ok).toBe(false);
  });
});

describe('atomic swap HTLC (claim + timeout refund)', () => {
  const TRUE = new Uint8Array([1]);
  const FALSE = new Uint8Array(0);

  it('recipient claims the top branch with secret + signature', () => {
    const recipient = generateKeyPair();
    const sender = generateKeyPair();
    const preimage = sha256(utf8('swap secret'));
    const script = htlcScript(sha256(preimage), recipient.publicKey, 50, sender.publicKey);
    const sighash = sha256(utf8('claim spend'));
    const sig = sign(sighash, recipient.privateKey);
    // witness = [sig, preimage, <select IF>]
    expect(evalScript(script, [sig, preimage, TRUE], ctx(sighash)).ok).toBe(true);
  });

  it('sender refunds the else branch once the locktime height is reached', () => {
    const recipient = generateKeyPair();
    const sender = generateKeyPair();
    const script = htlcScript(sha256(sha256(utf8('x'))), recipient.publicKey, 50, sender.publicKey);
    const sighash = sha256(utf8('refund spend'));
    const sig = sign(sighash, sender.privateKey);
    const at = (h: number): ScriptContext => ({ sighash, blockHeight: h, blockMtp: 1_000_000 });
    // witness = [sig, <select ELSE>]
    expect(evalScript(script, [sig, FALSE], at(100)).ok).toBe(true);   // height 100 ≥ 50
    expect(evalScript(script, [sig, FALSE], at(10)).ok).toBe(false);   // height 10 < 50 → CLTV fails
  });
});

describe('bare hash lock (demonstration only) is front-runnable', () => {
  it('passes for ANY destination given just the secret — this is the vulnerability', () => {
    const preimage = sha256(utf8('the secret'));
    const script = hashlockScript(sha256(preimage));
    // The same witness satisfies the script regardless of where the coins go,
    // so whoever sees the preimage can redirect the spend.
    expect(evalScript(script, [preimage], ctx(sha256(utf8('to bob')))).ok).toBe(true);
    expect(evalScript(script, [preimage], ctx(sha256(utf8('to mallory')))).ok).toBe(true);
  });
});
