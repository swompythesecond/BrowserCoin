import type { Blockchain } from '../chain/blockchain.js';
import { computeTxRoot, encodeHeader, type Block, type BlockHeader } from '../chain/block.js';
import { nextDifficulty } from '../chain/consensus.js';
import { DIFFICULTY_WINDOW, MAX_BLOCK_BYTES, MTP_WINDOW } from '../chain/genesis.js';
import type { Mempool } from '../chain/mempool.js';
import { applyBlockTxs, cloneState, stateRoot } from '../chain/state.js';
import { compactToTarget } from '../util/binary.js';
import { bytesToHex } from '../util/binary.js';
import type { PublicKey } from '../crypto/keys.js';

export type ControlMode = 'auto' | 'manual';
export type PowerLevel = 'low' | 'medium' | 'high';

/** Map a power-preset level to the CPU-throttle fraction it applies. */
export function powerThrottle(p: PowerLevel): number {
  return p === 'low' ? 0.25 : p === 'medium' ? 0.6 : 1.0;
}

export interface MinerStatus {
  running: boolean;
  hashesPerSecond: number;
  currentHeight: number;
  currentTxCount: number;
  /**
   * Compact difficulty of the template the workers are currently grinding.
   * `null` while idle. This is the source of truth for "how hard is the
   * block I'm mining right now" — UI should NOT derive this from a fresh
   * `nextDifficulty()` call, because that returns what the rules would
   * give *if a new template were built right now*, which can disagree
   * with what the workers are actually doing until the next refresh.
   */
  currentDifficulty: number | null;
  throttle: number; // 0..1
  workerCount: number;
  /** High-level control mode. In 'auto', the threads-tuner runs and CPU% is
   *  driven by `powerLevel`. In 'manual', `throttle` and `workerCount` are
   *  fully user-controlled and the tuner is paused. */
  mode: ControlMode;
  /** Active power preset. Only meaningful when `mode === 'auto'`. */
  powerLevel: PowerLevel;
  /** Auto-tuner thread bounds. Tuner stays within [autoMin, autoMax]. */
  autoMinThreads: number;
  autoMaxThreads: number;
  /** True once the auto-tuner has hit an OOM event and pinned threads. It
   *  stops probing upward for the rest of the session; clears on Stop or
   *  on a mode change. */
  autoLocked: boolean;
  /** Per-worker last-reported H/s. Length matches `workerCount`. */
  workerHashrates: number[];
  /** `performance.now()` of each worker's last hashrate report. A worker
   *  whose entry is older than ~10s without an explanation is probably
   *  stalled. */
  workerLastReportAt: number[];
  /** Hashes computed since `start()` (sum of `deltaHashes` from workers). */
  totalHashes: number;
  /**
   * Wall-clock (`Date.now()`) epoch ms when the current session started, i.e.
   * the moment of the `start()` that zeroed `totalHashes`. `null` while idle.
   *
   * The session average is `totalHashes / ((Date.now() - sessionStartedAt)/1000)`.
   * It MUST use the wall clock, not `performance.now()`: a backgrounded tab on
   * macOS (App Nap) can freeze the main thread's `performance.now()` while the
   * worker keeps doing — and reporting — real hashes. Measuring elapsed with the
   * monotonic clock then understates real time and the average spikes far above
   * the physical hashrate. Wall-clock elapsed always tracks true elapsed time,
   * so total/elapsed can never exceed what the machine actually did.
   */
  sessionStartedAt: number | null;
  /** `performance.now()` when the current template started grinding. Null
   *  while idle. */
  attemptStartedAt: number | null;
  /** Number of `restartTemplate()` calls since `start()` — surfaces tip
   *  thrashing in the UI. */
  attemptCount: number;
  /** Count of WebAssembly OOM events reported by workers since `start()`.
   *  Each is a single Argon2id allocation rejection — the worker retried
   *  and kept going, but a non-zero count is a strong signal the user has
   *  too many threads for their available WASM memory. */
  oomCount: number;
  /** Last reason start() refused. Cleared on a successful start. */
  blockedReason?: string;
}

type WorkerSolved = { type: 'solved'; nonce: number; hash: Uint8Array };
type WorkerHashrate = { type: 'hashrate'; hashesPerSecond: number; deltaHashes: number };
type WorkerExhausted = { type: 'exhausted' };
type WorkerOom = { type: 'oom' };
type WorkerOut = WorkerSolved | WorkerHashrate | WorkerExhausted | WorkerOom;

export function maxMinerWorkers(): number {
  return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
}

/**
 * Owns the mining Web Workers and the lifecycle of "build template → grind → on solve, add block".
 *
 * On each new chain tip (or new mempool contents), the controller rebuilds a fresh block
 * template and restarts every worker. Throttle slider (0..1) controls a duty cycle inside
 * each worker so the user can give back CPU to the browser. Workers split the 32-bit
 * nonce space by getting offset starting nonces, so the first 2^32 / N hashes have no
 * overlap.
 */
export class MinerController {
  private workers: Worker[] = [];
  private workerHashrates: number[] = [];
  private workerLastReportAt: number[] = [];
  private status: MinerStatus = {
    running: false,
    hashesPerSecond: 0,
    currentHeight: 0,
    currentTxCount: 0,
    currentDifficulty: null,
    throttle: 1,
    workerCount: 1,
    workerHashrates: [],
    workerLastReportAt: [],
    totalHashes: 0,
    sessionStartedAt: null,
    attemptStartedAt: null,
    attemptCount: 0,
    oomCount: 0,
    mode: 'auto',
    powerLevel: 'medium',
    autoMinThreads: 1,
    autoMaxThreads: maxMinerWorkers(),
    autoLocked: false,
  };

  // Auto-tuner state. Lives outside MinerStatus because the UI never needs
  // these directly — only the resulting `workerCount` and `autoLocked`.
  private lastProbeAt = 0;
  private oomCountAtLastProbe = 0;
  // 10s is short enough to feel interactive — the user sees the thread count
  // climb every 10s after enabling auto — and the new argon2id lib makes
  // per-probe OOM detection a non-issue, so we don't need the long
  // observation window the old hash-wasm path required.
  private static readonly PROBE_INTERVAL_MS = 10_000;
  private statusListeners = new Set<(s: MinerStatus) => void>();
  private currentTemplate: { block: Block } | null = null;

  /**
   * Optional gate: if set and returns a string, `start()` refuses with that
   * reason. Used by Node to block mining while the chain is still syncing —
   * mining on a stale tip just produces orphans.
   */
  private canStart: (() => string | null) | null = null;

  /** Background tick that keeps `hashesPerSecond` honest while workers report
   *  independently, and auto-respawns workers that have gone silent. */
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  /** A worker counts as stalled (and gets respawned) after this many ms with
   *  no hashrate report. Argon2id at 32 MB / 1 iter takes ~40-125 ms, so 30 s
   *  is roughly 250x the expected per-hash latency — only a true stall hits
   *  this. */
  private static readonly STALE_RESPAWN_MS = 30_000;
  /**
   * The live `hashesPerSecond` is actual hashes completed over this rolling
   * window. It used to be the SUM of each worker's last self-reported burst
   * rate, which badly overstated under memory-bandwidth thrash: with far more
   * workers than the memory bus supports (Argon2id wants ~32 MB each), workers
   * alternate short bursts and long stalls, and summing "most recent burst
   * rate" counts stalled workers as if they were still hashing — one user saw
   * live 640 H/s while the machine truly did ~150. Counting completed hashes
   * over a window cannot be fooled by duty-cycling.
   */
  private static readonly RATE_WINDOW_MS = 10_000;
  /** deltaHashes reports inside the rolling window (time-ascending). */
  private recentHashEvents: Array<{ t: number; hashes: number }> = [];
  /** performance.now() at session start — denominator floor while the window fills. */
  private rateWindowAnchor = 0;

  constructor(
    private chain: Blockchain,
    private mempool: Mempool,
    private minerAddress: PublicKey,
    /** Called by the controller whenever we successfully mine a block. */
    private onBlockMined: (b: Block) => void,
  ) {}

  setStartGate(fn: (() => string | null) | null): void {
    this.canStart = fn;
  }

  setMinerAddress(pk: PublicKey): void {
    this.minerAddress = pk;
    if (this.status.running) this.restartTemplate();
  }

  setThrottle(t: number): void {
    this.status.throttle = Math.max(0, Math.min(1, t));
    this.emit();
    if (this.status.running) this.restartTemplate();
  }

  setWorkerCount(n: number): void {
    const clamped = Math.max(1, Math.min(maxMinerWorkers(), Math.floor(n)));
    if (clamped === this.status.workerCount) return;
    this.status.workerCount = clamped;
    this.emit();
    if (this.status.running) {
      this.spawnWorkers();
      this.restartTemplate();
    }
  }

  /** High-level "what does the user want?" API. Applies a coherent set of
   *  mode + power-preset + bounds; internally calls setThrottle /
   *  setWorkerCount with derived values so the existing low-level paths
   *  are unchanged. The /mine view binds its mode-toggle + presets +
   *  Advanced fields through this; manual-mode sliders still call the
   *  raw setThrottle / setWorkerCount setters. */
  setControlMode(opts: {
    mode?: ControlMode;
    powerLevel?: PowerLevel;
    autoMin?: number;
    autoMax?: number;
  }): void {
    const max = maxMinerWorkers();
    const transitionedToAuto = opts.mode === 'auto' && this.status.mode !== 'auto';
    if (opts.mode !== undefined) {
      if (opts.mode !== this.status.mode) {
        this.status.mode = opts.mode;
        this.status.autoLocked = false; // fresh start on mode change
        this.lastProbeAt = 0; // probe again soon after mode change
      }
    }
    if (opts.powerLevel !== undefined) {
      this.status.powerLevel = opts.powerLevel;
      if (this.status.mode === 'auto') {
        this.setThrottle(powerThrottle(opts.powerLevel));
      }
    }
    if (opts.autoMin !== undefined) {
      this.status.autoMinThreads = Math.max(1, Math.min(max, Math.floor(opts.autoMin)));
    }
    if (opts.autoMax !== undefined) {
      this.status.autoMaxThreads = Math.max(1, Math.min(max, Math.floor(opts.autoMax)));
    }
    // Keep min<=max sane.
    if (this.status.autoMinThreads > this.status.autoMaxThreads) {
      this.status.autoMinThreads = this.status.autoMaxThreads;
    }
    // When the user *just toggled into* auto, snap straight to autoMax —
    // the goal is to use as much of the machine as it can handle. The
    // tuner then drops -1 per probe interval on OOM until it stabilises,
    // and locks (no probing back up) so we don't oscillate. With the new
    // argon2id lib OOMs are rare, so most machines just hold at the
    // ceiling.
    //
    // If auto was already on and only the bounds changed, just clamp the
    // current value into the new range without forcing the ceiling.
    if (this.status.mode === 'auto') {
      if (transitionedToAuto) {
        this.setWorkerCount(this.status.autoMaxThreads);
      } else if (this.status.workerCount < this.status.autoMinThreads) {
        this.setWorkerCount(this.status.autoMinThreads);
      } else if (this.status.workerCount > this.status.autoMaxThreads) {
        this.setWorkerCount(this.status.autoMaxThreads);
      }
    }
    this.emit();
  }

  start(): void {
    if (this.status.running) return;
    const reason = this.canStart?.();
    if (reason) {
      this.status.blockedReason = reason;
      this.emit();
      return;
    }
    this.status.blockedReason = undefined;
    this.status.running = true;
    this.status.totalHashes = 0;
    this.recentHashEvents = [];
    this.rateWindowAnchor = performance.now();
    this.status.sessionStartedAt = Date.now();
    this.status.attemptCount = 0;
    this.status.attemptStartedAt = null;
    this.status.oomCount = 0;
    this.status.autoLocked = false;
    this.lastProbeAt = 0;
    this.oomCountAtLastProbe = 0;
    // In auto mode, snap workerCount to the lower bound on start — the tuner
    // will probe up from there.
    if (this.status.mode === 'auto' && this.status.workerCount > this.status.autoMaxThreads) {
      this.status.workerCount = this.status.autoMaxThreads;
    }
    if (this.status.mode === 'auto' && this.status.workerCount < this.status.autoMinThreads) {
      this.status.workerCount = this.status.autoMinThreads;
    }
    this.spawnWorkers();
    this.restartTemplate();
    this.startHealthTimer();
    this.emit();
  }

  stop(): void {
    this.status.running = false;
    this.stopHealthTimer();
    this.terminateWorkers();
    this.recentHashEvents = [];
    this.status.hashesPerSecond = 0;
    this.status.sessionStartedAt = null;
    this.status.attemptStartedAt = null;
    this.status.currentDifficulty = null;
    this.status.workerHashrates = [];
    this.status.workerLastReportAt = [];
    this.currentTemplate = null;
    this.emit();
  }

  /** Kill every worker and respawn them at the current count. The user hits
   *  this via the "Restart workers" diagnostics button when something looks
   *  wrong but they don't want to fully Stop + Start (which would also clear
   *  the session counters). Internally also used by the auto-respawn path. */
  restartWorkers(): void {
    if (!this.status.running) return;
    this.spawnWorkers();
    this.restartTemplate();
  }

  /** Call when the chain tip or mempool changes — rebuilds the template against fresh state. */
  refresh(): void {
    if (this.status.running) this.restartTemplate();
  }

  getStatus(): MinerStatus {
    return { ...this.status };
  }

  onStatus(fn: (s: MinerStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private emit(): void {
    const snap = this.getStatus();
    for (const fn of this.statusListeners) fn(snap);
  }

  /**
   * Live hashrate = hashes actually completed in the last RATE_WINDOW_MS,
   * divided by the window. Because it integrates real completed work (the same
   * `deltaHashes` stream `totalHashes` uses), it stays honest when
   * oversubscribed workers duty-cycle between bursts and stalls — unlike the
   * old sum-of-last-burst-rates, which counted stalled workers at full speed
   * for up to 10 s after their last report. Called on every worker report and
   * once per health tick, so the number also decays to 0 when reports stop.
   */
  private recomputeHashrate(now: number): void {
    const cutoff = now - MinerController.RATE_WINDOW_MS;
    let drop = 0;
    while (drop < this.recentHashEvents.length && this.recentHashEvents[drop]!.t < cutoff) drop++;
    if (drop > 0) this.recentHashEvents.splice(0, drop);
    let hashes = 0;
    for (const e of this.recentHashEvents) hashes += e.hashes;
    // While the window is still filling after start(), divide by the time
    // actually observed so the first seconds aren't understated; floor at 1 s
    // so the very first report can't print a spike.
    const observedMs = Math.max(
      1000,
      Math.min(MinerController.RATE_WINDOW_MS, now - this.rateWindowAnchor),
    );
    this.status.hashesPerSecond = (hashes * 1000) / observedMs;
  }

  /** Replace a single worker in place — used when one has gone silent so we
   *  don't have to nuke healthy siblings. The replacement gets handed the
   *  current template via `restartTemplate()`. */
  private respawnWorker(idx: number): void {
    if (idx < 0 || idx >= this.workers.length) return;
    const old = this.workers[idx]!;
    try { old.postMessage({ type: 'stop' }); } catch { /* worker already gone */ }
    old.terminate();
    const fresh = new Worker(
      new URL('./miner.worker.ts', import.meta.url),
      { type: 'module' },
    );
    fresh.onmessage = (e: MessageEvent<WorkerOut>) => this.onWorker(idx, e.data);
    this.workers[idx] = fresh;
    const now = performance.now();
    this.workerHashrates[idx] = 0;
    this.workerLastReportAt[idx] = now;
    this.status.workerHashrates = this.workerHashrates.slice();
    this.status.workerLastReportAt = this.workerLastReportAt.slice();
    this.restartTemplate();
  }

  private startHealthTimer(): void {
    if (this.healthTimer !== null) return;
    this.healthTimer = setInterval(() => {
      if (!this.status.running) return;
      const now = performance.now();
      // 1. Refresh the live hashrate so stale rates fall off even when no
      //    worker is reporting.
      this.recomputeHashrate(now);
      // 2. Auto-respawn any worker that's been silent past the threshold.
      //    Argon2id is memory-bandwidth bound, so 11+ workers on a typical
      //    laptop can deadlock a chunk of them — surgically replacing the
      //    dead ones avoids disrupting the live ones.
      for (let i = 0; i < this.workers.length; i++) {
        const age = now - (this.workerLastReportAt[i] ?? now);
        if (age > MinerController.STALE_RESPAWN_MS) {
          console.warn(`[miner] worker #${i + 1} silent for ${Math.round(age / 1000)}s — respawning`);
          this.respawnWorker(i);
        }
      }
      // 3. Auto-tune thread count in auto mode — back off on OOM, probe up
      //    when there's headroom.
      this.autoTune(now);
      // 4. Re-template if the live difficulty has moved off what we're
      //    grinding. The template's timestamp is fixed at build time, but
      //    consensus rules (in particular the emergency drop) can change
      //    the valid difficulty as wall clock advances past the parent.
      //    Without this check the worker would keep grinding the old
      //    pre-stall difficulty for hours even after the rules eased.
      this.refreshTemplateIfDifficultyChanged();
      this.emit();
    }, 1000);
  }

  private refreshTemplateIfDifficultyChanged(): void {
    if (!this.currentTemplate) return;
    const parent = this.chain.tip.block.header;
    const recent = this.chain.getRecentHeaders(DIFFICULTY_WINDOW + MTP_WINDOW - 1);
    const liveDiff = nextDifficulty(
      parent.height + 1,
      recent,
      Math.floor(Date.now() / 1000),
    );
    if (liveDiff !== this.currentTemplate.block.header.difficulty) {
      this.restartTemplate();
    }
  }

  /** Auto-mode threads tuner. Runs once per probe interval (~30s) when the
   *  health timer fires and mode is 'auto'. Conservative hill-climber: any
   *  new OOM since the last probe drops us by one and pins the count
   *  (`autoLocked`); zero OOMs probes upward by one, capped by autoMax. */
  private autoTune(now: number): void {
    if (this.status.mode !== 'auto') return;
    if (this.lastProbeAt === 0) {
      // Warm-up: capture the baseline counters but don't probe yet.
      this.lastProbeAt = now;
      this.oomCountAtLastProbe = this.status.oomCount;
      return;
    }
    if (now - this.lastProbeAt < MinerController.PROBE_INTERVAL_MS) return;

    const oomDelta = this.status.oomCount - this.oomCountAtLastProbe;
    this.lastProbeAt = now;
    this.oomCountAtLastProbe = this.status.oomCount;

    if (oomDelta > 0) {
      const next = Math.max(this.status.autoMinThreads, this.status.workerCount - 1);
      if (next !== this.status.workerCount) {
        console.log(`[miner] auto-tune: ${oomDelta} OOM(s) — dropping threads ${this.status.workerCount} → ${next}, locking`);
        this.status.autoLocked = true;
        this.setWorkerCount(next);
      } else {
        // Already at minimum and still OOMing; lock anyway and let the user
        // know via diagnostics.
        this.status.autoLocked = true;
      }
      return;
    }
    if (this.status.autoLocked) return;
    if (this.status.workerCount < this.status.autoMaxThreads) {
      const next = this.status.workerCount + 1;
      console.log(`[miner] auto-tune: no OOM, probing up ${this.status.workerCount} → ${next}`);
      this.setWorkerCount(next);
    }
    // Else: at max and happy — hold.
  }

  private stopHealthTimer(): void {
    if (this.healthTimer === null) return;
    clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private spawnWorkers(): void {
    this.terminateWorkers();
    const now = performance.now();
    for (let i = 0; i < this.status.workerCount; i++) {
      const idx = i;
      const w = new Worker(
        new URL('./miner.worker.ts', import.meta.url),
        { type: 'module' },
      );
      w.onmessage = (e: MessageEvent<WorkerOut>) => this.onWorker(idx, e.data);
      // Without these, a worker that fails to load its module dies SILENTLY —
      // no hashing, no error. Surface it (fires only on an actual failure).
      w.onerror = (e) => console.error(`[miner] worker ${idx} failed to load/run:`, e.message, e.filename, e.lineno);
      w.onmessageerror = (e) => console.error(`[miner] worker ${idx} messageerror:`, e);
      this.workers.push(w);
    }
    this.workerHashrates = new Array(this.workers.length).fill(0);
    this.workerLastReportAt = new Array(this.workers.length).fill(now);
    this.status.workerHashrates = this.workerHashrates.slice();
    this.status.workerLastReportAt = this.workerLastReportAt.slice();
  }

  private terminateWorkers(): void {
    for (const w of this.workers) {
      try { w.postMessage({ type: 'stop' }); } catch { /* worker already gone */ }
      w.terminate();
    }
    this.workers = [];
    this.workerHashrates = [];
    this.workerLastReportAt = [];
  }

  private onWorker(idx: number, msg: WorkerOut): void {
    if (msg.type === 'hashrate') {
      if (idx < this.workerHashrates.length) {
        const now = performance.now();
        this.workerHashrates[idx] = msg.hashesPerSecond;
        this.workerLastReportAt[idx] = now;
        this.status.totalHashes += msg.deltaHashes;
        this.recentHashEvents.push({ t: now, hashes: msg.deltaHashes });
        this.recomputeHashrate(now);
        this.status.workerHashrates = this.workerHashrates.slice();
        this.status.workerLastReportAt = this.workerLastReportAt.slice();
        this.emit();
      }
      return;
    }
    if (msg.type === 'oom') {
      // Worker is alive but bouncing off the browser's WebAssembly memory
      // ceiling. Count it and refresh `lastReportAt` so the auto-respawn
      // doesn't fire (the worker is going to retry — terminating it would
      // just waste the partial work it's done).
      if (idx < this.workerLastReportAt.length) {
        this.workerLastReportAt[idx] = performance.now();
        this.status.workerLastReportAt = this.workerLastReportAt.slice();
      }
      this.status.oomCount++;
      this.emit();
      return;
    }
    if (msg.type === 'exhausted') {
      // Nonce space exhausted with no solution — rebuild with a new timestamp.
      this.restartTemplate();
      return;
    }
    if (msg.type === 'solved') {
      // Halt every worker immediately so a second worker can't also report a
      // solution for the same template (which would be a competing block at
      // the same height). restartTemplate() will re-issue `start` after the
      // tip moves.
      for (const w of this.workers) w.postMessage({ type: 'stop' });
      const template = this.currentTemplate;
      if (!template) return;
      const solved: Block = {
        header: { ...template.block.header, nonce: msg.nonce },
        transactions: template.block.transactions,
      };
      this.onBlockMined(solved);
      // Caller will refresh() the controller after the tip moves.
    }
  }

  /**
   * Build a fresh block template from the current chain tip + mempool, then
   * hand it to the worker to grind.
   */
  private restartTemplate(): void {
    if (this.workers.length === 0) return;

    const parent = this.chain.tip.block.header;
    const height = parent.height + 1;
    const recent = this.chain.getRecentHeaders(DIFFICULTY_WINDOW + MTP_WINDOW - 1);
    const timestamp = Math.floor(Date.now() / 1000);
    const difficulty = nextDifficulty(height, recent, timestamp);

    // Reserve a safety margin under the block-size cap.
    const budget = MAX_BLOCK_BYTES - 1024;
    const scriptCtx = this.chain.nextBlockScriptContext();
    let txs = this.mempool.selectForBlock(this.chain.tipState, budget, { ...scriptCtx, blockHeight: height });

    // Surface the "pool full but blocks empty" class of bug instead of letting
    // it pass silently — if we have pending txs but selected none, every
    // candidate had a nonce gap / failed selection against the current tip.
    if (txs.length === 0 && this.mempool.size() > 0) {
      console.warn(
        `[miner] template has 0 txs but mempool holds ${this.mempool.size()} ` +
          '— all pending txs are nonce-gapped or unminable against the current tip',
      );
    }

    // Simulate apply against tip state to derive stateRoot.
    let sim = cloneState(this.chain.tipState);
    let err = applyBlockTxs(sim, height, this.minerAddress, txs, scriptCtx);
    if (err) {
      // selectForBlock is balance- and nonce-aware, so a selected set should
      // always apply. If an edge case ever slips through, mine an empty block
      // rather than blank the template — a null template silently stops this
      // node from producing ANY blocks, which is far worse than skipping a few txs.
      console.warn(`[miner] selected txs failed to apply (${err}) — falling back to an empty block`);
      txs = [];
      sim = cloneState(this.chain.tipState);
      err = applyBlockTxs(sim, height, this.minerAddress, txs, scriptCtx); // empty set always applies
      if (err) {
        this.currentTemplate = null;
        return;
      }
    }
    const sRoot = stateRoot(sim);
    const tRoot = computeTxRoot(txs);

    const header: BlockHeader = {
      height,
      prevHash: this.chain.tip.hash,
      txRoot: tRoot,
      stateRoot: sRoot,
      timestamp,
      difficulty,
      nonce: 0,
      miner: this.minerAddress,
    };
    this.currentTemplate = { block: { header, transactions: txs } };
    this.status.currentHeight = height;
    this.status.currentTxCount = txs.length;
    this.status.currentDifficulty = difficulty;
    this.status.attemptStartedAt = performance.now();
    this.status.attemptCount++;
    this.emit();

    const target = compactToTarget(difficulty);
    const targetHex = target.toString(16).padStart(64, '0');
    const headerBytes = encodeHeader(header);

    // Spread each worker's startNonce evenly across the 32-bit nonce space so
    // the first 2^32 / N hashes have no overlap between workers.
    const span = 0x1_0000_0000;
    const slice = Math.floor(span / this.workers.length);
    const base = Math.floor(Math.random() * 0xffff_ffff);
    for (let i = 0; i < this.workers.length; i++) {
      const w = this.workers[i]!;
      w.postMessage({ type: 'stop' });
      w.postMessage({
        type: 'start',
        headerBytes,
        targetHex,
        startNonce: (base + i * slice) >>> 0,
        throttle: this.status.throttle,
      });
    }

    void bytesToHex; // keep import for future stats
  }
}
