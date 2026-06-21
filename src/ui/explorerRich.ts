import { formatAmount } from '../node.js';
import type { Node } from '../node.js';
import { TICKER } from '../brand.js';
import { renderPager } from './pager.js';
import type { ExplorerIndex } from './explorerIndex.js';
import { addressLink, circulatingSupply, percentOf, type SubView } from './explorerShared.js';
import { isBurnAddress } from '../chain/burnAddresses.js';

const BURN_BADGE = ' <span class="badge" style="background:#b4231f;border-color:#b4231f;color:#fff;">burn</span>';

const ROWS_PER_PAGE = 25;

/** Top holders: every holder ranked by balance, plus a top-miners leaderboard. */
export function renderRichView(container: HTMLElement, node: Node, index: ExplorerIndex): SubView {
  let page = 0;

  function paint(): void {
    const rows = index.richList(node.chain.tipState);
    const supply = circulatingSupply(node.chain.height);
    const you = node.wallet.address;
    const miners = index.topMiners(10);

    const pages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
    if (page >= pages) page = pages - 1;
    const slice = rows.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE);

    container.innerHTML = `
      <section class="card">
        <div class="card-header">
          <h3 class="card-title">Top holders</h3>
          <span class="card-spacer"></span>
          <span class="muted text-sm">${rows.length} holder${rows.length === 1 ? '' : 's'} · ${formatAmount(supply)} ${TICKER} in circulation</span>
        </div>
        <div class="table-scroll">
          <table class="table">
            <thead><tr><th class="rank">#</th><th>address</th><th>balance</th><th class="col-hide-sm">% of supply</th><th class="col-hide-sm">txs sent</th></tr></thead>
            <tbody>${slice.length === 0
              ? `<tr class="table-empty"><td colspan="5">No balances yet — mine the first block!</td></tr>`
              : slice.map((r, i) => `<tr${r.address === you ? ' class="row-mine"' : ''}>
                <td class="mono muted rank">${page * ROWS_PER_PAGE + i + 1}</td>
                <td>${addressLink(r.address)}${r.address === you ? ' <span class="badge badge-you">you</span>' : ''}${isBurnAddress(r.address) ? BURN_BADGE : ''}</td>
                <td class="mono">${formatAmount(r.balance)} ${TICKER}</td>
                <td class="mono muted col-hide-sm">${percentOf(r.balance, supply)}%</td>
                <td class="mono muted col-hide-sm">${r.nonce}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="pager" data-w="pager"></div>
      </section>

      <section class="card mt-md">
        <h3 class="card-title">Top miners</h3>
        <div class="table-scroll mt-md">
          <table class="table">
            <thead><tr><th class="rank">#</th><th>address</th><th>blocks mined</th><th class="col-hide-sm">rewards earned</th></tr></thead>
            <tbody>${miners.length === 0
              ? `<tr class="table-empty"><td colspan="4">No blocks mined yet.</td></tr>`
              : miners.map((m, i) => `<tr${m.address === you ? ' class="row-mine"' : ''}>
                <td class="mono muted rank">${i + 1}</td>
                <td>${addressLink(m.address)}${m.address === you ? ' <span class="badge badge-you">you</span>' : ''}</td>
                <td class="mono">${m.blocksMined}</td>
                <td class="mono muted col-hide-sm">${formatAmount(m.minedRewards)} ${TICKER}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </section>
    `;

    renderPager(container.querySelector<HTMLElement>('[data-w="pager"]')!, page, pages, (p) => { page = p; paint(); });
  }

  paint();
  return { repaint: paint };
}
