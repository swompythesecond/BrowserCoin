import { describe, expect, it } from 'vitest';
import { Blockchain } from './blockchain.js';
import { generateKeyPair, type KeyPair } from '../crypto/keys.js';
import {
  deserializeState,
  getAccount,
  serializeState,
  stateRoot,
} from './state.js';
import {
  computeTxRoot,
  hashHeader,
  type Block,
  type BlockHeader,
} from './block.js';
import { checkPoW, nextDifficulty } from './consensus.js';
import {
  blockReward,
  DIFFICULTY_WINDOW,
  GENESIS_TIMESTAMP,
  MTP_WINDOW,
  TARGET_BLOCK_TIME_S,
} from './genesis.js';
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

/** Seed `blocks` into a fresh chain using the snapshot fast-path: prefix below
 *  `finalizedHeight` gets no state, the anchor gets `anchorState`, the tail is
 *  replayed. Mirrors Node.replayWithSnapshot at the Blockchain layer. */
async function seedFromSnapshot(
  blocks: Block[],
  finalizedHeight: number,
  anchorHashHex: string,
  anchorState: ReturnType<typeof deserializeState>,
): Promise<Blockchain> {
  const fresh = new Blockchain();
  for (const blk of blocks) {
    const h = blk.header.height;
    if (h < finalizedHeight) {
      expect(fresh.seedHistoricalBlock(blk, null)).toBeNull();
    } else if (h === finalizedHeight) {
      expect(bytesToHex(hashHeader(blk.header))).toBe(anchorHashHex);
      expect(fresh.seedHistoricalBlock(blk, anchorState)).toBeNull();
    } else {
      expect(await fresh.addValidatedBlock(blk)).toBeNull();
    }
  }
  return fresh;
}

/** Mine a block with an arbitrary (possibly wrong) stateRoot — used to prove the
 *  restore path skips the stateRoot check that addBlock enforces. */
async function mineWithStateRoot(chain: Blockchain, miner: Uint8Array, sr: Uint8Array): Promise<Block> {
  const parent = chain.tip.block.header;
  const height = parent.height + 1;
  const timestamp = GENESIS_TIMESTAMP + TARGET_BLOCK_TIME_S * height;
  const difficulty = nextDifficulty(
    height,
    chain.getRecentHeaders(DIFFICULTY_WINDOW + MTP_WINDOW - 1),
    timestamp, null,
  );
  const base: BlockHeader = {
    height,
    prevHash: hashHeader(parent),
    txRoot: computeTxRoot([]),
    stateRoot: sr,
    timestamp,
    difficulty,
    nonce: 0,
    miner,
  };
  for (let nonce = 0; nonce < 0x7fff_ffff; nonce++) {
    const h: BlockHeader = { ...base, nonce };
    if (await checkPoW(h)) return { header: h, transactions: [] };
    if ((nonce & 0x7) === 0) await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('test mineWithStateRoot: no PoW');
}

describe('state snapshot restore', () => {
  it('round-trips: snapshot seed + tail replay equals full replay', async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    // Alternate miners so the finalized state has more than one account.
    const chain = new Blockchain();
    const blocks: Block[] = [];
    for (let i = 1; i <= 5; i++) {
      const blk = await emptyMine(chain, (i % 2 ? a : b).publicKey);
      expect(await chain.addBlock(blk)).toBeNull();
      blocks.push(blk);
    }
    const refTip = bytesToHex(chain.tip.hash);
    const refA = getAccount(chain.tipState, a.address).balance;
    const refB = getAccount(chain.tipState, b.address).balance;

    // Snapshot at height 2; round-trip the state through serialize/deserialize.
    const at = chain.snapshotAt(2);
    expect(at).not.toBeNull();
    expect(at!.height).toBe(2);
    const anchorState = deserializeState(serializeState(at!.state));
    // Integrity: the serialized state must hash to the anchor block's stateRoot.
    const anchorBlock = blocks[1]!; // height 2
    expect(compareBytes(stateRoot(anchorState), anchorBlock.header.stateRoot)).toBe(0);

    const fresh = await seedFromSnapshot(blocks, 2, at!.hashHex, anchorState);

    expect(fresh.height).toBe(5);
    expect(bytesToHex(fresh.tip.hash)).toBe(refTip);
    expect(getAccount(fresh.tipState, a.address).balance).toBe(refA);
    expect(getAccount(fresh.tipState, b.address).balance).toBe(refB);
    // Full history stays in memory (explorer / P2P serving depend on it).
    const heights = [...fresh.iterateCanonical()].map((cb) => cb.block.header.height);
    expect(heights).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it('skipStateRoot: addValidatedBlock accepts a bad stateRoot, addBlock rejects it', async () => {
    const a = generateKeyPair();
    const badRoot = new Uint8Array(32).fill(7);
    const c1 = new Blockchain();
    const bad = await mineWithStateRoot(c1, a.publicKey, badRoot);
    // Enforced on the network path.
    expect(await c1.addBlock(bad)).toBe('stateRoot mismatch');
    // Skipped on the trusted-restore path (fresh chain at the same genesis).
    const c2 = new Blockchain();
    expect(await c2.addValidatedBlock(bad)).toBeNull();
    expect(c2.height).toBe(1);
  });

  it('snapshotAt returns null past the tip and for unmaterialized blocks', async () => {
    const a = generateKeyPair();
    const { chain, blocks } = await buildChain(3, a);
    expect(chain.snapshotAt(0)).toBeNull(); // invalid
    expect(chain.snapshotAt(10)).toBeNull(); // beyond tip

    // A null-state prefix block is never snapshotted.
    const fresh = new Blockchain();
    expect(fresh.seedHistoricalBlock(blocks[0]!, null)).toBeNull(); // height 1, no state
    expect(fresh.snapshotAt(1)).toBeNull();
  });

  it('extending a null-state prefix block invalidates the snapshot and is rejected', async () => {
    const a = generateKeyPair();
    const { blocks } = await buildChain(2, a); // real block1, block2

    const fresh = new Blockchain();
    expect(fresh.seedHistoricalBlock(blocks[0]!, null)).toBeNull(); // block1 unmaterialized
    let fired = false;
    fresh.onSnapshotInvalidated(() => { fired = true; });

    const err = await fresh.addValidatedBlock(blocks[1]!); // child of the null-state block1
    expect(err).toMatch(/reorg below snapshot/);
    expect(fired).toBe(true);
  });

  it('reorgs within the tail still work after a snapshot seed', async () => {
    const a = generateKeyPair();
    const c = generateKeyPair();
    const { chain, blocks } = await buildChain(4, a); // heights 1..4 by a

    const at = chain.snapshotAt(2)!;
    const anchorState = deserializeState(serializeState(at.state));
    const fresh = await seedFromSnapshot(blocks, 2, at.hashHex, anchorState);
    expect(fresh.height).toBe(4);

    // Build a heavier competing branch off the anchor (height 2) mined by c.
    const sandbox = new Blockchain();
    for (let i = 0; i < 2; i++) expect(await sandbox.addBlock(blocks[i]!)).toBeNull(); // replay 1,2
    const fork: Block[] = [];
    for (let i = 0; i < 3; i++) {
      const blk = await emptyMine(sandbox, c.publicKey); // heights 3,4,5
      expect(await sandbox.addBlock(blk)).toBeNull();
      fork.push(blk);
    }

    // Feed the fork to the snapshot-restored chain; the 3rd block outweighs the
    // 2-block original tail and triggers a reorg down to the anchor.
    expect(await fresh.addValidatedBlock(fork[0]!)).toBeNull();
    expect(await fresh.addValidatedBlock(fork[1]!)).toBeNull();
    expect(await fresh.addValidatedBlock(fork[2]!)).toBeNull();

    expect(fresh.height).toBe(5);
    expect(bytesToHex(fresh.tip.hash)).toBe(bytesToHex(hashHeader(fork[2]!.header)));
    expect(getAccount(fresh.tipState, c.address).balance).toBe(
      blockReward(3) + blockReward(4) + blockReward(5),
    );
  });
});
