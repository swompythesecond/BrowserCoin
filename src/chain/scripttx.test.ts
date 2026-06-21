import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Blockchain } from './blockchain.js';
import { buildBlock, emptyMine } from './testutil.js';
import {
  applyBlockTxs,
  emptyState,
  getAccount,
  getLock,
  stateRoot,
  type State,
} from './state.js';
import {
  TxKind,
  decodeTx,
  encodeTx,
  lockIdOf,
  redeemSighash,
  signLock,
  type Transaction,
} from './transaction.js';
import { signTx } from './transaction.js';
import { decodeBlock, encodeBlock, type Block } from './block.js';
import { Op } from './script.js';
import { generateKeyPair, sign } from '../crypto/keys.js';
import { sha256 } from '../crypto/hash.js';
import { concat, bytesToHex } from '../util/binary.js';
import { COIN, GENESIS_TIMESTAMP } from './genesis.js';
import { resetForkActivationTimeForTesting, setForkActivationTimeForTesting } from './fork.js';

// --- helpers ---------------------------------------------------------------
const ZERO32 = new Uint8Array(32);
function push(data: Uint8Array): Uint8Array {
  if (data.length <= 0x4b) return concat(new Uint8Array([data.length]), data);
  return concat(new Uint8Array([Op.OP_PUSHDATA1, data.length]), data);
}
function op(c: number): Uint8Array { return new Uint8Array([c]); }

/** Hash-lock redeem script: SHA256 <h> EQUAL. Unlock witness = [preimage]. */
function hashLockScript(preimage: Uint8Array): Uint8Array {
  return concat(op(Op.OP_SHA256), push(sha256(preimage)), op(Op.OP_EQUAL));
}

function makeRedeem(opts: {
  lockId: Uint8Array;
  to: Uint8Array;
  amount: bigint;
  fee: bigint;
  redeemScript: Uint8Array;
  witness?: Uint8Array[];
  makeWitness?: (sighash: Uint8Array) => Uint8Array[];
}): Transaction {
  const base: Transaction = {
    kind: TxKind.Redeem,
    from: new Uint8Array(32),
    to: opts.to,
    amount: opts.amount,
    fee: opts.fee,
    nonce: 0,
    signature: new Uint8Array(0),
    lockId: opts.lockId,
    redeemScript: opts.redeemScript,
    witness: [],
  };
  const sighash = redeemSighash(base);
  base.witness = opts.makeWitness ? opts.makeWitness(sighash) : (opts.witness ?? []);
  return base;
}

const ACTIVE = { scriptsActive: true, blockMtp: 1_800_000_000 };

function fundedState(addrHex: string, balance: bigint): State {
  const s = emptyState();
  s.accounts.set(addrHex, { balance, nonce: 0 });
  return s;
}

// ===========================================================================
// Encoding round-trips
// ===========================================================================
describe('script tx: encode/decode round-trip', () => {
  it('lock', () => {
    const alice = generateKeyPair();
    const rs = hashLockScript(new TextEncoder().encode('x'));
    const lock = signLock(
      { from: alice.publicKey, to: ZERO32, amount: 5n * COIN, fee: 10n, nonce: 3, scriptHash: sha256(rs) },
      alice.privateKey,
    );
    const { tx, next } = decodeTx(encodeTx(lock));
    expect(next).toBe(encodeTx(lock).length);
    expect(tx.kind).toBe(TxKind.Lock);
    expect(tx.amount).toBe(5n * COIN);
    expect(tx.nonce).toBe(3);
    expect(bytesToHex(tx.scriptHash!)).toBe(bytesToHex(sha256(rs)));
    expect(bytesToHex(tx.from)).toBe(alice.address);
  });

  it('redeem', () => {
    const bob = generateKeyPair();
    const preimage = new TextEncoder().encode('secret');
    const rs = hashLockScript(preimage);
    const redeem = makeRedeem({
      lockId: sha256(new TextEncoder().encode('lock')),
      to: bob.publicKey,
      amount: 7n * COIN,
      fee: 50n,
      redeemScript: rs,
      witness: [preimage],
    });
    const enc = encodeTx(redeem);
    const { tx, next } = decodeTx(enc);
    expect(next).toBe(enc.length);
    expect(tx.kind).toBe(TxKind.Redeem);
    expect(tx.amount).toBe(7n * COIN);
    expect(bytesToHex(tx.to)).toBe(bob.address);
    expect(tx.witness!.length).toBe(1);
    expect(bytesToHex(tx.witness![0]!)).toBe(bytesToHex(preimage));
    expect(bytesToHex(tx.redeemScript!)).toBe(bytesToHex(rs));
  });

  it('block with mixed tx kinds round-trips through encodeBlock/decodeBlock', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const preimage = new TextEncoder().encode('blk');
    const rs = hashLockScript(preimage);
    const transfer = signTx({ from: alice.publicKey, to: bob.publicKey, amount: 1n * COIN, fee: 5n, nonce: 0 }, alice.privateKey);
    const lock = signLock({ from: alice.publicKey, to: ZERO32, amount: 2n * COIN, fee: 5n, nonce: 1, scriptHash: sha256(rs) }, alice.privateKey);
    const redeem = makeRedeem({ lockId: sha256(new TextEncoder().encode('L')), to: bob.publicKey, amount: 2n * COIN, fee: 5n, redeemScript: rs, witness: [preimage] });

    const block: Block = {
      header: {
        height: 1, prevHash: ZERO32, txRoot: ZERO32, stateRoot: ZERO32,
        timestamp: 1_800_000_000, difficulty: 0x20020000, nonce: 0, miner: alice.publicKey,
      },
      transactions: [transfer, lock, redeem],
    };
    const back = decodeBlock(encodeBlock(block));
    expect(back.transactions.map((t) => t.kind)).toEqual([TxKind.Transfer, TxKind.Lock, TxKind.Redeem]);
    expect(back.transactions[2]!.witness!.length).toBe(1);
    expect(bytesToHex(back.transactions[1]!.scriptHash!)).toBe(bytesToHex(sha256(rs)));
  });
});

// ===========================================================================
// State transitions (fast — no mining)
// ===========================================================================
describe('script tx: state transitions', () => {
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  const miner = generateKeyPair();
  const preimage = new TextEncoder().encode('open sesame');
  const rs = hashLockScript(preimage);

  function lockTx(nonce: number, amount: bigint, fee: bigint): Transaction {
    return signLock(
      { from: alice.publicKey, to: ZERO32, amount, fee, nonce, scriptHash: sha256(rs) },
      alice.privateKey,
    );
  }

  it('LOCK debits sender and creates a lock; REDEEM deletes it and pays out', () => {
    const state = fundedState(alice.address, 100n * COIN);
    const lock = lockTx(0, 10n * COIN, 100n);
    const lockId = lockIdOf(lock);

    expect(applyBlockTxs(state, 1, miner.publicKey, [lock], ACTIVE)).toBeNull();
    // alice paid amount + fee; lock holds the amount.
    expect(getAccount(state, alice.address).balance).toBe(100n * COIN - 10n * COIN - 100n);
    const live = getLock(state, bytesToHex(lockId))!;
    expect(live.amount).toBe(10n * COIN);
    expect(live.createdHeight).toBe(1);

    // Redeem in the NEXT block.
    const redeem = makeRedeem({ lockId, to: bob.publicKey, amount: 10n * COIN, fee: 200n, redeemScript: rs, witness: [preimage] });
    expect(applyBlockTxs(state, 2, miner.publicKey, [redeem], ACTIVE)).toBeNull();
    expect(getLock(state, bytesToHex(lockId))).toBeUndefined();
    expect(getAccount(state, bob.address).balance).toBe(10n * COIN - 200n);
  });

  it('rejects LOCK and REDEEM before activation', () => {
    const state = fundedState(alice.address, 100n * COIN);
    const lock = lockTx(0, 10n * COIN, 100n);
    const err = applyBlockTxs(state, 1, miner.publicKey, [lock], { scriptsActive: false, blockMtp: 0 });
    expect(err).toContain('before fork activation');
  });

  it('rejects redeeming a lock created in the same block', () => {
    const state = fundedState(alice.address, 100n * COIN);
    const lock = lockTx(0, 10n * COIN, 100n);
    const redeem = makeRedeem({ lockId: lockIdOf(lock), to: bob.publicKey, amount: 10n * COIN, fee: 0n, redeemScript: rs, witness: [preimage] });
    const err = applyBlockTxs(state, 1, miner.publicKey, [lock, redeem], ACTIVE);
    expect(err).toContain('creation block');
  });

  it('rejects a redeem with a wrong preimage', () => {
    const state = fundedState(alice.address, 100n * COIN);
    const lock = lockTx(0, 10n * COIN, 100n);
    expect(applyBlockTxs(state, 1, miner.publicKey, [lock], ACTIVE)).toBeNull();
    const redeem = makeRedeem({ lockId: lockIdOf(lock), to: bob.publicKey, amount: 10n * COIN, fee: 0n, redeemScript: rs, witness: [new TextEncoder().encode('wrong')] });
    const err = applyBlockTxs(state, 2, miner.publicKey, [redeem], ACTIVE);
    expect(err).toContain('script failed');
  });

  it('rejects double-redeem (lock already spent)', () => {
    const state = fundedState(alice.address, 100n * COIN);
    const lock = lockTx(0, 10n * COIN, 100n);
    const lockId = lockIdOf(lock);
    expect(applyBlockTxs(state, 1, miner.publicKey, [lock], ACTIVE)).toBeNull();
    const redeem = makeRedeem({ lockId, to: bob.publicKey, amount: 10n * COIN, fee: 0n, redeemScript: rs, witness: [preimage] });
    expect(applyBlockTxs(state, 2, miner.publicKey, [redeem], ACTIVE)).toBeNull();
    const again = applyBlockTxs(state, 3, miner.publicKey, [redeem], ACTIVE);
    expect(again).toContain('already-spent');
  });

  it('rejects a redeem whose script does not match the lock', () => {
    const state = fundedState(alice.address, 100n * COIN);
    const lock = lockTx(0, 10n * COIN, 100n);
    expect(applyBlockTxs(state, 1, miner.publicKey, [lock], ACTIVE)).toBeNull();
    const wrongScript = hashLockScript(new TextEncoder().encode('different'));
    const redeem = makeRedeem({ lockId: lockIdOf(lock), to: bob.publicKey, amount: 10n * COIN, fee: 0n, redeemScript: wrongScript, witness: [new TextEncoder().encode('different')] });
    const err = applyBlockTxs(state, 2, miner.publicKey, [redeem], ACTIVE);
    expect(err).toContain('does not match');
  });

  it('state root commits to locks and reverts to legacy form when empty', () => {
    const state = fundedState(alice.address, 100n * COIN);
    const before = bytesToHex(stateRoot(state));
    const lock = lockTx(0, 10n * COIN, 100n);
    const lockId = lockIdOf(lock);
    applyBlockTxs(state, 1, miner.publicKey, [lock], ACTIVE);
    const withLock = bytesToHex(stateRoot(state));
    expect(withLock).not.toBe(before);
    // Redeem removes the only lock → root format returns to accounts-only.
    const redeem = makeRedeem({ lockId, to: bob.publicKey, amount: 10n * COIN, fee: 200n, redeemScript: rs, witness: [preimage] });
    applyBlockTxs(state, 2, miner.publicKey, [redeem], ACTIVE);
    expect(state.locks.size).toBe(0);
  });
});

describe('script tx: multisig + checksig sighash binding', () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const c = generateKeyPair();
  const dest = generateKeyPair();
  const miner = generateKeyPair();
  const funder = generateKeyPair();

  // 2-of-3 multisig: 2 <a> <b> <c> 3 CHECKMULTISIG
  const rs = concat(
    op(Op.OP_2), push(a.publicKey), push(b.publicKey), push(c.publicKey), op(Op.OP_3), op(Op.OP_CHECKMULTISIG),
  );

  it('redeems a 2-of-3 multisig with two signatures over the redeem sighash', () => {
    const state = fundedState(funder.address, 50n * COIN);
    const lock = signLock(
      { from: funder.publicKey, to: ZERO32, amount: 20n * COIN, fee: 0n, nonce: 0, scriptHash: sha256(rs) },
      funder.privateKey,
    );
    const lockId = lockIdOf(lock);
    expect(applyBlockTxs(state, 1, miner.publicKey, [lock], ACTIVE)).toBeNull();

    const redeem = makeRedeem({
      lockId, to: dest.publicKey, amount: 20n * COIN, fee: 0n, redeemScript: rs,
      makeWitness: (sighash) => [sign(sighash, a.privateKey), sign(sighash, b.privateKey)],
    });
    expect(applyBlockTxs(state, 2, miner.publicKey, [redeem], ACTIVE)).toBeNull();
    expect(getAccount(state, dest.address).balance).toBe(20n * COIN);
  });

  it('rejects a multisig redeem signed for a different payout (sighash binding)', () => {
    const state = fundedState(funder.address, 50n * COIN);
    const lock = signLock(
      { from: funder.publicKey, to: ZERO32, amount: 20n * COIN, fee: 0n, nonce: 0, scriptHash: sha256(rs) },
      funder.privateKey,
    );
    const lockId = lockIdOf(lock);
    applyBlockTxs(state, 1, miner.publicKey, [lock], ACTIVE);

    // Sign for `dest`, then try to redirect to a thief.
    const honest = makeRedeem({
      lockId, to: dest.publicKey, amount: 20n * COIN, fee: 0n, redeemScript: rs,
      makeWitness: (sighash) => [sign(sighash, a.privateKey), sign(sighash, b.privateKey)],
    });
    const thief = generateKeyPair();
    const tampered: Transaction = { ...honest, to: thief.publicKey };
    const err = applyBlockTxs(state, 2, miner.publicKey, [tampered], ACTIVE);
    expect(err).toContain('script failed');
  });
});

// ===========================================================================
// End-to-end through real block mining + validation
// ===========================================================================
describe('script tx: end-to-end mined lock → redeem', () => {
  beforeAll(() => setForkActivationTimeForTesting(GENESIS_TIMESTAMP));
  afterAll(() => resetForkActivationTimeForTesting());

  it('locks coinbase funds then redeems them to a new address across blocks', async () => {
    const miner = generateKeyPair();
    const bob = generateKeyPair();
    const chain = new Blockchain();

    // Block 1: fund the miner with a coinbase reward.
    await chain.addBlock(await emptyMine(chain, miner.publicKey));
    const minerStart = getAccount(chain.tipState, miner.address).balance;
    expect(minerStart).toBeGreaterThan(0n);

    // Block 2: miner locks 10 BRC under a hash lock.
    const preimage = new TextEncoder().encode('mined-secret');
    const rs = hashLockScript(preimage);
    const lock = signLock(
      { from: miner.publicKey, to: ZERO32, amount: 10n * COIN, fee: 0n, nonce: 0, scriptHash: sha256(rs) },
      miner.privateKey,
    );
    const lockId = lockIdOf(lock);
    expect(await chain.addBlock(await buildBlock(chain, miner.publicKey, [lock]))).toBeNull();
    expect(getLock(chain.tipState, bytesToHex(lockId))).toBeDefined();

    // Block 3: anyone with the preimage redeems to bob.
    const redeem = makeRedeem({ lockId, to: bob.publicKey, amount: 10n * COIN, fee: 0n, redeemScript: rs, witness: [preimage] });
    expect(await chain.addBlock(await buildBlock(chain, miner.publicKey, [redeem]))).toBeNull();

    expect(getLock(chain.tipState, bytesToHex(lockId))).toBeUndefined();
    expect(getAccount(chain.tipState, bob.address).balance).toBe(10n * COIN);
  });

  it('split simulation: a script block valid post-fork is rejected when the fork is inactive', async () => {
    const miner = generateKeyPair();
    const chain = new Blockchain();

    // Pre-fork history (empty block) validates the same regardless of activation.
    const block1 = await emptyMine(chain, miner.publicKey);
    expect(await chain.addBlock(block1)).toBeNull();

    // Build a valid lock block while scripts are active.
    const preimage = new TextEncoder().encode('s');
    const rs = hashLockScript(preimage);
    const lock = signLock(
      { from: miner.publicKey, to: ZERO32, amount: 10n * COIN, fee: 0n, nonce: 0, scriptHash: sha256(rs) },
      miner.privateKey,
    );
    const lockBlock = await buildBlock(chain, miner.publicKey, [lock]);

    // Now move activation into the far future — a non-upgraded ruleset. The same
    // block must be rejected: a legacy node forks off here.
    setForkActivationTimeForTesting(GENESIS_TIMESTAMP + 1_000_000_000);
    const err = await chain.addBlock(lockBlock);
    expect(err).toContain('before fork activation');

    // Restore for the rest of this describe block.
    setForkActivationTimeForTesting(GENESIS_TIMESTAMP);
  });
});
