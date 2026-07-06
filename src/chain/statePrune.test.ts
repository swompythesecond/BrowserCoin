import { describe, expect, it } from 'vitest';
import { Blockchain } from './blockchain.js';
import { generateKeyPair } from '../crypto/keys.js';
import { getAccount } from './state.js';
import { hashHeader, type Block } from './block.js';
import { blockReward } from './genesis.js';
import { bytesToHex } from '../util/binary.js';
import { emptyMine } from './testutil.js';

/** Mine `n` empty blocks into `chain`; returns them ascending. */
async function mine(chain: Blockchain, n: number, miner: Uint8Array): Promise<Block[]> {
  const blocks: Block[] = [];
  for (let i = 0; i < n; i++) {
    const b = await emptyMine(chain, miner);
    expect(await chain.addBlock(b)).toBeNull();
    blocks.push(b);
  }
  return blocks;
}

const stateAt = (chain: Blockchain, b: Block) =>
  chain.getBlock(bytesToHex(hashHeader(b.header)))!.state;

describe('rolling state pruning', () => {
  it('dematerializes states below tip − retention, keeps the window', async () => {
    const a = generateKeyPair();
    const chain = new Blockchain(2); // retention shrunk from SNAPSHOT_DEPTH for the test
    const blocks = await mine(chain, 6, a.publicKey);

    // Boundary is 6 − 2 = 4: heights 1–3 pruned, 4–6 materialized.
    expect(stateAt(chain, blocks[0]!)).toBeNull();
    expect(stateAt(chain, blocks[1]!)).toBeNull();
    expect(stateAt(chain, blocks[2]!)).toBeNull();
    expect(stateAt(chain, blocks[3]!)).not.toBeNull();
    expect(stateAt(chain, blocks[5]!)).not.toBeNull();

    // The snapshot writer reads exactly tip − depth; below that is gone.
    expect(chain.snapshotAt(4)).not.toBeNull();
    expect(chain.snapshotAt(3)).toBeNull();

    // Tip state stays usable and correct.
    expect(getAccount(chain.tipState, a.address).balance).toBe(
      [1, 2, 3, 4, 5, 6].reduce((s, h) => s + blockReward(h), 0n),
    );

    // Block DATA below the boundary is untouched (explorer / P2P serving).
    const heights = [...chain.iterateCanonical()].map((cb) => cb.block.header.height);
    expect(heights).toEqual([6, 5, 4, 3, 2, 1, 0]);
  });

  it('rejects a block extending a pruned parent and signals invalidation', async () => {
    const a = generateKeyPair();
    const c = generateKeyPair();
    const chain = new Blockchain(2);
    const blocks = await mine(chain, 6, a.publicKey);

    // Mine a valid fork child of height-2 in a sandbox that never prunes.
    const sandbox = new Blockchain();
    expect(await sandbox.addBlock(blocks[0]!)).toBeNull();
    expect(await sandbox.addBlock(blocks[1]!)).toBeNull();
    const forkChild = await emptyMine(sandbox, c.publicKey); // height 3 off block 2

    let fired = false;
    chain.onSnapshotInvalidated(() => { fired = true; });
    expect(await chain.addBlock(forkChild)).toMatch(/parent state unavailable/);
    expect(fired).toBe(true);
    expect(chain.height).toBe(6); // tip untouched
  });

  it('reorgs within the retention window still work while pruning is active', async () => {
    const a = generateKeyPair();
    const c = generateKeyPair();
    const chain = new Blockchain(3);
    const blocks = await mine(chain, 5, a.publicKey);

    // Competing branch off height 3 (inside the window: boundary is 5 − 3 = 2).
    const sandbox = new Blockchain();
    for (const b of blocks.slice(0, 3)) expect(await sandbox.addBlock(b)).toBeNull();
    const fork = await mine(sandbox, 3, c.publicKey); // heights 4, 5, 6 — heavier

    for (const b of fork) expect(await chain.addBlock(b)).toBeNull();
    expect(chain.height).toBe(6);
    expect(bytesToHex(chain.tip.hash)).toBe(bytesToHex(hashHeader(fork[2]!.header)));
    // Pruning advanced with the new tip: boundary 6 − 3 = 3 → height 2 pruned.
    expect(stateAt(chain, blocks[1]!)).toBeNull();
    expect(stateAt(chain, blocks[2]!)).not.toBeNull(); // height 3, the fork point
  });

  it('reset restores pruning bookkeeping', async () => {
    const a = generateKeyPair();
    const chain = new Blockchain(2);
    await mine(chain, 4, a.publicKey);
    chain.reset();
    expect(chain.height).toBe(0);
    // A fresh replay after reset must accept blocks from height 1 again,
    // and pruning must resume from a clean floor.
    const blocks = await mine(chain, 4, a.publicKey);
    expect(stateAt(chain, blocks[0]!)).toBeNull();     // boundary 4 − 2 = 2 → height 1 pruned
    expect(stateAt(chain, blocks[1]!)).not.toBeNull(); // height 2 kept
  });
});
