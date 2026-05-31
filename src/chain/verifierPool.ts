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

interface Pending {
  id: number;
  resolve: PendingResolve;
}

export class VerifierPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Array<{ block: Block; resolve: PendingResolve }> = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private size: number;
  private started = false;

  constructor(size: number) {
    this.size = clampCores(size);
  }

  private spawnWorker(): Worker {
    const w = new Worker(new URL('./verifier.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; ok: boolean }>) => {
      const p = this.pending.get(e.data.id);
      if (p) {
        this.pending.delete(e.data.id);
        p.resolve(e.data.ok);
      }
      this.releaseWorker(w);
    };
    this.workers.push(w);
    return w;
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
    const next = this.queue.shift();
    if (next) {
      this.dispatch(w, next.block, next.resolve);
    } else if (this.workers.length > this.size) {
      // Pool was downsized while this worker was busy; retire it now that the
      // queue is drained rather than parking it back in the idle set.
      this.retire(w);
    } else {
      this.idle.push(w);
    }
  }

  private dispatch(w: Worker, block: Block, resolve: PendingResolve): void {
    const id = this.nextId++;
    this.pending.set(id, { id, resolve });
    const target = compactToTarget(block.header.difficulty);
    const targetHex = target.toString(16).padStart(64, '0');
    w.postMessage({ id, headerBytes: encodeHeader(block.header), targetHex });
  }

  /** Verify one block's PoW off-thread. */
  verify(block: Block): Promise<boolean> {
    this.ensureStarted();
    return new Promise<boolean>((resolve) => {
      const w = this.idle.pop();
      if (w) this.dispatch(w, block, resolve);
      else this.queue.push({ block, resolve });
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
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending.clear();
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
