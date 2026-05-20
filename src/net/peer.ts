import Peer, { type DataConnection } from 'peerjs';
import { CHAIN_ID } from '../chain/genesis.js';
import { bytesToHex } from '../util/binary.js';
import type { Blockchain } from '../chain/blockchain.js';
import type { Block } from '../chain/block.js';
import { hashHeader } from '../chain/block.js';
import type { Mempool } from '../chain/mempool.js';
import { txHash, type Transaction } from '../chain/transaction.js';
import {
  decodeBlockMsg,
  decodeTxMsg,
  encodeBlockMsg,
  encodeTxMsg,
  type ProtoMsg,
} from './protocol.js';

const MAX_PEERS = 8;
const MIN_PEERS = 3;
const HEARTBEAT_MS = 30_000;
const TX_REBROADCAST_MS = 15_000;
const PEER_PREFIX = 'browsercoin-';
const MAX_ORPHANS = 2048;

export interface PeerStatus {
  myId: string | null;
  connected: number;
  serverPeerCount: number;
  /** Active miners across the network as last reported by the bootstrap server. */
  serverMinersActive: number;
  bootstrapUrl: string;
}

/**
 * Manages the local browser's PeerJS identity, the live connections to other
 * browser nodes, and the gossip plumbing in/out.
 *
 * On open:
 *   1. Connect to the signaling server, register our peer ID.
 *   2. Pull `/peers` to learn current peer IDs, dial a handful.
 *   3. Whenever a new block or tx is added locally, broadcast to all peers.
 *   4. Heartbeat to /heartbeat every 30s so the server keeps us in the list.
 */
export class PeerNetwork {
  private peer: Peer | null = null;
  private connections = new Map<string, DataConnection>();
  private status: PeerStatus;
  private statusListeners = new Set<(s: PeerStatus) => void>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private txRebroadcastTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Blocks whose parent we don't yet have, keyed by parent hash hex. When the
   * parent eventually arrives, we drain the orphan and try to add it. This is
   * what lets two divergent chains reconcile — we walk backwards link-by-link.
   */
  private orphans = new Map<string, Block>();

  constructor(
    private chain: Blockchain,
    private mempool: Mempool,
    private bootstrapUrl: string,
    /** Called whenever a remote peer causes a state change we should reflect. */
    private onUpdate: () => void,
    /** Polled each heartbeat to tell the server whether this tab is actively mining. */
    private isMining: () => boolean = () => false,
  ) {
    this.status = {
      myId: null,
      connected: 0,
      serverPeerCount: 0,
      serverMinersActive: 0,
      bootstrapUrl,
    };
  }

  getStatus(): PeerStatus {
    return { ...this.status };
  }

  onStatus(fn: (s: PeerStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private emit(): void {
    const s = this.getStatus();
    for (const fn of this.statusListeners) fn(s);
  }

  async start(): Promise<void> {
    const url = new URL(this.bootstrapUrl);
    const myId = PEER_PREFIX + Math.random().toString(36).slice(2, 12);
    this.peer = new Peer(myId, {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      path: '/peerjs',
      secure: url.protocol === 'https:',
    });

    await new Promise<void>((resolve, reject) => {
      this.peer!.on('open', (id) => {
        this.status.myId = id;
        this.emit();
        resolve();
      });
      this.peer!.on('error', (err) => {
        console.warn('[peer] error', err.type, err.message);
        if (!this.status.myId) reject(err);
      });
    });

    this.peer!.on('connection', (conn) => this.adoptConnection(conn));

    await this.dialFromBootstrap();

    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
      if (this.connections.size < MIN_PEERS) {
        void this.dialFromBootstrap();
      }
    }, HEARTBEAT_MS);

    // Periodic mempool re-flood: covers peers who connected after a tx was
    // first broadcast, and peers who briefly dropped and reconnected.
    // Receivers dedupe via mempool.has(), so this is cheap and self-bounding.
    this.txRebroadcastTimer = setInterval(() => this.gossipMempool(), TX_REBROADCAST_MS);

    // Send a first heartbeat right away to register ourselves.
    void this.heartbeat();
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.txRebroadcastTimer) clearInterval(this.txRebroadcastTimer);
    this.txRebroadcastTimer = null;
    for (const c of this.connections.values()) c.close();
    this.connections.clear();
    this.peer?.destroy();
    this.peer = null;
    this.status.myId = null;
    this.status.connected = 0;
    this.emit();
  }

  broadcastBlock(): void {
    const tip = this.chain.tip.block;
    const msg = encodeBlockMsg(tip);
    this.broadcast(msg);
  }

  /** Gossip a single tx to every connected peer. Caller supplies the tx. */
  broadcastTx(tx: Transaction): void {
    this.broadcast(encodeTxMsg(tx));
  }

  /** Send every pending tx in our local mempool to every connected peer. */
  private gossipMempool(to?: DataConnection): void {
    const targets = to ? [to] : [...this.connections.values()];
    if (targets.length === 0) return;
    for (const tx of this.mempool.list()) {
      const msg = encodeTxMsg(tx);
      for (const c of targets) {
        try { c.send(msg); } catch { /* ignore */ }
      }
    }
  }

  private broadcast(msg: ProtoMsg): void {
    for (const c of this.connections.values()) {
      try {
        c.send(msg);
      } catch (e) {
        console.warn('[peer] send failed', (e as Error).message);
      }
    }
  }

  private async dialFromBootstrap(): Promise<void> {
    try {
      const r = await fetch(new URL('/peers', this.bootstrapUrl).toString());
      const { peers } = (await r.json()) as { peers: string[] };
      const candidates = peers.filter((id) => id !== this.status.myId && !this.connections.has(id));
      // Shuffle and take up to MAX_PEERS connection slots.
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
      }
      for (const id of candidates) {
        if (this.connections.size >= MAX_PEERS) break;
        const conn = this.peer!.connect(id, { reliable: true });
        this.adoptConnection(conn);
      }
    } catch (e) {
      console.warn('[peer] bootstrap dial failed', (e as Error).message);
    }
  }

  private adoptConnection(conn: DataConnection): void {
    conn.on('open', () => {
      this.connections.set(conn.peer, conn);
      this.status.connected = this.connections.size;
      this.emit();
      // Say hello with our chain tip so the peer can decide to sync.
      const tip = this.chain.tip;
      conn.send({
        t: 'hello',
        height: tip.block.header.height,
        tipHash: bytesToHex(tip.hash),
        chainId: CHAIN_ID,
      } satisfies ProtoMsg);
      // Flood the new peer with everything we've got in the mempool. Without
      // this, a peer joining 1s after a sender broadcasts never hears about
      // the pending tx and won't include it when it mines.
      this.gossipMempool(conn);
    });
    conn.on('data', (data) => this.onIncoming(conn, data as ProtoMsg));
    conn.on('close', () => {
      this.connections.delete(conn.peer);
      this.status.connected = this.connections.size;
      this.emit();
    });
    conn.on('error', (e) => {
      console.warn('[peer] conn error', conn.peer, e.message);
    });
  }

  private onIncoming(conn: DataConnection, msg: ProtoMsg): void {
    try {
      switch (msg.t) {
        case 'hello':
          if (msg.chainId !== CHAIN_ID) {
            conn.close();
            return;
          }
          if (msg.height > this.chain.height && !this.chain.hasBlock(msg.tipHash)) {
            // Ask for their tip. If its parent is unknown we'll walk backwards
            // via the orphan-pool fill below until we hit a shared ancestor.
            conn.send({ t: 'getBlock', hash: msg.tipHash } satisfies ProtoMsg);
          }
          break;

        case 'tx': {
          const tx = decodeTxMsg(msg);
          const hashHex = bytesToHex(txHash(tx));
          // Already in our mempool → drop without re-flooding. Without this
          // check, mempool.add() returns null for duplicates too, so peers
          // would ping-pong every tx forever in a 3+ peer mesh.
          if (this.mempool.has(hashHex)) break;
          const err = this.mempool.add(tx, this.chain.tipState);
          if (!err) {
            // Re-broadcast to other peers.
            for (const [pid, c] of this.connections) {
              if (pid !== conn.peer) {
                try { c.send(msg); } catch { /* ignore */ }
              }
            }
            this.onUpdate();
          }
          break;
        }

        case 'block': {
          const block = decodeBlockMsg(msg);
          void this.handleIncomingBlock(block, conn);
          break;
        }

        case 'getBlock': {
          const target = this.chain.getBlock(msg.hash);
          if (target) conn.send(encodeBlockMsg(target.block));
          break;
        }

        case 'getHeaders':
        case 'headers':
        case 'invBlock':
        case 'invTx':
          // Future work: implement light-header sync. Orphan-pool backfill
          // above handles arbitrary-depth divergence already — slower than a
          // batched header sync, but correct.
          break;
      }
    } catch (e) {
      console.warn('[peer] bad incoming msg from', conn.peer, (e as Error).message);
    }
  }

  /**
   * Try to add an incoming block, parking it as an orphan and walking back if
   * its parent is unknown. After a successful add, drain any orphans that were
   * waiting on this block (and recursively, those waiting on them).
   */
  private async handleIncomingBlock(block: Block, from: DataConnection): Promise<void> {
    const ownHashHex = bytesToHex(hashHeader(block.header));
    if (this.chain.hasBlock(ownHashHex)) return;

    const err = await this.chain.addBlock(block);
    if (err === null) {
      this.mempool.removeMany(block.transactions);
      await this.drainOrphans(ownHashHex);
      // Re-gossip to other peers.
      const msg = encodeBlockMsg(block);
      for (const [pid, c] of this.connections) {
        if (pid !== from.peer) {
          try { c.send(msg); } catch { /* ignore */ }
        }
      }
      this.onUpdate();
      return;
    }

    if (err === 'parent block unknown') {
      const parentHex = bytesToHex(block.header.prevHash);
      if (this.orphans.size >= MAX_ORPHANS) {
        // Evict an arbitrary oldest entry. We avoid memory exhaustion at the
        // cost of needing to re-request that block later — fine for v1.
        const firstKey = this.orphans.keys().next().value;
        if (firstKey !== undefined) this.orphans.delete(firstKey);
      }
      this.orphans.set(parentHex, block);
      // Ask the sender for the missing parent — they're our best bet.
      try {
        from.send({ t: 'getBlock', hash: parentHex } satisfies ProtoMsg);
      } catch {
        // peer went away; another peer's hello/block will retrigger sync
      }
      return;
    }

    // Invalid for any other reason — drop. Don't add to orphan pool.
    console.warn('[peer] block from', from.peer, 'rejected:', err);
  }

  /**
   * Walk the orphan map forward: while there's an orphan whose parent equals
   * the most recently added block's hash, try to add it. Each successful add
   * unlocks the next orphan in the chain — this is how arbitrarily deep
   * back-fills resolve in O(N) without a second round-trip per block.
   */
  private async drainOrphans(addedHashHex: string): Promise<void> {
    let cursor: string | undefined = addedHashHex;
    while (cursor) {
      const waiting = this.orphans.get(cursor);
      if (!waiting) return;
      this.orphans.delete(cursor);
      const err = await this.chain.addBlock(waiting);
      if (err !== null) {
        console.warn('[peer] drained orphan rejected:', err);
        return;
      }
      this.mempool.removeMany(waiting.transactions);
      cursor = bytesToHex(hashHeader(waiting.header));
    }
  }

  private async heartbeat(): Promise<void> {
    if (!this.status.myId) return;
    try {
      await fetch(new URL('/heartbeat', this.bootstrapUrl).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: this.status.myId,
          height: this.chain.height,
          mining: this.isMining(),
        }),
      });
      const r = await fetch(new URL('/stats', this.bootstrapUrl).toString());
      const stats = (await r.json()) as { peerCount: number; minersActive?: number };
      this.status.serverPeerCount = stats.peerCount;
      this.status.serverMinersActive = stats.minersActive ?? 0;
      this.emit();
    } catch {
      // network blip — fine, retry next interval
    }
  }
}
