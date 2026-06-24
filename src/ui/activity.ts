import type { Node } from '../node.js';
import { formatAmount } from '../node.js';
import { bytesToHex } from '../util/binary.js';
import { TICKER } from '../brand.js';
import { short, timeAgo, type ActivityRow } from './activityIndex.js';

export { short, timeAgo, blockTime, type ActivityRow } from './activityIndex.js';

export type ActivityFilter = 'all' | 'sent' | 'received' | 'mined' | 'pending';

/**
 * Compute the user's activity: live pending (mempool) rows merged with the
 * confirmed + mined rows from `node.activityIndex`. The index is maintained
 * incrementally as the canonical tip moves, so this no longer rescans the chain
 * and is no longer capped to a recent window — it returns the full history.
 */
export function computeActivity(node: Node): ActivityRow[] {
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

  rows.push(...node.activityIndex.rows());

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
        <td class="muted col-hide-sm" title="${new Date(r.sortKey).toLocaleString()}">${r.when}</td>
      </tr>`;
    })
    .join('');
}
