import type { Blockchain, ChainBlock, ReorgDelta } from '../chain/blockchain.js';
import { blockReward } from '../chain/genesis.js';
import { txHash } from '../chain/transaction.js';
import type { State } from '../chain/state.js';
import { bytesToHex } from '../util/binary.js';

export type TxDir = 'in' | 'out' | 'self' | 'mined';

/**
 * One history entry for one address. Stores only a *reference* into the chain
 * — amounts and counterparties are resolved from `chain.getBlock(blockHash)`
 * at render time, so the index never duplicates transaction data the chain
 * already holds in memory.
 */
export interface TxRef {
  blockHash: string;
  height: number;
  ts: number;       // header timestamp (unix seconds)
  txIndex: number;  // index into block.transactions; -1 = coinbase (mined)
  dir: TxDir;
}

export interface AddressStats {
  received: bigint;     // sum of incoming tx amounts
  sent: bigint;         // sum of outgoing tx amounts (excluding fees)
  feesPaid: bigint;
  minedRewards: bigint; // subsidy + fees collected as miner
  blocksMined: number;
  txCount: number;      // non-coinbase txs touching this address
  /** History, ascending by height. First/last seen derive from the ends. */
  refs: TxRef[];
}

export interface TxLocation {
  blockHash: string;
  height: number;
  txIndex: number;
}

export interface BlockSummary {
  height: number;
  hash: string;
  ts: number;
  txCount: number;
  fees: bigint;
  difficulty: number;
  /** False while the block's tx body hasn't been backfilled yet (fast sync). */
  hasBody: boolean;
}

export interface RichRow {
  address: string;
  balance: bigint;
  nonce: number;
}

/**
 * Chain-wide explorer index: per-address history + aggregates, tx-hash → block
 * location, and height → canonical hash. The `ActivityIndex` generalized from
 * "the wallet's address" to "every address".
 *
 * Built lazily on first explorer visit (one canonical walk + one sha256 per
 * tx), then maintained incrementally from canonical-tip moves. `ensureFresh()`
 * is the safety net: blocks seeded without events (IDB snapshot restore) or
 * any continuity surprise trigger a full rebuild instead of silent drift.
 * Pending (mempool) txs are never cached here — views read the mempool live.
 */
export class ExplorerIndex {
  private byAddress = new Map<string, AddressStats>();
  private txLoc = new Map<string, TxLocation>();
  private heightToHash = new Map<number, string>();
  private indexedTipHash = '';
  private stale = true;
  /** Bumped on every mutation so views can gate expensive recomputes. */
  version = 0;

  constructor(private chain: Blockchain) {}

  /** Apply a canonical-tip move. Falls back to a deferred rebuild on any gap. */
  apply(delta: ReorgDelta): void {
    if (this.stale) return; // rebuild already pending
    if (delta.connected.length === 0) return;

    // Continuity: the branch being unwound must start at our indexed tip, and
    // after unwinding, the oldest connected block must extend the common
    // ancestor (which equals our indexed tip when nothing was disconnected).
    const unwindFrom = delta.disconnected.length ? bytesToHex(delta.disconnected[0]!.hash) : this.indexedTipHash;
    const expectedTip = delta.disconnected.length
      ? bytesToHex(delta.disconnected[delta.disconnected.length - 1]!.block.header.prevHash)
      : this.indexedTipHash;
    const oldest = delta.connected[delta.connected.length - 1]!;
    if (unwindFrom !== this.indexedTipHash || bytesToHex(oldest.block.header.prevHash) !== expectedTip) {
      this.stale = true;
      this.version++;
      return;
    }

    for (const cb of delta.disconnected) this.unindexBlock(cb);
    // connected/disconnected arrive newest-first; index oldest-first so each
    // address's refs stay ascending by height.
    for (let i = delta.connected.length - 1; i >= 0; i--) this.indexBlock(delta.connected[i]!);
    this.indexedTipHash = bytesToHex(delta.connected[0]!.hash);
    this.version++;
  }

  /** Rebuild on any divergence between the indexed tip and the actual tip. */
  ensureFresh(): void {
    const tipHex = bytesToHex(this.chain.tip.hash);
    if (!this.stale && tipHex === this.indexedTipHash) return;
    this.rebuild();
  }

  /**
   * Force the next `ensureFresh()` to rebuild. Called when block bodies were
   * attached outside the tip-move event stream (background history backfill).
   */
  markStale(): void {
    this.stale = true;
    this.version++;
  }

  private rebuild(): void {
    this.byAddress.clear();
    this.txLoc.clear();
    this.heightToHash.clear();
    const blocks: ChainBlock[] = [];
    for (const cb of this.chain.iterateCanonical()) blocks.push(cb);
    for (let i = blocks.length - 1; i >= 0; i--) this.indexBlock(blocks[i]!);
    this.indexedTipHash = bytesToHex(this.chain.tip.hash);
    this.stale = false;
    this.version++;
  }

  private touch(addr: string): AddressStats {
    let s = this.byAddress.get(addr);
    if (!s) {
      s = { received: 0n, sent: 0n, feesPaid: 0n, minedRewards: 0n, blocksMined: 0, txCount: 0, refs: [] };
      this.byAddress.set(addr, s);
    }
    return s;
  }

  private indexBlock(cb: ChainBlock): void {
    const h = cb.block.header;
    if (h.height === 0) return; // genesis credits nobody
    const hashHex = bytesToHex(cb.hash);
    this.heightToHash.set(h.height, hashHex);

    // Fast-sync prefix: the header is known but the tx body isn't downloaded
    // yet, so per-address stats can't be computed. The height mapping above
    // still lets the block list render the row; `markStale()` after backfill
    // completes triggers the full rebuild that fills the stats in.
    if (!cb.hasBody) return;

    let totalFees = 0n;
    for (const tx of cb.block.transactions) totalFees += tx.fee;

    const miner = this.touch(bytesToHex(h.miner));
    miner.blocksMined++;
    miner.minedRewards += blockReward(h.height) + totalFees;
    miner.refs.push({ blockHash: hashHex, height: h.height, ts: h.timestamp, txIndex: -1, dir: 'mined' });

    for (let i = 0; i < cb.block.transactions.length; i++) {
      const tx = cb.block.transactions[i]!;
      const fromHex = bytesToHex(tx.from);
      const toHex = bytesToHex(tx.to);
      this.txLoc.set(bytesToHex(txHash(tx)), { blockHash: hashHex, height: h.height, txIndex: i });

      if (fromHex === toHex) {
        // Self-sends are forbidden by consensus; handled defensively so a rule
        // change can't double-count.
        const a = this.touch(fromHex);
        a.feesPaid += tx.fee;
        a.txCount++;
        a.refs.push({ blockHash: hashHex, height: h.height, ts: h.timestamp, txIndex: i, dir: 'self' });
        continue;
      }
      const sender = this.touch(fromHex);
      sender.sent += tx.amount;
      sender.feesPaid += tx.fee;
      sender.txCount++;
      sender.refs.push({ blockHash: hashHex, height: h.height, ts: h.timestamp, txIndex: i, dir: 'out' });

      const recipient = this.touch(toHex);
      recipient.received += tx.amount;
      recipient.txCount++;
      recipient.refs.push({ blockHash: hashHex, height: h.height, ts: h.timestamp, txIndex: i, dir: 'in' });
    }
  }

  /** Exact inverse of indexBlock. Reorgs only touch recent blocks, so the refs
   *  to drop sit at the tail of each address's history. */
  private unindexBlock(cb: ChainBlock): void {
    const h = cb.block.header;
    if (h.height === 0) return;
    const hashHex = bytesToHex(cb.hash);
    if (this.heightToHash.get(h.height) === hashHex) this.heightToHash.delete(h.height);

    if (!cb.hasBody) return; // never contributed address stats

    let totalFees = 0n;
    for (const tx of cb.block.transactions) totalFees += tx.fee;

    const minerHex = bytesToHex(h.miner);
    const miner = this.byAddress.get(minerHex);
    if (miner) {
      miner.blocksMined--;
      miner.minedRewards -= blockReward(h.height) + totalFees;
      this.dropRefs(minerHex, miner, hashHex);
    }

    for (const tx of cb.block.transactions) {
      const fromHex = bytesToHex(tx.from);
      const toHex = bytesToHex(tx.to);
      this.txLoc.delete(bytesToHex(txHash(tx)));

      if (fromHex === toHex) {
        const a = this.byAddress.get(fromHex);
        if (a) {
          a.feesPaid -= tx.fee;
          a.txCount--;
          this.dropRefs(fromHex, a, hashHex);
        }
        continue;
      }
      const sender = this.byAddress.get(fromHex);
      if (sender) {
        sender.sent -= tx.amount;
        sender.feesPaid -= tx.fee;
        sender.txCount--;
        this.dropRefs(fromHex, sender, hashHex);
      }
      const recipient = this.byAddress.get(toHex);
      if (recipient) {
        recipient.received -= tx.amount;
        recipient.txCount--;
        this.dropRefs(toHex, recipient, hashHex);
      }
    }
  }

  /** Remove all refs into `blockHash` (they cluster at the tail), then GC the
   *  entry if nothing is left. Each disconnected block calls this once per
   *  touched address, so dropping all matches at once stays correct when an
   *  address appears in several txs of the same block. */
  private dropRefs(addr: string, s: AddressStats, blockHash: string): void {
    let end = s.refs.length;
    while (end > 0 && this.refsTailMatches(s.refs, end, blockHash)) end--;
    if (end < s.refs.length) {
      s.refs.length = end;
    } else {
      s.refs = s.refs.filter((r) => r.blockHash !== blockHash); // deep reorg fallback
    }
    if (s.refs.length === 0 && s.txCount === 0 && s.blocksMined === 0) this.byAddress.delete(addr);
  }

  private refsTailMatches(refs: TxRef[], end: number, blockHash: string): boolean {
    return refs[end - 1]!.blockHash === blockHash;
  }

  // ---------- Read API ----------

  getAddress(addrHex: string): AddressStats | undefined {
    return this.byAddress.get(addrHex);
  }

  findTx(txHashHex: string): TxLocation | undefined {
    return this.txLoc.get(txHashHex);
  }

  hashAtHeight(height: number): string | undefined {
    return this.heightToHash.get(height);
  }

  /** Addresses ever seen on-chain (current holders are `tipState.size`). */
  addressCount(): number {
    return this.byAddress.size;
  }

  totalTxCount(): number {
    return this.txLoc.size;
  }

  /** Indexed addresses starting with `prefix`, up to `limit` matches. */
  knownAddressesWithPrefix(prefix: string, limit: number): string[] {
    const out: string[] = [];
    for (const addr of this.byAddress.keys()) {
      if (addr.startsWith(prefix)) {
        out.push(addr);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  private cachedRich: RichRow[] = [];
  private cachedRichVersion = -1;

  /** All non-zero balances sorted descending. Cached until the chain moves. */
  richList(state: State): RichRow[] {
    if (this.cachedRichVersion === this.version) return this.cachedRich;
    const rows: RichRow[] = [];
    for (const [address, acct] of state.accounts) {
      rows.push({ address, balance: acct.balance, nonce: acct.nonce });
    }
    rows.sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1));
    this.cachedRich = rows;
    this.cachedRichVersion = this.version;
    return rows;
  }

  topMiners(limit: number): Array<{ address: string; blocksMined: number; minedRewards: bigint }> {
    const out: Array<{ address: string; blocksMined: number; minedRewards: bigint }> = [];
    for (const [address, s] of this.byAddress) {
      if (s.blocksMined > 0) out.push({ address, blocksMined: s.blocksMined, minedRewards: s.minedRewards });
    }
    out.sort((a, b) => b.blocksMined - a.blocksMined);
    return out.slice(0, limit);
  }

  /** Summaries of the most recent `lastN` canonical blocks, ascending height. */
  blockSummaries(lastN: number): BlockSummary[] {
    const tipHeight = this.chain.height;
    const from = Math.max(1, tipHeight - lastN + 1);
    const out: BlockSummary[] = [];
    for (let height = from; height <= tipHeight; height++) {
      const hash = this.heightToHash.get(height);
      if (!hash) continue;
      const cb = this.chain.getBlock(hash);
      if (!cb) continue;
      let fees = 0n;
      if (cb.hasBody) for (const tx of cb.block.transactions) fees += tx.fee;
      out.push({
        height,
        hash,
        ts: cb.block.header.timestamp,
        txCount: cb.hasBody ? cb.block.transactions.length : 0,
        fees,
        difficulty: cb.block.header.difficulty,
        hasBody: cb.hasBody,
      });
    }
    return out;
  }
}

let singleton: ExplorerIndex | null = null;

/**
 * Lazy singleton: created (and the chain walked) on first explorer visit, then
 * kept in lock-step with the canonical tip for the life of the tab. The
 * subscription is intentionally never torn down — the index outlives any view.
 */
export function getExplorerIndex(chain: Blockchain): ExplorerIndex {
  if (!singleton) {
    const idx = new ExplorerIndex(chain);
    chain.onTipChanged((d) => idx.apply(d));
    singleton = idx;
  }
  return singleton;
}
