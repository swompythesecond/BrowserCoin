/**
 * Test utility: mine a block at low difficulty against a chain tip.
 *
 * Default-timestamp strategy: every test block lands at exactly
 * TARGET_BLOCK_TIME_S after its parent, anchored at GENESIS_TIMESTAMP + T
 * (i.e. block 1 is one target spacing after genesis). Under ASERT this
 * keeps target pinned at GENESIS difficulty (floor) — every block at
 * target pace is equilibrium. Timestamps drift forward but stay below
 * `now + MAX_FUTURE_TIME_S` as long as the suite is run reasonably soon
 * after the genesis-timestamp constant was set.
 */
import { hashHeader, computeTxRoot, type Block, type BlockHeader } from './block.js';
import { checkPoW, nextDifficulty } from './consensus.js';
import { DIFFICULTY_WINDOW, GENESIS_TIMESTAMP, MTP_WINDOW, TARGET_BLOCK_TIME_S } from './genesis.js';
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

  // Block 1 anchors at GENESIS_TIMESTAMP + T (one spacing past genesis) so
  // the MTP check (timestamp > genesis_ts) passes. Subsequent blocks step
  // by one target spacing each — ASERT sees blocks-at-target → target stays
  // at floor → difficulty stable across the synthetic chain.
  const defaultTimestamp = parent.height === 0
    ? GENESIS_TIMESTAMP + TARGET_BLOCK_TIME_S
    : parent.timestamp + TARGET_BLOCK_TIME_S;
  const timestamp = timestampOverride ?? defaultTimestamp;

  const difficulty = nextDifficulty(
    height,
    chain.getRecentHeaders(DIFFICULTY_WINDOW + MTP_WINDOW - 1),
    timestamp,
  );

  const scriptCtx = chain.nextBlockScriptContext();
  const sim = cloneState(chain.tipState);
  const err = applyBlockTxs(sim, height, miner, txs, scriptCtx);
  if (err) throw new Error('test buildBlock apply failed: ' + err);

  const baseHeader: BlockHeader = {
    height,
    prevHash: hashHeader(parent),
    txRoot: computeTxRoot(txs),
    stateRoot: stateRoot(sim),
    timestamp,
    difficulty,
    nonce: 0,
    miner,
  };
  for (let nonce = 0; nonce < 0x7fff_ffff; nonce++) {
    const h: BlockHeader = { ...baseHeader, nonce };
    if (await checkPoW(h)) return { header: h, transactions: txs };
    // Argon2id (via powHash) is synchronous, and after warm-up loadArgon2id()
    // resolves instantly — so `await checkPoW` only ever drains the microtask
    // queue. A multi-block test would then block the event loop's poll phase
    // for minutes straight, starving vitest's worker IPC heartbeat until birpc
    // trips its 60s "Timeout calling onTaskUpdate" error. Yield a real macrotask
    // every few attempts so the heartbeat gets serviced; the cost is negligible
    // next to a ~40–125ms hash.
    if ((nonce & 0x7) === 0) await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('test buildBlock failed to find PoW');
}

export function emptyMine(chain: Blockchain, miner: Uint8Array, timestampOverride?: number): Promise<Block> {
  return buildBlock(chain, miner, [], timestampOverride);
}

export { stateRoot };
export type { State };
