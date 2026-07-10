/**
 * Background history backfill after a fast sync.
 *
 * A fast-synced tab holds header-only entries for the finalized prefix — the
 * balances are correct (verified snapshot) but tx bodies are missing, so the
 * explorer/wallet history are truncated and the tab can't serve old blocks to
 * peers. This loop quietly re-downloads the full blocks oldest-first, attaches
 * each body to its already-verified header, and persists it to IndexedDB, so
 * the tab eventually becomes a normal archival node.
 *
 * It doubles as the full PoW sweep fast sync deferred: every backfilled block
 * gets an Argon2id verification (the header bytes are identical, so one hash
 * per historical block total). A PoW failure on a block whose hash matches a
 * seeded header proves the sampled verification was evaded by a forged prefix
 * — `onFatal` fires and the node discards everything and re-syncs from
 * genesis. (The network was never at risk — every other node validates all
 * blocks — only this miner's hashpower was.)
 *
 * Deliberately slow (one small batch per idle tick): mining and the UI have
 * priority, and at ~100 blocks per BACKFILL_IDLE_MS the full history lands in
 * minutes anyway.
 */

import type { Blockchain } from '../chain/blockchain.js';
import { decodeBlock, encodeBlock, hashHeader, type Block } from '../chain/block.js';
import { bytesToHex, hexToBytes } from '../util/binary.js';
import { noteFailure, noteSuccess } from './apiFanout.js';

export const BACKFILL_BATCH = 100;
export const BACKFILL_IDLE_MS = 4000;

export interface BackfillStatus {
  /** Bodyless count when the backfill started (0 = nothing to do). */
  total: number;
  /** Bodyless entries still missing. */
  remaining: number;
  running: boolean;
}

export interface BackfillDeps {
  chain: Blockchain;
  servers: () => string[];
  fetchImpl: (url: string) => Promise<Response>;
  verifier: { verifyAll(blocks: Block[]): Promise<boolean[]> };
  /** Persist an attached block (IDB putBlock in production). */
  persistBlock: (hashHex: string, height: number, encoded: Uint8Array) => Promise<void>;
  onProgress?: (s: BackfillStatus) => void;
  /** History is complete — rebuild indexes, drop the headerChain meta. */
  onComplete?: () => void | Promise<void>;
  /** A seeded header failed full PoW — forged prefix; discard and resync. */
  onFatal?: (reason: string) => void;
  idleMs?: number;
}

export class HistoryBackfill {
  private stopped = false;
  private started = false;
  private total = 0;

  constructor(private deps: BackfillDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.total = this.deps.chain.bodylessCount;
    if (this.total === 0) return;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  getStatus(): BackfillStatus {
    return {
      total: this.total,
      remaining: this.deps.chain.bodylessCount,
      running: this.started && !this.stopped && this.deps.chain.bodylessCount > 0,
    };
  }

  private async loop(): Promise<void> {
    const { chain } = this.deps;
    const idleMs = this.deps.idleMs ?? BACKFILL_IDLE_MS;
    // Rounds that attached nothing (all servers down, or serving a divergent
    // chain). Backfill is best-effort background work, so there's no give-up —
    // just progressively lazier retries up to one batch per minute.
    let dryRounds = 0;

    while (!this.stopped && chain.bodylessCount > 0) {
      const attached = await this.oneBatch();
      if (this.stopped) return;
      if (attached < 0) return; // fatal — onFatal already fired
      if (attached > 0) {
        dryRounds = 0;
        this.deps.onProgress?.(this.getStatus());
      } else {
        dryRounds++;
      }
      await sleep(Math.min(idleMs * (1 + dryRounds), 60_000));
    }

    if (!this.stopped && chain.bodylessCount === 0) {
      this.deps.onProgress?.(this.getStatus());
      await this.deps.onComplete?.();
    }
  }

  /** Pull + attach one batch. Returns attached count, or -1 on fatal. */
  private async oneBatch(): Promise<number> {
    const { chain } = this.deps;
    const from = chain.lowestBodylessHeight();
    if (from === 0) return 0;

    const body = await this.fetchBlocks(from, BACKFILL_BATCH);
    if (!body || body.blocks.length === 0) return 0;

    const decoded: Block[] = [];
    for (const hex of body.blocks) {
      try { decoded.push(decodeBlock(hexToBytes(hex))); }
      catch { /* drop malformed */ }
    }
    if (decoded.length === 0) return 0;

    // The background PoW sweep: every historical block Argon2id-verified once.
    const powResults = await this.deps.verifier.verifyAll(decoded);

    let attached = 0;
    for (let i = 0; i < decoded.length; i++) {
      if (this.stopped) return attached;
      const block = decoded[i]!;
      const hashHex = bytesToHex(hashHeader(block.header));
      const entry = chain.getBlock(hashHex);
      if (!entry) continue; // not one of ours (server fork?) — ignore
      if (entry.hasBody) continue;

      if (!powResults[i]) {
        // This hash IS a header we seeded — its PoW being invalid means the
        // fast-synced prefix was forged past the sampled verification.
        this.deps.onFatal?.(`seeded header at h=${block.header.height} failed full PoW verification`);
        return -1;
      }

      const err = chain.attachBody(block);
      if (err) {
        // txRoot mismatch = the server sent a body that doesn't match the
        // PoW-committed header — try again next round (health-ordered fetch
        // will prefer another server).
        console.warn(`[backfill] attach h=${block.header.height} failed: ${err}`);
        continue;
      }
      attached++;
      try {
        await this.deps.persistBlock(hashHex, block.header.height, encodeBlock(block));
      } catch (e) {
        console.warn('[backfill] idb persist failed:', (e as Error).message);
      }
    }
    return attached;
  }

  private async fetchBlocks(fromHeight: number, max: number): Promise<{ blocks: string[] } | null> {
    for (const base of this.deps.servers()) {
      try {
        const r = await this.deps.fetchImpl(new URL(`/blocks?fromHeight=${fromHeight}&max=${max}`, base).toString());
        if (!r.ok) { noteFailure(base); continue; }
        const body = (await r.json()) as { blocks: string[] };
        if (!Array.isArray(body?.blocks)) { noteFailure(base); continue; }
        noteSuccess(base);
        return body;
      } catch {
        noteFailure(base);
      }
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
