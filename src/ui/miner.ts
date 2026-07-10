import { maxMinerWorkers } from '../miner/controller.js';
import type { Node } from '../node.js';
import { formatAmount } from '../node.js';
import { nextDifficulty } from '../chain/consensus.js';
import { DIFFICULTY_WINDOW, MTP_WINDOW, blockReward } from '../chain/genesis.js';
import { compactToTarget } from '../util/binary.js';
import { bytesToHex } from '../util/binary.js';
import { TICKER } from '../brand.js';
import { cardHeader } from './info.js';
import { openPipMiner, pipMinerSupported } from './pip-miner.js';

const THREADS_KEY = 'browsercoin:miner-threads';
const THROTTLE_KEY = 'browsercoin:miner-throttle';
const MODE_KEY = 'browsercoin:miner-mode';
const AUTO_MIN_KEY = 'browsercoin:miner-auto-min';
const AUTO_MAX_KEY = 'browsercoin:miner-auto-max';

/**
 * Full miner view: big animated hashrate hero, live stat tiles, controls, and
 * a session counter that tallies blocks mined since the page loaded.
 */
export function mountMiner(host: HTMLElement, node: Node): () => void {
  const maxThreads = maxMinerWorkers();
  const savedThreads = clampThreads(Number(localStorage.getItem(THREADS_KEY)) || 1, maxThreads);
  const savedThrottlePct = clampPct(localStorage.getItem(THROTTLE_KEY));

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
      <div class="mt-md row" style="justify-content:center; gap:10px;">
        <button data-w="toggle">Start mining</button>
        <button class="ghost" data-w="popout" hidden>⧉ Pop out</button>
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

        <label>CPU power: <span data-w="pct">${savedThrottlePct}%</span></label>
        <input type="range" min="0" max="100" value="${savedThrottlePct}" class="slider" data-w="slider" />

        <div class="row" style="justify-content:space-between; align-items:center; margin-top:14px;">
          <label style="margin:0;">Threads: <span data-w="threads">${savedThreads}</span> <span class="muted">/ ${maxThreads} available</span></label>
          <label class="text-sm" style="display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="checkbox" data-w="autoCheck" />
            auto
          </label>
        </div>
        <input type="range" min="1" max="${maxThreads}" value="${savedThreads}" step="1" class="slider" data-w="threadSlider" ${maxThreads === 1 ? 'disabled' : ''} />

        <div data-w="autoBounds" hidden style="margin-top:10px;">
          <div class="row" style="gap:12px; align-items:center;">
            <label class="text-sm" style="flex:1;">Min threads
              <input type="number" min="1" max="${maxThreads}" value="1" class="mono" style="width:60px; margin-left:6px;" data-w="autoMin" />
            </label>
            <label class="text-sm" style="flex:1;">Max threads
              <input type="number" min="1" max="${maxThreads}" value="${maxThreads}" class="mono" style="width:60px; margin-left:6px;" data-w="autoMax" />
            </label>
          </div>
          <p class="text-sm muted" style="margin:6px 0 0;" data-w="autoStatus">Auto starts at Max and backs off only if your machine pushes back. Lower Max if you want to be gentler on memory.</p>
        </div>
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

    <section class="card mt-lg" data-mount="diag">
      <div data-slot="header"></div>
      <div data-w="diagIdle" class="text-sm muted">Start mining to see live diagnostics.</div>
      <div data-w="diagBody" hidden>
        <div class="conn-strip" data-w="diagBanner" hidden style="margin-bottom:12px;"></div>
        <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span class="label-caps">Workers</span>
          <button class="ghost small" data-w="diagRestart">Restart workers</button>
        </div>
        <div data-w="diagWorkers" style="display:grid; gap:4px; margin-bottom:14px;"></div>
        <div class="grid grid-2">
          <div class="stat-tile">
            <div class="stat-label">Elapsed on this template</div>
            <div class="stat-value mono" data-w="diagElapsed">—</div>
            <div class="stat-sub" data-w="diagAttempts">template #—</div>
          </div>
          <div class="stat-tile">
            <div class="stat-label">Hashes on this template</div>
            <div class="stat-value mono" data-w="diagAttemptHashes">—</div>
            <div class="stat-sub" data-w="diagAttemptHashesSub">template needs ~— hashes</div>
          </div>
          <div class="stat-tile">
            <div class="stat-label">P(found by now)</div>
            <div class="stat-value mono" data-w="diagPFound">—</div>
            <div class="stat-sub" data-w="diagPFoundSub">under 95% is still normal-luck territory</div>
          </div>
          <div class="stat-tile">
            <div class="stat-label">Hashrate</div>
            <div class="stat-value mono" data-w="diagAvgRate">—</div>
            <div class="stat-sub" data-w="diagAvgRateSub">session avg / live</div>
          </div>
          <div class="stat-tile" data-w="diagOomTile" style="grid-column: 1 / -1;">
            <div class="stat-label">WebAssembly OOM events</div>
            <div class="stat-value mono" data-w="diagOom">0</div>
            <div class="stat-sub" data-w="diagOomSub">workers retry automatically; non-zero usually means too many threads</div>
          </div>
        </div>
      </div>
    </section>
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
  view.querySelector<HTMLElement>('[data-mount="diag"] [data-slot="header"]')!.replaceWith(cardHeader({
    title: 'Mining diagnostics',
    info: {
      title: 'Mining diagnostics',
      body: `Per-worker hashrate plus stats on the *current template* — the specific block header your workers are grinding nonces against. The template's difficulty doesn't change while you're grinding it: it's frozen at build time. The controller rebuilds it whenever consensus rules would give a different difficulty (e.g. emergency drop kicks in), and on every new block or new tx in the mempool. P(found by now) compares hashes done on the current template against how many a block needs on average. PoW is memoryless — restarting at 99% probability does NOT improve your odds for the next hash; you just reset the counter. A few templates in a row reaching 95%+ is unlucky but not anomalous.`,
    },
  }));

  const hero = view.querySelector<HTMLElement>('[data-w="hero"]')!;
  const statusEl = view.querySelector<HTMLElement>('[data-w="status"]')!;
  const hashrateEl = view.querySelector<HTMLElement>('[data-w="hashrate"]')!;
  const tickerEl = view.querySelector<HTMLElement>('[data-w="ticker"]')!;
  const toggleBtn = view.querySelector<HTMLButtonElement>('[data-w="toggle"]')!;
  const connStrip = view.querySelector<HTMLElement>('[data-w="connStrip"]')!;

  // Pop-out miner: only offered where Document Picture-in-Picture exists.
  const popoutBtn = view.querySelector<HTMLButtonElement>('[data-w="popout"]')!;
  if (pipMinerSupported()) {
    popoutBtn.hidden = false;
    popoutBtn.addEventListener('click', () => { void openPipMiner(node); });
  }

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

  const autoCheck = view.querySelector<HTMLInputElement>('[data-w="autoCheck"]')!;
  const autoBounds = view.querySelector<HTMLElement>('[data-w="autoBounds"]')!;
  const autoStatusEl = view.querySelector<HTMLElement>('[data-w="autoStatus"]')!;
  const autoMinInput = view.querySelector<HTMLInputElement>('[data-w="autoMin"]')!;
  const autoMaxInput = view.querySelector<HTMLInputElement>('[data-w="autoMax"]')!;

  const diagIdle = view.querySelector<HTMLElement>('[data-w="diagIdle"]')!;
  const diagBody = view.querySelector<HTMLElement>('[data-w="diagBody"]')!;
  const diagBanner = view.querySelector<HTMLElement>('[data-w="diagBanner"]')!;
  const diagRestartBtn = view.querySelector<HTMLButtonElement>('[data-w="diagRestart"]')!;
  const diagWorkers = view.querySelector<HTMLElement>('[data-w="diagWorkers"]')!;

  diagRestartBtn.addEventListener('click', () => {
    node.miner.restartWorkers();
    diagRestartBtn.textContent = 'Restarted ✓';
    setTimeout(() => (diagRestartBtn.textContent = 'Restart workers'), 1200);
  });
  const diagElapsed = view.querySelector<HTMLElement>('[data-w="diagElapsed"]')!;
  const diagAttempts = view.querySelector<HTMLElement>('[data-w="diagAttempts"]')!;
  const diagAttemptHashes = view.querySelector<HTMLElement>('[data-w="diagAttemptHashes"]')!;
  const diagAttemptHashesSub = view.querySelector<HTMLElement>('[data-w="diagAttemptHashesSub"]')!;
  const diagPFound = view.querySelector<HTMLElement>('[data-w="diagPFound"]')!;
  const diagPFoundSub = view.querySelector<HTMLElement>('[data-w="diagPFoundSub"]')!;
  const diagAvgRate = view.querySelector<HTMLElement>('[data-w="diagAvgRate"]')!;
  const diagAvgRateSub = view.querySelector<HTMLElement>('[data-w="diagAvgRateSub"]')!;
  const diagOom = view.querySelector<HTMLElement>('[data-w="diagOom"]')!;
  const diagOomSub = view.querySelector<HTMLElement>('[data-w="diagOomSub"]')!;

  // Per-template baseline for the "hashes on this template" counter. The
  // session-spanning timing (start time + total hashes) lives in the controller
  // and is read off the status, so the session average uses a wall clock that
  // can't desync from the worker's hash counting while the tab is backgrounded.
  let attemptHashesBaseline = 0;
  let lastAttemptStartedAt: number | null = null;

  // Initial-state pickup from the controller (main.ts already restored
  // persisted values into the controller before any view mounted).
  {
    const s0 = node.miner.getStatus();
    autoMinInput.value = String(s0.autoMinThreads);
    autoMaxInput.value = String(s0.autoMaxThreads);
    autoCheck.checked = s0.mode === 'auto';
    applyAutoStateToUI(s0.mode === 'auto');
  }

  // "auto" checkbox toggles between the tuner (threads slider grayed +
  // bounds inputs visible) and manual mode (slider live, bounds hidden).
  function applyAutoStateToUI(isAuto: boolean): void {
    threadSlider.disabled = isAuto || maxThreads === 1;
    threadSlider.style.opacity = isAuto ? '0.5' : '';
    autoBounds.hidden = !isAuto;
  }

  autoCheck.addEventListener('change', () => {
    const isAuto = autoCheck.checked;
    localStorage.setItem(MODE_KEY, isAuto ? 'auto' : 'manual');
    node.miner.setControlMode({ mode: isAuto ? 'auto' : 'manual' });
    applyAutoStateToUI(isAuto);
  });

  autoMinInput.addEventListener('change', () => {
    const v = clampThreads(Number(autoMinInput.value), maxThreads);
    autoMinInput.value = String(v);
    localStorage.setItem(AUTO_MIN_KEY, String(v));
    node.miner.setControlMode({ autoMin: v });
  });
  autoMaxInput.addEventListener('change', () => {
    const v = clampThreads(Number(autoMaxInput.value), maxThreads);
    autoMaxInput.value = String(v);
    localStorage.setItem(AUTO_MAX_KEY, String(v));
    node.miner.setControlMode({ autoMax: v });
  });

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
    localStorage.setItem(THROTTLE_KEY, String(pct));
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
    // Session stats only need the blocks above the session's starting height —
    // the walk is bounded by session length, not chain length.
    for (const cb of node.chain.iterateCanonical()) {
      const h = cb.block.header;
      if (h.height <= startHeight) break;
      if (bytesToHex(h.miner) !== myAddr) continue;
      let fees = 0n;
      for (const tx of cb.block.transactions) fees += tx.fee;
      sessionBlocks++;
      sessionReward += blockReward(h.height) + fees;
    }
    // Lifetime comes from the incrementally-maintained activity index, which
    // covers the whole chain (no recent-window cap) without a rescan.
    return { blocks: sessionBlocks, reward: sessionReward, lifetime: node.activityIndex.minedTotal() };
  }

  function refreshDiagnostics(): void {
    const s = node.miner.getStatus();
    if (!s.running) {
      diagIdle.hidden = false;
      diagBody.hidden = true;
      attemptHashesBaseline = 0;
      return;
    }
    diagIdle.hidden = true;
    diagBody.hidden = false;
    const now = performance.now();
    // Snapshot session-total hashes on every fresh attempt so the per-attempt
    // counter resets to 0 when a block is mined and a new template starts.
    if (s.attemptStartedAt !== lastAttemptStartedAt) {
      lastAttemptStartedAt = s.attemptStartedAt;
      attemptHashesBaseline = s.totalHashes;
    }

    // Per-worker rows. A worker that hasn't reported in >10s gets a red
    // "stale" tag — that's the symptom of a dead grind loop. Newly-spawned
    // workers get a 4-second grace window so we don't flag them while
    // they're still warming up.
    const rates = s.workerHashrates;
    const lastAt = s.workerLastReportAt;
    const STALE_MS = 10_000;
    const WARMUP_MS = 4_000;
    const peak = Math.max(1, ...rates);
    let firstStaleIdx = -1;
    let staleAgeSec = 0;
    const rows: string[] = [];
    for (let i = 0; i < rates.length; i++) {
      const r = rates[i] ?? 0;
      const since = now - (lastAt[i] ?? now);
      const stale = since > STALE_MS && since > WARMUP_MS;
      if (stale && firstStaleIdx < 0) {
        firstStaleIdx = i;
        staleAgeSec = Math.round(since / 1000);
      }
      const pct = Math.max(2, Math.round((r / peak) * 100));
      const barColor = stale ? 'var(--red)' : (r > 0 ? 'var(--accent)' : 'var(--muted-2)');
      const label = `${formatHashNumber(r)} ${formatHashUnit(r)}`;
      const tag = stale ? `<span class="red mono text-sm">stale ${staleAgeSec}s</span>` : '';
      rows.push(`
        <div class="row" style="align-items:center; gap:10px;">
          <div class="mono text-sm" style="width:28px; ${stale ? 'color:var(--red);' : ''}">#${i + 1}</div>
          <div style="flex:1; height:6px; background:var(--surface-2); border-radius:3px; overflow:hidden;">
            <div style="height:100%; width:${pct}%; background:${barColor};"></div>
          </div>
          <div class="mono text-sm" style="width:90px; text-align:right; ${stale ? 'color:var(--red);' : ''}">${label}</div>
          <div style="width:80px; text-align:right;">${tag}</div>
        </div>`);
    }
    diagWorkers.innerHTML = rows.join('');

    // Source of truth for "what the worker is grinding right now" is the
    // template's recorded difficulty (set in MinerController.restartTemplate).
    // The previous version of this code re-ran nextDifficulty() with the
    // current wall clock, which was wrong: it showed what consensus *would*
    // give for a fresh template, not what the worker was actually doing.
    // With the controller's periodic-refresh fix, the two converge — but
    // using the template value directly is correct by construction.
    const templateDiff = s.currentDifficulty ?? 0;
    const target = templateDiff > 0 ? compactToTarget(templateDiff) : 0n;
    const expected = target > 0n ? (1n << 256n) / (target + 1n) : 0n;
    const expectedNum = Number(expected);
    const bits = target <= 0n ? 0 : 256 - target.toString(2).length;
    const elapsedMs = s.attemptStartedAt !== null ? now - s.attemptStartedAt : 0;
    const elapsedSec = elapsedMs / 1000;
    const attemptHashes = Math.max(0, s.totalHashes - attemptHashesBaseline);

    diagElapsed.textContent = elapsedSec > 0 ? formatDuration(Math.floor(elapsedSec)) : 'starting…';
    diagAttempts.textContent = `template #${s.attemptCount}, ${bits} bits`;
    diagAttemptHashes.textContent = formatBig(BigInt(Math.max(0, Math.floor(attemptHashes))));
    diagAttemptHashesSub.textContent =
      expected > 0n
        ? `template needs ~${formatBig(expected)} hashes on average`
        : `template needs — hashes`;

    let pFound = 0;
    if (expectedNum > 0 && attemptHashes > 0) {
      // Use total hashes vs expected — this is the cleanest "should I have
      // found one by now" metric, independent of current hashrate noise.
      pFound = 1 - Math.exp(-attemptHashes / expectedNum);
    }
    const pPct = pFound * 100;
    diagPFound.textContent = `${pPct < 1 ? pPct.toFixed(2) : pPct.toFixed(1)}%`;
    diagPFound.style.color = pFound > 0.95 ? 'var(--red)' : pFound > 0.5 ? 'var(--accent)' : '';
    if (pFound > 0.95) {
      diagPFoundSub.textContent = `unlucky — but PoW is memoryless, restarting doesn't help`;
    } else if (pFound > 0.5) {
      diagPFoundSub.textContent = `solid chance one was already due`;
    } else {
      diagPFoundSub.textContent = `under 95% is still normal-luck territory`;
    }

    // Wall-clock elapsed (Date.now), anchored in the controller at start(). Using
    // the wall clock rather than performance.now() keeps the denominator honest
    // when the tab is backgrounded on macOS — see MinerStatus.sessionStartedAt.
    const sessionElapsedSec = s.sessionStartedAt !== null
      ? Math.max(0, (Date.now() - s.sessionStartedAt) / 1000)
      : 0;
    const avg = sessionElapsedSec > 0 ? s.totalHashes / sessionElapsedSec : 0;
    diagAvgRate.textContent =
      `${formatHashNumber(avg)} ${formatHashUnit(avg)} / ${formatHashNumber(s.hashesPerSecond)} ${formatHashUnit(s.hashesPerSecond)}`;
    diagAvgRateSub.textContent =
      `session avg / live · ${formatBig(BigInt(Math.max(0, Math.floor(s.totalHashes))))} total hashes`;

    diagOom.textContent = String(s.oomCount);
    diagOom.style.color = s.oomCount > 0 ? 'var(--red)' : '';
    diagOomSub.textContent = s.oomCount > 0
      ? `${s.oomCount} Argon2id allocations rejected by the browser — workers retried and kept going`
      : `workers retry automatically; non-zero usually means too many threads`;

    // Count stale workers and surface oversubscription separately from a
    // single dead worker — Argon2id is memory-bandwidth bound, and 8+ stalls
    // out of 11 means the thread count is fighting itself rather than one
    // worker being unhappy.
    let staleCount = 0;
    for (let i = 0; i < rates.length; i++) {
      const since = now - (lastAt[i] ?? now);
      if (since > STALE_MS && since > WARMUP_MS) staleCount++;
    }

    // Soft-hint banner. Highest-severity first; only one shown at a time.
    let hint: { cls: string; html: string } | null = null;
    if (s.oomCount > 0) {
      const suggest = Math.max(2, Math.floor(rates.length / 2));
      hint = {
        cls: 'conn-strip bad',
        html: `<span class="dot"></span> Browser rejected ${s.oomCount} WebAssembly memory allocation${s.oomCount === 1 ? '' : 's'} — too many threads for your available RAM. Workers retried automatically, but <b>lowering the threads slider to ~${suggest}</b> will get you a higher effective hashrate.`,
      };
    } else if (staleCount >= 2 && staleCount >= rates.length / 2) {
      hint = {
        cls: 'conn-strip bad',
        html: `<span class="dot"></span> ${staleCount} of ${rates.length} workers stalled — likely too many threads for your memory bandwidth. The controller is auto-respawning them; <b>lowering the threads slider to ~${Math.max(2, Math.floor(rates.length / 2))}</b> usually mines faster on memory-bound PoW.`,
      };
    } else if (firstStaleIdx >= 0) {
      hint = {
        cls: 'conn-strip bad',
        html: `<span class="dot"></span> Worker #${firstStaleIdx + 1} hasn't reported in ${staleAgeSec}s — the controller will auto-respawn it. If this repeats, try <b>Restart workers</b> or lower the threads count.`,
      };
    } else if (pFound > 0.95 && expectedNum > 0 && s.hashesPerSecond > 0) {
      const meanSec = expectedNum / s.hashesPerSecond;
      if (elapsedSec > 3 * meanSec) {
        hint = {
          cls: 'conn-strip warn',
          html: `<span class="dot"></span> You'd normally have a block by now (${pPct.toFixed(1)}%). Could still be bad luck — worth a restart if it persists.`,
        };
      }
    } else if (sessionElapsedSec > 300 && s.hashesPerSecond > 0 && avg < 0.5 * s.hashesPerSecond) {
      // Note: this signature (avg ≪ live) means there were stretches of NOT
      // hashing at the current speed — it cannot be caused by stale templates
      // (hashes on a stale template still count toward the rate). The usual
      // causes are a backgrounded tab / sleeping laptop, or the user raising
      // threads/CPU mid-session, all of which are harmless after the fact.
      hint = {
        cls: 'conn-strip warn',
        html: `<span class="dot"></span> Session average is well below the live rate — usually the tab spent time in the background (or the laptop slept), or CPU/threads were raised mid-session. If the live rate looks right, nothing is being wasted now.`,
      };
    }
    if (hint) {
      diagBanner.className = hint.cls;
      diagBanner.innerHTML = hint.html;
      diagBanner.hidden = false;
    } else {
      diagBanner.hidden = true;
    }
  }

  function refresh(): void {
    const s = node.miner.getStatus();
    toggleBtn.textContent = s.running ? 'Stop mining' : 'Start mining';
    statusEl.textContent = s.running ? (s.currentHeight > 0 ? `mining block #${s.currentHeight}` : 'mining…') : 'idle';
    hero.classList.toggle('running', s.running);

    hashrateEl.innerHTML = `${formatHashNumber(s.hashesPerSecond)} <span class="hashrate-unit">${formatHashUnit(s.hashesPerSecond)}</span>`;

    blockEl.textContent = s.currentHeight > 0 ? `#${s.currentHeight}` : '—';
    txsEl.textContent = `${s.currentTxCount} ${s.currentTxCount === 1 ? 'tx' : 'txs'} included`;

    // When mining, show the difficulty of the template the worker is actually
    // grinding (truth). When idle, fall back to the freshly-computed difficulty
    // so the user can preview what they'd start at if they hit Start now.
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

    // Status line (only visible in auto mode — the autoBounds box is shown).
    if (s.mode === 'auto') {
      let detail: string;
      if (!s.running) {
        detail = `will start at Max (${s.autoMaxThreads}) when you Start mining`;
      } else if (s.autoLocked && s.workerCount > s.autoMinThreads) {
        detail = `settled at ${s.workerCount} after backing off from Max ${s.autoMaxThreads} (OOM). Raise Max if you want to retry`;
      } else if (s.autoLocked) {
        detail = `at Min ${s.autoMinThreads} after repeated OOM — lower Max or check memory`;
      } else if (s.workerCount >= s.autoMaxThreads) {
        detail = `running at Max (${s.workerCount}). Will drop on OOM`;
      } else {
        detail = `at ${s.workerCount} of [${s.autoMinThreads}–${s.autoMaxThreads}], holding`;
      }
      autoStatusEl.textContent = `Auto: ${detail}.`;
    }
    // Mirror controller state into the sliders so e.g. the auto-tuner moving
    // the thread count is visible, or a switch from elsewhere keeps us in
    // sync. Skip while the user is actively dragging — would fight input.
    if (document.activeElement !== slider) {
      slider.value = String(Math.round(s.throttle * 100));
      pctEl.textContent = `${Math.round(s.throttle * 100)}%`;
    }
    if (document.activeElement !== threadSlider) {
      threadSlider.value = String(s.workerCount);
      threadsEl.textContent = String(s.workerCount);
    }

    refreshDiagnostics();
  }

  // "Grinding" effect — flicker a fake nonce-progress string while mining.
  // Also bump the diagnostics "elapsed" reading every tick so it ticks
  // smoothly instead of in 3-second jumps with the rest of refresh().
  let diagTickAcc = 0;
  const tickerId = setInterval(() => {
    const s = node.miner.getStatus();
    if (!s.running || s.hashesPerSecond <= 0) {
      tickerEl.textContent = s.running ? '— warming up —' : '— waiting —';
    } else {
      tickerEl.textContent = `nonce 0x${randomHex(8)}  hash 0x${randomHex(12)}…`;
    }
    // ~1s cadence for the elapsed text — the other diag fields move slowly
    // and don't need the full 120ms refresh rate.
    diagTickAcc += 120;
    if (diagTickAcc >= 1000) {
      diagTickAcc = 0;
      if (s.running && s.attemptStartedAt !== null) {
        const sec = Math.floor((performance.now() - s.attemptStartedAt) / 1000);
        diagElapsed.textContent = sec > 0 ? formatDuration(sec) : 'starting…';
      }
    }
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

  let dismissing = false;
  const close = (): void => {
    dismissing = true;
    overlay.remove();
    openModal = null;
    unsubNet();
    unsubServer();
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

  // React to any change in connectivity while the modal is up: refresh the
  // peer-ID field, and — crucially — close the modal once we're no longer
  // fully offline. Without this, a connection that comes back on its own (a
  // peer dials in, or the bootstrap server returns) leaves the stale "you're
  // offline" dialog stuck on screen. We watch both network and server status
  // since either path counts as being back online. `dismissing` guards against
  // re-entrancy from the successful-dial flow, which closes itself.
  const onConnChange = (): void => {
    renderId();
    if (!dismissing && !isMiningOffline(node)) close();
  };
  renderId();
  const unsubNet = node.network?.onStatus(onConnChange) ?? (() => {});
  const unsubServer = node.serverSync?.onStatus(onConnChange) ?? (() => {});

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
        // Suppress the connectivity-driven auto-close so the success state
        // stays visible for the brief pause below, then close ourselves —
        // they're back online, the modal has served its purpose.
        dismissing = true;
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
function clampPct(raw: string | null): number {
  if (raw === null) return 100;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(100, Math.round(n)));
}
export function formatHashNumber(h: number): string {
  if (h < 1000) return h.toFixed(0);
  if (h < 1e6) return (h / 1e3).toFixed(2);
  return (h / 1e6).toFixed(2);
}
export function formatHashUnit(h: number): string {
  if (h < 1000) return 'H/s';
  if (h < 1e6) return 'kH/s';
  return 'MH/s';
}
