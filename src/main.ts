import { Node, formatAmount } from './node.js';
import { mountHome } from './ui/home.js';
import { mountWallet } from './ui/wallet.js';
import { mountMiner, openOfflineModal, isOfflineModalOpen } from './ui/miner.js';
import { mountNetwork } from './ui/network.js';
import { mountExplorer } from './ui/explorer.js';
import { mountMempool } from './ui/mempool.js';
import { mountSettings } from './ui/settings.js';
import { mountAbout } from './ui/about.js';
import { mountDevelopers } from './ui/developers.js';
import { compactToTarget } from './util/binary.js';
import { Router, wireNav } from './ui/router.js';
import { TICKER } from './brand.js';

const node = new Node();

(window as unknown as { browsercoin: Node }).browsercoin = node;

// QR-code share links land here as `?to=<address>` on the bare URL. The app
// is a hash-routed SPA, so rewrite to `#/wallet?to=...` and clear the query
// string from the address bar before the router starts.
{
  const qs = new URLSearchParams(window.location.search);
  const to = qs.get('to');
  if (to) {
    history.replaceState(null, '', window.location.pathname + `#/wallet?to=${encodeURIComponent(to)}`);
  }
}

void node.start();

const viewRoot = document.querySelector<HTMLElement>('[data-view-root]')!;
const router: Router = new Router(viewRoot);
router
  .route('/',         (host) => mountHome(host, node, router))
  .route('/wallet',   (host, params) => mountWallet(host, node, params))
  .route('/mine',     (host) => mountMiner(host, node))
  .route('/explorer', (host) => mountExplorer(host, node))
  .route('/mempool',  (host) => mountMempool(host, node))
  .route('/about',    (host) => mountAbout(host))
  .route('/developers', (host) => mountDevelopers(host))
  .route('/settings', (host) => mountSettings(host, node))
  .setFallback('/');
wireNav(router);
router.start();

// ============ Top-bar live stats ============

const stat = (k: string) => document.querySelector<HTMLElement>(`[data-stat="${k}"]`)!;
const netDot = document.querySelector<HTMLElement>('[data-stat-dot="net"]')!;

function refreshTopbar(): void {
  stat('height').textContent = `height ${node.chain.height}`;
  const netStatus = node.network?.getStatus();
  const peers = netStatus?.connected ?? 0;
  const miners = netStatus?.serverMinersActive ?? 0;
  stat('miners').textContent = `miners ${miners}`;
  stat('peers').textContent = `peers ${peers}`;
  stat('mempool').textContent = `mempool ${node.mempool.size()}`;
  const bits = leadingZeroBits(node.chain.tipDifficulty);
  stat('difficulty').textContent = `diff ${bits} bits`;
  stat('difficulty').title = `compact 0x${node.chain.tipDifficulty.toString(16)} — hash must have ${bits} leading zero bits`;

  const ss = node.serverSync?.getStatus();
  if (node.network?.getStatus().myId) {
    netDot.className = 'stat-dot live';
  } else if (ss && ss.reachable > 0) {
    netDot.className = 'stat-dot warn';
  } else {
    netDot.className = 'stat-dot off';
  }
}

function leadingZeroBits(compact: number): number {
  const target = compactToTarget(compact);
  if (target <= 0n) return 256;
  return 256 - target.toString(2).length;
}
node.onChain(refreshTopbar);
setInterval(refreshTopbar, 1500);
refreshTopbar();

// ============ Sync overlay ============

const overlay = document.querySelector<HTMLElement>('[data-sync-overlay]')!;
const overlayBar = document.querySelector<HTMLElement>('[data-sync-bar]')!;
const overlayMeta = document.querySelector<HTMLElement>('[data-sync-meta]')!;
const overlayPhase = document.querySelector<HTMLElement>('[data-sync-phase]')!;
const overlayTitle = document.querySelector<HTMLElement>('[data-sync-title]')!;
const overlaySub = document.querySelector<HTMLElement>('[data-sync-sub]')!;
const overlayDismiss = document.querySelector<HTMLButtonElement>('[data-sync-dismiss]')!;

const PHASE_LABEL: Record<string, string> = {
  restoring:  'restoring local cache',
  connecting: 'looking for a network',
  fetching:   'reaching the network',
  verifying:  'verifying blocks',
  ready:      'ready',
  offline:    'offline — network unreachable',
};

// Title / sub copy per phase. Two flavors of overlay: chain-sync (we have a
// network and we're catching up to it) and connect (we don't yet have a
// network and we're trying to find one). The latter is what answers the
// "I see Offline for a moment on startup" complaint — we keep the overlay up
// instead of letting the home page render with stale data.
const PHASE_TITLE: Record<string, string> = {
  restoring:  'Loading your wallet',
  connecting: 'Connecting to the network',
  fetching:   'Connecting to the network',
  verifying:  'Syncing the chain',
  ready:      'Ready',
  offline:    "Can't reach the network",
};
const PHASE_SUB: Record<string, string> = {
  restoring:  'Restoring local cache. This only takes a moment.',
  connecting: 'Reaching out to the bootstrap server and looking for peers — your balance will load once we’re connected.',
  fetching:   'Reaching out to the bootstrap server and looking for peers — your balance will load once we’re connected.',
  verifying:  'Verifying blocks. This only happens on fresh tabs — reloads are instant.',
  ready:      '',
  offline:    'The bootstrap server is unreachable and no peers have answered. You can continue offline and try again later — balances will be from your last cached state.',
};

overlayDismiss.addEventListener('click', () => node.dismissSyncOverlay());

function paintSync(): void {
  const s = node.getSyncStatus();
  if (!s.syncing) {
    overlay.classList.add('hidden');
    return;
  }
  overlay.classList.remove('hidden');
  const target = Math.max(s.targetHeight, s.localHeight, 1);
  const pct = target > 0 ? Math.min(100, Math.round((s.localHeight / target) * 100)) : 0;
  overlayBar.style.width = `${pct}%`;
  overlayMeta.textContent = `local ${s.localHeight} / server ${s.targetHeight || '—'}`;
  overlayPhase.textContent = PHASE_LABEL[s.phase] ?? s.phase;
  overlayTitle.textContent = PHASE_TITLE[s.phase] ?? 'Connecting';
  overlaySub.textContent = PHASE_SUB[s.phase] ?? '';
  overlayDismiss.hidden = !s.canDismiss;
}

node.onSync(paintSync);
paintSync();

// ============ Offline auto-popup ============
//
// When the tab is fully disconnected (no peers AND the bootstrap server is
// unreachable), the user is invisible to the rest of the network — can't sync,
// can't send tx, can't mine usefully. Pop the connect-by-ID modal so they at
// least have a path forward (paste a friend's peer ID over Discord, etc.).
//
// We wait until the initial sync attempt completes (or its 5s safety timer
// fires) so we don't flash the modal during normal startup before connectivity
// has had a chance to come up. Then we watch transitions: pop on entering
// offline, re-arm when we leave offline so the next offline event can re-pop.

let wasOffline = false;
let armed = false;

function isFullyOffline(): boolean {
  const peers = node.network?.getStatus().connected ?? 0;
  const apiUp = node.serverSync?.getStatus().reachable ?? 0;
  return peers === 0 && apiUp === 0;
}

function maybePopOffline(): void {
  if (!armed) return;
  const offline = isFullyOffline();
  if (offline && !wasOffline && !isOfflineModalOpen()) {
    openOfflineModal(node);
  }
  wasOffline = offline;
}

// Arm once the sync overlay actually comes down (syncing flips false). We wait
// for that rather than for a specific phase, because the overlay now stays up
// during 'offline' until the user explicitly dismisses — and we don't want to
// stack the offline modal on top of the still-visible overlay.
// `serverSync` and `network` are both created during `node.start()`, so by
// the time the first sync event fires they're guaranteed to exist.
// Starting `wasOffline = false` is intentional — if we boot already offline
// and the user dismisses, the first maybePopOffline() call sees an offline-
// transition and pops the connect-by-ID modal.
node.onSync((s) => {
  if (!armed && !s.syncing) {
    armed = true;
    node.serverSync?.onStatus(maybePopOffline);
    node.network?.onStatus(maybePopOffline);
    maybePopOffline();
  }
});
node.onChain(maybePopOffline);
setInterval(maybePopOffline, 3000);

// ============ Block-found toast ============
//
// One toast element, reused. Mining two blocks in a row resets the timer
// rather than stacking — the most recent find is what the user cares about.

const toast = document.querySelector<HTMLElement>('[data-block-toast]')!;
const toastTitle = document.querySelector<HTMLElement>('[data-toast-title]')!;
const toastSub = document.querySelector<HTMLElement>('[data-toast-sub]')!;
const TOAST_MS = 5000;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

node.onBlockMined((info) => {
  const total = info.reward + info.fees;
  const feeNote = info.fees > 0n ? ` (+${formatAmount(info.fees)} fees)` : '';
  toastTitle.textContent = `Block #${info.height} found!`;
  toastSub.textContent = `+${formatAmount(total)} ${TICKER}${feeNote}`;

  toast.hidden = false;
  // Force a reflow so the transition replays even if the toast was already showing.
  void toast.offsetWidth;
  toast.classList.add('toast-show');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('toast-show');
    // Hide after the fade-out transition so screen readers don't re-announce.
    setTimeout(() => { if (!toast.classList.contains('toast-show')) toast.hidden = true; }, 250);
    toastTimer = null;
  }, TOAST_MS);
});
