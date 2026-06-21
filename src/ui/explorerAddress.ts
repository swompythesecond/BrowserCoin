import { blockReward, COIN } from '../chain/genesis.js';
import { getAccount } from '../chain/state.js';
import { getBurnAddressInfo } from '../chain/burnAddresses.js';
import type { Transaction } from '../chain/transaction.js';
import { txHash } from '../chain/transaction.js';
import { bytesToHex } from '../util/binary.js';
import { formatAmount } from '../node.js';
import type { Node } from '../node.js';
import { TICKER } from '../brand.js';
import { blockTime, timeAgo } from './activityIndex.js';
import { renderPager } from './pager.js';
import type { ExplorerIndex, TxRef } from './explorerIndex.js';
import { addressLink, burnBadge, heightLink, txLink, type SubView } from './explorerShared.js';
import { downsample, sparklineSVG } from './sparkline.js';

const HISTORY_PER_PAGE = 25;

/** Resolved display row for one TxRef. */
interface HistoryRow {
  ref: TxRef;
  txHashHex: string | null; // null for coinbase rows
  counterparty: string;     // html
  delta: bigint;            // signed balance effect
  fee: bigint;
}

/**
 * Wallet lookup: balance + lifetime aggregates, balance-over-time chart,
 * pending mempool activity and the full confirmed history of any address.
 */
export function renderAddressView(container: HTMLElement, node: Node, index: ExplorerIndex, addrHex: string): SubView {
  if (!/^[0-9a-f]{64}$/.test(addrHex)) {
    container.innerHTML = `
      <section class="card">
        <h3 class="card-title">Invalid address</h3>
        <p class="muted text-sm mt-md">Addresses are 64 hex characters (a 32-byte public key).</p>
      </section>`;
    return { repaint: () => {} };
  }

  let page = 0;
  let sparkVersion = -1;
  let sparkSVG = '';

  /** Signed balance effect of one history entry, resolved from the chain. */
  function resolveRow(ref: TxRef): HistoryRow | null {
    const cb = node.chain.getBlock(ref.blockHash);
    if (!cb) return null;
    if (ref.txIndex === -1) {
      let fees = 0n;
      for (const tx of cb.block.transactions) fees += tx.fee;
      return {
        ref,
        txHashHex: null,
        counterparty: heightLink(ref.height),
        delta: blockReward(ref.height) + fees,
        fee: 0n,
      };
    }
    const tx = cb.block.transactions[ref.txIndex];
    if (!tx) return null;
    const hashHex = bytesToHex(txHash(tx));
    switch (ref.dir) {
      case 'in':
        return { ref, txHashHex: hashHex, counterparty: addressLink(bytesToHex(tx.from)), delta: tx.amount, fee: 0n };
      case 'out':
        return { ref, txHashHex: hashHex, counterparty: addressLink(bytesToHex(tx.to)), delta: -(tx.amount + tx.fee), fee: tx.fee };
      default: // 'self'
        return { ref, txHashHex: hashHex, counterparty: addressLink(addrHex), delta: -tx.fee, fee: tx.fee };
    }
  }

  function buildSparkline(refs: TxRef[]): string {
    if (index.version === sparkVersion) return sparkSVG;
    const points: number[] = [];
    let balance = 0n;
    for (const ref of refs) {
      const row = resolveRow(ref);
      if (!row) continue;
      balance += row.delta;
      // Float precision is fine for a chart; bigint math stays exact above.
      points.push(Number(balance) / Number(COIN));
    }
    sparkSVG = points.length >= 2 ? sparklineSVG(downsample(points, 120), { w: 640, h: 64, fill: true }) : '';
    sparkVersion = index.version;
    return sparkSVG;
  }

  function pendingRows(): Array<{ tx: Transaction; receivedAt: number; outgoing: boolean }> {
    const out: Array<{ tx: Transaction; receivedAt: number; outgoing: boolean }> = [];
    for (const e of node.mempool.listEntries()) {
      const fromHex = bytesToHex(e.tx.from);
      const toHex = bytesToHex(e.tx.to);
      if (fromHex !== addrHex && toHex !== addrHex) continue;
      out.push({ tx: e.tx, receivedAt: e.receivedAt, outgoing: fromHex === addrHex });
    }
    return out;
  }

  function dirBadge(dir: TxRef['dir']): string {
    switch (dir) {
      case 'in': return `<span class="badge badge-in">in</span>`;
      case 'out': return `<span class="badge badge-out">out</span>`;
      case 'mined': return `<span class="badge badge-mined">mined</span>`;
      default: return `<span class="badge">self</span>`;
    }
  }

  function paint(): void {
    const acct = getAccount(node.chain.tipState, addrHex);
    const stats = index.getAddress(addrHex);
    const refs = stats?.refs ?? [];
    const isYou = addrHex === node.wallet.address;
    const burn = getBurnAddressInfo(addrHex);
    const firstSeen = refs.length ? refs[0]!.ts : null;
    const lastSeen = refs.length ? refs[refs.length - 1]!.ts : null;
    const pending = pendingRows();
    const spark = buildSparkline(refs);

    const pages = Math.max(1, Math.ceil(refs.length / HISTORY_PER_PAGE));
    if (page >= pages) page = pages - 1;
    // Newest first: take a slice from the tail of the ascending refs array.
    const start = Math.max(0, refs.length - (page + 1) * HISTORY_PER_PAGE);
    const end = refs.length - page * HISTORY_PER_PAGE;
    const visible = refs.slice(start, end).reverse();

    container.innerHTML = `
      <section class="card">
        <div class="card-header">
          <h3 class="card-title">Address</h3>
          ${isYou ? '<span class="badge badge-you">you</span>' : ''}
          ${burn ? burnBadge() : ''}
          <span class="card-spacer"></span>
          <button type="button" class="ghost small" data-w="copy">Copy</button>
        </div>
        <div class="hash" style="word-break:break-all;">${addrHex}</div>
        ${refs.length === 0 ? `<p class="muted text-sm mt-md">This address has no on-chain history${acct.balance > 0n ? '' : ' and a zero balance'}.</p>` : ''}
      </section>

      ${burn ? `
      <section class="card mt-md" style="border-left:3px solid #b4231f;">
        <div class="card-header">
          <h3 class="card-title">${burn.label}</h3>
          <span class="card-spacer"></span>
          <span class="muted text-sm">${formatAmount(acct.balance)} ${TICKER} burned</span>
        </div>
        <p class="muted text-sm mt-md" style="margin-bottom:0;">${burn.description}</p>
      </section>` : ''}

      <div class="grid grid-3 mt-md explorer-tiles">
        <div class="stat-tile accent">
          <div class="stat-label">Balance</div>
          <div class="stat-value">${formatAmount(acct.balance)} <span class="muted">${TICKER}</span></div>
          <div class="stat-sub">nonce ${acct.nonce} · ${stats?.txCount ?? 0} tx${(stats?.txCount ?? 0) === 1 ? '' : 's'}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Received / sent</div>
          <div class="stat-value">${formatAmount(stats?.received ?? 0n)}</div>
          <div class="stat-sub">sent ${formatAmount(stats?.sent ?? 0n)} ${TICKER} · fees ${formatAmount(stats?.feesPaid ?? 0n)} ${TICKER}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Mined</div>
          <div class="stat-value">${stats?.blocksMined ?? 0} <span class="muted">blocks</span></div>
          <div class="stat-sub">${formatAmount(stats?.minedRewards ?? 0n)} ${TICKER} in rewards${firstSeen ? ` · first seen ${blockTime(firstSeen)}` : ''}${lastSeen ? ` · last active ${blockTime(lastSeen)}` : ''}</div>
        </div>
      </div>

      ${spark ? `
      <section class="card mt-md">
        <h3 class="card-title">Balance over time</h3>
        <div class="mt-md">${spark}</div>
      </section>` : ''}

      ${pending.length > 0 ? `
      <section class="card mt-md">
        <div class="card-header">
          <h3 class="card-title">Pending</h3>
          <span class="badge badge-pending">${pending.length}</span>
        </div>
        <div class="table-scroll">
          <table class="table">
            <thead><tr><th>dir</th><th>counterparty</th><th>amount</th><th class="col-hide-sm">fee</th><th>seen</th></tr></thead>
            <tbody>${pending.map((p) => `<tr>
              <td>${p.outgoing ? '<span class="badge badge-out">out</span>' : '<span class="badge badge-in">in</span>'}</td>
              <td>${addressLink(p.outgoing ? bytesToHex(p.tx.to) : bytesToHex(p.tx.from))}</td>
              <td class="mono ${p.outgoing ? 'red' : 'green'}">${p.outgoing ? '-' : '+'}${formatAmount(p.outgoing ? p.tx.amount + p.tx.fee : p.tx.amount)} ${TICKER}</td>
              <td class="mono muted col-hide-sm">${formatAmount(p.tx.fee)}</td>
              <td class="muted">${timeAgo(p.receivedAt)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </section>` : ''}

      <section class="card mt-md">
        <h3 class="card-title">History</h3>
        <div class="table-scroll mt-md">
          <table class="table">
            <thead><tr><th>dir</th><th>counterparty</th><th>amount</th><th class="col-hide-sm">fee</th><th>block</th><th class="col-hide-sm">tx</th><th>time</th></tr></thead>
            <tbody>${visible.length === 0
              ? `<tr class="table-empty"><td colspan="7">No confirmed activity yet.</td></tr>`
              : visible.map((ref) => {
                const row = resolveRow(ref);
                if (!row) return '';
                const positive = row.delta >= 0n;
                return `<tr>
                  <td>${dirBadge(ref.dir)}</td>
                  <td>${row.counterparty}</td>
                  <td class="mono ${positive ? 'green' : 'red'}">${positive ? '+' : '-'}${formatAmount(row.delta < 0n ? -row.delta : row.delta)} ${TICKER}</td>
                  <td class="mono muted col-hide-sm">${row.fee > 0n ? formatAmount(row.fee) : '—'}</td>
                  <td>${heightLink(ref.height)}</td>
                  <td class="col-hide-sm">${row.txHashHex ? txLink(row.txHashHex, row.txHashHex.slice(0, 10) + '…') : '<span class="muted">coinbase</span>'}</td>
                  <td class="muted">${blockTime(ref.ts)}</td>
                </tr>`;
              }).join('')}</tbody>
          </table>
        </div>
        <div class="pager" data-w="pager"></div>
      </section>
    `;

    container.querySelector<HTMLButtonElement>('[data-w="copy"]')!.addEventListener('click', (e) => {
      void navigator.clipboard.writeText(addrHex);
      const btn = e.currentTarget as HTMLButtonElement;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    });

    renderPager(container.querySelector<HTMLElement>('[data-w="pager"]')!, page, pages, (p) => { page = p; paint(); });
  }

  paint();
  return { repaint: paint };
}
