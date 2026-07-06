import { bytesToHex, compareBytes } from '../util/binary.js';
import {
  blockSize,
  computeTxRoot,
  encodeHeader,
  hashHeader,
  type Block,
  type BlockHeader,
} from './block.js';
import { blockWork, checkPoW, medianTimePast, nextDifficulty } from './consensus.js';
import {
  DIFFICULTY_WINDOW,
  GENESIS,
  MAX_BLOCK_BYTES,
  MAX_FUTURE_TIME_S,
  MTP_WINDOW,
  SNAPSHOT_DEPTH,
} from './genesis.js';

// Retarget reads up to DIFFICULTY_WINDOW headers, and MTP at the window
// start reads MTP_WINDOW headers ending there — so we need that many
// extras before the window for the start-MTP to be accurate.
const RETARGET_LOOKBACK = DIFFICULTY_WINDOW + MTP_WINDOW - 1;
import {
  applyBlockTxs,
  cloneState,
  emptyState,
  stateRoot,
  type State,
} from './state.js';
import { validateTxStructure, type Transaction } from './transaction.js';
import { scriptsActiveForMtp } from './fork.js';

export interface ChainBlock {
  block: Block;
  hash: Uint8Array;        // header hash, cached
  work: bigint;            // cumulative work up to and including this block
  /**
   * Account state AFTER applying this block, or `null` if not materialized.
   * Only blocks within SNAPSHOT_DEPTH of the tip keep a materialized state:
   * deeper states are pruned as the tip advances (and snapshot-restore never
   * materializes them in the first place). Retaining one full state clone per
   * block is O(blocks × accounts) — ~1.5 GB at h≈24.5k — which iOS Safari's
   * per-tab memory limit can't hold; the tip is always materialized, and only
   * `parent.state` (when extending) and the snapshot writer ever read a
   * non-tip block's state, both within the kept window.
   */
  state: State | null;
}

/**
 * Description of how the canonical chain changed when the tip moved. `confirmed`
 * txs are now on the active chain (drop them from the mempool); `restored` txs
 * were displaced by a reorg and should go back into the mempool so they can be
 * re-mined. For a plain tip-extension `restored` is empty and `confirmed` is
 * just the new block's txs.
 */
export interface ReorgDelta {
  confirmed: Transaction[];
  restored: Transaction[];
  /** Blocks now on the canonical chain (the new branch above the common ancestor). */
  connected: ChainBlock[];
  /** Blocks displaced off the canonical chain by a reorg (the old branch). */
  disconnected: ChainBlock[];
}

export type ValidationError = string;

/**
 * In-memory blockchain. Holds all known blocks indexed by hash, tracks the heaviest
 * tip, and supports inserting new blocks with full validation. Designed to be small
 * enough to live alongside a 64KB miner in a single tab — we trim to the heaviest
 * branch + a small buffer when persisting elsewhere.
 */
export class Blockchain {
  /** All known valid blocks, by hex header hash. */
  private blocks = new Map<string, ChainBlock>();
  /** The chain tip — the block with the highest cumulative work. */
  private tipHash!: string;
  /**
   * Hex hashes of every block at a height, across all branches. Lets the state
   * pruner null out fork siblings too, not just the canonical block. Entries
   * are dropped once their height is pruned — a block below the prune floor
   * can never be accepted again (its parent's state is gone).
   */
  private byHeight = new Map<number, string[]>();
  /** Heights below this have had their states pruned (monotonic). */
  private pruneFloor = 0;
  /** Listeners invoked after a block is accepted (any branch). Hash-hex passed for keying. */
  private acceptListeners = new Set<(cb: ChainBlock) => void>();
  /** Listeners invoked only when the canonical tip moves, with the mempool delta. */
  private tipChangeListeners = new Set<(d: ReorgDelta) => void>();
  /**
   * Listeners fired when a block can only be validated against state below the
   * snapshot anchor — state we don't hold after a snapshot restore. The node
   * clears the persisted snapshot so the next load full-replays from genesis.
   * Practically unreachable: it needs a reorg deeper than SNAPSHOT_DEPTH.
   */
  private snapshotInvalidatedListeners = new Set<() => void>();

  /**
   * `stateRetentionDepth` is how many blocks below the tip keep a materialized
   * state (see `pruneStates`). Tests shrink it to exercise pruning without
   * mining SNAPSHOT_DEPTH real-PoW blocks; production uses the default — it
   * must be ≥ SNAPSHOT_DEPTH or the snapshot writer would find its anchor
   * state already pruned.
   */
  constructor(private readonly stateRetentionDepth: number = SNAPSHOT_DEPTH) {
    this.initGenesis();
  }

  private initGenesis(): void {
    const genHash = hashHeader(GENESIS.header);
    const genHashHex = bytesToHex(genHash);
    this.blocks.set(genHashHex, {
      block: GENESIS,
      hash: genHash,
      work: blockWork(GENESIS.header.difficulty),
      state: emptyState(),
    });
    this.indexHeight(0, genHashHex);
    this.tipHash = genHashHex;
  }

  /**
   * Discard all in-memory blocks back to genesis only. Used to retry restore via
   * a clean full replay after the snapshot fast-path aborts on any anomaly.
   */
  reset(): void {
    this.blocks.clear();
    this.byHeight.clear();
    this.pruneFloor = 0;
    this.initGenesis();
  }

  private indexHeight(height: number, hashHex: string): void {
    const bucket = this.byHeight.get(height);
    if (bucket) bucket.push(hashHex);
    else this.byHeight.set(height, [hashHex]);
  }

  /**
   * Null out materialized states more than SNAPSHOT_DEPTH below the tip. Called
   * whenever the tip advances. Keeping a state clone per block is
   * O(blocks × accounts) and grows without bound; everything the node does with
   * historical blocks (explorer, P2P serving, wallet history) reads block DATA,
   * which stays — only the derived per-height account state is dropped. This is
   * the same shape a snapshot-restored tab already runs in. The floor is
   * monotonic and each height is visited once, so cost is O(1) amortized per
   * accepted block. Trade-off: a reorg forking below the floor can't be
   * validated (fires onSnapshotInvalidated) — it needs a reorg deeper than
   * SNAPSHOT_DEPTH, which sync's 5-block overlap makes practically unreachable.
   */
  private pruneStates(): void {
    const boundary = this.height - this.stateRetentionDepth;
    while (this.pruneFloor < boundary) {
      const hashes = this.byHeight.get(this.pruneFloor);
      if (hashes) {
        for (const hex of hashes) {
          const cb = this.blocks.get(hex);
          if (cb) cb.state = null;
        }
        this.byHeight.delete(this.pruneFloor);
      }
      this.pruneFloor++;
    }
  }

  /** Subscribe to every accepted block (canonical or fork). Returns an unsubscribe fn. */
  onBlockAdded(fn: (cb: ChainBlock) => void): () => void {
    this.acceptListeners.add(fn);
    return () => this.acceptListeners.delete(fn);
  }

  /**
   * Subscribe to canonical-tip moves. Fires only when the active chain changes
   * (a plain extension or a reorg) with the txs that became confirmed and the
   * txs that were displaced back into pending. This is the single place mempool
   * eviction should hang off — a tx must never leave the mempool just because
   * it appeared in some accepted-but-non-canonical fork block.
   */
  onTipChanged(fn: (d: ReorgDelta) => void): () => void {
    this.tipChangeListeners.add(fn);
    return () => this.tipChangeListeners.delete(fn);
  }

  /** Subscribe to snapshot-invalidation (a reorg below the snapshot anchor). */
  onSnapshotInvalidated(fn: () => void): () => void {
    this.snapshotInvalidatedListeners.add(fn);
    return () => this.snapshotInvalidatedListeners.delete(fn);
  }

  get tip(): ChainBlock {
    return this.blocks.get(this.tipHash)!;
  }

  get height(): number {
    return this.tip.block.header.height;
  }

  /** State at the chain tip — do NOT mutate. The tip is always materialized. */
  get tipState(): State {
    const s = this.tip.state;
    if (s === null) throw new Error('tip state not materialized'); // invariant violation
    return s;
  }

  get tipDifficulty(): number {
    return this.tip.block.header.difficulty;
  }

  hasBlock(hashHex: string): boolean {
    return this.blocks.has(hashHex);
  }

  getBlock(hashHex: string): ChainBlock | undefined {
    return this.blocks.get(hashHex);
  }

  /** Walk back from the tip collecting up to `n` block headers (newest last). */
  getRecentHeaders(n: number, fromHash: string = this.tipHash): BlockHeader[] {
    const out: BlockHeader[] = [];
    let cursor: string | undefined = fromHash;
    while (cursor && out.length < n) {
      const entry = this.blocks.get(cursor);
      if (!entry) break;
      out.push(entry.block.header);
      if (entry.block.header.height === 0) break;
      cursor = bytesToHex(entry.block.header.prevHash);
    }
    return out.reverse();
  }

  /**
   * Try to add a block. Validates fully: parent exists, PoW, header roots match,
   * timestamp rules, tx signatures + balance/nonce, block size cap. Returns null
   * on success, or an error message.
   *
   * Reorgs are handled by virtue of storing every valid block and letting the
   * heaviest-work tip win. Storage is per-block — no in-place mutation of
   * other branches.
   */
  async addBlock(block: Block): Promise<ValidationError | null> {
    return this.addBlockInternal(block, { skipPoW: false, skipTxSig: false });
  }

  /**
   * Restore a block that was previously validated and persisted locally (IDB).
   * Skips Argon2id PoW + tx signature re-checks — those were verified when the
   * block was first accepted, and re-running them would burn ~40–125 ms each.
   * Still performs all state-dependent checks (parent link, difficulty,
   * timestamp, roots, state apply) because they're cheap and catch IDB
   * corruption / version-skew bugs.
   *
   * An attacker who can rewrite IndexedDB could also rewrite the running JS,
   * so re-verifying PoW from IDB buys no real security — just latency. By the
   * same logic we skip the per-block stateRoot recompute (a full sort + merkle
   * of every account, O(accounts) per block): the root was checked when the
   * block was first accepted, and `applyBlockTxs` still runs so balance/nonce
   * arithmetic is still validated.
   */
  async addValidatedBlock(block: Block): Promise<ValidationError | null> {
    return this.addBlockInternal(block, { skipPoW: true, skipTxSig: true, skipStateRoot: true });
  }

  /**
   * Script-fork context a child of `parentHashHex` (default: the current tip)
   * would be mined under: its median-time-past and whether script (Lock/Redeem)
   * transactions are active at that point. Used by the miner template and tests
   * so the candidate's stateRoot matches what validation will recompute.
   */
  nextBlockScriptContext(parentHashHex: string = this.tipHash): { scriptsActive: boolean; blockMtp: number } {
    const mtp = medianTimePast(this.getRecentHeaders(MTP_WINDOW, parentHashHex));
    return { scriptsActive: scriptsActiveForMtp(mtp), blockMtp: mtp };
  }

  private async addBlockInternal(
    block: Block,
    opts: { skipPoW: boolean; skipTxSig: boolean; skipStateRoot?: boolean },
  ): Promise<ValidationError | null> {
    const { header, transactions } = block;
    const hash = hashHeader(header);
    const hashHex = bytesToHex(hash);

    if (this.blocks.has(hashHex)) return null; // already have it; idempotent

    // Parent must exist and height must follow.
    const parentHashHex = bytesToHex(header.prevHash);
    const parent = this.blocks.get(parentHashHex);
    if (!parent) return 'parent block unknown';
    if (header.height !== parent.block.header.height + 1) return 'height not parent+1';

    // Block size cap.
    if (blockSize(block) > MAX_BLOCK_BYTES) return 'block too large';

    // Difficulty must match what the chain expects at this height.
    const lookbackHeaders = this.getRecentHeaders(RETARGET_LOOKBACK, parentHashHex);
    const expectedDiff = nextDifficulty(header.height, lookbackHeaders, header.timestamp);
    if (header.difficulty !== expectedDiff) {
      return `bad difficulty (expected ${expectedDiff.toString(16)} got ${header.difficulty.toString(16)})`;
    }

    // Timestamp rules.
    const now = Math.floor(Date.now() / 1000);
    if (header.timestamp > now + MAX_FUTURE_TIME_S) return 'timestamp too far in future';
    const mtp = medianTimePast(this.getRecentHeaders(MTP_WINDOW, parentHashHex));
    if (mtp > 0 && header.timestamp <= mtp) return 'timestamp not above median-time-past';

    // PoW.
    if (!opts.skipPoW && !(await checkPoW(header))) return 'PoW invalid';

    // txRoot must match the supplied tx list.
    const expectedTxRoot = computeTxRoot(transactions);
    if (compareBytes(expectedTxRoot, header.txRoot) !== 0) return 'txRoot mismatch';

    // Apply all txs against parent state into a clone, verify final stateRoot.
    if (parent.state === null) {
      // Parent is a finalized-prefix block whose state we didn't materialize on
      // snapshot restore. Extending it means a reorg deeper than SNAPSHOT_DEPTH —
      // we can't validate without that state. Signal the node to drop the
      // snapshot and full-replay, and reject this block for now.
      for (const fn of this.snapshotInvalidatedListeners) fn();
      return 'parent state unavailable (reorg below snapshot anchor)';
    }
    const newState = cloneState(parent.state);
    if (!opts.skipTxSig) {
      for (const tx of transactions) {
        const sErr = validateTxStructure(tx);
        if (sErr) return `tx structure: ${sErr}`;
      }
    }
    const applyErr = applyBlockTxs(newState, header.height, header.miner, transactions, {
      scriptsActive: scriptsActiveForMtp(mtp),
      blockMtp: mtp,
    });
    if (applyErr) return `apply: ${applyErr}`;
    if (!opts.skipStateRoot) {
      const finalRoot = stateRoot(newState);
      if (compareBytes(finalRoot, header.stateRoot) !== 0) return 'stateRoot mismatch';
    }

    // All good. Cache the block and update tip if this branch is now heaviest.
    const work = parent.work + blockWork(header.difficulty);
    const accepted: ChainBlock = { block, hash, work, state: newState };
    this.blocks.set(hashHex, accepted);
    this.indexHeight(header.height, hashHex);

    const prevTipHex = this.tipHash;
    if (work > this.tip.work) {
      this.tipHash = hashHex;
      this.pruneStates();
    }
    for (const fn of this.acceptListeners) fn(accepted);

    // If the canonical tip moved, tell mempool-reconciliation listeners which
    // txs are now confirmed and which were displaced. Computed even when the
    // move is a plain extension (cheap: empty `restored`, one block's txs).
    if (this.tipHash !== prevTipHex && this.tipChangeListeners.size > 0) {
      const delta = this.reorgDelta(prevTipHex, this.tipHash);
      for (const fn of this.tipChangeListeners) fn(delta);
    }
    return null;
  }

  /**
   * Diff two canonical tips by their hashes: walk both back to their common
   * ancestor. Txs on the old branch (above the ancestor) are `restored`
   * (return to mempool); txs on the new branch are `confirmed` (leave mempool).
   */
  private reorgDelta(oldTipHex: string, newTipHex: string): ReorgDelta {
    const oldBlocks: ChainBlock[] = [];
    const newBlocks: ChainBlock[] = [];
    let aHex: string = oldTipHex;
    let bHex: string = newTipHex;
    let a = this.blocks.get(aHex);
    let b = this.blocks.get(bHex);

    // Bring the deeper branch up until both cursors sit at the same height.
    while (a && b && a.block.header.height > b.block.header.height) {
      oldBlocks.push(a);
      aHex = bytesToHex(a.block.header.prevHash);
      a = this.blocks.get(aHex);
    }
    while (a && b && b.block.header.height > a.block.header.height) {
      newBlocks.push(b);
      bHex = bytesToHex(b.block.header.prevHash);
      b = this.blocks.get(bHex);
    }
    // Same height now — step both back together until they converge.
    while (a && b && aHex !== bHex) {
      oldBlocks.push(a);
      newBlocks.push(b);
      aHex = bytesToHex(a.block.header.prevHash);
      bHex = bytesToHex(b.block.header.prevHash);
      a = this.blocks.get(aHex);
      b = this.blocks.get(bHex);
    }

    const restored: Transaction[] = [];
    for (const cb of oldBlocks) for (const tx of cb.block.transactions) restored.push(tx);
    const confirmed: Transaction[] = [];
    for (const cb of newBlocks) for (const tx of cb.block.transactions) confirmed.push(tx);
    return { confirmed, restored, connected: newBlocks, disconnected: oldBlocks };
  }

  /**
   * Variant of addBlock that lets the caller supply a pre-computed PoW result.
   * Used by the parallel verifier worker pool: the worker runs Argon2id in
   * parallel and the main thread feeds the verdict in here. State-dependent
   * checks still run sequentially.
   */
  async addBlockWithPow(block: Block, powValid: boolean): Promise<ValidationError | null> {
    if (!powValid) return 'PoW invalid';
    return this.addBlockInternal(block, { skipPoW: true, skipTxSig: false });
  }

  /**
   * Insert a previously-validated block from local storage WITHOUT re-validating
   * or firing accept/tip listeners. The block's post-state is `state` — `null`
   * for an ordinary finalized-prefix block (skips the costly clone + apply), or
   * the materialized account state for the snapshot anchor so the tail can be
   * replayed on top of it. Cumulative work is derived from the parent (cheap).
   *
   * Keeping the full block (with txs) in memory preserves the explorer, P2P
   * block serving and wallet-history rebuild; only per-block *state* is skipped.
   * Returns an error string if the parent isn't present yet (caller feeds blocks
   * height-ascending so parents always precede children).
   */
  seedHistoricalBlock(block: Block, state: State | null): ValidationError | null {
    const header = block.header;
    const hash = hashHeader(header);
    const hashHex = bytesToHex(hash);
    if (this.blocks.has(hashHex)) return null; // idempotent

    const parent = this.blocks.get(bytesToHex(header.prevHash));
    if (!parent) return 'parent block unknown';

    const work = parent.work + blockWork(header.difficulty);
    this.blocks.set(hashHex, { block, hash, work, state });
    this.indexHeight(header.height, hashHex);

    if (state !== null) {
      // The designated canonical anchor — force it to be the tip so the tail
      // replays on it regardless of any equal-work fork at the same height.
      this.tipHash = hashHex;
    } else if (work > this.tip.work) {
      this.tipHash = hashHex;
    }
    return null;
  }

  /**
   * Capture the canonical block at `finalizedHeight` and its materialized state,
   * for persisting a local state snapshot. Returns null if the chain doesn't
   * reach that height or that block's state isn't materialized (so we never
   * serialize a `null`-state prefix block).
   */
  snapshotAt(finalizedHeight: number): { hashHex: string; height: number; state: State } | null {
    if (finalizedHeight <= 0) return null;
    let cursor: string | undefined = this.tipHash;
    while (cursor) {
      const entry: ChainBlock | undefined = this.blocks.get(cursor);
      if (!entry) return null;
      const h = entry.block.header.height;
      if (h === finalizedHeight) {
        if (entry.state === null) return null;
        return { hashHex: cursor, height: h, state: entry.state };
      }
      if (h <= finalizedHeight) return null; // walked past it (gap)
      cursor = bytesToHex(entry.block.header.prevHash);
    }
    return null;
  }

  /** Number of stored blocks across all branches. Helpful for debugging/UI. */
  get size(): number {
    return this.blocks.size;
  }

  /** Hash of a header, hex-encoded. Convenience. */
  static hash(header: BlockHeader): string {
    return bytesToHex(hashHeader(header));
  }

  /** Pre-image hash for the header without nonce mutation — handy for the miner. */
  static headerBytes(header: BlockHeader): Uint8Array {
    return encodeHeader(header);
  }

  /** Iterate the canonical chain (tip → genesis), used for explorer + persistence. */
  *iterateCanonical(): IterableIterator<ChainBlock> {
    let cursor: string | undefined = this.tipHash;
    while (cursor) {
      const entry = this.blocks.get(cursor);
      if (!entry) return;
      yield entry;
      if (entry.block.header.height === 0) return;
      cursor = bytesToHex(entry.block.header.prevHash);
    }
  }

  /** Headers along the canonical chain, genesis-first. */
  canonicalHeaders(): BlockHeader[] {
    const out: BlockHeader[] = [];
    for (const cb of this.iterateCanonical()) out.push(cb.block.header);
    return out.reverse();
  }
}
