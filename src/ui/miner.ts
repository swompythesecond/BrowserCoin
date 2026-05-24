import { maxMinerWorkers } from '../miner/controller.js';
import type { Node } from '../node.js';
import { formatAmount } from '../node.js';
import { nextDifficulty } from '../chain/consensus.js';
import { DIFFICULTY_WINDOW, MTP_WINDOW, blockReward } from '../chain/genesis.js';
import { compactToTarget } from '../util/binary.js';
import { bytesToHex } from '../util/binary.js';
import { TICKER } from '../brand.js';
import { cardHeader } from './info.js';

const THREADS_KEY = 'browsercoin:miner-threads';

/**
 * Full miner view: big animated hashrate hero, live stat tiles, controls, and
 * a session counter that tallies blocks mined since the page loaded.
 */
export function mountMiner(host: HTMLElement, node: Node): () => void {
  const maxThreads = maxMinerWorkers();
  const savedThreads = clampThreads(Number(localStorage.getItem(THREADS_KEY)) || 1, maxThreads);

  const view = document.createElement('div');
  view.className = 'view';
  view.innerHTML = `
    <div class="view-header">
      <h2 class="view-title">Mining</h2>
      <span class="view-sub">Solve the math puzzle, win the block, earn the reward.</span>
    </div>

    <div class="conn-strip" data-w="connStrip" hidden></div>

    <section class="miner-hero" data-w="hero">
      <div class="status-line">
        <span class="pulse-dot"></span>
        <span data-w="status">idle</span>
      </div>
      <div class="hashrate" data-w="hashrate">0 <span class="hashrate-unit">H/s</span></div>
      <div class="nonce-ticker" data-w="ticker">— waiting —</div>
      <div class="mt-md row" style="justify-content:center;">
        <button data-w="toggle">Start mining</button>
      </div>
    </section>

    <div class="grid grid-3 mt-lg">
      <div class="stat-tile accent">
        <div class="stat-label">Mining block</div>
        <div class="stat-value mono" data-w="block">—</div>
        <div class="stat-sub" data-w="txs">0 txs included</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Difficulty</div>
        <div class="stat-value mono" data-w="diff">—</div>
        <div class="stat-sub" data-w="diffSub">target —</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Estimated solve</div>
        <div class="stat-value mono" data-w="eta">—</div>
        <div class="stat-sub" data-w="etaSub">based on current hashrate</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Blocks this session</div>
        <div class="stat-value mono" data-w="sessionBlocks">0</div>
        <div class="stat-sub">since you opened this tab</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Rewards this session</div>
        <div class="stat-value mono" data-w="sessionReward">0 ${TICKER}</div>
        <div class="stat-sub" data-w="lifetime">lifetime: 0 ${TICKER}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Block reward (now)</div>
        <div class="stat-value mono" data-w="reward">— ${TICKER}</div>
        <div class="stat-sub">halves every 210 000 blocks</div>
      </div>
    </div>

    <div class="grid grid-2 mt-lg">
      <section class="card" data-mount="cpu">
        <div data-slot="header"></div>
        <label>CPU power: <span data-w="pct">100%</span></label>
        <input type="range" min="0" max="100" value="100" class="slider" data-w="slider" />
        <label class="mt-md">Threads: <span data-w="threads">${savedThreads}</span> <span class="muted">/ ${maxThreads} available</span></label>
        <input type="range" min="1" max="${maxThreads}" value="${savedThreads}" step="1" class="slider" data-w="threadSlider" ${maxThreads === 1 ? 'disabled' : ''} />
      </section>

      <section class="card" data-mount="how">
        <div data-slot="header"></div>
        <p class="text-sm muted" style="margin:0 0 8px;">
          Your browser builds a candidate block from pending transactions, then races other miners
          to find a nonce whose hash falls below a target value. The first to hit it wins the block
          reward plus the fees from every transaction included.
        </p>
        <p class="text-sm muted" style="margin:0;">
          Mining uses your CPU heavily — your laptop will warm up. Lower CPU power or threads
          if you want to keep using your machine while it runs.
        </p>
      </section>
    </div>
  `;
  host.appendChild(view);

  view.querySelector<HTMLElement>('[data-mount="cpu"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'CPU & Threads',
    info: {
      title: 'CPU and threads',
      body: `CPU power throttles each thread's duty cycle — 50% means each worker sleeps half the time.\n\nThreads spreads the work across multiple CPU cores. More threads = faster hashing, but more heat and battery drain.`,
    },
  }));
  view.querySelector<HTMLElement>('[data-mount="how"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'How mining works',
    info: {
      title: 'Proof of work',
      body: `BrowserCoin uses a memory-hard hash function. The "difficulty" sets how many leading zero bits a valid block hash needs. As more miners join, the network automatically raises the difficulty to keep blocks arriving at the target rate.`,
    },
  }));

  const hero = view.querySelector<HTMLElement>('[data-w="hero"]')!;
  const statusEl = view.querySelector<HTMLElement>('[data-w="status"]')!;
  const hashrateEl = view.querySelector<HTMLElement>('[data-w="hashrate"]')!;
  const tickerEl = view.querySelector<HTMLElement>('[data-w="ticker"]')!;
  const toggleBtn = view.querySelector<HTMLButtonElement>('[data-w="toggle"]')!;
  const connStrip = view.querySelector<HTMLElement>('[data-w="connStrip"]')!;

  const blockEl = view.querySelector<HTMLElement>('[data-w="block"]')!;
  const txsEl = view.querySelector<HTMLElement>('[data-w="txs"]')!;
  const diffEl = view.querySelector<HTMLElement>('[data-w="diff"]')!;
  const diffSubEl = view.querySelector<HTMLElement>('[data-w="diffSub"]')!;
  const etaEl = view.querySelector<HTMLElement>('[data-w="eta"]')!;
  const sessBlocksEl = view.querySelector<HTMLElement>('[data-w="sessionBlocks"]')!;
  const sessRewardEl = view.querySelector<HTMLElement>('[data-w="sessionReward"]')!;
  const lifetimeEl = view.querySelector<HTMLElement>('[data-w="lifetime"]')!;
  const rewardEl = view.querySelector<HTMLElement>('[data-w="reward"]')!;

  const slider = view.querySelector<HTMLInputElement>('[data-w="slider"]')!;
  const pctEl = view.querySelector<HTMLElement>('[data-w="pct"]')!;
  const threadSlider = view.querySelector<HTMLInputElement>('[data-w="threadSlider"]')!;
  const threadsEl = view.querySelector<HTMLElement>('[data-w="threads"]')!;

  node.miner.setWorkerCount(savedThreads);

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
  slider.addEventListener('input', () => {
    const pct = Number(slider.value);
    pctEl.textContent = `${pct}%`;
    node.miner.setThrottle(pct / 100);
  });
  threadSlider.addEventListener('input', () => {
    const n = clampThreads(Number(threadSlider.value), maxThreads);
    threadsEl.textContent = String(n);
    localStorage.setItem(THREADS_KEY, String(n));
    node.miner.setWorkerCount(n);
  });

  // Capture starting block count for session-level stats. Anything mined by us
  // beyond this height counts toward "this session".
  const startHeight = node.chain.height;

  function sessionStats(): { blocks: number; reward: bigint; lifetime: bigint } {
    const myAddr = node.wallet.address;
    let sessionBlocks = 0;
    let sessionReward = 0n;
    let lifetimeReward = 0n;
    let scanned = 0;
    for (const cb of node.chain.iterateCanonical()) {
      if (scanned++ > 2000) break;
      const h = cb.block.header;
      if (h.height === 0) break;
      if (bytesToHex(h.miner) !== myAddr) continue;
      let fees = 0n;
      for (const tx of cb.block.transactions) fees += tx.fee;
      const reward = blockReward(h.height) + fees;
      lifetimeReward += reward;
      if (h.height > startHeight) {
        sessionBlocks++;
        sessionReward += reward;
      }
    }
    return { blocks: sessionBlocks, reward: sessionReward, lifetime: lifetimeReward };
  }

  function refresh(): void {
    const s = node.miner.getStatus();
    toggleBtn.textContent = s.running ? 'Stop mining' : 'Start mining';
    statusEl.textContent = s.running ? (s.currentHeight > 0 ? `mining block #${s.currentHeight}` : 'mining…') : 'idle';
    hero.classList.toggle('running', s.running);

    hashrateEl.innerHTML = `${formatHashNumber(s.hashesPerSecond)} <span class="hashrate-unit">${formatHashUnit(s.hashesPerSecond)}</span>`;

    blockEl.textContent = s.currentHeight > 0 ? `#${s.currentHeight}` : '—';
    txsEl.textContent = `${s.currentTxCount} ${s.currentTxCount === 1 ? 'tx' : 'txs'} included`;

    const nextHeight = node.chain.height + 1;
    const headers = node.chain.getRecentHeaders(DIFFICULTY_WINDOW + MTP_WINDOW - 1);
    const diff = nextDifficulty(nextHeight, headers, Math.floor(Date.now() / 1000));
    const target = compactToTarget(diff);
    const bits = target <= 0n ? 256 : 256 - target.toString(2).length;
    const expected = target > 0n ? (1n << 256n) / (target + 1n) : 0n;
    diffEl.textContent = `${bits} bits`;
    diffSubEl.textContent = `~${formatBig(expected)} hashes/block`;

    if (s.running && s.hashesPerSecond > 0 && expected > 0n) {
      const seconds = Number(expected / BigInt(Math.max(1, Math.floor(s.hashesPerSecond))));
      etaEl.textContent = formatDuration(seconds);
    } else {
      etaEl.textContent = s.running ? 'measuring…' : 'idle';
    }

    const stats = sessionStats();
    sessBlocksEl.textContent = String(stats.blocks);
    sessRewardEl.textContent = `${formatAmount(stats.reward)} ${TICKER}`;
    lifetimeEl.textContent = `lifetime: ${formatAmount(stats.lifetime)} ${TICKER}`;
    rewardEl.textContent = `${formatAmount(blockReward(nextHeight))} ${TICKER}`;
  }

  // "Grinding" effect — flicker a fake nonce-progress string while mining.
  const tickerId = setInterval(() => {
    const s = node.miner.getStatus();
    if (!s.running || s.hashesPerSecond <= 0) {
      tickerEl.textContent = s.running ? '— warming up —' : '— waiting —';
      return;
    }
    tickerEl.textContent = `nonce 0x${randomHex(8)}  hash 0x${randomHex(12)}…`;
  }, 120);

  function refreshConnStrip(): void {
    const ps = node.network?.getStatus();
    const ss = node.serverSync?.getStatus();
    const peers = ps?.connected ?? 0;
    const apiUp = ss?.reachable ?? 0;
    const apiTotal = ss?.total ?? 0;
    const sigOpen = ps?.signalingServers.filter((s) => s.open).length ?? 0;
    const sigTotal = ps?.signalingServers.length ?? 0;
    connStrip.hidden = false;
    if (peers > 0) {
      connStrip.className = 'conn-strip ok';
      connStrip.innerHTML = `<span class="dot"></span> Connected to <b>${peers}</b> peer${peers === 1 ? '' : 's'} — your blocks gossip directly to the network. <span class="muted">(${apiUp}/${apiTotal} API · ${sigOpen}/${sigTotal} signaling)</span>`;
    } else if (apiUp > 0) {
      connStrip.className = 'conn-strip warn';
      connStrip.innerHTML = `<span class="dot"></span> Server-bridged — no direct peers right now. Blocks reach the chain through ${apiUp}/${apiTotal} helper server${apiUp === 1 ? '' : 's'} (other tabs pick them up within ~90s).`;
    } else {
      connStrip.className = 'conn-strip bad';
      connStrip.innerHTML = `<span class="dot"></span> Offline — no peers and no bootstrap server. Click <b>Start mining</b> to set up a direct peer link, or wait for connectivity to come back.`;
    }
  }

  refresh();
  refreshConnStrip();
  const unsubStatus = node.miner.onStatus(refresh);
  const unsubChain = node.onChain(refresh);
  const unsubNet = node.network?.onStatus(refreshConnStrip) ?? (() => {});
  const unsubServer = node.serverSync?.onStatus(refreshConnStrip) ?? (() => {});
  const refreshTicker = setInterval(refresh, 3000);
  const connTicker = setInterval(refreshConnStrip, 5000);

  return () => {
    unsubStatus();
    unsubChain();
    unsubNet();
    unsubServer();
    clearInterval(tickerId);
    clearInterval(refreshTicker);
    clearInterval(connTicker);
  };
}

/**
 * True iff we'd be mining into a void — no direct peers AND the bootstrap
 * server is unreachable. "server-only" mode is not offline: blocks still
 * reach the chain through the server, and the slow-poll bridge makes sure
 * peered clients pick those up within ~90s.
 */
export function isMiningOffline(node: Node): boolean {
  const ps = node.network?.getStatus();
  const ss = node.serverSync?.getStatus();
  const peers = ps?.connected ?? 0;
  const apiUp = ss?.reachable ?? 0;
  return peers === 0 && apiUp === 0;
}

export interface OfflineModalOpts {
  /** Headline. Defaults to "No network connectivity". */
  title?: string;
  /** Body paragraph under the headline. Defaults to a sync-focused message. */
  description?: string;
  /**
   * Optional override action shown as a destructive button. The "mine anyway"
   * escape hatch uses this; the startup popup omits it (no useful override to
   * offer — being offline isn't something you "do anyway").
   */
  primary?: { label: string; onClick: () => void };
  /** Label for the dismiss button. Defaults to "Close". */
  dismissLabel?: string;
}

/**
 * Track that a modal is currently open so the global startup-watcher in
 * main.ts doesn't stack duplicates if the network state flickers.
 */
let openModal: HTMLElement | null = null;

export function isOfflineModalOpen(): boolean {
  return openModal !== null;
}

/**
 * Modal shown when the tab is fully offline (no peers + no server). Surfaces
 * the user's peer ID for out-of-band sharing and a paste-in to dial a
 * friend's peer. Used both:
 *   - on startup, the moment we determine the bootstrap server is unreachable
 *     (gives the user a way to join the network anyway), and
 *   - when the user tries to start mining while offline (with a "mine anyway"
 *     override added).
 *
 * The peer-ID display live-updates as PeerJS finishes establishing — the user
 * might dismiss before that happens, but if they wait we'll show the real ID
 * the moment it's available.
 */
export function openOfflineModal(node: Node, opts: OfflineModalOpts = {}): void {
  if (openModal) return; // already open; don't stack
  const title = opts.title ?? 'No network connectivity';
  const description = opts.description ??
    "You're not connected to any peers and the bootstrap server is unreachable. " +
    "Without a connection, this tab can't receive new blocks, send transactions, or join the network. " +
    "Paste a peer's ID below to link directly, or check your internet connection.";
  const dismissLabel = opts.dismissLabel ?? 'Close';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3 style="margin:0 0 8px;">${escapeHtml(title)}</h3>
      <p class="text-sm muted" style="margin:0 0 16px;">${escapeHtml(description)}</p>
      <p class="text-sm" style="margin:0 0 6px;"><b>Your network ID</b> (share it with a friend over Discord, Signal, etc.):</p>
      <div class="row" style="margin-bottom:14px;">
        <input data-w="my" readonly value="(network not running yet)" />
        <button class="ghost small" data-w="copy" disabled>Copy</button>
      </div>
      <p class="text-sm" style="margin:0 0 6px;"><b>Connect to a peer by ID:</b></p>
      <div class="row" style="margin-bottom:6px;">
        <input data-w="dial" placeholder="browsercoin-xxxxxxxxxx" />
        <button data-w="dial-btn">Connect</button>
      </div>
      <div class="text-sm" data-w="msg" style="min-height:1.2em;"></div>
      <div class="row" style="justify-content:flex-end; gap:8px; margin-top:18px;">
        <button class="ghost" data-w="dismiss">${escapeHtml(dismissLabel)}</button>
        ${opts.primary ? `<button class="ghost danger" data-w="primary">${escapeHtml(opts.primary.label)}</button>` : ''}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  openModal = overlay;

  const close = (): void => {
    overlay.remove();
    openModal = null;
    unsubNet();
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const myInput = overlay.querySelector<HTMLInputElement>('[data-w="my"]')!;
  const copyBtn = overlay.querySelector<HTMLButtonElement>('[data-w="copy"]')!;
  const dialInput = overlay.querySelector<HTMLInputElement>('[data-w="dial"]')!;
  const dialBtn = overlay.querySelector<HTMLButtonElement>('[data-w="dial-btn"]')!;
  const msgEl = overlay.querySelector<HTMLElement>('[data-w="msg"]')!;
  const dismissBtn = overlay.querySelector<HTMLButtonElement>('[data-w="dismiss"]')!;
  const primaryBtn = overlay.querySelector<HTMLButtonElement>('[data-w="primary"]');

  // Live-update the peer ID display — PeerJS might still be negotiating when
  // we open. If the user waits a moment, they'll see the real ID populate
  // without needing to reopen the modal.
  const renderId = (): void => {
    const id = node.network?.getStatus().myId;
    if (id) {
      myInput.value = id;
      copyBtn.disabled = false;
    } else {
      myInput.value = '(network not running yet)';
      copyBtn.disabled = true;
    }
  };
  renderId();
  const unsubNet = node.network?.onStatus(renderId) ?? (() => {});

  copyBtn.addEventListener('click', () => {
    const id = node.network?.getStatus().myId;
    if (!id) return;
    navigator.clipboard.writeText(id).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
    });
  });

  dialBtn.addEventListener('click', async () => {
    const id = dialInput.value.trim();
    if (!id || !node.network) return;
    msgEl.textContent = 'Connecting…';
    msgEl.className = 'text-sm muted';
    dialBtn.disabled = true;
    try {
      const ok = await node.network.dialPeer(id);
      if (ok) {
        msgEl.textContent = 'Connected ✓';
        msgEl.className = 'text-sm green';
        // Brief pause so the user sees the success state, then auto-close —
        // they're back online, the modal has served its purpose.
        setTimeout(() => close(), 700);
      } else {
        msgEl.textContent = 'Could not reach that peer. Double-check the ID.';
        msgEl.className = 'text-sm red';
      }
    } finally {
      dialBtn.disabled = false;
    }
  });

  dismissBtn.addEventListener('click', close);
  if (primaryBtn && opts.primary) {
    const onClick = opts.primary.onClick;
    primaryBtn.addEventListener('click', () => { close(); onClick(); });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;'
  );
}

function randomHex(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function formatBig(n: bigint): string {
  const s = n.toString();
  if (s.length <= 4) return s;
  if (s.length <= 6) return `${(Number(n) / 1e3).toFixed(1)}k`;
  if (s.length <= 9) return `${(Number(n) / 1e6).toFixed(2)}M`;
  if (s.length <= 12) return `${(Number(n) / 1e9).toFixed(2)}G`;
  return `${s[0]}.${s.slice(1, 3)}e${s.length - 1}`;
}
function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '—';
  if (sec < 1) return '<1s';
  if (sec < 60) return `~${sec.toFixed(0)}s`;
  if (sec < 3600) return `~${(sec / 60).toFixed(1)}m`;
  if (sec < 86400) return `~${(sec / 3600).toFixed(1)}h`;
  return `~${(sec / 86400).toFixed(1)}d`;
}
function clampThreads(n: number, max: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(max, Math.floor(n)));
}
function formatHashNumber(h: number): string {
  if (h < 1000) return h.toFixed(0);
  if (h < 1e6) return (h / 1e3).toFixed(2);
  return (h / 1e6).toFixed(2);
}
function formatHashUnit(h: number): string {
  if (h < 1000) return 'H/s';
  if (h < 1e6) return 'kH/s';
  return 'MH/s';
}
