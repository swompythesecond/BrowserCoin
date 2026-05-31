import type { Node } from '../node.js';
import { formatAmount } from '../node.js';
import { hexToBytes } from '../util/binary.js';
import { TICKER, UNIT_LONG } from '../brand.js';
import { computeActivity, filterActivity, renderActivityRows, type ActivityFilter } from './activity.js';
import { cardHeader } from './info.js';
import { renderPager } from './pager.js';
import { renderAddressQr } from './qr.js';

const PAGE_SIZE = 25;

const FILTERS: Array<{ key: ActivityFilter; label: string }> = [
  { key: 'all',       label: 'All' },
  { key: 'received',  label: 'Received' },
  { key: 'sent',      label: 'Sent' },
  { key: 'mined',     label: 'Mined' },
  { key: 'pending',   label: 'Pending' },
];

/**
 * Full-page wallet: hero balance, send form, paginated activity with filter
 * chips.
 */
export function mountWallet(host: HTMLElement, node: Node, params?: URLSearchParams): () => void {
  const view = document.createElement('div');
  view.className = 'view';
  view.innerHTML = `
    <div class="view-header">
      <h2 class="view-title">Wallet</h2>
      <span class="view-sub">Manage your coins and send to anyone with an address.</span>
    </div>

    <div class="grid grid-12">
      <section class="card hero col-7" data-mount="balance">
        <div data-slot="header"></div>
        <div class="balance" data-w="balance">0 <span class="unit">${UNIT_LONG}</span></div>
        <label>Your address (share this to receive coins)</label>
        <div class="row">
          <input data-w="address" readonly />
          <button class="ghost" data-w="copy">Copy</button>
        </div>
        <div class="qr-wrap mt-md">
          <div class="qr-box" data-w="qr"></div>
          <div class="qr-caption">Scan to send coins to this wallet.</div>
        </div>
        <div class="mt-md text-sm muted" data-w="nonce">nonce —</div>
      </section>

      <section class="card col-5" data-mount="send">
        <div data-slot="header"></div>
        <label>Recipient address (64 hex chars)</label>
        <input data-w="to" placeholder="paste address here" />
        <div class="row mt-sm" style="align-items:flex-end;">
          <div style="flex:1; min-width:0;">
            <label>Amount (${TICKER})</label>
            <input data-w="amount" placeholder="1.0" />
          </div>
          <div style="flex:1; min-width:0;">
            <label>Fee (${TICKER})</label>
            <input data-w="fee" value="0.00001" />
          </div>
        </div>
        <div class="row mt-md">
          <button data-w="send">Send</button>
          <span data-w="msg" class="text-sm muted"></span>
        </div>
      </section>

      <section class="card col-12" data-mount="activity">
        <div data-slot="header"></div>
        <div class="row" style="justify-content:space-between; align-items:center;">
          <div class="chips" data-w="chips"></div>
          <span class="muted text-sm" data-w="count">—</span>
        </div>
        <div class="table-scroll mt-md">
          <table class="table">
            <thead><tr>
              <th>status</th><th class="col-hide-sm">dir</th><th>counterparty</th><th>amount</th><th class="col-hide-sm">when</th>
            </tr></thead>
            <tbody data-w="rows"></tbody>
          </table>
        </div>
        <div class="pager" data-w="pager"></div>
      </section>
    </div>
  `;
  host.appendChild(view);

  const slot = (key: string, header: HTMLElement): void => {
    view.querySelector<HTMLElement>(`[data-mount="${key}"] [data-slot="header"]`)!.replaceWith(header);
  };
  slot('balance', cardHeader({
    title: 'Balance',
    info: {
      title: 'Your balance',
      body: `This is how much ${TICKER} your wallet owns. It updates automatically when new blocks arrive.\n\nPending transactions don't count yet — they only affect your balance after they confirm inside a block.`,
    },
  }));
  slot('send', cardHeader({
    title: 'Send',
    info: {
      title: 'Sending coins',
      body: `Paste any BrowserCoin address to send to it. The fee is a tip that helps miners include your transaction faster.\n\nOnce sent, the transaction is broadcast to the network and waits in the mempool until a miner picks it up.`,
    },
  }));
  slot('activity', cardHeader({
    title: 'Activity',
    info: {
      title: 'Your activity',
      body: `Every coin you send, receive, or mine appears here. Use the filters to narrow the list. "Pending" means it's not yet in a block — wait one block to confirm.`,
    },
  }));

  const balanceEl = view.querySelector<HTMLElement>('[data-w="balance"]')!;
  const addressEl = view.querySelector<HTMLInputElement>('[data-w="address"]')!;
  const copyBtn = view.querySelector<HTMLButtonElement>('[data-w="copy"]')!;
  const nonceEl = view.querySelector<HTMLElement>('[data-w="nonce"]')!;
  const qrEl = view.querySelector<HTMLElement>('[data-w="qr"]')!;

  const toEl = view.querySelector<HTMLInputElement>('[data-w="to"]')!;
  const amountEl = view.querySelector<HTMLInputElement>('[data-w="amount"]')!;
  const feeEl = view.querySelector<HTMLInputElement>('[data-w="fee"]')!;
  const sendBtn = view.querySelector<HTMLButtonElement>('[data-w="send"]')!;
  const msgEl = view.querySelector<HTMLSpanElement>('[data-w="msg"]')!;

  const chipsEl = view.querySelector<HTMLElement>('[data-w="chips"]')!;
  const countEl = view.querySelector<HTMLElement>('[data-w="count"]')!;
  const rowsEl = view.querySelector<HTMLTableSectionElement>('[data-w="rows"]')!;
  const pagerEl = view.querySelector<HTMLElement>('[data-w="pager"]')!;

  let activeFilter: ActivityFilter = 'all';
  let page = 0;

  // Build filter chips once.
  for (const f of FILTERS) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = f.label;
    chip.dataset['filter'] = f.key;
    chip.addEventListener('click', () => {
      activeFilter = f.key;
      page = 0;
      paint();
    });
    chipsEl.appendChild(chip);
  }

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(node.wallet.address).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
    });
  });

  sendBtn.addEventListener('click', () => {
    msgEl.className = 'text-sm muted';
    msgEl.textContent = '';
    try {
      const to = hexToBytes(toEl.value.trim());
      if (to.length !== 32) throw new Error('recipient address must be 32 bytes (64 hex chars)');
      const err = node.send(to, amountEl.value, feeEl.value);
      if (err) {
        msgEl.className = 'text-sm red';
        msgEl.textContent = err;
      } else {
        msgEl.className = 'text-sm green';
        msgEl.textContent = 'Submitted to mempool';
        amountEl.value = '';
      }
    } catch (e) {
      msgEl.className = 'text-sm red';
      msgEl.textContent = (e as Error).message;
    }
  });

  function paintBalance(): void {
    balanceEl.innerHTML = `${formatAmount(node.myBalance())} <span class="unit">${UNIT_LONG}</span>`;
    addressEl.value = node.wallet.address;
    nonceEl.textContent = `nonce ${node.myNonce()}`;
    renderAddressQr(qrEl, node.wallet.address);
  }

  function paint(): void {
    paintBalance();

    for (const c of chipsEl.querySelectorAll<HTMLElement>('.chip')) {
      c.classList.toggle('active', c.dataset['filter'] === activeFilter);
    }

    const all = computeActivity(node);
    const filtered = filterActivity(all, activeFilter);
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (page >= pages) page = pages - 1;

    const start = page * PAGE_SIZE;
    const shown = filtered.slice(start, start + PAGE_SIZE);

    if (all.length === 0) {
      rowsEl.innerHTML = `<tr class="table-empty"><td colspan="5">No activity yet — share your address to receive ${TICKER}, or start mining.</td></tr>`;
      countEl.textContent = '';
      pagerEl.innerHTML = '';
      return;
    }
    if (filtered.length === 0) {
      rowsEl.innerHTML = `<tr class="table-empty"><td colspan="5">No matching activity.</td></tr>`;
      countEl.textContent = `${all.length} total`;
      pagerEl.innerHTML = '';
      return;
    }

    rowsEl.innerHTML = renderActivityRows(shown);
    const pending = all.filter((r) => r.status === 'pending').length;
    countEl.textContent = pending > 0
      ? `${filtered.length} match · ${pending} pending`
      : `${filtered.length} match`;

    renderPager(pagerEl, page, pages, (p) => { page = p; paint(); });
  }

  // Prefill the recipient if the page was opened via a `?to=...` share link.
  // Strip the param from the URL so it doesn't re-prefill on subsequent navigation.
  const prefillTo = params?.get('to');
  if (prefillTo && /^[0-9a-fA-F]{64}$/.test(prefillTo)) {
    toEl.value = prefillTo.toLowerCase();
    history.replaceState(null, '', '/wallet');
    msgEl.className = 'text-sm muted';
    msgEl.textContent = 'Recipient prefilled from share link.';
    setTimeout(() => view.querySelector<HTMLElement>('[data-mount="send"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }

  paint();
  const unsubChain = node.onChain(paint);
  const unsubWallet = node.onWallet(paint);
  const ticker = setInterval(paint, 5000);

  return () => {
    unsubChain();
    unsubWallet();
    clearInterval(ticker);
  };
}
