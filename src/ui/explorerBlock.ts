import { GENESIS, blockReward } from '../chain/genesis.js';
import { hashHeader } from '../chain/block.js';
import type { ChainBlock } from '../chain/blockchain.js';
import { txHash } from '../chain/transaction.js';
import { bytesToHex } from '../util/binary.js';
import { formatAmount } from '../node.js';
import type { Node } from '../node.js';
import { TICKER } from '../brand.js';
import { blockTime, timeAgo } from './activityIndex.js';
import type { ExplorerIndex } from './explorerIndex.js';
import { addressLink, blockLink, difficultyBits, heightLink, txLink, type SubView } from './explorerShared.js';
import { kindBadge, flowCells, scriptTxDetail } from './explorerScript.js';

/** Block detail: `?block=` accepts a height or a 64-hex header hash. */
export function renderBlockView(container: HTMLElement, node: Node, index: ExplorerIndex, query: string): SubView {
  function resolve(): ChainBlock | undefined {
    if (/^\d{1,10}$/.test(query)) {
      const height = Number(query);
      if (height === 0) return node.chain.getBlock(bytesToHex(hashHeader(GENESIS.header)));
      const hash = index.hashAtHeight(height);
      return hash ? node.chain.getBlock(hash) : undefined;
    }
    if (/^[0-9a-f]{64}$/.test(query)) return node.chain.getBlock(query);
    return undefined;
  }

  function paint(): void {
    const cb = resolve();
    if (!cb) {
      container.innerHTML = `
        <section class="card">
          <h3 class="card-title">Block not found</h3>
          <p class="muted text-sm mt-md">No block matches <span class="mono">${escapeForDisplay(query)}</span>. It may not have reached your node yet.</p>
        </section>`;
      return;
    }

    const h = cb.block.header;
    const hashHex = bytesToHex(cb.hash);
    const canonical = h.height === 0 || index.hashAtHeight(h.height) === hashHex;
    let fees = 0n;
    if (cb.hasBody) for (const tx of cb.block.transactions) fees += tx.fee;
    const reward = h.height === 0 ? 0n : blockReward(h.height);
    const prevHex = bytesToHex(h.prevHash);
    const nextHash = index.hashAtHeight(h.height + 1);

    container.innerHTML = `
      <section class="card">
        <div class="card-header">
          <h3 class="card-title">Block #${h.height}</h3>
          ${canonical ? '' : `<span class="badge badge-pending" title="A heavier branch won — this block is not part of the active chain.">off-chain fork</span>`}
          <span class="card-spacer"></span>
          <span class="muted text-sm">
            ${h.height > 0 ? `<a class="hash" href="/explorer?block=${h.height - 1}">← #${h.height - 1}</a>` : ''}
            ${nextHash && canonical ? ` &nbsp; <a class="hash" href="/explorer?block=${h.height + 1}">#${h.height + 1} →</a>` : ''}
          </span>
        </div>
        <dl class="kv">
          <dt>hash</dt><dd class="hash">${hashHex}</dd>
          <dt>previous</dt><dd>${h.height === 0 ? '<span class="muted">—</span>' : blockLink(prevHex, prevHex)}</dd>
          <dt>time</dt><dd>${new Date(h.timestamp * 1000).toLocaleString()} <span class="muted">(${blockTime(h.timestamp)})</span></dd>
          <dt>miner</dt><dd>${h.height === 0 ? '<span class="muted">— (genesis)</span>' : addressLink(bytesToHex(h.miner), bytesToHex(h.miner))}</dd>
          <dt>reward</dt><dd>${formatAmount(reward)} ${TICKER} <span class="muted">${cb.hasBody ? `+ ${formatAmount(fees)} ${TICKER} fees` : '+ fees (pending download)'}</span></dd>
          <dt>difficulty</dt><dd>${difficultyBits(h.difficulty)} bits <span class="muted">(compact 0x${h.difficulty.toString(16).padStart(8, '0')})</span></dd>
          <dt>nonce</dt><dd>${h.nonce}</dd>
          <dt>tx root</dt><dd class="muted">${bytesToHex(h.txRoot)}</dd>
          <dt>state root</dt><dd class="muted">${bytesToHex(h.stateRoot)}</dd>
        </dl>
      </section>

      <section class="card mt-md">
        <h3 class="card-title">${cb.hasBody ? `${cb.block.transactions.length} transaction${cb.block.transactions.length === 1 ? '' : 's'}` : 'Transactions'}</h3>
        ${!cb.hasBody
          ? `<p class="muted text-sm mt-md" style="font-style:italic;">Not downloaded yet — history is still syncing in the background.</p>`
          : cb.block.transactions.length === 0
          ? `<p class="muted text-sm mt-md" style="font-style:italic;">Coinbase only (block reward).</p>`
          : `<div class="table-scroll mt-md"><table class="table">
              <thead><tr><th>tx</th><th>type</th><th>from</th><th class="col-hide-sm">to</th><th>amount</th><th class="col-hide-sm">fee</th></tr></thead>
              <tbody>${cb.block.transactions.map((tx) => { const f = flowCells(tx); return `<tr>
                <td>${txLink(bytesToHex(txHash(tx)))}</td>
                <td>${kindBadge(tx) || '<span class="muted text-sm">transfer</span>'}</td>
                <td>${f.from}</td>
                <td class="col-hide-sm">${f.to}</td>
                <td class="mono">${formatAmount(tx.amount)} ${TICKER}</td>
                <td class="mono muted col-hide-sm">${formatAmount(tx.fee)} ${TICKER}</td>
              </tr>`; }).join('')}</tbody>
            </table></div>`}
      </section>
    `;
  }

  paint();
  return { repaint: paint };
}

/** Tx detail: confirmed (resolved via the index) or still pending in the mempool. */
export function renderTxView(container: HTMLElement, node: Node, index: ExplorerIndex, hashHex: string): SubView {
  function paint(): void {
    const loc = index.findTx(hashHex);
    if (loc) {
      const cb = node.chain.getBlock(loc.blockHash);
      const tx = cb?.block.transactions[loc.txIndex];
      if (cb && tx) {
        const confirmations = node.chain.height - loc.height + 1;
        const scriptBody = scriptTxDetail(tx);
        container.innerHTML = `
          <section class="card">
            <div class="card-header">
              <h3 class="card-title">Transaction</h3>
              ${kindBadge(tx)}
              <span class="badge badge-confirmed">confirmed</span>
            </div>
            <dl class="kv"><dt>hash</dt><dd class="hash">${hashHex}</dd></dl>
            ${scriptBody ?? `<dl class="kv">
              <dt>from</dt><dd>${addressLink(bytesToHex(tx.from), bytesToHex(tx.from))}</dd>
              <dt>to</dt><dd>${addressLink(bytesToHex(tx.to), bytesToHex(tx.to))}</dd>
              <dt>amount</dt><dd>${formatAmount(tx.amount)} ${TICKER}</dd>
              <dt>fee</dt><dd>${formatAmount(tx.fee)} ${TICKER}</dd>
              <dt>nonce</dt><dd>${tx.nonce}</dd>
            </dl>`}
            <dl class="kv">
              <dt>block</dt><dd>${heightLink(loc.height)} <span class="muted">(${blockLink(loc.blockHash)})</span></dd>
              <dt>confirmations</dt><dd>${confirmations}</dd>
              <dt>time</dt><dd>${new Date(cb.block.header.timestamp * 1000).toLocaleString()} <span class="muted">(${blockTime(cb.block.header.timestamp)})</span></dd>
            </dl>
          </section>
        `;
        return;
      }
    }

    const pendingEntry = node.mempool.listEntries().find((e) => bytesToHex(txHash(e.tx)) === hashHex);
    if (pendingEntry) {
      const tx = pendingEntry.tx;
      const scriptBody = scriptTxDetail(tx);
      container.innerHTML = `
        <section class="card">
          <div class="card-header">
            <h3 class="card-title">Transaction</h3>
            ${kindBadge(tx)}
            <span class="badge badge-pending">pending</span>
          </div>
          <dl class="kv"><dt>hash</dt><dd class="hash">${hashHex}</dd></dl>
          ${scriptBody ?? `<dl class="kv">
            <dt>from</dt><dd>${addressLink(bytesToHex(tx.from), bytesToHex(tx.from))}</dd>
            <dt>to</dt><dd>${addressLink(bytesToHex(tx.to), bytesToHex(tx.to))}</dd>
            <dt>amount</dt><dd>${formatAmount(tx.amount)} ${TICKER}</dd>
            <dt>fee</dt><dd>${formatAmount(tx.fee)} ${TICKER}</dd>
            <dt>nonce</dt><dd>${tx.nonce}</dd>
          </dl>`}
          <dl class="kv"><dt>seen</dt><dd>${timeAgo(pendingEntry.receivedAt)}</dd></dl>
          <p class="muted text-sm mt-md">Waiting in the mempool to be mined into a block.</p>
        </section>
      `;
      return;
    }

    container.innerHTML = `
      <section class="card">
        <h3 class="card-title">Transaction not found</h3>
        <p class="muted text-sm mt-md">No transaction matches <span class="mono">${escapeForDisplay(hashHex)}</span> — it isn't on your copy of the chain or in the mempool.</p>
      </section>`;
  }

  paint();
  return { repaint: paint };
}

/** Queries come from the URL — strip anything that isn't ours before echoing. */
function escapeForDisplay(s: string): string {
  return s.replace(/[^0-9a-zA-Z]/g, '').slice(0, 80);
}
