import type { Node } from '../node.js';
import { nextDifficulty } from '../chain/consensus.js';
import { DIFFICULTY_WINDOW, MTP_WINDOW } from '../chain/genesis.js';
import { compactToTarget } from '../util/binary.js';
import { TICKER } from '../brand.js';
import { maxMinerWorkers } from '../miner/controller.js';
import { formatHashNumber, formatHashUnit } from './miner.js';

/**
 * Pop-out miner: render a compact, live miner widget inside a Document
 * Picture-in-Picture window so the user can watch and control mining while
 * working in another browser tab.
 *
 * The PiP window runs in the *same* JS context as the opener, so the widget
 * drives the existing singleton `node.miner` controller directly — no second
 * controller, no extra workers, no cross-window messaging. It's purely
 * another view/control surface; mining keeps running on the opener's workers
 * whether the PiP window is open, closed, or the tab is backgrounded.
 *
 * Document Picture-in-Picture is Chromium-only (Chrome/Edge 116+). On every
 * other browser `pipMinerSupported()` returns false and callers hide the
 * trigger button.
 */

const THROTTLE_KEY = 'browsercoin:miner-throttle';
const THREADS_KEY = 'browsercoin:miner-threads';

/** Minimal typing for the Document Picture-in-Picture API, which isn't in
 *  every TypeScript lib yet. We access it through this accessor to avoid
 *  clashing with (or depending on) the ambient global declaration. */
interface PipApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}
function getPipApi(): PipApi | undefined {
  return (globalThis as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture;
}

export function pipMinerSupported(): boolean {
  return !!getPipApi();
}

// Only one PiP miner window at a time. A second openPipMiner() call focuses
// the existing window instead of stacking a duplicate.
let currentPipWindow: Window | null = null;

export async function openPipMiner(node: Node): Promise<void> {
  const api = getPipApi();
  if (!api) return;
  if (currentPipWindow) {
    currentPipWindow.focus();
    return;
  }

  const pip = await api.requestWindow({ width: 320, height: 400 });
  currentPipWindow = pip;
  const pipDoc = pip.document;
  pipDoc.title = `${TICKER} Miner`;
  copyStyles(pipDoc);
  pipDoc.body.className = 'pip-body';

  const maxThreads = maxMinerWorkers();

  const root = pipDoc.createElement('div');
  root.className = 'pip-miner miner-hero';
  root.innerHTML = `
    <div class="status-line">
      <span class="pulse-dot"></span>
      <span data-w="status">idle</span>
    </div>
    <div class="hashrate" data-w="hashrate">0 <span class="hashrate-unit">H/s</span></div>
    <div class="pip-meta mono" data-w="meta">—</div>
    <button class="pip-toggle" data-w="toggle">Start mining</button>
    <label class="pip-cpu">CPU power: <span data-w="pct">100%</span></label>
    <input type="range" min="0" max="100" value="100" class="slider" data-w="slider" />
    <label class="pip-cpu">Cores: <span data-w="cores">${maxThreads}</span> <span class="muted">/ ${maxThreads}</span></label>
    <input type="range" min="1" max="${maxThreads}" value="${maxThreads}" step="1" class="slider" data-w="coreSlider" ${maxThreads === 1 ? 'disabled' : ''} />
  `;
  pipDoc.body.appendChild(root);

  const statusEl = root.querySelector<HTMLElement>('[data-w="status"]')!;
  const hashrateEl = root.querySelector<HTMLElement>('[data-w="hashrate"]')!;
  const metaEl = root.querySelector<HTMLElement>('[data-w="meta"]')!;
  const toggleBtn = root.querySelector<HTMLButtonElement>('[data-w="toggle"]')!;
  const slider = root.querySelector<HTMLInputElement>('[data-w="slider"]')!;
  const pctEl = root.querySelector<HTMLElement>('[data-w="pct"]')!;
  const coreSlider = root.querySelector<HTMLInputElement>('[data-w="coreSlider"]')!;
  const coresEl = root.querySelector<HTMLElement>('[data-w="cores"]')!;

  function refresh(): void {
    const s = node.miner.getStatus();
    root.classList.toggle('running', s.running);
    statusEl.textContent = s.running
      ? (s.currentHeight > 0 ? `mining block #${s.currentHeight}` : 'mining…')
      : 'idle';
    toggleBtn.textContent = s.running ? 'Stop mining' : 'Start mining';
    hashrateEl.innerHTML =
      `${formatHashNumber(s.hashesPerSecond)} <span class="hashrate-unit">${formatHashUnit(s.hashesPerSecond)}</span>`;

    // Difficulty of the template actually being ground while running; otherwise
    // the difficulty a fresh Start would begin at (mirrors the /mine view).
    const nextHeight = node.chain.height + 1;
    let diff: number;
    if (s.running && s.currentDifficulty !== null) {
      diff = s.currentDifficulty;
    } else {
      const headers = node.chain.getRecentHeaders(DIFFICULTY_WINDOW + MTP_WINDOW - 1);
      diff = nextDifficulty(nextHeight, headers, Math.floor(Date.now() / 1000));
    }
    const target = compactToTarget(diff);
    const bits = target <= 0n ? 256 : 256 - target.toString(2).length;
    const blockLabel = s.running && s.currentHeight > 0 ? `#${s.currentHeight}` : `#${nextHeight}`;
    metaEl.textContent = `block ${blockLabel} · ${bits} bits`;

    // Don't fight the user while they're dragging a slider. activeElement is
    // per-document, so check the PiP document's, not the opener's.
    if (pipDoc.activeElement !== slider) {
      const pct = Math.round(s.throttle * 100);
      slider.value = String(pct);
      pctEl.textContent = `${pct}%`;
    }
    if (pipDoc.activeElement !== coreSlider) {
      coreSlider.value = String(s.workerCount);
      coresEl.textContent = String(s.workerCount);
    }
    // The cores slider is a manual-mode control; in auto the tuner owns the
    // count, so reflect it read-only (mirrors the full /mine view).
    coreSlider.disabled = s.mode === 'auto' || maxThreads === 1;
  }

  toggleBtn.addEventListener('click', () => {
    if (node.miner.getStatus().running) node.miner.stop();
    else node.miner.start();
  });
  slider.addEventListener('input', () => {
    const pct = Number(slider.value);
    pctEl.textContent = `${pct}%`;
    localStorage.setItem(THROTTLE_KEY, String(pct));
    node.miner.setThrottle(pct / 100);
  });
  coreSlider.addEventListener('input', () => {
    const n = Math.max(1, Math.min(maxThreads, Number(coreSlider.value)));
    coresEl.textContent = String(n);
    localStorage.setItem(THREADS_KEY, String(n));
    node.miner.setWorkerCount(n);
  });

  const unsubStatus = node.miner.onStatus(refresh);
  const unsubChain = node.onChain(refresh);
  const tick = window.setInterval(refresh, 1000);
  refresh();

  // Fires when the user closes the PiP window. Tear down every subscription so
  // we don't leak listeners/timers; mining itself is unaffected.
  pip.addEventListener('pagehide', () => {
    unsubStatus();
    unsubChain();
    clearInterval(tick);
    currentPipWindow = null;
  });
}

/**
 * Document PiP windows start blank, so replicate the app's stylesheets into the
 * new document. Same-origin sheets (our bundled styles.css) are copied rule by
 * rule; any cross-origin sheet is re-linked by href instead (reading its
 * cssRules would throw).
 */
function copyStyles(pipDoc: Document): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = pipDoc.createElement('style');
      style.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n');
      pipDoc.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = pipDoc.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        if (sheet.media?.mediaText) link.media = sheet.media.mediaText;
        pipDoc.head.appendChild(link);
      }
    }
  }
}
