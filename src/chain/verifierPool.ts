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
    // Leave at least one core free for the main thread + UI. Mining workers
    // are gated by the sync overlay, so they shouldn't be competing here.
    this.size = Math.max(1, Math.min(8, size));
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.size; i++) {
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
      this.idle.push(w);
    }
  }

  private releaseWorker(w: Worker): void {
    const next = this.queue.shift();
    if (next) {
      this.dispatch(w, next.block, next.resolve);
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

/** Default pool sized to the device. Cap at 4 to keep transient memory <128 MB. */
export function defaultVerifierPoolSize(): number {
  const cores =
    (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(4, cores - 1));
}
