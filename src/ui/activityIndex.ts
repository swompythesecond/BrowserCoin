import type { Block } from '../chain/block.js';
import type { ChainBlock, ReorgDelta } from '../chain/blockchain.js';
import { blockReward } from '../chain/genesis.js';
import { bytesToHex } from '../util/binary.js';

export interface ActivityRow {
  status: 'pending' | 'confirmed' | 'mined';
  dir: 'sent' | 'received' | 'mined';
  counterparty: string; // short hex, or 'block #N' for mined rows
  amount: bigint;       // positive = inflow, negative = outflow (incl. fee)
  fee: bigint;
  when: string;
  sortKey: number;      // higher = newer
}

/**
 * Activity rows contributed by a single canonical block (mined coinbase + any
 * txs touching `myAddr`). Shared by the live index and the fallback scanner in
 * activity.ts so both produce identical rows.
 */
export function extractBlockRows(block: Block, myAddr: string): ActivityRow[] {
  const h = block.header;
  if (h.height === 0) return []; // genesis credits nobody
  const rows: ActivityRow[] = [];
  const sortBase = h.timestamp * 1000;

  if (bytesToHex(h.miner) === myAddr) {
    let totalFees = 0n;
    for (const tx of block.transactions) totalFees += tx.fee;
    rows.push({
      status: 'mined',
      dir: 'mined',
      counterparty: `block #${h.height}`,
      amount: blockReward(h.height) + totalFees,
      fee: 0n,
      when: blockTime(h.timestamp),
      sortKey: sortBase,
    });
  }

  for (const tx of block.transactions) {
    const fromHex = bytesToHex(tx.from);
    const toHex = bytesToHex(tx.to);
    if (fromHex !== myAddr && toHex !== myAddr) continue;
    const sent = fromHex === myAddr;
    rows.push({
      status: 'confirmed',
      dir: sent ? 'sent' : 'received',
      counterparty: short(sent ? toHex : fromHex),
      amount: sent ? -(tx.amount + tx.fee) : tx.amount,
      fee: sent ? tx.fee : 0n,
      when: blockTime(h.timestamp),
      sortKey: sortBase,
    });
  }

  return rows;
}

/**
 * Incrementally-maintained index of the wallet's confirmed + mined activity.
 *
 * The chain already visits every transaction of every block to rebuild tip
 * state — on IDB replay and on each new block. By riding along on the same
 * canonical-tip-move events, this index captures the wallet's full history for
 * free, so the UI never has to rescan the chain (and isn't capped to a recent
 * window). Pending (mempool) rows are NOT cached here — they're recomputed live
 * by `computeActivity`, since the mempool is small and their "when" is relative.
 *
 * Keyed by block hash so a reorg can drop the disconnected blocks' rows exactly.
 */
export class ActivityIndex {
  private address: string;
  private byBlock = new Map<string, ActivityRow[]>();

  constructor(address: string) {
    this.address = address;
  }

  /** Apply a canonical-tip move: drop disconnected blocks, add connected ones. */
  apply(delta: ReorgDelta): void {
    for (const cb of delta.disconnected) this.byBlock.delete(bytesToHex(cb.hash));
    for (const cb of delta.connected) {
      const key = bytesToHex(cb.hash);
      const rows = extractBlockRows(cb.block, this.address);
      if (rows.length) this.byBlock.set(key, rows);
      else this.byBlock.delete(key); // re-add of a block that no longer matches
    }
  }

  /** Point at a new address (wallet switch) and rebuild from the canonical chain. */
  rebuild(address: string, canonical: Iterable<ChainBlock>): void {
    this.address = address;
    this.byBlock.clear();
    for (const cb of canonical) {
      const rows = extractBlockRows(cb.block, address);
      if (rows.length) this.byBlock.set(bytesToHex(cb.hash), rows);
    }
  }

  /** Total rewards (subsidy + fees) of every canonical block this wallet mined. */
  minedTotal(): bigint {
    let total = 0n;
    for (const rows of this.byBlock.values()) {
      for (const r of rows) if (r.dir === 'mined') total += r.amount;
    }
    return total;
  }

  /**
   * All confirmed + mined rows, newest-first. The relative "when" is recomputed
   * on read (from the block timestamp in sortKey) so it stays fresh instead of
   * freezing at the value from when the block was indexed.
   */
  rows(): ActivityRow[] {
    const out: ActivityRow[] = [];
    for (const rows of this.byBlock.values()) {
      for (const r of rows) {
        out.push({ ...r, when: blockTime(Math.floor(r.sortKey / 1000)) });
      }
    }
    out.sort((a, b) => b.sortKey - a.sortKey);
    return out;
  }
}

export function short(hex: string): string {
  return hex.slice(0, 10) + '…' + hex.slice(-4);
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function blockTime(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}
