/**
 * Test utility: mine a block at low difficulty against a chain tip.
 * Lives outside the test files so multiple test suites can reuse it.
 *
 * Important: the default timestamp jumps by TARGET_BLOCK_TIME_S per block so
 * the per-block difficulty retarget sees blocks-at-target and keeps difficulty
 * stable at genesis. Without this, the test harness's sub-second timestamps
 * trigger ±4× harder difficulty on every block — by block 8 each PoW solve
 * takes minutes and tests time out.
 */
import { hashHeader, computeTxRoot, type Block, type BlockHeader } from './block.js';
import { checkPoW, nextDifficulty } from './consensus.js';
import { DIFFICULTY_WINDOW, TARGET_BLOCK_TIME_S } from './genesis.js';
import { applyBlockTxs, cloneState, stateRoot, type State } from './state.js';
import type { Transaction } from './transaction.js';
import type { Blockchain } from './blockchain.js';

export async function buildBlock(
  chain: Blockchain,
  miner: Uint8Array,
  txs: Transaction[],
  timestampOverride?: number,
): Promise<Block> {
  const parent = chain.tip.block.header;
  const height = parent.height + 1;
  const difficulty = nextDifficulty(height, chain.getRecentHeaders(DIFFICULTY_WINDOW));

  const sim = cloneState(chain.tipState);
  const err = applyBlockTxs(sim, height, miner, txs);
  if (err) throw new Error('test buildBlock apply failed: ' + err);

  // Default timestamp = parent + target block time, so retargeting keeps
  // difficulty stable across the test's synthetic chain.
  const defaultTimestamp = parent.height === 0
    ? Math.floor(Date.now() / 1000)
    : parent.timestamp + TARGET_BLOCK_TIME_S;

  const baseHeader: BlockHeader = {
    height,
    prevHash: hashHeader(parent),
    txRoot: computeTxRoot(txs),
    stateRoot: stateRoot(sim),
    timestamp: timestampOverride ?? defaultTimestamp,
    difficulty,
    nonce: 0,
    miner,
  };
  for (let nonce = 0; nonce < 0x7fff_ffff; nonce++) {
    const h: BlockHeader = { ...baseHeader, nonce };
    if (await checkPoW(h)) return { header: h, transactions: txs };
  }
  throw new Error('test buildBlock failed to find PoW');
}

export function emptyMine(chain: Blockchain, miner: Uint8Array, timestampOverride?: number): Promise<Block> {
  return buildBlock(chain, miner, [], timestampOverride);
}

export { stateRoot };
export type { State };
