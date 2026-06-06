import type { Blockchain } from '../chain/blockchain.js';
import { decodeBlock, encodeBlock, hashHeader, type Block } from '../chain/block.js';
import { bytesToHex, hexToBytes } from '../util/binary.js';
import type { Mempool } from '../chain/mempool.js';
import { decodeTx, encodeTx, txHash, type Transaction } from '../chain/transaction.js';
import { VerifierPool, configuredVerifierCores } from '../chain/verifierPool.js';
import { fanoutWrite, fanoutWriteWith, noteFailure, noteSuccess, reachableCount, tryRead } from './apiFanout.js';
import {
  HELPER_DISCOVERY_NETWORK,
  loadCachedHelperRecords,
  mergeHelperRecords,
  parseHelperResponse,
  saveCachedHelperRecords,
} from './helperDiscovery.js';

const PUSH_BATCH = 50;
const PULL_BATCH = 100;
/** Background safety re-sync when we're totally isolated from peers. */
const ISOLATED_POLL_MS = 10_000;
/**
 * Always-on background poll, even when peered. This is the bridge that lets a
 * NAT-stuck "server-only" miner's blocks reach the rest of the mesh — peered
 * clients pick them up within this window instead of "whenever someone happens
 * to mine next." ~½× block time; tiny server load (one /tip per minute, no
 * batch fetch unless heights actually differ).
 */
const BRIDGE_POLL_MS = 90_000;

export interface ServerSyncStatus {
  /**
   * Count of API servers currently considered reachable (last contact
   * succeeded, or first attempt hasn't been made). UI consumers should check
   * `reachable > 0` to mean "at least one helper server is responsive."
   */
  reachable: number;
  /** Total count of API servers configured. `reachable / total` is the health ratio. */
  total: number;
  /** Max height reported across reachable servers — what we sync up to. */
  serverHeight: number;
  lastSyncedAt: number;
}

export interface HeartbeatPayload {
  id: string;
  height: number;
  mining: boolean;
}

export interface NetworkStats {
  peerCount: number;
  minersActive: number;
}

/**
 * Talks to N independently-operated helper servers. Reads try them in health
 * order and take the first success; writes fan out to all in parallel for
 * durability. Used as backup storage + peer-discovery, NOT a constant gossip
 * relay — that role belongs to P2P.
 *
 * Server contact happens on these events:
 *   • Startup       — one-shot bootstrap (fetch chain + mempool snapshot).
 *   • Local mine    — push our new block (via `kick()`).
 *   • Local send    — push the one tx we just submitted (via `pushTx()`).
 *   • Lost peers    — if peer count falls to 0, a 10-s safety poll resumes
 *                     so an isolated tab can still catch up. Cancels the
 *                     moment a P2P peer comes back.
 *   • Bridge poll   — slow background sync (~90 s) so server-only miners'
 *                     blocks propagate to peered clients.
 *
 * No server has authority — every block returned is validated by the local
 * chain like any peer-relayed block.
 */
export class ServerSync {
  /** Fast poll, only running while we have 0 P2P peers (isolated rescue). */
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Slow poll, always running once bootstrapped. Bridges server-only miners
   * (whose blocks reach the server but not peers via WebRTC) into the peered
   * mesh. Independent of `timer` — both can be active when isolated.
   */
  private bridgeTimer: ReturnType<typeof setInterval> | null = null;
  private status: ServerSyncStatus = { reachable: 0, total: 0, serverHeight: 0, lastSyncedAt: 0 };
  private statusListeners = new Set<(s: ServerSyncStatus) => void>();
  private inFlight = false;
  private peerCount = 0;
  private bootstrapped = false;

  /**
   * Txs this node authored that haven't confirmed yet, keyed by hash hex. We
   * re-POST these to the servers on every sync tick until they leave our
   * mempool (confirmed on the canonical chain, or evicted) — Bitcoin-style,
   * the wallet that created a tx is responsible for rebroadcasting it. Bounded
   * by how much *this* user sends, so it stays cheap as the network grows.
   */
  private localPending = new Map<string, Transaction>();

  /** Lazily-created pool of PoW verifier workers. */
  private verifier: VerifierPool | null = null;

  constructor(
    private chain: Blockchain,
    private mempool: Mempool,
    private apiServers: string[],
    /** Called whenever sync caused our local chain to change. */
    private onUpdate: () => void,
    /**
     * Whether this node is actively mining. A mining node always pulls the
     * server mempool (it needs every pending tx to build full blocks); a
     * non-mining node only pulls when it has no P2P peers to learn txs from.
     */
    private isMining: () => boolean = () => false,
  ) {
    this.status.total = apiServers.length;
  }

  private getVerifier(): VerifierPool {
    if (!this.verifier) this.verifier = new VerifierPool(configuredVerifierCores());
    return this.verifier;
  }

  /**
   * Change how many cores bulk-sync verification uses, applied live. If a pool
   * is already running it resizes in place; otherwise the next one picks up the
   * value from localStorage on its own.
   */
  setVerifierConcurrency(cores: number): void {
    this.verifier?.setSize(cores);
  }

  setApiServers(urls: string[]): void {
    this.apiServers = urls;
    this.status.total = urls.length;
    this.status.reachable = Math.min(this.status.reachable, urls.length);
    this.emit();
  }

  getApiServers(): string[] {
    return [...this.apiServers];
  }

  getStatus(): ServerSyncStatus {
    // Always pull from HEALTH so callers see the latest reachability without
    // having to wait for the next emit(). Several code paths (pullFrom,
    // pullMempool, heartbeat) mark health success but don't immediately
    // refresh the cached status field — recomputing here keeps reads honest.
    this.status.reachable = reachableCount(this.apiServers);
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

  private refreshHealth(): void {
    this.status.reachable = reachableCount(this.apiServers);
  }

  async start(): Promise<void> {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    // One-shot bootstrap: get the chain and mempool snapshot in a single
    // round-trip. After this we run a low-frequency bridge poll (so server-
    // only miners' blocks always reach the peered mesh) plus a fast
    // isolation-rescue poll whenever peer count drops to 0.
    await this.syncOnce();
    await this.pullHelperRecords();
    await this.pullMempool();
    this.startBridgePolling();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.bridgeTimer) clearInterval(this.bridgeTimer);
    this.bridgeTimer = null;
    this.bootstrapped = false;
    this.status.reachable = 0;
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

  private startBridgePolling(): void {
    if (this.bridgeTimer) return;
    this.bridgeTimer = setInterval(() => void this.syncOnce(), BRIDGE_POLL_MS);
  }

  /** Force a sync immediately — called after we mine a block locally. */
  kick(): void {
    void this.syncOnce();
  }

  /**
   * Push a tx this node just authored to every reachable API server right away,
   * and remember it so we keep re-pushing on each sync tick until it confirms.
   * The immediate POST gives low latency; the retry survives a server that was
   * briefly unreachable when the tx was first sent.
   */
  pushTx(tx: Transaction): void {
    const hashHex = bytesToHex(txHash(tx));
    this.localPending.set(hashHex, tx);
    void this.postTxs([tx]);
  }

  /**
   * Re-POST our still-unconfirmed authored txs and forget any that have left
   * the mempool (confirmed on the canonical chain, or evicted). Self-terminates
   * per tx — nothing is re-pushed forever.
   */
  private pushLocalPending(): void {
    if (this.localPending.size === 0) return;
    const stillPending: Transaction[] = [];
    for (const [hashHex, tx] of this.localPending) {
      if (this.mempool.has(hashHex)) stillPending.push(tx);
      else this.localPending.delete(hashHex);
    }
    if (stillPending.length > 0) void this.postTxs(stillPending);
  }

  /**
   * Used by PeerNetwork's heartbeat: fan out our liveness/height/mining state
   * to every API server, then aggregate /stats from all of them (taking the
   * max of each metric — every server has its own vantage point on the same
   * network, max approximates the union).
   */
  async heartbeat(payload: HeartbeatPayload): Promise<NetworkStats | null> {
    if (this.apiServers.length === 0) return null;
    await fanoutWrite(this.apiServers, '/heartbeat', JSON.stringify(payload));
    // Read stats from each server, take max.
    const all = await Promise.allSettled(
      this.apiServers.map(async (base) => {
        const r = await fetch(new URL('/stats', base).toString());
        if (!r.ok) return null;
        return (await r.json()) as { peerCount: number; minersActive?: number };
      }),
    );
    let peerCount = 0;
    let minersActive = 0;
    let anyOk = false;
    for (const r of all) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      anyOk = true;
      peerCount = Math.max(peerCount, r.value.peerCount);
      minersActive = Math.max(minersActive, r.value.minersActive ?? 0);
    }
    this.refreshHealth();
    this.emit();
    return anyOk ? { peerCount, minersActive } : null;
  }

  /**
   * Used by PeerNetwork's peer-discovery: union all servers' /peers lists so a
   * peer registered on any one helper is discoverable to us. Dedupes.
   */
  async fetchPeers(): Promise<string[]> {
    if (this.apiServers.length === 0) return [];
    const all = await Promise.allSettled(
      this.apiServers.map(async (base) => {
        const r = await fetch(new URL('/peers', base).toString());
        if (!r.ok) return [] as string[];
        const body = (await r.json()) as { peers?: string[] };
        return body.peers ?? [];
      }),
    );
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of all) {
      if (r.status !== 'fulfilled') continue;
      for (const id of r.value) {
        if (typeof id !== 'string') continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }
    this.refreshHealth();
    return out;
  }

  async pullHelperRecords(): Promise<void> {
    if (this.apiServers.length === 0) return;
    const records = await tryRead(
      this.apiServers,
      '/helpers',
      async (r) => parseHelperResponse(await r.json()),
    );
    if (!records || records.length === 0) return;
    const merged = mergeHelperRecords(loadCachedHelperRecords(), records, {
      nowSeconds: Math.floor(Date.now() / 1000),
      network: HELPER_DISCOVERY_NETWORK,
      source: 'api',
    });
    saveCachedHelperRecords(merged.records);
  }

  private async syncOnce(): Promise<void> {
    if (this.inFlight) return;
    if (this.apiServers.length === 0) return;
    this.inFlight = true;
    try {
      const tip = await this.getServerTip();
      this.refreshHealth();
      if (!tip) {
        this.emit();
        return;
      }
      this.status.serverHeight = tip.height;
      this.status.lastSyncedAt = Date.now();
      // Emit once we know the target so the sync overlay can show progress
      // (local X / server Y) and switch to the 'verifying' phase BEFORE the
      // pullFrom loop blocks for seconds on Argon2id verification. Without
      // this, the user stares at "Connecting · local 300 / server —" for the
      // entire bulk catchup, then it snaps to ready with no progress shown.
      this.emit();

      const ourHeight = this.chain.height;
      const ourTipHex = bytesToHex(this.chain.tip.hash);

      if (tip.height > ourHeight || (tip.height === ourHeight && tip.tipHash !== ourTipHex && !this.chain.hasBlock(tip.tipHash))) {
        const grew = await this.pullFrom(Math.max(0, ourHeight + 1 - 5)); // small overlap in case of recent reorg
        if (grew) this.onUpdate();
      }

      // Push anything we have beyond the server's tip. tip.height is the *max*
      // across all servers; any server below it gets caught up via the fan-out
      // POST. Servers above it stay above (no-op for them).
      if (this.chain.height > tip.height) {
        await this.pushFrom(tip.height + 1);
      }

      // Mempool reconciliation. Peered nodes learn pending txs over P2P, so
      // only pull when we'd otherwise be starved: no peers (isolated rescue)
      // or actively mining (a miner needs every pending tx to build full
      // blocks — this is what feeds a NAT-stuck server-only miner). Always
      // re-push our own authored txs, which is cheap and bounded.
      if (this.peerCount === 0 || this.isMining()) {
        await this.pullMempool();
      }
      this.pushLocalPending();
    } catch (e) {
      console.warn('[serverSync] error:', (e as Error).message);
    } finally {
      this.inFlight = false;
      this.emit();
    }
  }

  /**
   * Query every server's /tip in parallel, return the max-height response.
   * Different servers may briefly disagree on tip; we sync to "whoever is
   * furthest ahead" which the local chain then validates normally.
   */
  private async getServerTip(): Promise<{ height: number; tipHash: string } | null> {
    const all = await Promise.allSettled(
      this.apiServers.map(async (base) => {
        try {
          const r = await fetch(new URL('/tip', base).toString());
          if (!r.ok) { noteFailure(base); return null; }
          const v = (await r.json()) as { height: number; tipHash: string };
          noteSuccess(base);
          return v;
        } catch {
          noteFailure(base);
          return null;
        }
      }),
    );
    let best: { height: number; tipHash: string } | null = null;
    for (const r of all) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      if (!best || r.value.height > best.height) best = r.value;
    }
    return best;
  }

  /**
   * Pull canonical blocks from whichever server returns them first (health-
   * ordered). Argon2id PoW verification is fanned out to the verifier worker
   * pool — main thread stays free, and the per-batch wall clock drops to
   * ~N×cores faster.
   */
  private async pullFrom(fromHeight: number): Promise<boolean> {
    let cursor = fromHeight;
    let anyAdded = false;
    while (true) {
      const body = await tryRead(
        this.apiServers,
        `/blocks?fromHeight=${cursor}&max=${PULL_BATCH}`,
        (r) => r.json() as Promise<{ blocks: string[] }>,
      );
      if (!body || body.blocks.length === 0) break;

      // Decode all blocks up front so the workers can chew through their PoW
      // checks while we do nothing on the main thread.
      const decoded: Block[] = [];
      for (const hex of body.blocks) {
        try { decoded.push(decodeBlock(hexToBytes(hex))); }
        catch { /* drop malformed */ }
      }
      if (decoded.length === 0) break;

      const powResults = await this.getVerifier().verifyAll(decoded);

      let appliedThisRound = 0;
      for (let i = 0; i < decoded.length; i++) {
        const block = decoded[i]!;
        const err = await this.chain.addBlockWithPow(block, powResults[i]!);
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
      cursor += body.blocks.length;
      // Notify listeners between batches so the sync overlay's progress bar
      // and local/target counters advance live during a multi-batch pull —
      // not just at the end of the whole loop.
      if (appliedThisRound > 0) this.emit();
    }
    return anyAdded;
  }

  /** Push canonical blocks starting at fromHeight (inclusive) to every server. */
  private async pushFrom(fromHeight: number): Promise<void> {
    // Walk canonical newest-first then reverse so we send genesis-first.
    const pending: Block[] = [];
    for (const cb of this.chain.iterateCanonical()) {
      if (cb.block.header.height < fromHeight) break;
      pending.push(cb.block);
    }
    pending.reverse();

    for (const block of pending.slice(0, PUSH_BATCH)) {
      const body = JSON.stringify({ block: bytesToHex(encodeBlock(block)) });
      const results = await fanoutWriteWith(
        this.apiServers,
        '/block',
        body,
        (r) => r.json() as Promise<{ status: string; parentNeeded?: string }>,
      );

      // If *any* server says "orphan, parent needed," recursively push the
      // parent then retry. Different servers may be at different heights so
      // some accept while others need backfill — that's fine, we just need to
      // catch the laggards up. We don't bail on rejections; other servers may
      // have accepted.
      for (const res of results) {
        if (!res.ok || !res.value) continue;
        if (res.value.status === 'orphan' && res.value.parentNeeded) {
          const parentBlock = this.chain.getBlock(res.value.parentNeeded);
          if (parentBlock && parentBlock.block.header.height > 0) {
            await this.pushFrom(parentBlock.block.header.height);
            // Retry just to that one server.
            await fetch(new URL('/block', res.server).toString(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            }).catch(() => {});
          }
        } else if (res.value.status === 'invalid') {
          console.warn('[serverSync]', res.server, 'rejected block at height', block.header.height);
        }
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
    const body = await tryRead(
      this.apiServers,
      '/mempool',
      (r) => r.json() as Promise<{ txs: string[] }>,
    );
    if (!body) return;
    let added = false;
    for (const hex of body.txs) {
      let tx: Transaction;
      try { tx = decodeTx(hexToBytes(hex)).tx; } catch { continue; }
      const h = bytesToHex(txHash(tx));
      if (this.mempool.has(h)) continue;
      const err = this.mempool.add(tx, this.chain.tipState);
      if (!err) added = true;
    }
    if (added) this.onUpdate();
  }

  /** Push a batch of txs to every server. Returns how many ACK'd. */
  private async postTxs(txs: Transaction[]): Promise<number> {
    if (this.apiServers.length === 0) return 0;
    const body = JSON.stringify({ txs: txs.map((tx) => bytesToHex(encodeTx(tx))) });
    return fanoutWrite(this.apiServers, '/txs', body);
  }
}
