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
import { DIFFICULTY_WINDOW, GENESIS, MAX_BLOCK_BYTES, MAX_FUTURE_TIME_S } from './genesis.js';
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
    const expectedDiff = nextDifficulty(header.height, this.getRecentHeaders(DIFFICULTY_WINDOW, parentHashHex));
    if (header.difficulty !== expectedDiff) {
      return `bad difficulty (expected ${expectedDiff.toString(16)} got ${header.difficulty.toString(16)})`;
    }

    // Timestamp rules.
    const now = Math.floor(Date.now() / 1000);
    if (header.timestamp > now + MAX_FUTURE_TIME_S) return 'timestamp too far in future';
    const mtp = medianTimePast(this.getRecentHeaders(11, parentHashHex));
    if (mtp > 0 && header.timestamp <= mtp) return 'timestamp not above median-time-past';

    // PoW.
    if (!(await checkPoW(header))) return 'PoW invalid';

    // txRoot must match the supplied tx list.
    const expectedTxRoot = computeTxRoot(transactions);
    if (compareBytes(expectedTxRoot, header.txRoot) !== 0) return 'txRoot mismatch';

    // Apply all txs against parent state into a clone, verify final stateRoot.
    const newState = cloneState(parent.state);
    for (const tx of transactions) {
      const sErr = validateTxStructure(tx);
      if (sErr) return `tx structure: ${sErr}`;
    }
    const applyErr = applyBlockTxs(newState, header.height, header.miner, transactions);
    if (applyErr) return `apply: ${applyErr}`;
    const finalRoot = stateRoot(newState);
    if (compareBytes(finalRoot, header.stateRoot) !== 0) return 'stateRoot mismatch';

    // All good. Cache the block and update tip if this branch is now heaviest.
    const work = parent.work + blockWork(header.difficulty);
    this.blocks.set(hashHex, { block, hash, work, state: newState });

    if (work > this.tip.work) {
      this.tipHash = hashHex;
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
