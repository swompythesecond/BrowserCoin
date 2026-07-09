import { describe, expect, it } from 'vitest';
import { Blockchain } from './blockchain.js';
import { generateKeyPair, type KeyPair } from '../crypto/keys.js';
import { deserializeState, getAccount, serializeState, stateRoot } from './state.js';
import { computeTxRoot, hashHeader, type Block, type BlockHeader } from './block.js';
import { GENESIS, GENESIS_DIFFICULTY_COMPACT, GENESIS_TIMESTAMP, TARGET_BLOCK_TIME_S } from './genesis.js';
import { bytesToHex, compareBytes } from '../util/binary.js';
import { emptyMine } from './testutil.js';

/** Build a chain of `n` empty blocks mined by `miner`; returns chain + blocks (asc). */
async function buildChain(n: number, miner: KeyPair): Promise<{ chain: Blockchain; blocks: Block[] }> {
  const chain = new Blockchain();
  const blocks: Block[] = [];
  for (let i = 0; i < n; i++) {
    const b = await emptyMine(chain, miner.publicKey);
    expect(await chain.addBlock(b)).toBeNull();
    blocks.push(b);
  }
  return { chain, blocks };
}

/**
 * Seed a fresh chain the way fast sync does: headers only below the anchor,
 * the anchor header with its verified snapshot state, then the tail replayed
 * as full blocks. Mirrors fastSync's seeding at the Blockchain layer.
 */
async function seedFromHeaders(
  blocks: Block[],
  anchorHeight: number,
  anchorState: ReturnType<typeof deserializeState>,
): Promise<Blockchain> {
  const fresh = new Blockchain();
  for (const blk of blocks) {
    const h = blk.header.height;
    if (h < anchorHeight) {
      expect(fresh.seedHeader(blk.header)).toBeNull();
    } else if (h === anchorHeight) {
      expect(compareBytes(stateRoot(anchorState), blk.header.stateRoot)).toBe(0);
      expect(fresh.seedAnchor(blk.header, anchorState)).toBeNull();
    } else {
      expect(await fresh.addValidatedBlock(blk)).toBeNull();
    }
  }
  return fresh;
}

describe('header-only seeding (fast sync)', () => {
  it('header seed + anchor state + tail replay equals full replay', async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const chain = new Blockchain();
    const blocks: Block[] = [];
    for (let i = 1; i <= 6; i++) {
      const blk = await emptyMine(chain, (i % 2 ? a : b).publicKey);
      expect(await chain.addBlock(blk)).toBeNull();
      blocks.push(blk);
    }
    const at = chain.snapshotAt(3)!;
    const anchorState = deserializeState(serializeState(at.state));

    const fresh = await seedFromHeaders(blocks, 3, anchorState);

    expect(fresh.height).toBe(6);
    expect(bytesToHex(fresh.tip.hash)).toBe(bytesToHex(chain.tip.hash));
    expect(getAccount(fresh.tipState, a.address).balance)
      .toBe(getAccount(chain.tipState, a.address).balance);
    expect(getAccount(fresh.tipState, b.address).balance)
      .toBe(getAccount(chain.tipState, b.address).balance);

    // The prefix (1,2) and the anchor (3) are bodyless; the tail has bodies.
    expect(fresh.bodylessCount).toBe(3);
    expect(fresh.hasFullHistory).toBe(false);
    expect(fresh.lowestBodylessHeight()).toBe(1);

    // Canonical iteration and header lookback span the bodyless prefix.
    const heights = [...fresh.iterateCanonical()].map((cb) => cb.block.header.height);
    expect(heights).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(fresh.getRecentHeaders(10).map((h) => h.height)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('seedHeader never moves the tip; seedAnchor forces it', async () => {
    const a = generateKeyPair();
    const { chain, blocks } = await buildChain(3, a);

    const fresh = new Blockchain();
    expect(fresh.seedHeader(blocks[0]!.header)).toBeNull();
    expect(fresh.seedHeader(blocks[1]!.header)).toBeNull();
    // Headers carry more cumulative work than genesis, but the tip must stay
    // on the only entry with materialized state.
    expect(fresh.height).toBe(0);

    const at = chain.snapshotAt(3)!;
    const anchorState = deserializeState(serializeState(at.state));
    expect(fresh.seedAnchor(blocks[2]!.header, anchorState)).toBeNull();
    expect(fresh.height).toBe(3);
    expect(bytesToHex(fresh.tip.hash)).toBe(at.hashHex);
  });

  it('seedHeader requires the parent and validates height linkage', async () => {
    const a = generateKeyPair();
    const { blocks } = await buildChain(2, a);
    const fresh = new Blockchain();
    expect(fresh.seedHeader(blocks[1]!.header)).toBe('parent block unknown');
    expect(fresh.seedHeader(blocks[0]!.header)).toBeNull();
    expect(fresh.seedHeader(blocks[0]!.header)).toBeNull(); // idempotent
    expect(fresh.bodylessCount).toBe(1);
  });

  it('attachBody: happy path, wrong txRoot, unknown block, already-bodied', async () => {
    const a = generateKeyPair();
    const { chain, blocks } = await buildChain(3, a);
    const at = chain.snapshotAt(2)!;
    const anchorState = deserializeState(serializeState(at.state));
    const fresh = await seedFromHeaders(blocks, 2, anchorState);
    expect(fresh.bodylessCount).toBe(2); // heights 1 (header) + 2 (anchor)

    // Happy path: attach the real bodies oldest-first.
    expect(fresh.attachBody(blocks[0]!)).toBeNull();
    expect(fresh.bodylessCount).toBe(1);
    expect(fresh.lowestBodylessHeight()).toBe(2);
    expect(fresh.getBlock(bytesToHex(hashHeader(blocks[0]!.header)))!.hasBody).toBe(true);

    // Attaching to the anchor keeps its state.
    expect(fresh.attachBody(blocks[1]!)).toBeNull();
    expect(fresh.hasFullHistory).toBe(true);
    expect(fresh.lowestBodylessHeight()).toBe(0);
    expect(fresh.getBlock(at.hashHex)!.state).not.toBeNull();

    // Unknown block.
    const stranger = await emptyMine(chain, a.publicKey);
    const other = new Blockchain();
    expect(other.attachBody(stranger)).toBe('unknown block');

    // Already-bodied entry is a no-op.
    expect(fresh.attachBody(blocks[2]!)).toBeNull();
  });

  it('attachBody rejects a body that does not match the committed txRoot', () => {
    // Hand-craft a header whose txRoot can't match the empty tx list. PoW is
    // irrelevant — seedHeader trusts the caller's verification by design.
    const header: BlockHeader = {
      height: 1,
      prevHash: hashHeader(GENESIS.header),
      txRoot: new Uint8Array(32).fill(9),
      stateRoot: new Uint8Array(32),
      timestamp: GENESIS_TIMESTAMP + TARGET_BLOCK_TIME_S,
      difficulty: GENESIS_DIFFICULTY_COMPACT,
      nonce: 0,
      miner: new Uint8Array(32),
    };
    const fresh = new Blockchain();
    expect(fresh.seedHeader(header)).toBeNull();
    expect(fresh.attachBody({ header, transactions: [] })).toBe('txRoot mismatch');
    expect(fresh.bodylessCount).toBe(1); // still missing
    void computeTxRoot; // (imported for readers cross-checking the mismatch)
  });

  it('extending a bodyless header (reorg below the anchor) fires onSnapshotInvalidated', async () => {
    const a = generateKeyPair();
    const c = generateKeyPair();
    const { chain, blocks } = await buildChain(3, a);
    const at = chain.snapshotAt(3)!;
    const anchorState = deserializeState(serializeState(at.state));
    const fresh = await seedFromHeaders(blocks, 3, anchorState);

    // Build a competing block at height 3 whose parent is the bodyless header 2.
    const sandbox = new Blockchain();
    for (let i = 0; i < 2; i++) expect(await sandbox.addBlock(blocks[i]!)).toBeNull();
    const forkBlock = await emptyMine(sandbox, c.publicKey); // height 3, parent = block 2

    let fired = false;
    fresh.onSnapshotInvalidated(() => { fired = true; });
    const err = await fresh.addValidatedBlock(forkBlock);
    expect(err).toMatch(/reorg below snapshot/);
    expect(fired).toBe(true);
  });

  it('reset clears bodyless bookkeeping', async () => {
    const a = generateKeyPair();
    const { chain, blocks } = await buildChain(2, a);
    const at = chain.snapshotAt(2)!;
    const anchorState = deserializeState(serializeState(at.state));
    const fresh = await seedFromHeaders(blocks, 2, anchorState);
    expect(fresh.bodylessCount).toBe(2);

    fresh.reset();
    expect(fresh.bodylessCount).toBe(0);
    expect(fresh.hasFullHistory).toBe(true);
    expect(fresh.lowestBodylessHeight()).toBe(0);
    expect(fresh.height).toBe(0);
  });
});
