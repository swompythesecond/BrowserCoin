import { describe, expect, it } from 'vitest';
import { Blockchain } from '../chain/blockchain.js';
import {
  computeTxRoot,
  encodeBlock,
  hashHeader,
  type Block,
  type BlockHeader,
} from '../chain/block.js';
import {
  GENESIS,
  GENESIS_DIFFICULTY_COMPACT,
  GENESIS_TIMESTAMP,
  TARGET_BLOCK_TIME_S,
} from '../chain/genesis.js';
import { deserializeState, stateRoot } from '../chain/state.js';
import { bytesToHex } from '../util/binary.js';
import { HistoryBackfill } from './backfill.js';

/**
 * Header-consistent chain with no real PoW (the verifier is injected). The
 * anchor carries a synthetic snapshot state, mirroring a fast-synced tab.
 */
const HEIGHTS = 5;

function buildSeededChain(): { chain: Blockchain; blocks: Block[] } {
  const state = deserializeState([['ab'.repeat(32), '42', 0]]);
  const anchorRoot = stateRoot(state);
  const blocks: Block[] = [];
  let prevHash = hashHeader(GENESIS.header);
  for (let height = 1; height <= HEIGHTS; height++) {
    const header: BlockHeader = {
      height,
      prevHash,
      txRoot: computeTxRoot([]),
      stateRoot: height === HEIGHTS ? anchorRoot : new Uint8Array(32),
      timestamp: GENESIS_TIMESTAMP + height * TARGET_BLOCK_TIME_S,
      difficulty: GENESIS_DIFFICULTY_COMPACT,
      nonce: 0,
      miner: new Uint8Array(32),
    };
    blocks.push({ header, transactions: [] });
    prevHash = hashHeader(header);
  }
  const chain = new Blockchain();
  for (let i = 0; i < HEIGHTS - 1; i++) expect(chain.seedHeader(blocks[i]!.header)).toBeNull();
  expect(chain.seedAnchor(blocks[HEIGHTS - 1]!.header, state)).toBeNull();
  expect(chain.bodylessCount).toBe(HEIGHTS);
  return { chain, blocks };
}

function blocksEndpoint(blocks: Block[]): (url: string) => Promise<Response> {
  return async (url: string) => {
    const u = new URL(url);
    const from = Number(u.searchParams.get('fromHeight') ?? 0);
    const max = Number(u.searchParams.get('max') ?? 100);
    const slice = blocks.filter((b) => b.header.height >= from).slice(0, max);
    return {
      ok: true,
      status: 200,
      json: async () => ({ blocks: slice.map((b) => bytesToHex(encodeBlock(b))) }),
    } as unknown as Response;
  };
}

function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('HistoryBackfill', () => {
  it('attaches every missing body, persists, and reports completion', async () => {
    const { chain, blocks } = buildSeededChain();
    const persisted: number[] = [];
    let completed = false;

    const backfill = new HistoryBackfill({
      chain,
      servers: () => ['http://helper'],
      fetchImpl: blocksEndpoint(blocks),
      verifier: { verifyAll: async (bs) => bs.map(() => true) },
      persistBlock: async (_hash, height) => { persisted.push(height); },
      onComplete: () => { completed = true; },
      idleMs: 1,
    });
    backfill.start();
    await waitFor(() => completed);

    expect(chain.hasFullHistory).toBe(true);
    expect(chain.bodylessCount).toBe(0);
    expect(persisted.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    // The anchor kept its snapshot state through the body attach.
    expect(chain.tipState.accounts.get('ab'.repeat(32))!.balance).toBe(42n);
    expect(backfill.getStatus().running).toBe(false);
  });

  it('fires onFatal when a seeded header fails the full PoW sweep', async () => {
    const { chain, blocks } = buildSeededChain();
    let fatal = '';

    const backfill = new HistoryBackfill({
      chain,
      servers: () => ['http://helper'],
      fetchImpl: blocksEndpoint(blocks),
      // Block at index 2 (height 3) fails Argon2id → forged-prefix signal.
      verifier: { verifyAll: async (bs) => bs.map((b) => b.header.height !== 3) },
      persistBlock: async () => {},
      onFatal: (reason) => { fatal = reason; },
      idleMs: 1,
    });
    backfill.start();
    await waitFor(() => fatal !== '');

    expect(fatal).toMatch(/h=3/);
    // Heights 1-2 were attached before the fatal block; 3-5 never were.
    expect(chain.bodylessCount).toBe(3);
  });

  it('ignores blocks that are not part of the seeded chain and keeps retrying', async () => {
    const { chain } = buildSeededChain();
    // A different (unrelated) chain served at the same heights.
    const stranger = buildSeededChain().blocks.map((b) => ({
      header: { ...b.header, miner: new Uint8Array(32).fill(7) },
      transactions: [],
    }));
    const backfill = new HistoryBackfill({
      chain,
      servers: () => ['http://helper'],
      fetchImpl: blocksEndpoint(stranger),
      verifier: { verifyAll: async (bs) => bs.map(() => true) },
      persistBlock: async () => {},
      onFatal: () => { throw new Error('must not be fatal'); },
      idleMs: 1,
    });
    backfill.start();
    await new Promise((r) => setTimeout(r, 50));
    backfill.stop();

    expect(chain.bodylessCount).toBe(HEIGHTS); // nothing attached, nothing broken
  });
});
