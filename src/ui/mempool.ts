import type { Node } from '../node.js';
import { formatAmount } from '../node.js';
import { bytesToHex } from '../util/binary.js';
import { TICKER } from '../brand.js';
import { cardHeader } from './info.js';
import { renderPager } from './pager.js';

const PER_PAGE = 25;

/**
 * Mempool view: paginated list of unconfirmed transactions, with a "mine"
 * highlight on any tx involving the user's address.
 */
export function mountMempool(host: HTMLElement, node: Node): () => void {
  const view = document.createElement('div');
  view.className = 'view';
  view.innerHTML = `
    <div class="view-header">
      <h2 class="view-title">Mempool</h2>
      <span class="view-sub">Transactions waiting to be picked up by a miner.</span>
    </div>

    <section class="card" data-mount="mempool">
      <div data-slot="header"></div>
      <div class="row" style="justify-content:space-between; gap:8px;">
        <span class="muted text-sm" data-w="count">0 pending</span>
        <span class="muted text-sm" data-w="totals">—</span>
      </div>
      <div class="table-scroll mt-md">
        <table class="table">
          <thead><tr>
            <th>from</th><th class="col-hide-sm">to</th><th>amount</th><th class="col-hide-sm">fee</th><th class="col-hide-sm">nonce</th><th>received</th>
          </tr></thead>
          <tbody data-w="rows"></tbody>
        </table>
      </div>
      <div class="pager" data-w="pager"></div>
    </section>
  `;
  host.appendChild(view);

  view.querySelector<HTMLElement>('[data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Pending transactions',
    info: {
      title: 'How the mempool works',
      body: `When you send coins, the transaction lands here first. It's broadcast peer-to-peer so every miner sees it.\n\nMiners pick from the mempool when building the next block, prioritizing the highest fees. Once a miner includes your transaction in a mined block, it disappears from here and shows as "confirmed" in your wallet activity.`,
    },
  }));

  const countEl = view.querySelector<HTMLElement>('[data-w="count"]')!;
  const totalsEl = view.querySelector<HTMLElement>('[data-w="totals"]')!;
  const rowsEl = view.querySelector<HTMLTableSectionElement>('[data-w="rows"]')!;
  const pagerEl = view.querySelector<HTMLElement>('[data-w="pager"]')!;

  let page = 0;

  function paint(): void {
    const entries = node.mempool.listEntries().sort((a, b) => b.receivedAt - a.receivedAt);
    countEl.textContent = `${entries.length} pending`;

    let totalAmount = 0n;
    let totalFees = 0n;
    for (const e of entries) { totalAmount += e.tx.amount; totalFees += e.tx.fee; }
    totalsEl.textContent = entries.length === 0
      ? '—'
      : `${formatAmount(totalAmount)} ${TICKER} value · ${formatAmount(totalFees)} ${TICKER} fees`;

    const pages = Math.max(1, Math.ceil(entries.length / PER_PAGE));
    if (page >= pages) page = pages - 1;
    const slice = entries.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
    const myAddr = node.wallet.address;

    if (entries.length === 0) {
      rowsEl.innerHTML = `<tr class="table-empty"><td colspan="6">No pending transactions — every sent transaction has been mined.</td></tr>`;
      pagerEl.innerHTML = '';
      return;
    }

    rowsEl.innerHTML = slice.map((e) => {
      const fromHex = bytesToHex(e.tx.from);
      const toHex = bytesToHex(e.tx.to);
      const mine = fromHex === myAddr || toHex === myAddr;
      return `<tr class="${mine ? 'row-mine' : ''}">
        <td class="addr">${shortHex(fromHex)}${fromHex === myAddr ? ' <span class="badge badge-you">you</span>' : ''}</td>
        <td class="addr col-hide-sm">${shortHex(toHex)}${toHex === myAddr ? ' <span class="badge badge-you">you</span>' : ''}</td>
        <td class="mono">${formatAmount(e.tx.amount)} ${TICKER}</td>
        <td class="mono muted col-hide-sm">${formatAmount(e.tx.fee)} ${TICKER}</td>
        <td class="mono muted col-hide-sm">${e.tx.nonce}</td>
        <td class="muted">${timeAgo(e.receivedAt)}</td>
      </tr>`;
    }).join('');

    renderPager(pagerEl, page, pages, (p) => { page = p; paint(); });
  }

  paint();
  const unsubChain = node.onChain(paint);
  const ticker = setInterval(paint, 4000);
  return () => {
    unsubChain();
    clearInterval(ticker);
  };
}

function shortHex(hex: string): string {
  return hex.slice(0, 10) + '…' + hex.slice(-4);
}
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
