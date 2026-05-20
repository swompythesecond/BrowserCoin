import type { Node } from '../node.js';
import { formatAmount } from '../node.js';
import { bytesToHex } from '../util/binary.js';
import { blockReward } from '../chain/genesis.js';
import { TICKER } from '../brand.js';

export interface ActivityRow {
  status: 'pending' | 'confirmed' | 'mined';
  dir: 'sent' | 'received' | 'mined';
  counterparty: string; // short hex, or 'block #N' for mined rows
  amount: bigint;       // positive = inflow, negative = outflow (incl. fee)
  fee: bigint;
  when: string;
  sortKey: number;      // higher = newer
}

export type ActivityFilter = 'all' | 'sent' | 'received' | 'mined' | 'pending';

/**
 * Compute the user's activity (pending mempool + canonical chain history). Caps
 * canonical scan at `maxScan` blocks so the wallet page stays snappy on long
 * chains; for the home preview pass a small limit.
 */
export function computeActivity(node: Node, maxScan = 1000): ActivityRow[] {
  const myAddr = node.wallet.address;
  const rows: ActivityRow[] = [];

  for (const e of node.mempool.listEntries()) {
    const fromHex = bytesToHex(e.tx.from);
    const toHex = bytesToHex(e.tx.to);
    if (fromHex !== myAddr && toHex !== myAddr) continue;
    const sent = fromHex === myAddr;
    rows.push({
      status: 'pending',
      dir: sent ? 'sent' : 'received',
      counterparty: short(sent ? toHex : fromHex),
      amount: sent ? -(e.tx.amount + e.tx.fee) : e.tx.amount,
      fee: sent ? e.tx.fee : 0n,
      when: timeAgo(e.receivedAt),
      sortKey: e.receivedAt,
    });
  }

  let scanned = 0;
  for (const cb of node.chain.iterateCanonical()) {
    if (scanned++ > maxScan) break;
    const h = cb.block.header;
    if (h.height === 0) break;
    const minerHex = bytesToHex(h.miner);
    const sortBase = h.timestamp * 1000;

    if (minerHex === myAddr) {
      let totalFees = 0n;
      for (const tx of cb.block.transactions) totalFees += tx.fee;
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

    for (const tx of cb.block.transactions) {
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
        when: `block #${h.height}`,
        sortKey: sortBase,
      });
    }
  }

  rows.sort((a, b) => b.sortKey - a.sortKey);
  return rows;
}

export function filterActivity(rows: ActivityRow[], filter: ActivityFilter): ActivityRow[] {
  if (filter === 'all') return rows;
  if (filter === 'pending') return rows.filter((r) => r.status === 'pending');
  if (filter === 'mined') return rows.filter((r) => r.status === 'mined');
  return rows.filter((r) => r.dir === filter);
}

export function renderActivityRows(rows: ActivityRow[]): string {
  if (rows.length === 0) {
    return `<tr class="table-empty"><td colspan="5">No matching activity.</td></tr>`;
  }
  return rows
    .map((r) => {
      const sign = r.amount >= 0n ? '+' : '−';
      const cls = r.amount >= 0n ? 'green' : 'red';
      const arrow = r.dir === 'sent' ? '→' : r.dir === 'received' ? '←' : '⛏';
      const abs = r.amount < 0n ? -r.amount : r.amount;
      return `<tr>
        <td><span class="badge badge-${r.status}">${r.status}</span></td>
        <td class="mono col-hide-sm">${arrow} ${r.dir}</td>
        <td class="addr">${r.counterparty}</td>
        <td class="mono ${cls}">${sign}${formatAmount(abs)} ${TICKER}</td>
        <td class="muted col-hide-sm">${r.when}</td>
      </tr>`;
    })
    .join('');
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
