import { hashHeader } from '../chain/block.js';
import { bytesToHex, compactToTarget } from '../util/binary.js';
import { formatAmount } from '../node.js';
import type { Node } from '../node.js';
import { TICKER } from '../brand.js';
import { cardHeader } from './info.js';
import { renderPager } from './pager.js';

const BLOCKS_PER_PAGE = 20;

interface BlockRow {
  height: number;
  hash: string;
  txCount: number;
  miner: string;
  ts: number;
  totalFees: bigint;
  difficulty: number;
  txs: Array<{ from: string; to: string; amount: bigint; fee: bigint; nonce: number }>;
}

function difficultyBits(compact: number): number {
  const target = compactToTarget(compact);
  return target <= 0n ? 256 : 256 - target.toString(2).length;
}

/**
 * Explorer: paginated chain history (newest first) with click-to-expand rows
 * that reveal every transaction inside the block. Pending transactions live
 * on the dedicated /mempool tab.
 */
export function mountExplorer(host: HTMLElement, node: Node): () => void {
  const view = document.createElement('div');
  view.className = 'view';
  view.innerHTML = `
    <div class="view-header">
      <h2 class="view-title">Explorer</h2>
      <span class="view-sub">Every block ever mined. Click a row to inspect its transactions.</span>
    </div>

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
  host.appendChild(view);

  view.querySelector<HTMLElement>('[data-mount="blocks"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Blocks',
    info: {
      title: 'The chain',
      body: `Each block bundles a batch of transactions and links to the previous block — that chain of hashes is what makes the history tamper-resistant.\n\nClick a row to expand the block and see every transaction inside.`,
    },
  }));

  const tipEl = view.querySelector<HTMLElement>('[data-w="tip"]')!;
  const blockRowsEl = view.querySelector<HTMLTableSectionElement>('[data-w="blockRows"]')!;
  const blockPagerEl = view.querySelector<HTMLElement>('[data-w="blockPager"]')!;
  const blockCountEl = view.querySelector<HTMLElement>('[data-w="blockCount"]')!;

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
        hash: bytesToHex(hashHeader(h)).slice(0, 12) + '…',
        txCount: cb.block.transactions.length,
        miner: bytesToHex(h.miner).slice(0, 12) + '…',
        ts: h.timestamp,
        totalFees: fees,
        difficulty: h.difficulty,
        txs: cb.block.transactions.map((tx) => ({
          from: bytesToHex(tx.from).slice(0, 12) + '…',
          to: bytesToHex(tx.to).slice(0, 12) + '…',
          amount: tx.amount,
          fee: tx.fee,
          nonce: tx.nonce,
        })),
      });
    }
    return out;
  }

  function renderRows(rows: BlockRow[]): string {
    if (rows.length === 0) return `<tr class="table-empty"><td colspan="7">No blocks yet.</td></tr>`;
    return rows.map((b) => {
      const detail = expanded.has(b.height)
        ? `<tr><td colspan="7" style="background: var(--surface); padding: 0;">
            <div style="padding: 12px 16px;">
              <div class="label-caps" style="margin-bottom:8px;">${b.txs.length} transaction${b.txs.length === 1 ? '' : 's'}</div>
              ${b.txs.length === 0
                ? `<div class="muted text-sm" style="font-style:italic;">Coinbase only (block reward).</div>`
                : `<div class="table-scroll"><table class="table">
                    <thead><tr><th>from</th><th class="col-hide-sm">to</th><th>amount</th><th class="col-hide-sm">fee</th><th class="col-hide-sm">nonce</th></tr></thead>
                    <tbody>${b.txs.map((tx) => `<tr>
                      <td class="addr">${tx.from}</td>
                      <td class="addr col-hide-sm">${tx.to}</td>
                      <td class="mono">${formatAmount(tx.amount)} ${TICKER}</td>
                      <td class="mono muted col-hide-sm">${formatAmount(tx.fee)} ${TICKER}</td>
                      <td class="mono muted col-hide-sm">${tx.nonce}</td>
                    </tr>`).join('')}</tbody>
                   </table></div>`}
            </div>
          </td></tr>`
        : '';
      return `<tr data-block="${b.height}" style="cursor:pointer;">
        <td class="mono">${b.height}</td>
        <td class="hash">${b.hash}</td>
        <td class="mono">${b.txCount}</td>
        <td class="addr col-hide-sm">${b.miner}</td>
        <td class="mono muted col-hide-sm">${formatAmount(b.totalFees)}</td>
        <td class="mono muted col-hide-sm" title="0x${b.difficulty.toString(16).padStart(8, '0')}">${difficultyBits(b.difficulty)} bits</td>
        <td class="muted">${new Date(b.ts * 1000).toLocaleTimeString()}</td>
      </tr>${detail}`;
    }).join('');
  }

  function paint(): void {
    tipEl.textContent = node.chain.tip ? bytesToHex(hashHeader(node.chain.tip.block.header)).slice(0, 16) + '…' : '—';

    const blocks = collectBlocks();
    blockCountEl.textContent = `${blocks.length} block${blocks.length === 1 ? '' : 's'}`;
    const pages = Math.max(1, Math.ceil(blocks.length / BLOCKS_PER_PAGE));
    if (blockPage >= pages) blockPage = pages - 1;
    const slice = blocks.slice(blockPage * BLOCKS_PER_PAGE, (blockPage + 1) * BLOCKS_PER_PAGE);
    blockRowsEl.innerHTML = renderRows(slice);

    blockRowsEl.querySelectorAll<HTMLElement>('tr[data-block]').forEach((row) => {
      row.addEventListener('click', () => {
        const h = Number(row.dataset['block']);
        if (expanded.has(h)) expanded.delete(h); else expanded.add(h);
        paint();
      });
    });

    renderPager(blockPagerEl, blockPage, pages, (p) => { blockPage = p; paint(); });
  }

  paint();
  const unsubChain = node.onChain(paint);
  const ticker = setInterval(paint, 5000);
  return () => {
    unsubChain();
    clearInterval(ticker);
  };
}
