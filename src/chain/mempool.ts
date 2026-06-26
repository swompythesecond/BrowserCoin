import { bytesToHex, compareBytes } from '../util/binary.js';
import { MAX_MEMPOOL_TXS, MEMPOOL_TX_TTL_MS, MIN_FEE_PER_BYTE, TARGET_BLOCK_TIME_S } from './genesis.js';
import { getAccount, getLock, type State } from './state.js';
import { evalScript, scriptHash } from './script.js';
import {
  encodedTxLen,
  isLock,
  isRedeem,
  redeemSighash,
  txHash,
  validateTxStructure,
  type Transaction,
} from './transaction.js';

/**
 * Grace before evicting a provably-unminable (nonce-gapped or unfundable) tx,
 * so a predecessor still propagating isn't dropped on a tip change that happens
 * to land in the gap. One block target is ample — the `+16` nonce-ahead window
 * already bounds how far a gap can run. Does NOT apply to nonce-too-low txs:
 * their slot is already consumed, so they're evicted immediately.
 */
const UNMINABLE_GRACE_MS = TARGET_BLOCK_TIME_S * 1000;

/** Block context a Redeem needs to be script-validated for inclusion. */
export interface SelectScriptContext {
  scriptsActive: boolean;
  blockHeight: number;
  blockMtp: number;
}

/** Per-tx entry — keyed by tx hash hex. */
interface MempoolEntry {
  tx: Transaction;
  hashHex: string;
  feePerByte: bigint;
  receivedAt: number;
}

/**
 * In-memory pending-tx pool. Orders by fee-per-byte descending when selecting
 * txs for the next block. Rejects spam (bad sig, low fee, full pool).
 *
 * Three tx kinds flow through here. Transfers and Locks both debit a `from`
 * account and are ordered by its `nonce` (the original machinery). Redeems are
 * authorized by a witness and replay-protected by spending a one-shot lock, so
 * they have no `from`/`nonce`: they're admitted against an existing lock and
 * de-duplicated per lock id, and only selected once their script actually
 * satisfies the candidate block's context.
 */
export class Mempool {
  private entries = new Map<string, MempoolEntry>();

  size(): number {
    return this.entries.size;
  }

  has(hashHex: string): boolean {
    return this.entries.has(hashHex);
  }

  /** Fetch a single pooled tx by its hash hex, or undefined if absent. */
  get(hashHex: string): Transaction | undefined {
    return this.entries.get(hashHex)?.tx;
  }

  /** Hash hexes of every pooled tx — used for `inv`-style hash announcements. */
  hashes(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Try to admit a transaction. Returns null on success, or an error string.
   * `state` is the current chain-tip state — used for sender-nonce / balance
   * checks (Transfer/Lock) or lock lookup (Redeem).
   */
  add(tx: Transaction, state: State, now = Date.now()): string | null {
    const sErr = validateTxStructure(tx);
    if (sErr) return sErr;

    const feePerByte = tx.fee / BigInt(encodedTxLen(tx));
    if (feePerByte < MIN_FEE_PER_BYTE) return 'fee too low';

    const hashHex = bytesToHex(txHash(tx));
    if (this.entries.has(hashHex)) return null;

    if (isRedeem(tx)) return this.addRedeem(tx, state, feePerByte, hashHex, now);

    // Transfer / Lock: both debit `from` (amount + fee) and consume `nonce`.
    const fromHex = bytesToHex(tx.from);
    const sender = getAccount(state, fromHex);
    if (sender.balance < tx.amount + tx.fee) return 'insufficient balance';
    // We allow nonces ≥ current expected (so a sender can queue a few ahead),
    // but cap how far ahead they can go to avoid memory pinning.
    if (tx.nonce < sender.nonce) return 'nonce too low';
    if (tx.nonce > sender.nonce + 16) return 'nonce too far ahead';

    // Replace-by-fee: a sender may hold only ONE tx per nonce in the pool.
    // Block validation requires strictly sequential nonces, so two txs sharing a
    // (sender, nonce) can never both be mined — keep whichever pays more.
    for (const e of this.entries.values()) {
      if (!isRedeem(e.tx) && e.tx.nonce === tx.nonce && bytesToHex(e.tx.from) === fromHex) {
        if (feePerByte <= e.feePerByte) return 'nonce already pending';
        this.entries.delete(e.hashHex);
        break;
      }
    }

    const full = this.evictForRoom(feePerByte);
    if (full) return full;
    this.entries.set(hashHex, { tx, hashHex, feePerByte, receivedAt: now });
    return null;
  }

  /** Admit a Redeem: its lock must be confirmed, the script must match, and the
   * pool holds at most one Redeem per lock (highest fee wins). */
  private addRedeem(tx: Transaction, state: State, feePerByte: bigint, hashHex: string, now: number): string | null {
    const lockIdHex = bytesToHex(tx.lockId!);
    const lock = getLock(state, lockIdHex);
    if (!lock) return 'unknown or unconfirmed lock';
    if (compareBytes(scriptHash(tx.redeemScript!), lock.scriptHash) !== 0) return 'redeem script does not match lock';
    if (tx.amount !== lock.amount) return 'redeem amount mismatch';
    if (tx.fee > lock.amount) return 'redeem fee exceeds locked amount';

    // One Redeem per lock in the pool — only one can ever be mined.
    for (const e of this.entries.values()) {
      if (isRedeem(e.tx) && e.tx.lockId && bytesToHex(e.tx.lockId) === lockIdHex) {
        if (feePerByte <= e.feePerByte) return 'lock already being redeemed';
        this.entries.delete(e.hashHex);
        break;
      }
    }

    const full = this.evictForRoom(feePerByte);
    if (full) return full;
    this.entries.set(hashHex, { tx, hashHex, feePerByte, receivedAt: now });
    return null;
  }

  /** Make room when the pool is full by evicting the lowest-fee entry. Returns
   * an error string if the incoming tx doesn't out-bid the worst already held. */
  private evictForRoom(feePerByte: bigint): string | null {
    if (this.entries.size < MAX_MEMPOOL_TXS) return null;
    let worst: MempoolEntry | null = null;
    for (const e of this.entries.values()) {
      if (!worst || e.feePerByte < worst.feePerByte) worst = e;
    }
    if (worst && worst.feePerByte >= feePerByte) return 'mempool full';
    if (worst) this.entries.delete(worst.hashHex);
    return null;
  }

  /** Drop any tx in `txs` from the pool. Called after block apply. */
  removeMany(txs: Transaction[]): void {
    for (const tx of txs) {
      this.entries.delete(bytesToHex(txHash(tx)));
    }
  }

  /**
   * The nonce a sender should assign to a *new* tx, accounting for txs already
   * pending in this pool. Returns `onChainNonce` when the sender has nothing
   * pending. Redeems carry no nonce and are ignored.
   */
  nextNonceFor(addressHex: string, onChainNonce: number): number {
    let next = onChainNonce;
    for (const e of this.entries.values()) {
      if (isRedeem(e.tx)) continue;
      if (bytesToHex(e.tx.from) === addressHex && e.tx.nonce >= next) {
        next = e.tx.nonce + 1;
      }
    }
    return next;
  }

  /**
   * Split one sender's pooled account-txs into the prefix that can actually be
   * mined against `state` and the rest (dead weight). A tx is mineable only if
   * its nonce continues the sequence from the on-chain nonce AND the sender's
   * running balance still covers `amount + fee`. Mirrors what block validation
   * enforces, so a kept set never makes `applyBlockTxs` fail. (Locks debit
   * `amount + fee` too, so they're handled identically to transfers here.)
   */
  private mineablePrefix(
    state: State,
    senderHex: string,
    entries: MempoolEntry[],
  ): { keep: MempoolEntry[]; drop: MempoolEntry[] } {
    const sorted = [...entries].sort((a, b) => a.tx.nonce - b.tx.nonce);
    const acct = getAccount(state, senderHex);
    let expected = acct.nonce;
    let balance = acct.balance;
    let i = 0;
    for (; i < sorted.length; i++) {
      const e = sorted[i]!;
      const cost = e.tx.amount + e.tx.fee;
      if (e.tx.nonce !== expected || balance < cost) break;
      balance -= cost;
      expected += 1;
    }
    return { keep: sorted.slice(0, i), drop: sorted.slice(i) };
  }

  /**
   * Drop every pooled tx that can't be mined against `state`, so "pending"
   * always means "actually mineable" and a wedged pool self-heals on each tip
   * change. Covers nonce-too-low (evicted now), nonce-gapped/unfundable account
   * txs and Redeems whose lock has vanished (evicted after a grace window), and
   * a TTL backstop for anything abandoned. Returns the number removed.
   */
  pruneUnminable(state: State, now = Date.now()): number {
    let removed = 0;
    const bySender = new Map<string, MempoolEntry[]>();
    for (const e of this.entries.values()) {
      if (isRedeem(e.tx)) continue; // redeems handled below
      const k = bytesToHex(e.tx.from);
      if (!bySender.has(k)) bySender.set(k, []);
      bySender.get(k)!.push(e);
    }
    for (const [sender, list] of bySender) {
      const senderNonce = getAccount(state, sender).nonce;
      const { drop } = this.mineablePrefix(state, sender, list);
      for (const e of drop) {
        const dead = e.tx.nonce < senderNonce;
        if (dead || now - e.receivedAt >= UNMINABLE_GRACE_MS) {
          this.entries.delete(e.hashHex);
          removed++;
        }
      }
    }
    // Redeems: unminable once their lock is gone (spent or never confirmed).
    for (const e of this.entries.values()) {
      if (!isRedeem(e.tx)) continue;
      const lock = getLock(state, bytesToHex(e.tx.lockId!));
      if (!lock && now - e.receivedAt >= UNMINABLE_GRACE_MS) {
        this.entries.delete(e.hashHex);
        removed++;
      }
    }
    // TTL backstop: evict anything stale regardless of why.
    for (const e of [...this.entries.values()]) {
      if (now - e.receivedAt >= MEMPOOL_TX_TTL_MS) {
        this.entries.delete(e.hashHex);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Pick a set of txs to include in the next block. Walks each sender's mineable
   * prefix (contiguous, fundable nonces), adds any Redeems whose lock is
   * confirmed and whose script satisfies `scriptCtx`, then sorts by fee-per-byte
   * and packs to `maxBytes`. Redeems are only considered when `scriptCtx` says
   * the fork is active — pre-fork they can't be mined.
   */
  selectForBlock(state: State, maxBytes: number, scriptCtx?: SelectScriptContext): Transaction[] {
    const bySender = new Map<string, MempoolEntry[]>();
    const redeems: MempoolEntry[] = [];
    for (const e of this.entries.values()) {
      if (isRedeem(e.tx)) { redeems.push(e); continue; }
      const k = bytesToHex(e.tx.from);
      if (!bySender.has(k)) bySender.set(k, []);
      bySender.get(k)!.push(e);
    }

    const eligible: MempoolEntry[] = [];
    for (const [sender, list] of bySender) {
      let keep = this.mineablePrefix(state, sender, list).keep;
      // Pre-activation a Lock can't be mined; stop the prefix there so the
      // transfers ahead of it still flow (and the Lock waits for the fork).
      if (!scriptCtx?.scriptsActive) {
        const lockIdx = keep.findIndex((e) => isLock(e.tx));
        if (lockIdx >= 0) keep = keep.slice(0, lockIdx);
      }
      eligible.push(...keep);
    }

    if (scriptCtx?.scriptsActive) {
      for (const e of redeems) {
        const lock = getLock(state, bytesToHex(e.tx.lockId!));
        if (!lock) continue; // lock must be confirmed in a prior block
        if (compareBytes(scriptHash(e.tx.redeemScript!), lock.scriptHash) !== 0) continue;
        if (e.tx.amount !== lock.amount || e.tx.fee > lock.amount) continue;
        const r = evalScript(e.tx.redeemScript!, e.tx.witness ?? [], {
          sighash: redeemSighash(e.tx),
          blockHeight: scriptCtx.blockHeight,
          blockMtp: scriptCtx.blockMtp,
        });
        if (r.ok) eligible.push(e);
      }
    }

    // Greedily pack by fee-per-byte (preserve sender-internal order via stable sort).
    eligible.sort((a, b) => {
      if (a.feePerByte !== b.feePerByte) return a.feePerByte > b.feePerByte ? -1 : 1;
      return a.tx.nonce - b.tx.nonce;
    });

    const picked: Transaction[] = [];
    const usedLocks = new Set<string>();
    let bytesUsed = 0;
    for (const e of eligible) {
      if (isRedeem(e.tx)) {
        const lid = bytesToHex(e.tx.lockId!);
        if (usedLocks.has(lid)) continue; // never two redeems of one lock
        usedLocks.add(lid);
      }
      const sz = encodedTxLen(e.tx);
      if (bytesUsed + sz > maxBytes) break;
      picked.push(e.tx);
      bytesUsed += sz;
    }
    return picked;
  }

  list(): Transaction[] {
    return [...this.entries.values()].map((e) => e.tx);
  }

  /** Like `list()` but also exposes when each tx hit the pool — used by the UI. */
  listEntries(): Array<{ tx: Transaction; receivedAt: number; feePerByte: bigint }> {
    return [...this.entries.values()].map((e) => ({
      tx: e.tx,
      receivedAt: e.receivedAt,
      feePerByte: e.feePerByte,
    }));
  }

  clear(): void {
    this.entries.clear();
  }
}
