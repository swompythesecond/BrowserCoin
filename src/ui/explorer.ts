import { hashHeader } from '../chain/block.js';
import type { Transaction } from '../chain/transaction.js';
import { txHash } from '../chain/transaction.js';
import { bytesToHex } from '../util/binary.js';
import { formatAmount } from '../node.js';
import type { Node } from '../node.js';
import { TICKER } from '../brand.js';
import { cardHeader } from './info.js';
import { renderPager } from './pager.js';
import type { Router } from './router.js';
import { getExplorerIndex, type ExplorerIndex } from './explorerIndex.js';
import { addressLink, blockLink, difficultyBits, heightLink, txLink, type SubView } from './explorerShared.js';
import { renderAddressView } from './explorerAddress.js';
import { renderBlockView, renderTxView } from './explorerBlock.js';
import { renderRichView } from './explorerRich.js';
import { renderStatsView } from './explorerStats.js';

const BLOCKS_PER_PAGE = 20;

/**
 * Explorer shell: a search box that understands addresses, heights, block
 * hashes and tx hashes, plus tabbed sub-views (blocks / top holders / stats) and
 * drill-in detail pages — all routed through `/explorer?…` query params so
 * plain anchors deep-link and the back button works.
 */
export function mountExplorer(host: HTMLElement, node: Node, params: URLSearchParams, router: Router): () => void {
  const index = getExplorerIndex(node.chain);
  index.ensureFresh();

  const address = params.get('address')?.trim().toLowerCase() ?? null;
  const tx = params.get('tx')?.trim().toLowerCase() ?? null;
  const block = params.get('block')?.trim().toLowerCase() ?? null;
  const tab = params.get('tab');
  const isDetail = !!(address || tx || block);

  const view = document.createElement('div');
  view.className = 'view';
  view.innerHTML = `
    <div class="view-header">
      <h2 class="view-title">Explorer</h2>
      <span class="view-sub">Search any wallet, block or transaction — everything verified locally by your own node.</span>
    </div>

    <form class="explorer-search" data-w="searchForm">
      <input type="text" placeholder="Address / block height / block hash / tx hash" data-w="searchInput" spellcheck="false" autocomplete="off" />
      <button type="submit">Search</button>
    </form>
    <div class="muted text-sm explorer-search-msg" data-w="searchMsg" hidden></div>

    <div class="row explorer-tabs">
      <div class="chips" data-w="tabs">
        <button type="button" class="chip${!isDetail && !tab ? ' active' : ''}" data-tab="">Blocks</button>
        <button type="button" class="chip${tab === 'holders' ? ' active' : ''}" data-tab="holders">Top holders</button>
        <button type="button" class="chip${tab === 'stats' ? ' active' : ''}" data-tab="stats">Stats</button>
      </div>
    </div>

    <div data-w="subview"></div>
  `;
  host.appendChild(view);

  const searchForm = view.querySelector<HTMLFormElement>('[data-w="searchForm"]')!;
  const searchInput = view.querySelector<HTMLInputElement>('[data-w="searchInput"]')!;
  const searchMsg = view.querySelector<HTMLElement>('[data-w="searchMsg"]')!;
  const subRoot = view.querySelector<HTMLElement>('[data-w="subview"]')!;

  view.querySelectorAll<HTMLButtonElement>('[data-w="tabs"] .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const t = chip.dataset['tab'];
      router.navigate(t ? `/explorer?tab=${t}` : '/explorer');
    });
  });

  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const error = runSearch(searchInput.value, node, index, router);
    searchMsg.hidden = !error;
    searchMsg.textContent = error ?? '';
  });

  let sub: SubView;
  if (address) sub = renderAddressView(subRoot, node, index, address);
  else if (tx) sub = renderTxView(subRoot, node, index, tx);
  else if (block) sub = renderBlockView(subRoot, node, index, block);
  else if (tab === 'holders') sub = renderRichView(subRoot, node, index);
  else if (tab === 'stats') sub = renderStatsView(subRoot, node, index);
  else sub = renderBlocksView(subRoot, node);

  function tick(): void {
    index.ensureFresh();
    sub.repaint();
  }
  const unsubChain = node.onChain(tick);
  const ticker = setInterval(tick, 5000);
  return () => {
    unsubChain();
    clearInterval(ticker);
  };
}

/**
 * Figure out what the user is looking for and navigate there. Returns an
 * error/hint message instead when the query doesn't resolve.
 */
function runSearch(raw: string, node: Node, index: ExplorerIndex, router: Router): string | null {
  let q = raw.trim().toLowerCase();
  if (q.startsWith('0x')) q = q.slice(2);
  if (!q) return null;

  if (/^\d{1,10}$/.test(q)) {
    const height = Number(q);
    if (height > node.chain.height) return `Block #${height} doesn't exist yet — the chain is at #${node.chain.height}.`;
    router.navigate(`/explorer?block=${height}`);
    return null;
  }

  if (/^[0-9a-f]{64}$/.test(q)) {
    // A 64-hex string is a block hash, a tx hash, or an address. Check the
    // hash spaces first — any 32-byte value is at least a *possible* address,
    // so that's the fallback.
    if (node.chain.getBlock(q)) router.navigate(`/explorer?block=${q}`);
    else if (index.findTx(q)) router.navigate(`/explorer?tx=${q}`);
    else router.navigate(`/explorer?address=${q}`);
    return null;
  }

  if (/^[0-9a-f]{8,63}$/.test(q)) {
    const matches = index.knownAddressesWithPrefix(q, 2);
    if (matches.length === 1) {
      router.navigate(`/explorer?address=${matches[0]}`);
      return null;
    }
    return matches.length === 0
      ? 'No known address starts with that prefix. Paste the full 64-character address.'
      : 'Several addresses start with that prefix — add a few more characters.';
  }

  return 'Enter an address, block height, block hash or transaction hash.';
}

// ---------- Default tab: the block list ----------

interface BlockRow {
  height: number;
  hashHex: string;
  minerHex: string;
  ts: number;
  totalFees: bigint;
  difficulty: number;
  txs: Transaction[];
}

function renderBlocksView(container: HTMLElement, node: Node): SubView {
  container.innerHTML = `
    <section class="card" data-mount="blocks">
      <div data-slot="header"></div>
      <div class="row" style="justify-content:space-between;">
        <span class="muted text-sm">Tip: <span class="hash" data-w="tip">—</span></span>
        <span class="muted text-sm" data-w="blockCount">—</span>
      </div>
      <div class="table-scroll mt-md">
        <table class="table">
          <thead><tr>
            <th>height</th><th>hash</th><th>txs</th><th class="col-hide-sm">miner</th><th class="col-hide-sm">fees</th><th class="col-hide-sm">diff</th><th>time</th>
          </tr></thead>
          <tbody data-w="blockRows"></tbody>
        </table>
      </div>
      <div class="pager" data-w="blockPager"></div>
    </section>
  `;

  container.querySelector<HTMLElement>('[data-mount="blocks"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Blocks',
    info: {
      title: 'The chain',
      body: `Each block bundles a batch of transactions and links to the previous block — that chain of hashes is what makes the history tamper-resistant.\n\nClick a row to expand the block and see every transaction inside.`,
    },
  }));

  const tipEl = container.querySelector<HTMLElement>('[data-w="tip"]')!;
  const blockRowsEl = container.querySelector<HTMLTableSectionElement>('[data-w="blockRows"]')!;
  const blockPagerEl = container.querySelector<HTMLElement>('[data-w="blockPager"]')!;
  const blockCountEl = container.querySelector<HTMLElement>('[data-w="blockCount"]')!;

  let blockPage = 0;
  const expanded = new Set<number>();

  function collectBlocks(): BlockRow[] {
    const out: BlockRow[] = [];
    for (const cb of node.chain.iterateCanonical()) {
      const h = cb.block.header;
      let fees = 0n;
      for (const tx of cb.block.transactions) fees += tx.fee;
      out.push({
        height: h.height,
        hashHex: bytesToHex(cb.hash),
        minerHex: bytesToHex(h.miner),
        ts: h.timestamp,
        totalFees: fees,
        difficulty: h.difficulty,
        txs: cb.block.transactions,
      });
    }
    return out;
  }

  function renderTxDetail(b: BlockRow): string {
    if (b.txs.length === 0) {
      return `<div class="muted text-sm" style="font-style:italic;">Coinbase only (block reward).</div>`;
    }
    return `<div class="table-scroll"><table class="table">
      <thead><tr><th>tx</th><th>from</th><th class="col-hide-sm">to</th><th>amount</th><th class="col-hide-sm">fee</th><th class="col-hide-sm">nonce</th></tr></thead>
      <tbody>${b.txs.map((tx) => `<tr>
        <td>${txLink(bytesToHex(txHash(tx)), bytesToHex(txHash(tx)).slice(0, 10) + '…')}</td>
        <td>${addressLink(bytesToHex(tx.from))}</td>
        <td class="col-hide-sm">${addressLink(bytesToHex(tx.to))}</td>
        <td class="mono">${formatAmount(tx.amount)} ${TICKER}</td>
        <td class="mono muted col-hide-sm">${formatAmount(tx.fee)} ${TICKER}</td>
        <td class="mono muted col-hide-sm">${tx.nonce}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  function paint(): void {
    tipEl.textContent = node.chain.tip ? bytesToHex(hashHeader(node.chain.tip.block.header)).slice(0, 16) + '…' : '—';

    const blocks = collectBlocks();
    blockCountEl.textContent = `${blocks.length} block${blocks.length === 1 ? '' : 's'}`;
    const pages = Math.max(1, Math.ceil(blocks.length / BLOCKS_PER_PAGE));
    if (blockPage >= pages) blockPage = pages - 1;
    const slice = blocks.slice(blockPage * BLOCKS_PER_PAGE, (blockPage + 1) * BLOCKS_PER_PAGE);

    blockRowsEl.innerHTML = slice.length === 0
      ? `<tr class="table-empty"><td colspan="7">No blocks yet.</td></tr>`
      : slice.map((b) => {
        const detail = expanded.has(b.height)
          ? `<tr><td colspan="7" style="background: var(--surface); padding: 0;">
              <div style="padding: 12px 16px;">
                <div class="label-caps" style="margin-bottom:8px;">${b.txs.length} transaction${b.txs.length === 1 ? '' : 's'}</div>
                ${renderTxDetail(b)}
              </div>
            </td></tr>`
          : '';
        return `<tr data-block="${b.height}" style="cursor:pointer;">
          <td class="mono">${heightLink(b.height)}</td>
          <td>${blockLink(b.hashHex)}</td>
          <td class="mono">${b.txs.length}</td>
          <td class="col-hide-sm">${addressLink(b.minerHex)}</td>
          <td class="mono muted col-hide-sm">${formatAmount(b.totalFees)}</td>
          <td class="mono muted col-hide-sm" title="0x${b.difficulty.toString(16).padStart(8, '0')}">${difficultyBits(b.difficulty)} bits</td>
          <td class="muted">${new Date(b.ts * 1000).toLocaleTimeString()}</td>
        </tr>${detail}`;
      }).join('');

    blockRowsEl.querySelectorAll<HTMLElement>('tr[data-block]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if ((e.target as Element | null)?.closest('a')) return; // let links navigate
        const h = Number(row.dataset['block']);
        if (expanded.has(h)) expanded.delete(h); else expanded.add(h);
        paint();
      });
    });

    renderPager(blockPagerEl, blockPage, pages, (p) => { blockPage = p; paint(); });
  }

  paint();
  return { repaint: paint };
}
