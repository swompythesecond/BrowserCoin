import { bytesToHex } from '../util/binary.js';
import { MAX_MEMPOOL_TXS, MIN_FEE_PER_BYTE } from './genesis.js';
import { getAccount, type State } from './state.js';
import {
  TX_ENCODED_LEN,
  txHash,
  validateTxStructure,
  type Transaction,
} from './transaction.js';

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
   * Drop txs that can no longer be mined against `state` — a different tx has
   * already taken their nonce slot (`tx.nonce < sender.nonce`). That slot is
   * consumed forever, so the tx is dead weight. Called on every tip change so
   * "pending" always means "actually mineable" and a wedged pool self-heals.
   * Returns the number of entries removed.
   */
  pruneStale(state: State): number {
    let removed = 0;
    for (const e of [...this.entries.values()]) {
      const sender = getAccount(state, bytesToHex(e.tx.from));
      if (e.tx.nonce < sender.nonce) {
        this.entries.delete(e.hashHex);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Pick a set of txs to include in the next block. Walks each sender in nonce
   * order (lowest nonce first), then sorts the resulting eligible set by fee-per-byte.
   * Caps to `maxBytes` total.
   */
  selectForBlock(state: State, maxBytes: number): Transaction[] {
    // Group by sender.
    const bySender = new Map<string, MempoolEntry[]>();
    for (const e of this.entries.values()) {
      const k = bytesToHex(e.tx.from);
      if (!bySender.has(k)) bySender.set(k, []);
      bySender.get(k)!.push(e);
    }

    const eligible: MempoolEntry[] = [];
    for (const [sender, list] of bySender) {
      list.sort((a, b) => a.tx.nonce - b.tx.nonce);
      let expected = getAccount(state, sender).nonce;
      for (const e of list) {
        if (e.tx.nonce === expected) {
          eligible.push(e);
          expected += 1;
        } else {
          break; // gap — stop adding for this sender
        }
      }
    }

    // Now greedily pack by fee-per-byte (preserve sender-internal order via stable sort).
    eligible.sort((a, b) => {
      if (a.feePerByte !== b.feePerByte) return a.feePerByte > b.feePerByte ? -1 : 1;
      // Same fee tier: keep nonce order so a sender's txs stay grouped.
      return a.tx.nonce - b.tx.nonce;
    });

    const picked: Transaction[] = [];
    let bytesUsed = 0;
    for (const e of eligible) {
      if (bytesUsed + TX_ENCODED_LEN > maxBytes) break;
      picked.push(e.tx);
      bytesUsed += TX_ENCODED_LEN;
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
