// Bundled via Vite so the emitted asset gets a content hash. Without this,
// `public/styles.css` was served at a stable URL, so a CDN/browser holding
// an old copy could pair it with a fresh index.html — see the sync-overlay
// logo blow-up after the May 2026 deploy.
import './styles.css';
import { Node, formatAmount } from './node.js';
import { mountLanding } from './ui/landing.js';
import { mountHome } from './ui/home.js';
import { mountWallet } from './ui/wallet.js';
import { mountMiner, openOfflineModal, isOfflineModalOpen } from './ui/miner.js';
import { maxMinerWorkers } from './miner/controller.js';
import { mountExplorer } from './ui/explorer.js';
import { mountScripts } from './ui/scripts.js';
import { mountMempool } from './ui/mempool.js';
import { mountSettings } from './ui/settings.js';
import { mountAbout } from './ui/about.js';
import { mountDevelopers } from './ui/developers.js';
import { mountHighlights } from './ui/highlights.js';
import { compactToTarget } from './util/binary.js';
import { Router, wireNav } from './ui/router.js';
import { TICKER } from './brand.js';
import { hasWallet } from './storage/wallet.js';
import { VERIFY_CORES_KEY, maxVerifierCores, configuredVerifierCores } from './chain/verifierPool.js';

// ============ Node lifecycle ============
//
// The node is opt-in. Visiting the site does NOT make you a peer: `/` and the
// other reading routes render as plain documents with no chain, no wallet, no
// WebRTC and no workers, so the root URL is something you can hand to someone
// who just wants to know what this is. The node boots on the first navigation
// to a route that genuinely needs one (or immediately, if this tab was mining
// when it was last closed — see the auto-resume block below).
//
// Everything that touches the node — the top-bar stats, the sync overlay, the
// offline modal, the block toast — is wired inside `ensureNode()` rather than
// at module scope, because none of it has anything to render until then.

/** Routes that require a live node. Everything else is documentation. */
const NODE_ROUTES = new Set(['/app', '/wallet', '/mine', '/explorer', '/scripts', '/mempool', '/settings']);

/** Where the app itself lives, now that `/` is the landing page. */
const APP_HOME = '/app';

const MINING_KEY = 'browsercoin:miner-running';

let node: Node | null = null;

function ensureNode(): Node {
  if (node) return node;
  const n = new Node();
  node = n;
  (window as unknown as { browsercoin: Node }).browsercoin = n;

  applyPersistedMinerSettings(n);
  wireMiningPersistence(n);
  wireTopbar(n);
  wireSyncOverlay(n);
  wireOfflinePopup(n);
  wireBlockToast(n);
  revealAppNav();

  void n.start();
  resumeMiningIfWasRunning(n);
  return n;
}

const viewRoot = document.querySelector<HTMLElement>('[data-view-root]')!;
const router: Router = new Router(viewRoot);

/** Reveal the app-only nav tabs (hidden by default for first-time readers). */
function revealAppNav(): void {
  document.querySelectorAll<HTMLElement>('[data-nav] .nav-tab[data-app-tab]')
    .forEach((tab) => { tab.hidden = false; });
}

// ============ Miner settings + persistence ============

// Apply persisted miner settings up-front so auto-resume fires with the
// user's last config even if the active route isn't /mine or /app
// (those views also apply them on mount — this is the no-view-mounted path).
function applyPersistedMinerSettings(n: Node): void {
  const max = maxMinerWorkers();
  // New mode-aware settings, with sensible defaults for first-time users.
  // Default to manual + full CPU + all cores: go full-blast out of the box,
  // and only fall into the auto-tuner if the user explicitly picked it.
  const mode = (localStorage.getItem('browsercoin:miner-mode') === 'auto') ? 'auto' : 'manual';
  // Default Max = all cores. With the new argon2id lib, OOM is rare enough
  // that "try to use everything" is the right default; the tuner backs off
  // automatically if the machine pushes back.
  const defaultAutoMax = max;
  const rawAutoMin = Number(localStorage.getItem('browsercoin:miner-auto-min'));
  const autoMin = Number.isFinite(rawAutoMin) && rawAutoMin >= 1 ? Math.min(max, Math.floor(rawAutoMin)) : 1;
  const rawAutoMax = Number(localStorage.getItem('browsercoin:miner-auto-max'));
  const autoMax = Number.isFinite(rawAutoMax) && rawAutoMax >= 1 ? Math.min(max, Math.floor(rawAutoMax)) : defaultAutoMax;

  // Legacy keys: meaningful in manual mode (and also used as the initial
  // workerCount/throttle when auto mode boots, before the tuner kicks in).
  const rawThreads = Number(localStorage.getItem('browsercoin:miner-threads')) || max;
  const threads = Math.max(1, Math.min(max, Math.floor(rawThreads)));
  const rawPctStr = localStorage.getItem('browsercoin:miner-throttle');
  const rawPct = rawPctStr === null ? 100 : Number(rawPctStr);
  const pct = Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : 100;

  n.miner.setWorkerCount(threads);
  n.miner.setThrottle(pct / 100);
  n.miner.setControlMode({ mode, autoMin, autoMax });
}

// Persist whether mining is on. Saved state is consulted on next page load
// to auto-resume; clicking Stop clears it so a deliberately-stopped tab
// stays stopped across refreshes. We only touch the flag on actual
// transitions — that way a start() refused by the start-gate doesn't
// emit running=false and wipe the resume intent before we can retry.
function wireMiningPersistence(n: Node): void {
  let prevRunning = false;
  n.miner.onStatus((s) => {
    if (s.running && !prevRunning) localStorage.setItem(MINING_KEY, '1');
    else if (!s.running && prevRunning) localStorage.removeItem(MINING_KEY);
    prevRunning = s.running;
  });
}

// Auto-resume after refresh if the user was mining. The start-gate refuses
// while we're still syncing — so retry once sync completes (canDismiss or
// not, syncing flipping false is the signal we need).
function resumeMiningIfWasRunning(n: Node): void {
  if (localStorage.getItem(MINING_KEY) !== '1') return;
  const tryResume = (): boolean => {
    if (n.getSyncStatus().syncing) return false;
    n.miner.start();
    return true;
  };
  if (!tryResume()) {
    const unsub = n.onSync(() => { if (tryResume()) unsub(); });
  }
}

// ============ Top-bar live stats ============

function wireTopbar(n: Node): void {
  const stat = (k: string) => document.querySelector<HTMLElement>(`[data-stat="${k}"]`)!;
  const netDot = document.querySelector<HTMLElement>('[data-stat-dot="net"]')!;
  // Hidden until there's a node behind them — a strip of "height -" is worse
  // than no strip at all on a page that deliberately isn't a node.
  document.querySelector<HTMLElement>('.netstats')!.hidden = false;

  function refreshTopbar(): void {
    stat('height').textContent = `height ${n.chain.height}`;
    const netStatus = n.network?.getStatus();
    const peers = netStatus?.connected ?? 0;
    const miners = netStatus?.serverMinersActive ?? 0;
    stat('miners').textContent = `miners ${miners}`;
    stat('peers').textContent = `peers ${peers}`;
    stat('mempool').textContent = `mempool ${n.mempool.size()}`;
    const bits = leadingZeroBits(n.chain.tipDifficulty);
    stat('difficulty').textContent = `diff ${bits} bits`;
    stat('difficulty').title = `compact 0x${n.chain.tipDifficulty.toString(16)}, hash must have ${bits} leading zero bits`;

    // History pill: visible only while a fast-synced tab is still backfilling
    // old block bodies. Balances are already final — this is history/explorer
    // completeness only.
    const hist = stat('history');
    const bf = n.getBackfillStatus();
    if (bf.total > 0 && bf.remaining > 0) {
      hist.hidden = false;
      const pct = Math.round(((bf.total - bf.remaining) / bf.total) * 100);
      hist.textContent = `history ${pct}%`;
      hist.title = 'Downloading full block history in the background, balances are already verified and final.';
    } else {
      hist.hidden = true;
    }

    const ss = n.serverSync?.getStatus();
    if (n.network?.getStatus().myId) {
      netDot.className = 'stat-dot live';
    } else if (ss && ss.reachable > 0) {
      netDot.className = 'stat-dot warn';
    } else {
      netDot.className = 'stat-dot off';
    }
  }

  n.onChain(refreshTopbar);
  n.onBackfill(refreshTopbar);
  setInterval(refreshTopbar, 1500);
  refreshTopbar();
}

function leadingZeroBits(compact: number): number {
  const target = compactToTarget(compact);
  if (target <= 0n) return 256;
  return 256 - target.toString(2).length;
}

// ============ Sync overlay ============

const PHASE_LABEL: Record<string, string> = {
  restoring:  'restoring local cache',
  connecting: 'looking for a network',
  fetching:   'reaching the network',
  verifying:  'verifying blocks',
  headers:    'checking block headers',
  snapshot:   'verifying balance snapshot',
  ready:      'ready',
  offline:    'offline, network unreachable',
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
  headers:    'Fast-syncing the chain',
  snapshot:   'Fast-syncing the chain',
  ready:      'Ready',
  offline:    "Can't reach the network",
};
const PHASE_SUB: Record<string, string> = {
  restoring:
    'Replaying blocks you already verified, straight from local storage. Just a moment.',
  connecting:
    'Looking for the bootstrap server and other browser nodes so we can ask where the chain tip is. Your balance will load as soon as someone answers.',
  fetching:
    'Looking for the bootstrap server and other browser nodes so we can ask where the chain tip is. Your balance will load as soon as someone answers.',
  verifying:
    'Every browser is its own full node, no trusted central server. We re-check each block\'s proof-of-work locally before showing you any balance, so the chain is yours, not the server\'s word. This only happens once per fresh tab; reloads use the cached chain.',
  headers:
    'Downloading and checking every block header: the hash chain, the difficulty schedule, and spot-checked proof-of-work. No server is trusted; full blocks download in the background after you\'re ready.',
  snapshot:
    'Fetching a compact snapshot of every balance and verifying it against the header chain\'s state commitment. The snapshot can\'t be forged without redoing the chain\'s proof-of-work.',
  ready:      '',
  offline:
    'The bootstrap server is unreachable and no peers have answered. You can continue with your last cached state. Syncing keeps retrying in the background, and mining unlocks once the chain catches up.',
};

function wireSyncOverlay(n: Node): void {
  const overlay = document.querySelector<HTMLElement>('[data-sync-overlay]')!;
  const overlayBar = document.querySelector<HTMLElement>('[data-sync-bar]')!;
  const overlayMeta = document.querySelector<HTMLElement>('[data-sync-meta]')!;
  const overlayPhase = document.querySelector<HTMLElement>('[data-sync-phase]')!;
  const overlayTitle = document.querySelector<HTMLElement>('[data-sync-title]')!;
  const overlaySub = document.querySelector<HTMLElement>('[data-sync-sub]')!;
  const overlayDismiss = document.querySelector<HTMLButtonElement>('[data-sync-dismiss]')!;

  overlayDismiss.addEventListener('click', () => n.dismissSyncOverlay());

  // Live "verification cores" control on the sync overlay. This is the moment it
  // actually matters — the chain is being verified right now, behind this overlay
  // — so the user can dial cores up/down and feel the ETA move. The pool resizes
  // in place via setVerifierConcurrency; the choice is also persisted so the next
  // fresh sync starts where they left it. (Settings has the same control for
  // pre-configuring before a sync starts.)
  const overlayAdvanced = document.querySelector<HTMLDetailsElement>('[data-sync-advanced]')!;
  const overlayVSlider = document.querySelector<HTMLInputElement>('[data-sync-vslider]')!;
  const overlayVCores = document.querySelector<HTMLElement>('[data-sync-vcores]')!;
  const overlayVMax = document.querySelector<HTMLElement>('[data-sync-vmax]')!;
  {
    const maxV = maxVerifierCores();
    const savedV = configuredVerifierCores();
    overlayVMax.textContent = String(maxV);
    overlayVSlider.max = String(maxV);
    overlayVSlider.value = String(savedV);
    overlayVCores.textContent = String(savedV);
    if (maxV === 1) overlayVSlider.disabled = true;
    overlayVSlider.addEventListener('input', () => {
      const v = Math.max(1, Math.min(maxV, Math.floor(Number(overlayVSlider.value)) || 1));
      overlayVCores.textContent = String(v);
      localStorage.setItem(VERIFY_CORES_KEY, String(v));
      n.serverSync?.setVerifierConcurrency(v);
    });
  }

  // ETA estimator. Tracks first observed (height, time) once verification is
  // actually progressing, then projects remaining time from the observed rate.
  // Cleared on phase change so the estimate resets between restoring and
  // verifying. Floors at ~5 blocks/sec so a momentary stall doesn't produce
  // a wildly pessimistic estimate.
  let etaStartHeight = -1;
  let etaStartMs = 0;
  let etaLastPhase = '';

  function estimateRemaining(localHeight: number, targetHeight: number, phase: string): string {
    if (phase !== 'verifying' && phase !== 'fetching') {
      etaStartHeight = -1;
      etaLastPhase = phase;
      return '';
    }
    if (phase !== etaLastPhase) {
      etaStartHeight = localHeight;
      etaStartMs = performance.now();
      etaLastPhase = phase;
      return '';
    }
    const remaining = Math.max(0, targetHeight - localHeight);
    if (remaining === 0) return '';
    const advanced = localHeight - etaStartHeight;
    const elapsedMs = performance.now() - etaStartMs;
    // Need a couple seconds of observed progress before guessing.
    if (advanced < 5 || elapsedMs < 2000) {
      // Fall back to a typical verifier throughput (~25 blocks/sec, 4-worker laptop).
      const secs = Math.max(1, Math.round(remaining / 25));
      return ` · ~${formatEtaSeconds(secs)} remaining`;
    }
    const rate = Math.max(5, advanced / (elapsedMs / 1000));
    const secs = Math.max(1, Math.round(remaining / rate));
    return ` · ~${formatEtaSeconds(secs)} remaining`;
  }

  function paintSync(): void {
    const s = n.getSyncStatus();
    // The overlay belongs to the app, not to the site. On the reading routes it
    // never appears, even mid-sync: a node booted by auto-resume (or left
    // running while the user clicks into About) syncs silently in the
    // background instead of covering the text they came to read.
    const onNodeRoute = NODE_ROUTES.has(router.currentRoute());
    // Overlay is down once we're caught up OR the user chose "Continue offline".
    // `dismissed` is sticky for the session, so background sync re-discovering
    // backlog (syncing flips back to true) can't pull the overlay back up.
    if (!onNodeRoute || !s.syncing || s.dismissed) {
      overlay.classList.add('hidden');
      return;
    }
    overlay.classList.remove('hidden');
    if ((s.phase === 'headers' || s.phase === 'snapshot') && s.aux) {
      // Fast sync: the chain height doesn't move until the verified anchor is
      // seeded in one step, so progress comes from the aux counters instead.
      const total = Math.max(1, s.aux.total);
      const pct = Math.min(100, Math.round((s.aux.done / total) * 100));
      overlayBar.style.width = `${pct}%`;
      overlayMeta.textContent = s.phase === 'headers'
        ? `headers ${s.aux.done} / ${total}`
        : 'verifying balances against the chain';
    } else {
      const target = Math.max(s.targetHeight, s.localHeight, 1);
      const pct = target > 0 ? Math.min(100, Math.round((s.localHeight / target) * 100)) : 0;
      overlayBar.style.width = `${pct}%`;
      const eta = estimateRemaining(s.localHeight, s.targetHeight, s.phase);
      overlayMeta.textContent = `local ${s.localHeight} / server ${s.targetHeight || '-'}${eta}`;
    }
    overlayPhase.textContent = PHASE_LABEL[s.phase] ?? s.phase;
    overlayTitle.textContent = PHASE_TITLE[s.phase] ?? 'Connecting';
    overlaySub.textContent = PHASE_SUB[s.phase] ?? '';
    overlayDismiss.hidden = !s.canDismiss;
    // Only surface the cores control while we're actually pulling/verifying the
    // chain — it's meaningless during local-cache replay or the connect phase.
    overlayAdvanced.hidden = s.phase !== 'verifying' && s.phase !== 'fetching';
  }

  n.onSync(paintSync);
  // Re-paint on a slow timer so the ETA updates between sync-status emits.
  setInterval(paintSync, 1000);
  // ...and on navigation, so stepping into the app mid-sync raises the overlay
  // and stepping back out of it lowers it again.
  router.onNavigate(paintSync);
  paintSync();
}

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

function wireOfflinePopup(n: Node): void {
  let wasOffline = false;
  let armed = false;

  const isFullyOffline = (): boolean => {
    const peers = n.network?.getStatus().connected ?? 0;
    const apiUp = n.serverSync?.getStatus().reachable ?? 0;
    return peers === 0 && apiUp === 0;
  };

  const maybePopOffline = (): void => {
    if (!armed) return;
    // Never interrupt someone who's reading. A background node that can't find
    // the network has nothing to say to a person on the About page.
    if (!NODE_ROUTES.has(router.currentRoute())) return;
    const offline = isFullyOffline();
    if (offline && !wasOffline && !isOfflineModalOpen()) {
      openOfflineModal(n);
    }
    wasOffline = offline;
  };

  // Arm once the sync overlay actually comes down — either we caught up (syncing
  // flips false) or the user clicked "Continue offline". We wait for
  // that rather than for a specific phase, because the overlay stays up during
  // 'offline' until the user explicitly dismisses — and we don't want to stack
  // the offline modal on top of the still-visible overlay.
  // `serverSync` and `network` are both created during `node.start()`, so by
  // the time the first sync event fires they're guaranteed to exist.
  // Starting `wasOffline = false` is intentional — if we boot already offline
  // and the user dismisses, the first maybePopOffline() call sees an offline-
  // transition and pops the connect-by-ID modal.
  n.onSync((s) => {
    if (!armed && (!s.syncing || s.dismissed)) {
      armed = true;
      n.serverSync?.onStatus(maybePopOffline);
      n.network?.onStatus(maybePopOffline);
      maybePopOffline();
    }
  });
  n.onChain(maybePopOffline);
  setInterval(maybePopOffline, 3000);
}

// ============ Block-found toast ============
//
// One toast element, reused. Mining two blocks in a row resets the timer
// rather than stacking — the most recent find is what the user cares about.

function wireBlockToast(n: Node): void {
  const toast = document.querySelector<HTMLElement>('[data-block-toast]')!;
  const toastTitle = document.querySelector<HTMLElement>('[data-toast-title]')!;
  const toastSub = document.querySelector<HTMLElement>('[data-toast-sub]')!;
  const TOAST_MS = 5000;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  n.onBlockMined((info) => {
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
}

function formatEtaSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = (s / 3600).toFixed(1);
  return `${h} h`;
}

// ============ Bootstrap ============
//
// Everything below runs on module evaluation and must stay LAST in the file.
// `router.start()` can mount an app route synchronously, which calls
// `ensureNode()`, which reaches back into the `const` tables above — so any
// bootstrap placed before them hits the temporal dead zone and throws before
// the first view renders. That failure is invisible on a click-through
// (`/` → Launch) because module evaluation has finished by then; it only bites
// on a direct load of an app route, which is exactly what a refresh or a
// bookmarked /wallet link is.

// QR-code share links land here as `?to=<address>` on the bare URL. Forward
// straight into the wallet route — replaceState (not pushState) so the entry
// the user came in on doesn't clutter their back-button history.
{
  const qs = new URLSearchParams(window.location.search);
  const to = qs.get('to');
  if (to && window.location.pathname === '/') {
    history.replaceState(null, '', `/wallet?to=${encodeURIComponent(to)}`);
  }
}

router
  .route('/',           (host) => mountLanding(host, router))
  .route('/app',        (host) => mountHome(host, ensureNode(), router))
  .route('/wallet',     (host, params) => mountWallet(host, ensureNode(), params))
  .route('/mine',       (host) => mountMiner(host, ensureNode()))
  .route('/explorer',   (host, params) => mountExplorer(host, ensureNode(), params, router))
  .route('/scripts',    (host) => mountScripts(host, ensureNode()))
  .route('/mempool',    (host) => mountMempool(host, ensureNode()))
  .route('/about',      (host, params) => mountAbout(host, params, router))
  .route('/highlights', (host) => mountHighlights(host))
  .route('/developers', (host) => mountDevelopers(host))
  .route('/settings',   (host) => mountSettings(host, ensureNode()))
  .setFallback('/');
// Once the node is live the brand mark belongs to the app, not the pitch.
wireNav(router, { homePath: () => (node ? APP_HOME : '/') });

// Someone who already has a wallet has been here before — give them the full
// tab strip up front so the app doesn't feel like it disappeared. The tabs are
// just links; the node still doesn't start until one of them is clicked.
if (hasWallet()) revealAppNav();

router.start();

// A tab that was mining when it was closed resumes on reload wherever the user
// lands — including the reading routes, so mining survives a click into About.
// The overlay stays route-gated, so this boots quietly in the background.
if (localStorage.getItem(MINING_KEY) === '1') ensureNode();
