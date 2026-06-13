import type { Node } from '../node.js';
import { formatAmount } from '../node.js';
import { hashHeader } from '../chain/block.js';
import { bytesToHex, compactToTarget } from '../util/binary.js';
import { TICKER, UNIT_LONG } from '../brand.js';
import { computeActivity, renderActivityRows, blockTime, timeAgo } from './activity.js';
import { cardHeader } from './info.js';
import type { Router } from './router.js';
import { maxMinerWorkers } from '../miner/controller.js';
import { renderAddressQr } from './qr.js';
import { openScanner } from './qrScanner.js';
import { nextDifficulty } from '../chain/consensus.js';
import { DIFFICULTY_WINDOW, MTP_WINDOW } from '../chain/genesis.js';
import { isMiningOffline, openOfflineModal } from './miner.js';
import { openPipMiner, pipMinerSupported } from './pip-miner.js';

const PREVIEW_ROWS = 5;
// Shared with the dedicated Mine view so the two stay in sync across reloads.
const THREADS_KEY = 'browsercoin:miner-threads';
const THROTTLE_KEY = 'browsercoin:miner-throttle';

function clampThreads(n: number, max: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(max, Math.floor(n)));
}
function clampPct(raw: string | null): number {
  if (raw === null) return 100;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Dashboard / Home view. Shows compact previews of every section with "view
 * all" links to the dedicated full-page views.
 */
export function mountHome(host: HTMLElement, node: Node, router: Router): () => void {
  const view = document.createElement('div');
  view.className = 'view';
  view.innerHTML = `
    <div class="view-header">
      <h2 class="view-title">Welcome to BrowserCoin</h2>
      <span class="view-sub">A fully decentralized cryptocurrency you can mine, send and explore — right here in your browser. <a class="view-sub-link" href="/about">Learn more</a></span>
    </div>

    <div class="grid grid-12">
      <section class="card hero col-7" data-mount="balance">
        <div data-slot="header"></div>
        <div class="balance" data-w="balance">0 <span class="unit">${UNIT_LONG}</span></div>
        <label>Your address (share this to receive coins)</label>
        <div class="row">
          <input data-w="address" readonly />
          <button class="ghost small" data-w="copy">Copy</button>
          <button class="ghost small" data-w="scan">Scan</button>
          <button class="small" data-w="send">Send →</button>
        </div>
        <div class="qr-wrap mt-md">
          <div class="qr-box" data-w="qr"></div>
          <div class="qr-caption">Scan to send coins to this wallet.</div>
        </div>
        <div class="mt-md text-sm muted" data-w="nonce">nonce —</div>
      </section>

      <section class="card col-5" data-mount="miner">
        <div data-slot="header"></div>
        <div class="row" style="align-items:flex-start; gap:18px;">
          <div style="flex:1">
            <div class="label-caps">Hashrate</div>
            <div class="mono" style="font-size:1.6rem; font-weight:700;" data-w="hashrate">0 H/s</div>
            <div class="text-sm muted mt-sm" data-w="state">idle</div>
          </div>
          <div style="flex:1">
            <div class="label-caps">Difficulty</div>
            <div class="mono" style="font-size:1.6rem; font-weight:700;" data-w="diff">— bits</div>
            <div class="text-sm muted mt-sm" data-w="diffSub">target —</div>
          </div>
          <div style="display:flex; flex-direction:column; gap:8px;">
            <button data-w="toggle">Start mining</button>
            <button class="ghost small" data-w="popout" hidden>⧉ Pop out</button>
          </div>
        </div>
        <div class="text-sm muted mt-md" data-w="eta">Press start to begin.</div>
        <div class="conn-strip conn-strip-small" data-w="connStrip" hidden></div>

        <div class="mt-md">
          <label class="text-sm">CPU power: <span data-w="pct">100%</span></label>
          <input type="range" min="0" max="100" value="100" class="slider" data-w="slider" />
          <div class="row" style="justify-content:space-between; align-items:center; margin-top:8px;">
            <label class="text-sm" style="margin:0;">Threads: <span data-w="threads">1</span> <span class="muted">/ <span data-w="maxThreads">1</span> available</span></label>
            <label class="text-sm" style="display:flex; align-items:center; gap:6px; cursor:pointer;">
              <input type="checkbox" data-w="autoCheck" />
              auto
            </label>
          </div>
          <input type="range" min="1" max="1" value="1" step="1" class="slider" data-w="threadSlider" />
          <div class="text-sm muted mt-sm" data-w="autoStatus" hidden></div>
        </div>
      </section>

      <section class="card col-7" data-mount="activity">
        <div data-slot="header"></div>
        <div class="table-scroll">
          <table class="table">
            <thead><tr>
              <th>status</th><th class="col-hide-sm">dir</th><th>counterparty</th><th>amount</th><th class="col-hide-sm">when</th>
            </tr></thead>
            <tbody data-w="actRows"></tbody>
          </table>
        </div>
      </section>

      <section class="card col-5" data-mount="network">
        <div data-slot="header"></div>
        <dl class="kv">
          <dt>Status</dt><dd data-w="state" class="muted">connecting…</dd>
          <dt>Peers</dt><dd data-w="peers" class="mono">0</dd>
          <dt>Miners</dt><dd data-w="miners" class="mono">0</dd>
          <dt>Height</dt><dd data-w="height" class="mono">—</dd>
          <dt>Server</dt><dd data-w="server" class="mono">—</dd>
        </dl>
      </section>

      <section class="card col-6" data-mount="explorer">
        <div data-slot="header"></div>
        <div class="table-scroll">
          <table class="table">
            <thead><tr>
              <th>height</th><th>hash</th><th>txs</th><th class="col-hide-sm">miner</th><th>time</th>
            </tr></thead>
            <tbody data-w="rows"></tbody>
          </table>
        </div>
      </section>

      <section class="card col-6" data-mount="mempool">
        <div data-slot="header"></div>
        <div class="table-scroll">
          <table class="table">
            <thead><tr>
              <th>from</th><th class="col-hide-sm">to</th><th>amount</th><th class="col-hide-sm">when</th>
            </tr></thead>
            <tbody data-w="memRows"></tbody>
          </table>
        </div>
      </section>
    </div>
  `;
  host.appendChild(view);

  const mountSlot = (key: string, header: HTMLElement): void => {
    const target = view.querySelector<HTMLElement>(`[data-mount="${key}"] [data-slot="header"]`)!;
    target.replaceWith(header);
  };

  mountSlot('balance', cardHeader({
    title: 'Your wallet',
    info: {
      title: 'Your wallet',
      body: `Every browser gets its own wallet automatically. It's a pair of keys saved in this browser — anyone who has the private key controls the coins.\n\nShare your address to receive ${TICKER}. Back up your wallet from Settings if you don't want to lose it when you clear your browser data.`,
    },
    link: { label: 'Open wallet →', onClick: () => router.navigate('/wallet') },
  }));
  mountSlot('miner', cardHeader({
    title: 'Mining',
    info: {
      title: 'Mining',
      body: `Mining is how new ${TICKER} is created. Your browser races other browsers to solve a math puzzle for each block; the winner collects the reward.\n\nIt uses your CPU, so it'll make your laptop fan spin. You can throttle it or stop anytime.`,
    },
    link: { label: 'Full miner →', onClick: () => router.navigate('/mine') },
  }));
  mountSlot('activity', cardHeader({
    title: 'Recent activity',
    info: {
      title: 'Your activity',
      body: `Every coin you send, receive, or mine appears here. "Pending" means a transaction is in the mempool but not yet inside a block — wait for the next block to be mined for it to confirm.`,
    },
    link: { label: 'View all →', onClick: () => router.navigate('/wallet') },
  }));
  mountSlot('network', cardHeader({
    title: 'Network',
    info: {
      title: 'Network',
      body: `BrowserCoin has no central server — every tab is a full node. Your browser talks directly to other browsers over WebRTC, and a bootstrap server helps everyone find each other.`,
    },
  }));
  mountSlot('explorer', cardHeader({
    title: 'Recent blocks',
    info: {
      title: 'Blocks',
      body: `Every confirmed transaction lives inside a block. New blocks arrive roughly every 2.5 minutes (depending on the network's combined hashrate).`,
    },
    link: { label: 'Explorer →', onClick: () => router.navigate('/explorer') },
  }));
  mountSlot('mempool', cardHeader({
    title: 'Pending transactions',
    info: {
      title: 'Mempool',
      body: `Transactions that have been broadcast but not yet picked up by a miner. They confirm as soon as a miner includes them in the next block.`,
    },
    link: { label: 'Open mempool →', onClick: () => router.navigate('/mempool') },
  }));

  const balEl = view.querySelector<HTMLElement>('[data-w="balance"]')!;
  const addrEl = view.querySelector<HTMLInputElement>('[data-w="address"]')!;
  const copyBtn = view.querySelector<HTMLButtonElement>('[data-w="copy"]')!;
  const nonceEl = view.querySelector<HTMLElement>('[data-w="nonce"]')!;
  const qrEl = view.querySelector<HTMLElement>('[data-mount="balance"] [data-w="qr"]')!;

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(node.wallet.address).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
    });
  });

  view.querySelector<HTMLButtonElement>('[data-mount="balance"] [data-w="send"]')!
    .addEventListener('click', () => router.navigate('/wallet'));

  view.querySelector<HTMLButtonElement>('[data-mount="balance"] [data-w="scan"]')!
    .addEventListener('click', async () => {
      const addr = await openScanner();
      if (addr) router.navigate(`/wallet?to=${addr}`);
    });

  const hashrateEl = view.querySelector<HTMLElement>('[data-mount="miner"] [data-w="hashrate"]')!;
  const minerStateEl = view.querySelector<HTMLElement>('[data-mount="miner"] [data-w="state"]')!;
  const minerEtaEl = view.querySelector<HTMLElement>('[data-mount="miner"] [data-w="eta"]')!;
  const minerDiffEl = view.querySelector<HTMLElement>('[data-mount="miner"] [data-w="diff"]')!;
  const minerDiffSubEl = view.querySelector<HTMLElement>('[data-mount="miner"] [data-w="diffSub"]')!;
  const toggleBtn = view.querySelector<HTMLButtonElement>('[data-mount="miner"] [data-w="toggle"]')!;
  const connStripEl = view.querySelector<HTMLElement>('[data-mount="miner"] [data-w="connStrip"]')!;
  toggleBtn.addEventListener('click', () => {
    const s = node.miner.getStatus();
    if (s.running) { node.miner.stop(); return; }
    if (isMiningOffline(node)) {
      openOfflineModal(node, {
        description: "You're not connected to any peers and the bootstrap server is unreachable. " +
          "If you mine now, your blocks won't reach anyone else until you reconnect.",
        primary: { label: 'Mine anyway', onClick: () => node.miner.start() },
        dismissLabel: 'Cancel',
      });
      return;
    }
    node.miner.start();
  });

  const popoutBtn = view.querySelector<HTMLButtonElement>('[data-mount="miner"] [data-w="popout"]')!;
  if (pipMinerSupported()) {
    popoutBtn.hidden = false;
    popoutBtn.addEventListener('click', () => { void openPipMiner(node); });
  }

  const cpuSlider = view.querySelector<HTMLInputElement>('[data-mount="miner"] [data-w="slider"]')!;
  const cpuPctEl = view.querySelector<HTMLElement>('[data-mount="miner"] [data-w="pct"]')!;
  const threadSlider = view.querySelector<HTMLInputElement>('[data-mount="miner"] [data-w="threadSlider"]')!;
  const threadsEl = view.querySelector<HTMLElement>('[data-mount="miner"] [data-w="threads"]')!;
  const maxThreadsEl = view.querySelector<HTMLElement>('[data-mount="miner"] [data-w="maxThreads"]')!;
  const autoCheck = view.querySelector<HTMLInputElement>('[data-mount="miner"] [data-w="autoCheck"]')!;
  const autoStatusEl = view.querySelector<HTMLElement>('[data-mount="miner"] [data-w="autoStatus"]')!;

  const maxThreads = maxMinerWorkers();
  maxThreadsEl.textContent = String(maxThreads);
  threadSlider.max = String(maxThreads);
  if (maxThreads === 1) threadSlider.disabled = true;

  // Reflect persisted manual-mode values as the slider defaults (auto mode
  // ignores these). main.ts already restored the full mode/power state into
  // the controller before this view mounted.
  const savedThreads = clampThreads(Number(localStorage.getItem(THREADS_KEY)) || 1, maxThreads);
  const savedThrottlePct = clampPct(localStorage.getItem(THROTTLE_KEY));
  cpuSlider.value = String(savedThrottlePct);
  cpuPctEl.textContent = `${savedThrottlePct}%`;
  threadSlider.value = String(savedThreads);
  threadsEl.textContent = String(savedThreads);

  cpuSlider.addEventListener('input', () => {
    const pct = Number(cpuSlider.value);
    cpuPctEl.textContent = `${pct}%`;
    localStorage.setItem(THROTTLE_KEY, String(pct));
    node.miner.setThrottle(pct / 100);
  });
  threadSlider.addEventListener('input', () => {
    const n = clampThreads(Number(threadSlider.value), maxThreads);
    threadsEl.textContent = String(n);
    localStorage.setItem(THREADS_KEY, String(n));
    node.miner.setWorkerCount(n);
  });

  function applyAutoStateToHomeUI(isAuto: boolean): void {
    threadSlider.disabled = isAuto || maxThreads === 1;
    threadSlider.style.opacity = isAuto ? '0.5' : '';
    autoStatusEl.hidden = !isAuto;
  }
  autoCheck.addEventListener('change', () => {
    const isAuto = autoCheck.checked;
    localStorage.setItem('browsercoin:miner-mode', isAuto ? 'auto' : 'manual');
    node.miner.setControlMode({ mode: isAuto ? 'auto' : 'manual' });
    applyAutoStateToHomeUI(isAuto);
  });

  const actRowsEl = view.querySelector<HTMLTableSectionElement>('[data-mount="activity"] [data-w="actRows"]')!;

  const netStateEl = view.querySelector<HTMLElement>('[data-mount="network"] [data-w="state"]')!;
  const netPeersEl = view.querySelector<HTMLElement>('[data-mount="network"] [data-w="peers"]')!;
  const netMinersEl = view.querySelector<HTMLElement>('[data-mount="network"] [data-w="miners"]')!;
  const netHeightEl = view.querySelector<HTMLElement>('[data-mount="network"] [data-w="height"]')!;
  const netServerEl = view.querySelector<HTMLElement>('[data-mount="network"] [data-w="server"]')!;

  const blockRowsEl = view.querySelector<HTMLTableSectionElement>('[data-mount="explorer"] [data-w="rows"]')!;
  const memRowsEl = view.querySelector<HTMLTableSectionElement>('[data-mount="mempool"] [data-w="memRows"]')!;

  function refresh(): void {
    balEl.innerHTML = `${formatAmount(node.myBalance())} <span class="unit">${UNIT_LONG}</span>`;
    addrEl.value = node.wallet.address;
    nonceEl.textContent = `nonce ${node.myNonce()}`;
    renderAddressQr(qrEl, node.wallet.address);

    const rows = computeActivity(node).slice(0, PREVIEW_ROWS);
    actRowsEl.innerHTML = rows.length === 0
      ? `<tr class="table-empty"><td colspan="5">No activity yet — share your address to receive ${TICKER}, or start mining.</td></tr>`
      : renderActivityRows(rows);

    const ps = node.network?.getStatus();
    const ss = node.serverSync?.getStatus();
    const apiUp = ss?.reachable ?? 0;
    if (ps?.myId && (ps.connected > 0)) { netStateEl.textContent = 'online'; netStateEl.className = 'green'; }
    else if (apiUp > 0) { netStateEl.textContent = 'server-only'; netStateEl.className = 'muted'; }
    else { netStateEl.textContent = 'offline'; netStateEl.className = 'red'; }
    netPeersEl.textContent = String(ps?.connected ?? 0);
    netMinersEl.textContent = String(ps?.serverMinersActive ?? 0);
    netHeightEl.textContent = `${node.chain.height}`;

    // Difficulty preview — what the next block would need to beat.
    const nextHeight = node.chain.height + 1;
    const lookback = node.chain.getRecentHeaders(DIFFICULTY_WINDOW + MTP_WINDOW - 1);
    const diff = nextDifficulty(nextHeight, lookback, Math.floor(Date.now() / 1000));
    const target = compactToTarget(diff);
    const bits = target <= 0n ? 256 : 256 - target.toString(2).length;
    const expected = target > 0n ? (1n << 256n) / (target + 1n) : 0n;
    minerDiffEl.textContent = `${bits} bits`;
    minerDiffSubEl.textContent = `~${formatBig(expected)} hashes/block`;
    if (ss) {
      const lag = node.chain.height - ss.serverHeight;
      const reachable = ss.reachable > 0;
      const tag = reachable ? (lag === 0 ? 'in sync' : lag > 0 ? `pushing (+${lag})` : `pulling (${-lag})`) : 'unreachable';
      netServerEl.textContent = `${tag} · ${ss.serverHeight} · ${ss.reachable}/${ss.total} up`;
      netServerEl.className = reachable ? 'green mono' : 'red mono';
    } else {
      netServerEl.textContent = '—';
    }

    // Compact connectivity strip on the miner card — mirrors the full strip
    // on /mine so users see the state without navigating.
    const peers = ps?.connected ?? 0;
    const serverOk = (ss?.reachable ?? 0) > 0;
    connStripEl.hidden = false;
    if (peers > 0) {
      connStripEl.className = 'conn-strip conn-strip-small ok';
      connStripEl.innerHTML = `<span class="dot"></span> ${peers} peer${peers === 1 ? '' : 's'} · direct gossip`;
    } else if (serverOk) {
      connStripEl.className = 'conn-strip conn-strip-small warn';
      connStripEl.innerHTML = `<span class="dot"></span> Server-bridged · blocks reach the chain via the bootstrap server`;
    } else {
      connStripEl.className = 'conn-strip conn-strip-small bad';
      connStripEl.innerHTML = `<span class="dot"></span> Offline · click Start to set up a direct peer link`;
    }

    // Recent blocks (5).
    const blocks: string[] = [];
    let n = 0;
    for (const cb of node.chain.iterateCanonical()) {
      if (n++ >= PREVIEW_ROWS) break;
      const h = cb.block.header;
      const hashHex = bytesToHex(hashHeader(h)).slice(0, 10) + '…';
      const minerHex = bytesToHex(h.miner).slice(0, 10) + '…';
      blocks.push(`<tr>
        <td class="mono">${h.height}</td>
        <td class="hash">${hashHex}</td>
        <td class="mono">${cb.block.transactions.length}</td>
        <td class="addr col-hide-sm">${minerHex}</td>
        <td class="muted">${blockTime(h.timestamp)}</td>
      </tr>`);
    }
    blockRowsEl.innerHTML = blocks.length === 0
      ? `<tr class="table-empty"><td colspan="5">No blocks yet.</td></tr>`
      : blocks.join('');

    // Mempool preview (5 latest).
    const mem = node.mempool.listEntries()
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, PREVIEW_ROWS);
    const myAddr = node.wallet.address;
    if (mem.length === 0) {
      memRowsEl.innerHTML = `<tr class="table-empty"><td colspan="4">No pending transactions.</td></tr>`;
    } else {
      memRowsEl.innerHTML = mem.map((e) => {
        const fromHex = bytesToHex(e.tx.from);
        const toHex = bytesToHex(e.tx.to);
        const mine = fromHex === myAddr || toHex === myAddr;
        return `<tr class="${mine ? 'row-mine' : ''}">
          <td class="addr">${fromHex.slice(0, 8)}…${fromHex === myAddr ? ' <span class="badge badge-you">you</span>' : ''}</td>
          <td class="addr col-hide-sm">${toHex.slice(0, 8)}…${toHex === myAddr ? ' <span class="badge badge-you">you</span>' : ''}</td>
          <td class="mono">${formatAmount(e.tx.amount)} ${TICKER}</td>
          <td class="muted col-hide-sm">${timeAgo(e.receivedAt)}</td>
        </tr>`;
      }).join('');
    }
  }

  function refreshMiner(): void {
    const s = node.miner.getStatus();
    toggleBtn.textContent = s.running ? 'Stop' : 'Start mining';
    minerStateEl.textContent = s.running
      ? (s.currentHeight > 0 ? `mining block #${s.currentHeight}` : 'mining…')
      : 'idle';
    minerStateEl.className = s.running ? 'green text-sm mt-sm' : 'text-sm muted mt-sm';
    hashrateEl.textContent = formatHashrate(s.hashesPerSecond);
    minerEtaEl.textContent = s.running
      ? (s.hashesPerSecond > 0 ? `${formatHashrate(s.hashesPerSecond)} grinding — full stats on the Mine tab.` : 'measuring…')
      : 'Press start to begin.';

    // Sync the auto checkbox + slider enablement with controller state, so
    // changes from /mine flow back to the home card immediately.
    autoCheck.checked = s.mode === 'auto';
    applyAutoStateToHomeUI(s.mode === 'auto');
    if (s.mode === 'auto') {
      let detail: string;
      if (!s.running) {
        detail = `will start at Max (${s.autoMaxThreads}) when mining`;
      } else if (s.autoLocked) {
        detail = `${s.workerCount} (settled after OOM from Max ${s.autoMaxThreads})`;
      } else if (s.workerCount >= s.autoMaxThreads) {
        detail = `${s.workerCount} (at Max)`;
      } else {
        detail = `${s.workerCount} of [${s.autoMinThreads}–${s.autoMaxThreads}]`;
      }
      autoStatusEl.textContent = `Threads (auto): ${detail}`;
    }
    // Mirror controller state into both sliders regardless of mode — when
    // auto-tuner moves the thread count we want it visible here too. Skip
    // while the user is actively dragging — would fight their input.
    if (document.activeElement !== cpuSlider) {
      const pct = Math.round(s.throttle * 100);
      cpuSlider.value = String(pct);
      cpuPctEl.textContent = `${pct}%`;
    }
    if (document.activeElement !== threadSlider) {
      threadSlider.value = String(s.workerCount);
      threadsEl.textContent = String(s.workerCount);
    }
  }

  refresh();
  refreshMiner();

  const unsubChain = node.onChain(refresh);
  const unsubWallet = node.onWallet(refresh);
  const unsubMiner = node.miner.onStatus(refreshMiner);
  // Repaint when network connectivity changes too — otherwise a peer connect
  // or first-server-reachable event right after this view mounts wouldn't
  // update the connStrip until the 5s ticker, briefly showing "Offline".
  // Subscribe lazily: serverSync/network are created during node.start(), so
  // they may be null at mount time. We piggyback on onSync — once that fires
  // they exist, and we wire up the network-level subscriptions.
  let unsubServer: (() => void) | undefined;
  let unsubPeer: (() => void) | undefined;
  const wireWhenReady = (): void => {
    if (!unsubServer && node.serverSync) unsubServer = node.serverSync.onStatus(refresh);
    if (!unsubPeer && node.network) unsubPeer = node.network.onStatus(refresh);
  };
  wireWhenReady();
  const unsubSync = node.onSync(() => { wireWhenReady(); refresh(); });
  const ticker = setInterval(refresh, 5000);

  return () => {
    unsubChain();
    unsubWallet();
    unsubMiner();
    unsubServer?.();
    unsubPeer?.();
    unsubSync();
    clearInterval(ticker);
  };
}

function formatHashrate(h: number): string {
  if (h < 1000) return `${h.toFixed(0)} H/s`;
  if (h < 1e6) return `${(h / 1e3).toFixed(2)} kH/s`;
  return `${(h / 1e6).toFixed(2)} MH/s`;
}

function formatBig(n: bigint): string {
  const s = n.toString();
  if (s.length <= 4) return s;
  if (s.length <= 6) return `${(Number(n) / 1e3).toFixed(1)}k`;
  if (s.length <= 9) return `${(Number(n) / 1e6).toFixed(2)}M`;
  if (s.length <= 12) return `${(Number(n) / 1e9).toFixed(2)}G`;
  return `${s[0]}.${s.slice(1, 3)}e${s.length - 1}`;
}

