import { encodeHeader, type Block } from './block.js';
import { compactToTarget } from '../util/binary.js';

/**
 * Pool of Web Workers that run Argon2id PoW verification in parallel. Used by
 * ServerSync (and any other bulk-block path) to fan a list of blocks across
 * cores while the main thread stays free.
 *
 * Single-block verification (e.g. P2P relay) skips this and stays on the main
 * thread — round-tripping a single header through a worker isn't worth it.
 */

type PendingResolve = (ok: boolean) => void;

interface Job {
  block: Block;
  resolve: PendingResolve;
  /** Dispatch attempts so far — see MAX_ATTEMPTS. */
  attempts: number;
}

interface InFlight {
  id: number;
  job: Job;
  timer: ReturnType<typeof setTimeout>;
}

export class VerifierPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job[] = [];
  /** One in-flight job per busy worker. */
  private busy = new Map<Worker, InFlight>();
  private nextId = 1;
  private size: number;
  private started = false;

  /**
   * A worker that hasn't answered in this long is presumed wedged: retire it,
   * respawn, and re-dispatch its job to another worker. Argon2id verification
   * is ~40-125 ms uncontended and seconds under heavy mining contention, so a
   * minute of silence is a genuine stall, not slowness. Without this, one
   * browser-killed worker left its promise unsettled forever — hanging every
   * verifyAll() that included it (which froze history backfill at 0%).
   */
  private static readonly JOB_TIMEOUT_MS = 60_000;
  /**
   * How many times a job is dispatched before the pool gives up and resolves
   * `false`. Retries cover transient failures (a WASM allocation rejected
   * under memory pressure, a worker crash); three attempts across respawned
   * workers make it overwhelmingly likely a persistent `false` is a real
   * verdict rather than an environmental hiccup.
   */
  private static readonly MAX_ATTEMPTS = 3;

  constructor(size: number) {
    this.size = clampCores(size);
  }

  private spawnWorker(): Worker {
    const w = new Worker(new URL('./verifier.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; ok?: boolean; err?: true }>) => {
      const entry = this.busy.get(w);
      if (entry && entry.id === e.data.id) {
        clearTimeout(entry.timer);
        this.busy.delete(w);
        if (e.data.err) this.retryOrFail(entry.job); // couldn't verify — not a verdict
        else entry.job.resolve(e.data.ok === true);
      }
      this.releaseWorker(w);
    };
    // A worker that dies hard (browser OOM-kill, script error) never posts a
    // result — reclaim its job and replace it instead of hanging the batch.
    w.onerror = () => this.failWorker(w);
    this.workers.push(w);
    return w;
  }

  /** Retire a wedged/dead worker, requeue its job, and backfill the pool. */
  private failWorker(w: Worker): void {
    console.warn('[verifierPool] worker failed or stalled — retiring it and retrying its job');
    const entry = this.busy.get(w);
    if (entry) {
      clearTimeout(entry.timer);
      this.busy.delete(w);
    }
    this.retire(w);
    if (entry) this.retryOrFail(entry.job);
    if (this.started && this.workers.length < this.size) {
      this.releaseWorker(this.spawnWorker()); // picks up queued work immediately
    }
  }

  private retryOrFail(job: Job): void {
    if (job.attempts >= VerifierPool.MAX_ATTEMPTS) {
      job.resolve(false);
      return;
    }
    this.queue.push(job);
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.size; i++) {
      this.idle.push(this.spawnWorker());
    }
  }

  /**
   * Change how many cores this pool uses, applied live. Growing spawns workers
   * immediately; shrinking retires idle workers now and busy ones as they
   * finish, so an in-flight batch never loses results. Safe to call before the
   * pool has started — it just records the new size for the first dispatch.
   */
  setSize(size: number): void {
    this.size = clampCores(size);
    if (!this.started) return;
    // Grow: spin up new workers and let them pick up queued work (or idle).
    while (this.workers.length < this.size) {
      this.releaseWorker(this.spawnWorker());
    }
    // Shrink: drop idle workers now. Busy ones retire themselves on release.
    while (this.workers.length > this.size && this.idle.length > 0) {
      this.retire(this.idle.pop()!);
    }
  }

  private retire(w: Worker): void {
    w.terminate();
    const wi = this.workers.indexOf(w);
    if (wi >= 0) this.workers.splice(wi, 1);
    const ii = this.idle.indexOf(w);
    if (ii >= 0) this.idle.splice(ii, 1);
  }

  private releaseWorker(w: Worker): void {
    if (!this.workers.includes(w)) return; // already retired (failWorker raced a late message)
    const next = this.queue.shift();
    if (next) {
      this.dispatch(w, next);
    } else if (this.workers.length > this.size) {
      // Pool was downsized while this worker was busy; retire it now that the
      // queue is drained rather than parking it back in the idle set.
      this.retire(w);
    } else {
      this.idle.push(w);
    }
  }

  private dispatch(w: Worker, job: Job): void {
    const id = this.nextId++;
    job.attempts++;
    const timer = setTimeout(() => this.failWorker(w), VerifierPool.JOB_TIMEOUT_MS);
    this.busy.set(w, { id, job, timer });
    const target = compactToTarget(job.block.header.difficulty);
    const targetHex = target.toString(16).padStart(64, '0');
    w.postMessage({ id, headerBytes: encodeHeader(job.block.header), targetHex });
  }

  /** Verify one block's PoW off-thread. */
  verify(block: Block): Promise<boolean> {
    this.ensureStarted();
    return new Promise<boolean>((resolve) => {
      const job: Job = { block, resolve, attempts: 0 };
      const w = this.idle.pop();
      if (w) this.dispatch(w, job);
      else this.queue.push(job);
    });
  }

  /**
   * Verify a batch in parallel, returning results in the same order. Resolves
   * as soon as all blocks are verified — caller can then iterate in-order
   * and apply state-dependent checks.
   */
  verifyAll(blocks: Block[]): Promise<boolean[]> {
    return Promise.all(blocks.map((b) => this.verify(b)));
  }

  /** Tear down workers. Tests + page-close. */
  terminate(): void {
    for (const entry of this.busy.values()) clearTimeout(entry.timer);
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.busy.clear();
    this.started = false;
  }
}

/** localStorage key holding the user's chosen verifier core count. */
export const VERIFY_CORES_KEY = 'browsercoin:verify-cores';

/** Hardware thread count, with a safe fallback when it's unavailable. */
export function maxVerifierCores(): number {
  return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
}

/** Clamp a requested core count to a sane [1, hardware] range. */
function clampCores(n: number): number {
  const max = maxVerifierCores();
  if (!Number.isFinite(n)) return Math.min(4, max);
  return Math.max(1, Math.min(max, Math.floor(n)));
}

/**
 * How many cores to verify with. Reads the user's persisted choice; first-time
 * users default to 4 (or fewer on smaller machines). Each Argon2id worker holds
 * ~32 MB while busy, so the default keeps a fresh tab well under ~128 MB while
 * still parallelising bulk sync; power users can raise it up to all cores in
 * Settings.
 */
export function configuredVerifierCores(): number {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VERIFY_CORES_KEY) : null;
  if (raw === null) return Math.min(4, maxVerifierCores());
  return clampCores(Number(raw));
}
