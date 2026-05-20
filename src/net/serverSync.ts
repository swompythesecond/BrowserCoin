import type { Blockchain } from '../chain/blockchain.js';
import { decodeBlock, encodeBlock, hashHeader, type Block } from '../chain/block.js';
import { bytesToHex, hexToBytes } from '../util/binary.js';
import type { Mempool } from '../chain/mempool.js';
import { decodeTx, encodeTx, txHash, type Transaction } from '../chain/transaction.js';

const PUSH_BATCH = 50;
const PULL_BATCH = 100;
/** Background safety re-sync when we're totally isolated from peers. */
const ISOLATED_POLL_MS = 10_000;

export interface ServerSyncStatus {
  reachable: boolean;
  serverHeight: number;
  lastSyncedAt: number;
}

/**
 * Talks to the always-on bootstrap server. Used as backup storage + peer
 * discovery, NOT a constant gossip relay — that role belongs to P2P.
 *
 * Server contact happens only on these events:
 *   • Startup       — one-shot bootstrap (fetch chain + mempool snapshot).
 *   • Local mine    — push our new block (via `kick()`).
 *   • Local send    — push the one tx we just submitted (via `pushTx()`).
 *   • Lost peers    — if peer count falls to 0, a 10-s safety poll resumes
 *                     so an isolated tab can still catch up. Cancels the
 *                     moment a P2P peer comes back.
 *
 * The server has no authority — every block it returns is validated by the
 * local chain like any peer-relayed block.
 */
export class ServerSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private status: ServerSyncStatus = { reachable: false, serverHeight: 0, lastSyncedAt: 0 };
  private statusListeners = new Set<(s: ServerSyncStatus) => void>();
  private inFlight = false;
  private peerCount = 0;
  private bootstrapped = false;

  /** Hashes of txs we've already pushed to the server; prevents re-POST on every kick. */
  private pushedTxHashes = new Set<string>();

  constructor(
    private chain: Blockchain,
    private mempool: Mempool,
    private serverUrl: string,
    /** Called whenever sync caused our local chain to change. */
    private onUpdate: () => void,
  ) {}

  setServerUrl(url: string): void {
    this.serverUrl = url;
  }

  getStatus(): ServerSyncStatus {
    return { ...this.status };
  }

  onStatus(fn: (s: ServerSyncStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private emit(): void {
    const snap = this.getStatus();
    for (const fn of this.statusListeners) fn(snap);
  }

  async start(): Promise<void> {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    // One-shot bootstrap: get the chain and mempool snapshot in a single
    // round-trip. After this, the server is only contacted when we mine,
    // when we send, or when we lose all P2P peers.
    await this.syncOnce();
    await this.pullMempool();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bootstrapped = false;
    this.status.reachable = false;
    this.emit();
  }

  /**
   * Tell ServerSync the current P2P peer count. When we have peers, we go
   * silent; when peer count drops to 0 we resume a 10-s safety poll so a
   * fully-isolated tab can still discover new chain activity.
   */
  setPeerCount(n: number): void {
    const prev = this.peerCount;
    this.peerCount = n;
    if (n === 0 && prev > 0) this.startIsolatedPolling();
    if (n > 0 && prev === 0) this.stopIsolatedPolling();
  }

  private startIsolatedPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.syncOnce(), ISOLATED_POLL_MS);
  }

  private stopIsolatedPolling(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Force a sync immediately — called after we mine a block locally. */
  kick(): void {
    void this.syncOnce();
  }

  /** Push a single tx to the server right away (best-effort, one-shot). */
  pushTx(tx: Transaction): void {
    const hashHex = bytesToHex(txHash(tx));
    if (this.pushedTxHashes.has(hashHex)) return;
    void this.postTxs([tx]).then((ok) => {
      if (ok) this.pushedTxHashes.add(hashHex);
    });
  }

  private async syncOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const tip = await this.getServerTip();
      if (!tip) {
        this.status.reachable = false;
        this.emit();
        return;
      }
      this.status.reachable = true;
      this.status.serverHeight = tip.height;
      this.status.lastSyncedAt = Date.now();

      const ourHeight = this.chain.height;
      const ourTipHex = bytesToHex(this.chain.tip.hash);

      if (tip.height > ourHeight || (tip.height === ourHeight && tip.tipHash !== ourTipHex && !this.chain.hasBlock(tip.tipHash))) {
        const grew = await this.pullFrom(Math.max(0, ourHeight + 1 - 5)); // small overlap in case of recent reorg
        if (grew) this.onUpdate();
      }

      // Push anything we have beyond the server's tip.
      if (this.chain.height > tip.height) {
        await this.pushFrom(tip.height + 1);
      }
    } catch (e) {
      this.status.reachable = false;
      console.warn('[serverSync] error:', (e as Error).message);
    } finally {
      this.inFlight = false;
      this.emit();
    }
  }

  private async getServerTip(): Promise<{ height: number; tipHash: string } | null> {
    try {
      const r = await fetch(this.url('/tip'));
      if (!r.ok) return null;
      return (await r.json()) as { height: number; tipHash: string };
    } catch {
      return null;
    }
  }

  /** Pull canonical blocks from the server starting at fromHeight. */
  private async pullFrom(fromHeight: number): Promise<boolean> {
    let cursor = fromHeight;
    let anyAdded = false;
    while (true) {
      const r = await fetch(this.url(`/blocks?fromHeight=${cursor}&max=${PULL_BATCH}`));
      if (!r.ok) break;
      const { blocks } = (await r.json()) as { blocks: string[] };
      if (blocks.length === 0) break;

      let appliedThisRound = 0;
      for (const hex of blocks) {
        const block = decodeBlock(hexToBytes(hex));
        const err = await this.chain.addBlock(block);
        if (err === null) {
          appliedThisRound++;
          anyAdded = true;
        } else if (err === 'parent block unknown' && cursor > 0) {
          // Server's chain branches from ours below our tip — back off further.
          cursor = Math.max(0, cursor - PULL_BATCH);
          appliedThisRound = -1; // signal "restart loop at lower cursor"
          break;
        }
        // any other error (signature, etc) → ignore that block, keep going
      }
      if (appliedThisRound === -1) continue;
      if (appliedThisRound === 0) break;
      cursor += blocks.length;
    }
    return anyAdded;
  }

  /** Push canonical blocks starting at fromHeight (inclusive) to the server. */
  private async pushFrom(fromHeight: number): Promise<void> {
    // Walk canonical newest-first then reverse so we send genesis-first.
    const pending: Block[] = [];
    for (const cb of this.chain.iterateCanonical()) {
      if (cb.block.header.height < fromHeight) break;
      pending.push(cb.block);
    }
    pending.reverse();

    for (const block of pending.slice(0, PUSH_BATCH)) {
      const r = await fetch(this.url('/block'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ block: bytesToHex(encodeBlock(block)) }),
      });
      if (!r.ok) return;
      const result = (await r.json()) as { status: string; parentNeeded?: string };
      if (result.status === 'orphan' && result.parentNeeded) {
        // Server is way behind / on a different branch — find the parent and push it first.
        const parentHashHex = result.parentNeeded;
        const parentBlock = this.chain.getBlock(parentHashHex);
        if (parentBlock && parentBlock.block.header.height > 0) {
          await this.pushFrom(parentBlock.block.header.height);
          // Then retry the original push.
          await fetch(this.url('/block'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ block: bytesToHex(encodeBlock(block)) }),
          });
        }
      } else if (result.status === 'invalid') {
        console.warn('[serverSync] server rejected our block at height', block.header.height);
        return;
      }
    }

    // Anti-warning: hashHeader is imported because future versions of this
    // file will use it for branch-detection in the pull path.
    void hashHeader;
  }

  /**
   * One-shot bootstrap fetch of the server's pending mempool. Called on
   * startup so a brand-new tab learns about txs that are in flight on the
   * network. Not called on a timer — gossip is P2P's job after this.
   */
  private async pullMempool(): Promise<void> {
    try {
      const r = await fetch(this.url('/mempool'));
      if (!r.ok) return;
      const { txs } = (await r.json()) as { txs: string[] };
      let added = false;
      for (const hex of txs) {
        let tx: Transaction;
        try { tx = decodeTx(hexToBytes(hex)).tx; } catch { continue; }
        const h = bytesToHex(txHash(tx));
        if (this.mempool.has(h)) continue;
        const err = this.mempool.add(tx, this.chain.tipState);
        if (!err) added = true;
        // Server already has it — no need to bounce it back.
        this.pushedTxHashes.add(h);
      }
      if (added) this.onUpdate();
    } catch {
      // server unreachable — peers will fill the gap once they connect
    }
  }

  private async postTxs(txs: Transaction[]): Promise<boolean> {
    try {
      const body = { txs: txs.map((tx) => bytesToHex(encodeTx(tx))) };
      const r = await fetch(this.url('/txs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  private url(path: string): string {
    return new URL(path, this.serverUrl).toString();
  }
}
