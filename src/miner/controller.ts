import type { Blockchain } from '../chain/blockchain.js';
import { computeTxRoot, encodeHeader, type Block, type BlockHeader } from '../chain/block.js';
import { nextDifficulty } from '../chain/consensus.js';
import { DIFFICULTY_WINDOW, MAX_BLOCK_BYTES } from '../chain/genesis.js';
import type { Mempool } from '../chain/mempool.js';
import { applyBlockTxs, cloneState, stateRoot } from '../chain/state.js';
import { compactToTarget } from '../util/binary.js';
import { bytesToHex } from '../util/binary.js';
import type { PublicKey } from '../crypto/keys.js';

export interface MinerStatus {
  running: boolean;
  hashesPerSecond: number;
  currentHeight: number;
  currentTxCount: number;
  throttle: number; // 0..1
  workerCount: number;
}

type WorkerSolved = { type: 'solved'; nonce: number; hash: Uint8Array };
type WorkerHashrate = { type: 'hashrate'; hashesPerSecond: number };
type WorkerExhausted = { type: 'exhausted' };
type WorkerOut = WorkerSolved | WorkerHashrate | WorkerExhausted;

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
  private status: MinerStatus = {
    running: false,
    hashesPerSecond: 0,
    currentHeight: 0,
    currentTxCount: 0,
    throttle: 1,
    workerCount: 1,
  };
  private statusListeners = new Set<(s: MinerStatus) => void>();
  private currentTemplate: { block: Block } | null = null;

  constructor(
    private chain: Blockchain,
    private mempool: Mempool,
    private minerAddress: PublicKey,
    /** Called by the controller whenever we successfully mine a block. */
    private onBlockMined: (b: Block) => void,
  ) {}

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

  start(): void {
    if (this.status.running) return;
    this.status.running = true;
    this.spawnWorkers();
    this.restartTemplate();
    this.emit();
  }

  stop(): void {
    this.status.running = false;
    this.terminateWorkers();
    this.status.hashesPerSecond = 0;
    this.emit();
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

  private spawnWorkers(): void {
    this.terminateWorkers();
    for (let i = 0; i < this.status.workerCount; i++) {
      const idx = i;
      const w = new Worker(
        new URL('./miner.worker.ts', import.meta.url),
        { type: 'module' },
      );
      w.onmessage = (e: MessageEvent<WorkerOut>) => this.onWorker(idx, e.data);
      this.workers.push(w);
    }
    this.workerHashrates = new Array(this.workers.length).fill(0);
  }

  private terminateWorkers(): void {
    for (const w of this.workers) {
      try { w.postMessage({ type: 'stop' }); } catch { /* worker already gone */ }
      w.terminate();
    }
    this.workers = [];
    this.workerHashrates = [];
  }

  private onWorker(idx: number, msg: WorkerOut): void {
    if (msg.type === 'hashrate') {
      if (idx < this.workerHashrates.length) {
        this.workerHashrates[idx] = msg.hashesPerSecond;
        this.status.hashesPerSecond =
          this.workerHashrates.reduce((a, b) => a + b, 0);
        this.emit();
      }
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
    const recent = this.chain.getRecentHeaders(DIFFICULTY_WINDOW);
    const difficulty = nextDifficulty(height, recent);

    // Reserve a safety margin under the block-size cap.
    const budget = MAX_BLOCK_BYTES - 1024;
    const txs = this.mempool.selectForBlock(this.chain.tipState, budget);

    // Simulate apply against tip state to derive stateRoot.
    const sim = cloneState(this.chain.tipState);
    const err = applyBlockTxs(sim, height, this.minerAddress, txs);
    if (err) {
      // Should never happen — selectForBlock already filtered. Skip these txs.
      this.currentTemplate = null;
      return;
    }
    const sRoot = stateRoot(sim);
    const tRoot = computeTxRoot(txs);

    const header: BlockHeader = {
      height,
      prevHash: this.chain.tip.hash,
      txRoot: tRoot,
      stateRoot: sRoot,
      timestamp: Math.floor(Date.now() / 1000),
      difficulty,
      nonce: 0,
      miner: this.minerAddress,
    };
    this.currentTemplate = { block: { header, transactions: txs } };
    this.status.currentHeight = height;
    this.status.currentTxCount = txs.length;
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
