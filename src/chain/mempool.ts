import { bytesToHex } from '../util/binary.js';
import { MAX_MEMPOOL_TXS, MEMPOOL_TX_TTL_MS, MIN_FEE_PER_BYTE, TARGET_BLOCK_TIME_S } from './genesis.js';
import { getAccount, type State } from './state.js';
import {
  TX_ENCODED_LEN,
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
 * Note: nonce ordering within a sender is enforced softly — we don't pre-sort,
 * but `selectForBlock` walks senders in nonce order so out-of-order txs sit
 * in the pool until their predecessor lands. Good enough for v1.
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
   * `state` is the current chain-tip state — used for sender-nonce / balance checks.
   */
  add(tx: Transaction, state: State, now = Date.now()): string | null {
    const sErr = validateTxStructure(tx);
    if (sErr) return sErr;

    const feePerByte = tx.fee / BigInt(TX_ENCODED_LEN);
    if (feePerByte < MIN_FEE_PER_BYTE) return 'fee too low';

    const fromHex = bytesToHex(tx.from);
    const sender = getAccount(state, fromHex);
    if (sender.balance < tx.amount + tx.fee) return 'insufficient balance';
    // We allow nonces ≥ current expected (so a sender can queue a few ahead),
    // but cap how far ahead they can go to avoid memory pinning.
    if (tx.nonce < sender.nonce) return 'nonce too low';
    if (tx.nonce > sender.nonce + 16) return 'nonce too far ahead';

    const hashHex = bytesToHex(txHash(tx));
    if (this.entries.has(hashHex)) return null;

    // Replace-by-fee: a sender may hold only ONE tx per nonce in the pool.
    // Block validation requires strictly sequential nonces (applyTx rejects
    // `tx.nonce !== sender.nonce`), so two txs sharing a (sender, nonce) can
    // never both be mined — admitting both just wedges the pool with a tx
    // that masquerades as pending forever. Keep whichever pays more.
    for (const e of this.entries.values()) {
      if (e.tx.nonce === tx.nonce && bytesToHex(e.tx.from) === fromHex) {
        if (feePerByte <= e.feePerByte) return 'nonce already pending';
        this.entries.delete(e.hashHex);
        break;
      }
    }

    if (this.entries.size >= MAX_MEMPOOL_TXS) {
      // Evict the lowest-fee entry. Simple, not optimal — adequate for v1.
      let worst: MempoolEntry | null = null;
      for (const e of this.entries.values()) {
        if (!worst || e.feePerByte < worst.feePerByte) worst = e;
      }
      if (worst && worst.feePerByte >= feePerByte) return 'mempool full';
      if (worst) this.entries.delete(worst.hashHex);
    }

    this.entries.set(hashHex, { tx, hashHex, feePerByte, receivedAt: now });
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
   * pending in this pool. Without this a wallet that sends several txs before
   * any confirms reuses the on-chain nonce for all of them — only the first is
   * ever mineable and the rest wedge the pool. Returns `onChainNonce` when the
   * sender has nothing pending.
   */
  nextNonceFor(addressHex: string, onChainNonce: number): number {
    let next = onChainNonce;
    for (const e of this.entries.values()) {
      if (bytesToHex(e.tx.from) === addressHex && e.tx.nonce >= next) {
        next = e.tx.nonce + 1;
      }
    }
    return next;
  }

  /**
   * Split one sender's pooled entries into the prefix that can actually be mined
   * against `state` and the rest (dead weight). A tx is mineable only if its
   * nonce continues the sequence from the on-chain nonce AND the sender's running
   * balance still covers `amount + fee`. The first tx that gaps the nonce or
   * overdraws the balance stops the walk — nothing behind it can apply either, so
   * the entire tail is unminable from this tip. Mirrors what block validation
   * (`applyTx`) enforces, so a kept set never makes `applyBlockTxs` fail.
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
   * change. Covers:
   *   - nonce too low: the slot was consumed by a confirmed tx — dead forever,
   *     evicted immediately;
   *   - nonce-gapped or unfundable: no contiguous, affordable path from the
   *     on-chain nonce (see `mineablePrefix`). Evicted once it has sat past
   *     `UNMINABLE_GRACE_MS`, so a predecessor still propagating isn't dropped
   *     prematurely;
   *   - older than `MEMPOOL_TX_TTL_MS`: backstop for anything abandoned.
   * Returns the number of entries removed.
   */
  pruneUnminable(state: State, now = Date.now()): number {
    let removed = 0;
    const bySender = new Map<string, MempoolEntry[]>();
    for (const e of this.entries.values()) {
      const k = bytesToHex(e.tx.from);
      if (!bySender.has(k)) bySender.set(k, []);
      bySender.get(k)!.push(e);
    }
    for (const [sender, list] of bySender) {
      const senderNonce = getAccount(state, sender).nonce;
      const { drop } = this.mineablePrefix(state, sender, list);
      for (const e of drop) {
        // nonce-too-low → slot consumed, never minable → drop now; otherwise
        // (gap/overdraw) give a predecessor or incoming funds a grace window.
        const dead = e.tx.nonce < senderNonce;
        if (dead || now - e.receivedAt >= UNMINABLE_GRACE_MS) {
          this.entries.delete(e.hashHex);
          removed++;
        }
      }
    }
    // TTL backstop: evict anything stale regardless of why (e.g. a tx still
    // inside the grace window above but simply abandoned by its sender).
    for (const e of [...this.entries.values()]) {
      if (now - e.receivedAt >= MEMPOOL_TX_TTL_MS) {
        this.entries.delete(e.hashHex);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Pick a set of txs to include in the next block. For each sender we take its
   * mineable prefix (contiguous, fundable nonces from the on-chain nonce), then
   * pack senders in fee-priority order, keeping every sender's nonce sequence
   * intact. Caps to `maxBytes` total.
   */
  selectForBlock(state: State, maxBytes: number): Transaction[] {
    // Group by sender.
    const bySender = new Map<string, MempoolEntry[]>();
    for (const e of this.entries.values()) {
      const k = bytesToHex(e.tx.from);
      if (!bySender.has(k)) bySender.set(k, []);
      bySender.get(k)!.push(e);
    }

    // A sender's mineable prefix is contiguous, fundable and nonce-ascending --
    // the only run we can mine from this tip. It has to go into the block in
    // nonce order with no gaps, or `applyBlockTxs` (which requires
    // `tx.nonce === sender.nonce`) rejects the whole block. So we sort and pack
    // by whole sender, never by individual tx: flattening every sender's txs
    // into one list and sorting by fee-per-byte would let a sender's higher-fee
    // later nonce jump ahead of its own earlier one, producing an invalid block.
    const groups: Array<{ sender: string; txs: MempoolEntry[]; bestFee: bigint }> = [];
    for (const [sender, list] of bySender) {
      const keep = this.mineablePrefix(state, sender, list).keep;
      if (keep.length === 0) continue;
      let bestFee = keep[0]!.feePerByte;
      for (const e of keep) if (e.feePerByte > bestFee) bestFee = e.feePerByte;
      groups.push({ sender, txs: keep, bestFee });
    }

    // Prioritise senders by their best fee-per-byte; tie-break on sender id so
    // the resulting template order is deterministic.
    groups.sort((a, b) => {
      if (a.bestFee !== b.bestFee) return a.bestFee > b.bestFee ? -1 : 1;
      return a.sender < b.sender ? -1 : a.sender > b.sender ? 1 : 0;
    });

    const picked: Transaction[] = [];
    let bytesUsed = 0;
    for (const group of groups) {
      // Pack a sender's prefix from its nonce-start. If it doesn't fully fit we
      // take the leading prefix (nonces stay contiguous) and stop -- never a
      // middle slice, which would gap the sequence. Every tx is the same encoded
      // size, so once one doesn't fit, neither does anything after it.
      for (const e of group.txs) {
        if (bytesUsed + TX_ENCODED_LEN > maxBytes) break;
        picked.push(e.tx);
        bytesUsed += TX_ENCODED_LEN;
      }
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
