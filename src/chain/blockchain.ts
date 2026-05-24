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

export interface ChainBlock {
  block: Block;
  hash: Uint8Array;        // header hash, cached
  work: bigint;            // cumulative work up to and including this block
  state: State;            // state AFTER applying this block
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
  private tipHash: string;
  /** Listeners invoked after a block is accepted (any branch). Hash-hex passed for keying. */
  private acceptListeners = new Set<(cb: ChainBlock) => void>();

  constructor() {
    const genHash = hashHeader(GENESIS.header);
    const genHashHex = bytesToHex(genHash);
    this.blocks.set(genHashHex, {
      block: GENESIS,
      hash: genHash,
      work: blockWork(GENESIS.header.difficulty),
      state: emptyState(),
    });
    this.tipHash = genHashHex;
  }

  /** Subscribe to every accepted block (canonical or fork). Returns an unsubscribe fn. */
  onBlockAdded(fn: (cb: ChainBlock) => void): () => void {
    this.acceptListeners.add(fn);
    return () => this.acceptListeners.delete(fn);
  }

  get tip(): ChainBlock {
    return this.blocks.get(this.tipHash)!;
  }

  get height(): number {
    return this.tip.block.header.height;
  }

  /** State at the chain tip — do NOT mutate. */
  get tipState(): State {
    return this.tip.state;
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
   * so re-verifying PoW from IDB buys no real security — just latency.
   */
  async addValidatedBlock(block: Block): Promise<ValidationError | null> {
    return this.addBlockInternal(block, { skipPoW: true, skipTxSig: true });
  }

  private async addBlockInternal(
    block: Block,
    opts: { skipPoW: boolean; skipTxSig: boolean },
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
    const newState = cloneState(parent.state);
    if (!opts.skipTxSig) {
      for (const tx of transactions) {
        const sErr = validateTxStructure(tx);
        if (sErr) return `tx structure: ${sErr}`;
      }
    }
    const applyErr = applyBlockTxs(newState, header.height, header.miner, transactions);
    if (applyErr) return `apply: ${applyErr}`;
    const finalRoot = stateRoot(newState);
    if (compareBytes(finalRoot, header.stateRoot) !== 0) return 'stateRoot mismatch';

    // All good. Cache the block and update tip if this branch is now heaviest.
    const work = parent.work + blockWork(header.difficulty);
    const accepted: ChainBlock = { block, hash, work, state: newState };
    this.blocks.set(hashHex, accepted);

    if (work > this.tip.work) {
      this.tipHash = hashHex;
    }
    for (const fn of this.acceptListeners) fn(accepted);
    return null;
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
