import Peer, { type DataConnection } from 'peerjs';
import { CHAIN_ID } from '../chain/genesis.js';
import { bytesToHex, hexToBytes } from '../util/binary.js';
import type { Blockchain } from '../chain/blockchain.js';
import type { Block } from '../chain/block.js';
import { decodeBlock, encodeBlock, hashHeader } from '../chain/block.js';
import type { Mempool } from '../chain/mempool.js';
import { txHash, type Transaction } from '../chain/transaction.js';
import type { ServerSync } from './serverSync.js';
import {
  decodeBlockMsg,
  decodeTxMsg,
  encodeBlockMsg,
  encodeTxMsg,
  type ProtoMsg,
} from './protocol.js';
import {
  decodeHelpersMsg,
  encodeHelpersMsg,
  HELPER_DISCOVERY_NETWORK,
  loadCachedHelperRecords,
  mergeHelperRecords,
  saveCachedHelperRecords,
} from './helperDiscovery.js';

const MAX_PEERS = 8;
const MIN_PEERS = 3;
const HEARTBEAT_MS = 30_000;
const TX_REBROADCAST_MS = 15_000;
const PEER_PREFIX = 'browsercoin-';
const MAX_ORPHANS = 2048;
const DIAL_TIMEOUT_MS = 8_000;
// If we haven't received anything from a peer in this long, treat the
// connection as dead and GC it. WebRTC's own `close` event is unreliable
// when a remote tab vanishes — without an upper bound here the UI peer
// count never decreases until a manual reload. Set to ~2.5 heartbeats so a
// peer that misses two consecutive ping rounds is reaped.
const PEER_STALE_MS = 75_000;

/**
 * Public STUN servers used to discover our reflexive (NAT-mapped) address.
 * Without these, browsers behind almost any NAT can't establish direct WebRTC
 * connections — they only know their RFC1918 LAN address, which is useless to
 * a remote peer. STUN lifts the easy-NAT majority into the direct-connect
 * path; the residual (symmetric NAT) is expected to fall back to the manual
 * peer-ID handshake rather than a TURN relay — the project explicitly avoids
 * centralized relay infrastructure.
 *
 * Multiple servers are listed for redundancy; the browser races them. They're
 * STUN-only (lightweight, stateless, no traffic relay), so even though they
 * live at third parties they don't see or carry any chain data.
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export interface SignalingPeerStatus {
  url: string;
  /** True once PeerJS's WebSocket reached `open` for this signaling server. */
  open: boolean;
}

export interface PeerStatus {
  myId: string | null;
  /** Count of direct WebRTC connections currently established. */
  connected: number;
  /**
   * Highest chain height any connected peer has told us about via `hello`.
   * Lets a server-less tab gauge how far behind it is (and whether to show the
   * sync overlay) without consulting a helper server's /tip.
   */
  bestPeerHeight: number;
  serverPeerCount: number;
  /** Active miners across the network as last reported by helper servers. */
  serverMinersActive: number;
  /** Per-signaling-server liveness so the UI can show "K/L signaling up." */
  signalingServers: SignalingPeerStatus[];
}

/**
 * Manages the local browser's PeerJS identity across N independently-operated
 * signaling servers, the live direct WebRTC connections to other browser
 * nodes, and the gossip plumbing in/out.
 *
 * One Peer instance per signaling server, all sharing the **same peer ID**.
 * That way a friend who has our ID can reach us via any signaling server
 * that's still alive — and once any WebRTC channel opens, the signaling
 * server is irrelevant to that connection's continued operation.
 *
 * On start:
 *   1. Spawn one PeerJS client per signaling server; resolve as soon as any
 *      one opens.
 *   2. Pull a unioned `/peers` list from all helper API servers, dial a
 *      handful.
 *   3. Whenever a new block or tx is added locally, broadcast to all peers.
 *   4. Heartbeat every 30s — fan out to all helper API servers.
 */
export class PeerNetwork {
  /** Per-signaling-server PeerJS clients, keyed by signaling base URL. */
  private peers = new Map<string, Peer>();
  /** Track which signaling Peers reached `open`. Used for UI status surface. */
  private opened = new Set<string>();
  /** Single stable peer ID, reused across every Peer instance. */
  private myId: string | null = null;

  private connections = new Map<string, DataConnection>();
  /** Wall-clock ms of the last message received from each connected peer. */
  private lastSeen = new Map<string, number>();
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
  /**
   * Tx hashes we've sent a `getTx` for and are still waiting on. Stops us from
   * re-requesting the same tx from every peer that announces it via `invTxs`.
   * Cleared when the body arrives (or the entry is naturally re-requestable
   * after the peer set churns — we clear on receipt, which covers the common
   * case).
   */
  private requestedTx = new Set<string>();
  /**
   * Peer IDs we've learned about via gossip (or restored from IDB on startup)
   * but haven't necessarily connected to yet. When we drop below MIN_PEERS we
   * try these *before* falling back to the helper servers' /peers list. The
   * whole point: knowing one peer should be enough to find the rest of the
   * mesh, without ever needing the helper servers.
   */
  private candidatePool = new Set<string>();
  /** IDs we've already tried this session — avoid dialing the same dead peer in a loop. */
  private dialedThisSession = new Set<string>();
  /**
   * Outbound dials that have neither opened nor failed yet. Counted toward
   * MAX_PEERS alongside `connections` so a single dial pass — and successive
   * heartbeat passes — never exceed the cap while handshakes are still in
   * flight. Without this, `connections` only grows in the async `open`
   * callback, so the synchronous dial loop sees size 0 and dials the entire
   * candidate pool at once (Chrome then throws "Cannot create so many
   * PeerConnections").
   */
  private dialing = new Set<string>();
  /**
   * Per-dial watchdog timers. `peer-unavailable` fires on the *Peer* object,
   * not the DataConnection, so `conn.on('error')` never runs for the common
   * "dead ID" case — without a timeout the slot in `dialing` would leak
   * forever and starve us down to zero dials. The timer guarantees the slot
   * is freed; `open`/`close`/`error` clear it early when they do fire.
   */
  private dialTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Notified whenever a peer ID is observed (live or learned) so Node can persist it. */
  private peerSeenListeners = new Set<(id: string) => void>();

  constructor(
    private chain: Blockchain,
    private mempool: Mempool,
    private signalingServers: string[],
    /** Used for /heartbeat fan-out and /peers union — owns the API server list. */
    private serverSync: ServerSync,
    /** Called whenever a remote peer causes a state change we should reflect. */
    private onUpdate: () => void,
    /** Polled each heartbeat to tell helpers whether this tab is actively mining. */
    private isMining: () => boolean = () => false,
  ) {
    this.status = {
      myId: null,
      connected: 0,
      bestPeerHeight: 0,
      serverPeerCount: 0,
      serverMinersActive: 0,
      signalingServers: signalingServers.map((url) => ({ url, open: false })),
    };
  }

  getStatus(): PeerStatus {
    return { ...this.status, signalingServers: this.status.signalingServers.map((s) => ({ ...s })) };
  }

  onStatus(fn: (s: PeerStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Subscribe to "peer ID observed" events. Used by Node to persist to IDB. */
  onPeerSeen(fn: (id: string) => void): () => void {
    this.peerSeenListeners.add(fn);
    return () => this.peerSeenListeners.delete(fn);
  }

  /**
   * Seed the candidate pool from IDB on startup. Called by Node before
   * `start()` so the first dial-pass can prefer cached peers over the helper
   * servers' lists. Failed dials evict naturally.
   */
  seedCandidates(ids: string[]): void {
    for (const id of ids) {
      if (id !== this.myId) this.candidatePool.add(id);
    }
  }

  /**
   * Manually dial a single peer by ID. The escape hatch when both WebRTC
   * bootstrap and the server list don't work — users paste each other's IDs
   * in (copied from Discord, Signal, etc.). Resolves to whether the
   * connection opened within the timeout.
   *
   * Tries each registered signaling Peer in sequence: a peer might only be
   * discoverable via signaling server X, so dialing via signaling Y would
   * silently fail.
   */
  async dialPeer(id: string, timeoutMs = DIAL_TIMEOUT_MS): Promise<boolean> {
    if (!this.myId) return false;
    if (id === this.myId) return false;
    if (this.connections.has(id)) return true;
    if (this.peers.size === 0) return false;

    for (const peer of this.peers.values()) {
      const ok = await new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (v: boolean): void => { if (!settled) { settled = true; resolve(v); } };
        const timer = setTimeout(() => done(false), timeoutMs);
        try {
          const conn = peer.connect(id, { reliable: true });
          conn.on('open', () => { clearTimeout(timer); done(true); });
          conn.on('error', () => { clearTimeout(timer); done(false); });
          this.adoptConnection(conn);
        } catch {
          clearTimeout(timer);
          done(false);
        }
      });
      if (ok) return true;
      // Otherwise try the next signaling server.
    }
    return false;
  }

  private emit(): void {
    const s = this.getStatus();
    for (const fn of this.statusListeners) fn(s);
  }

  async start(): Promise<void> {
    if (this.signalingServers.length === 0) {
      // No signaling configured — nothing we can do for new connections. Existing
      // already-formed connections (if any) would survive, but at startup there
      // are none. Surface as "not started" and let the caller handle.
      throw new Error('no signaling servers configured');
    }

    // One stable ID reused across every signaling Peer instance, so a cached/
    // shared ID resolves to the same browser regardless of which signaling
    // server the dialer uses.
    this.myId = PEER_PREFIX + Math.random().toString(36).slice(2, 12);
    this.status.myId = this.myId;

    // Spawn one Peer per signaling server. We resolve start() as soon as the
    // first one opens — others continue connecting in the background. Reject
    // only if every single one fails.
    const opens = this.signalingServers.map((url) => this.spawnPeer(url));
    await firstSuccess(opens, 'all signaling servers unreachable');

    // After at least one signaling Peer is live, kick off the first peer-
    // discovery dial pass and the periodic background tasks.
    await this.dialFromBootstrap();

    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
      this.pingAndReapStalePeers();
      if (this.connections.size < MIN_PEERS) {
        void this.dialFromBootstrap();
      }
    }, HEARTBEAT_MS);

    // Periodic mempool re-flood: covers peers who connected after a tx was
    // first broadcast, and peers who briefly dropped and reconnected.
    // Receivers dedupe via mempool.has(), so this is cheap and self-bounding.
    this.txRebroadcastTimer = setInterval(() => {
      // Drop stale in-flight requests so an unanswered `getTx` (peer vanished
      // mid-response) gets retried on the next `invTxs` instead of being
      // wedged forever. Also bounds the set's memory.
      this.requestedTx.clear();
      this.announceMempool();
    }, TX_REBROADCAST_MS);

    // Send a first heartbeat right away to register ourselves on every API server.
    void this.heartbeat();
  }

  /**
   * Construct one PeerJS client pointed at a single signaling server. Returns
   * a promise that resolves when that client reaches `open` and rejects if it
   * errors before opening. After `open`, errors are warnings only — the
   * connection might recover, and other signaling servers are still alive.
   */
  private spawnPeer(signalingUrl: string): Promise<void> {
    const url = new URL(signalingUrl);
    const peer = new Peer(this.myId!, {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      path: '/peerjs',
      secure: url.protocol === 'https:',
      config: { iceServers: ICE_SERVERS },
    });
    this.peers.set(signalingUrl, peer);

    return new Promise<void>((resolve, reject) => {
      let opened = false;
      peer.on('open', () => {
        opened = true;
        this.opened.add(signalingUrl);
        this.markSignalingOpen(signalingUrl, true);
        resolve();
      });
      peer.on('error', (err) => {
        console.warn('[peer]', signalingUrl, 'error', err.type, err.message);
        // `peer-unavailable` fires here (on the Peer, not the DataConnection)
        // and names the dead ID in its message. Free its dial slot right away
        // instead of waiting out the watchdog, so a stale-heavy candidate pool
        // churns at full width rather than 8-every-DIAL_TIMEOUT_MS.
        if (err.type === 'peer-unavailable') {
          const deadId = err.message.split(' ').pop();
          if (deadId && deadId.startsWith(PEER_PREFIX)) this.releaseDial(deadId);
        }
        if (!opened) {
          this.markSignalingOpen(signalingUrl, false);
          reject(err);
        }
      });
      peer.on('disconnected', () => {
        this.opened.delete(signalingUrl);
        this.markSignalingOpen(signalingUrl, false);
        // PeerJS will auto-reconnect by default; we just reflect the gap.
      });
      peer.on('connection', (conn) => this.adoptConnection(conn));
    });
  }

  private markSignalingOpen(url: string, open: boolean): void {
    const entry = this.status.signalingServers.find((s) => s.url === url);
    if (entry) entry.open = open;
    this.emit();
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.txRebroadcastTimer) clearInterval(this.txRebroadcastTimer);
    this.txRebroadcastTimer = null;
    for (const c of this.connections.values()) c.close();
    this.connections.clear();
    this.lastSeen.clear();
    for (const t of this.dialTimers.values()) clearTimeout(t);
    this.dialTimers.clear();
    this.dialing.clear();
    for (const peer of this.peers.values()) {
      try { peer.destroy(); } catch { /* ignore */ }
    }
    this.peers.clear();
    this.opened.clear();
    this.myId = null;
    this.status.myId = null;
    this.status.connected = 0;
    for (const s of this.status.signalingServers) s.open = false;
    this.emit();
  }

  /**
   * Replace the signaling-server list. Tears down all current Peer instances
   * and rebuilds. As a side effect, all current direct WebRTC connections
   * close — they were owned by Peer instances that are being destroyed. The
   * fresh setup will re-dial known peers as soon as the new Peers open.
   */
  async setSignalingServers(urls: string[]): Promise<void> {
    this.signalingServers = urls;
    this.status.signalingServers = urls.map((url) => ({ url, open: false }));
    this.stop();
    if (urls.length === 0) {
      this.emit();
      return;
    }
    await this.start();
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

  /**
   * Announce our pending-tx hashes (not bodies) to peers via a single batched
   * `invTxs`. Peers reply `getTx` for the ones they're missing — so a peer that
   * joined after a sender broadcast still learns about the pending tx, and the
   * periodic re-announce costs ~32 B/tx instead of re-flooding full bodies.
   */
  private announceMempool(to?: DataConnection): void {
    const targets = to ? [to] : [...this.connections.values()];
    if (targets.length === 0) return;
    const hashes = this.mempool.hashes();
    if (hashes.length === 0) return;
    const msg: ProtoMsg = { t: 'invTxs', hashes };
    for (const c of targets) {
      try { c.send(msg); } catch { /* ignore */ }
    }
  }

  /**
   * On hearing a tx hash we don't have, ask the announcing peer for the body —
   * unless we already have it pooled or a `getTx` for it is already outstanding.
   */
  private requestTxIfMissing(hashHex: string, from: DataConnection): void {
    if (this.mempool.has(hashHex)) return;
    if (this.requestedTx.has(hashHex)) return;
    this.requestedTx.add(hashHex);
    try {
      from.send({ t: 'getTx', hash: hashHex } satisfies ProtoMsg);
    } catch {
      // Peer went away mid-request; allow a re-request when another peer
      // announces the same hash.
      this.requestedTx.delete(hashHex);
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

  /**
   * Pick any healthy Peer to use as the outbound-dial origin. PeerJS uses
   * whichever Peer instance you called `.connect()` on as the signaling
   * channel for that handshake.
   */
  private anyOpenPeer(): Peer | null {
    for (const [url, peer] of this.peers) {
      if (this.opened.has(url)) return peer;
    }
    return null;
  }

  private async dialFromBootstrap(): Promise<void> {
    // Three-source candidate gathering: the locally-known pool (gossip + IDB
    // cache) first, then a unioned /peers list from every helper API server.
    // If every helper is down the gossip path alone can still keep an
    // established mesh discoverable.
    const fresh: string[] = [];
    for (const id of this.candidatePool) {
      if (id === this.myId) continue;
      if (this.connections.has(id)) continue;
      if (this.dialedThisSession.has(id)) continue;
      fresh.push(id);
    }

    const serverPeers = await this.serverSync.fetchPeers();
    for (const id of serverPeers) {
      if (id === this.myId) continue;
      if (this.connections.has(id)) continue;
      if (this.dialedThisSession.has(id)) continue;
      if (!fresh.includes(id)) fresh.push(id);
    }

    if (fresh.length === 0) return;

    // Shuffle so we don't hammer the same subset of IDs from every tab.
    for (let i = fresh.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [fresh[i], fresh[j]] = [fresh[j]!, fresh[i]!];
    }
    const origin = this.anyOpenPeer();
    if (!origin) return; // no signaling open right now; try again next heartbeat
    for (const id of fresh) {
      // Count in-flight dials, not just opened connections — see `dialing`.
      if (this.connections.size + this.dialing.size >= MAX_PEERS) break;
      this.dialedThisSession.add(id);
      this.beginDial(id);
      const conn = origin.connect(id, { reliable: true });
      this.adoptConnection(conn);
    }
  }

  /** Reserve a MAX_PEERS slot for an outbound dial and arm its watchdog. */
  private beginDial(id: string): void {
    this.dialing.add(id);
    this.dialTimers.set(
      id,
      setTimeout(() => this.releaseDial(id), DIAL_TIMEOUT_MS),
    );
  }

  /** Free a dial's slot and cancel its watchdog. Idempotent; safe for IDs
   *  that were never dialed (inbound / targeted connections call this too). */
  private releaseDial(id: string): void {
    this.dialing.delete(id);
    const t = this.dialTimers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      this.dialTimers.delete(id);
    }
  }

  private adoptConnection(conn: DataConnection): void {
    conn.on('open', () => {
      // Handshake resolved — release the dial slot (no-op for inbound conns).
      this.releaseDial(conn.peer);
      // Dedup: a remote peer might reach us via two different signaling
      // servers in quick succession. Keep the first; close the rest.
      const existing = this.connections.get(conn.peer);
      if (existing && existing !== conn) {
        try { conn.close(); } catch { /* ignore */ }
        return;
      }
      this.connections.set(conn.peer, conn);
      this.lastSeen.set(conn.peer, Date.now());
      this.candidatePool.add(conn.peer);
      this.status.connected = this.connections.size;
      this.emit();
      // Persist this peer so a future page-load can dial it directly without
      // waiting on a helper server's /peers. Listener fires async.
      for (const fn of this.peerSeenListeners) {
        try { fn(conn.peer); } catch { /* listener shouldn't crash gossip */ }
      }
      // Say hello with our chain tip so the peer can decide to sync.
      const tip = this.chain.tip;
      conn.send({
        t: 'hello',
        height: tip.block.header.height,
        tipHash: bytesToHex(tip.hash),
        chainId: CHAIN_ID,
      } satisfies ProtoMsg);
      // Ask for more peer IDs so we can broaden the mesh independently of any
      // helper server.
      conn.send({ t: 'getAddrs', max: 32 } satisfies ProtoMsg);
      // Ask for signed helper candidates too. Peers can only expand our
      // candidate cache; helper records still need signature/network checks.
      conn.send({ t: 'getHelpers', max: 50 } satisfies ProtoMsg);
      // Announce our mempool tx hashes to the new peer. Without this, a peer
      // joining 1s after a sender broadcasts never hears about the pending tx
      // and won't include it when it mines. They `getTx` whatever they lack.
      this.announceMempool(conn);
    });
    conn.on('data', (data) => this.onIncoming(conn, data as ProtoMsg));
    conn.on('close', () => {
      // Free the dial slot whether or not the conn ever reached `open`.
      this.releaseDial(conn.peer);
      // Only remove if this exact DataConnection is the one we have stored
      // (might already have been replaced by a dedup race).
      if (this.connections.get(conn.peer) === conn) {
        this.connections.delete(conn.peer);
        this.lastSeen.delete(conn.peer);
        this.status.connected = this.connections.size;
        this.emit();
      }
    });
    conn.on('error', (e) => {
      this.releaseDial(conn.peer);
      console.warn('[peer] conn error', conn.peer, e.message);
    });
  }

  private onIncoming(conn: DataConnection, msg: ProtoMsg): void {
    // Any traffic at all proves the peer is still alive — refresh freshness
    // before dispatch so even a bare pong counts.
    if (this.connections.get(conn.peer) === conn) {
      this.lastSeen.set(conn.peer, Date.now());
    }
    try {
      switch (msg.t) {
        case 'hello':
          if (msg.chainId !== CHAIN_ID) {
            conn.close();
            return;
          }
          // Record the peer's height so a server-less node can tell how far
          // behind it is (drives the sync overlay) without asking a server.
          if (msg.height > this.status.bestPeerHeight) {
            this.status.bestPeerHeight = msg.height;
            this.emit();
          }
          if (msg.height > this.chain.height && !this.chain.hasBlock(msg.tipHash)) {
            // If the peer is more than one block ahead, prefer a range pull —
            // dramatically faster than walking back one parent at a time via
            // the orphan pool. The single-block path stays as the fallback
            // when the gap is small or when the range response is empty.
            if (msg.height > this.chain.height + 1) {
              conn.send({
                t: 'getBlocks',
                fromHeight: this.chain.height + 1,
                max: 64,
              } satisfies ProtoMsg);
            } else {
              conn.send({ t: 'getBlock', hash: msg.tipHash } satisfies ProtoMsg);
            }
          }
          break;

        case 'tx': {
          const tx = decodeTxMsg(msg);
          const hashHex = bytesToHex(txHash(tx));
          // The body arrived — no longer awaiting it.
          this.requestedTx.delete(hashHex);
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

        case 'getBlocks': {
          // Range serve: walk canonical from fromHeight forward. Cap at the
          // caller's max OR 64 (whichever's smaller) to bound message size.
          const max = Math.max(1, Math.min(64, msg.max | 0));
          const fromHeight = Math.max(0, msg.fromHeight | 0);
          // iterateCanonical() walks newest-first; collect then reverse so the
          // response is height-ascending (matches server /blocks behaviour).
          const collected: Block[] = [];
          for (const cb of this.chain.iterateCanonical()) {
            if (cb.block.header.height < fromHeight) break;
            collected.push(cb.block);
            if (collected.length >= max + 32) break; // small over-fetch then trim
          }
          collected.reverse();
          const slice = collected.slice(0, max);
          if (slice.length > 0) {
            conn.send({
              t: 'blocks',
              data: slice.map((b) => bytesToHex(encodeBlock(b))),
            } satisfies ProtoMsg);
          }
          break;
        }

        case 'blocks': {
          // Apply in order. handleIncomingBlock already does parent-gap orphan
          // parking, so even if the first block in the batch has an unknown
          // parent we'll backfill via getBlock on the originating peer.
          void (async () => {
            for (const hex of msg.data) {
              let block: Block;
              try { block = decodeBlock(hexToBytes(hex)); }
              catch { continue; }
              await this.handleIncomingBlock(block, conn);
            }
          })();
          break;
        }

        case 'getAddrs': {
          const max = Math.max(1, Math.min(64, msg.max | 0));
          const peers: string[] = [];
          for (const id of this.connections.keys()) {
            if (id === conn.peer) continue; // don't bounce them back to themselves
            peers.push(id);
            if (peers.length >= max) break;
          }
          if (peers.length > 0) {
            conn.send({ t: 'addrs', peers } satisfies ProtoMsg);
          }
          break;
        }

        case 'addrs': {
          for (const id of msg.peers) {
            if (typeof id !== 'string') continue;
            if (id === this.myId) continue;
            if (this.connections.has(id)) continue;
            this.candidatePool.add(id);
            // Persist newly-learned peers too, so a future page load can use
            // them directly (helper /peers stops being the single source).
            for (const fn of this.peerSeenListeners) {
              try { fn(id); } catch { /* ignore */ }
            }
          }
          // If we're below MIN_PEERS, kick a dial pass — we just got more
          // candidates and shouldn't wait for the heartbeat tick.
          if (this.connections.size < MIN_PEERS) {
            void this.dialFromBootstrap();
          }
          break;
        }

        case 'getHelpers': {
          const max = Math.max(1, Math.min(50, msg.max | 0));
          try { conn.send(encodeHelpersMsg(loadCachedHelperRecords().slice(0, max))); } catch { /* ignore */ }
          break;
        }

        case 'helpers': {
          const merged = mergeHelperRecords(loadCachedHelperRecords(), decodeHelpersMsg(msg), {
            nowSeconds: Math.floor(Date.now() / 1000),
            network: HELPER_DISCOVERY_NETWORK,
            source: 'peer',
          });
          saveCachedHelperRecords(merged.records);
          break;
        }

        case 'ping':
          try { conn.send({ t: 'pong' } satisfies ProtoMsg); } catch { /* ignore */ }
          break;

        case 'pong':
          // lastSeen already refreshed at the top of the switch.
          break;

        case 'invTx':
          this.requestTxIfMissing(msg.hash, conn);
          break;

        case 'invTxs':
          for (const hash of msg.hashes) {
            if (typeof hash !== 'string') continue;
            this.requestTxIfMissing(hash, conn);
          }
          break;

        case 'getTx': {
          // Serve the full body if we have it pending. (Confirmed txs aren't
          // kept around — the peer will learn them via block sync instead.)
          const tx = this.mempool.get(msg.hash);
          if (tx) {
            try { conn.send(encodeTxMsg(tx)); } catch { /* ignore */ }
          }
          break;
        }

        case 'getHeaders':
        case 'headers':
        case 'invBlock':
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
      // Mempool reconciliation happens in the chain's onTipChanged handler
      // (wired by Node) — only canonical-confirmed txs are evicted there.
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
      // Mempool reconciliation happens in the chain's onTipChanged handler.
      cursor = bytesToHex(hashHeader(waiting.header));
    }
  }

  /**
   * Walk every direct connection: drop ones we haven't heard from in
   * PEER_STALE_MS, and send a ping to the rest so a peer with no other traffic
   * still produces a pong that refreshes their freshness. Critical because
   * WebRTC's own close detection is delayed (and sometimes absent) when a
   * remote tab is closed or its network drops — without this the UI peer
   * count never decreases.
   */
  private pingAndReapStalePeers(): void {
    const now = Date.now();
    let reaped = false;
    for (const [id, conn] of this.connections) {
      const seen = this.lastSeen.get(id) ?? now;
      if (now - seen > PEER_STALE_MS) {
        try { conn.close(); } catch { /* ignore */ }
        this.connections.delete(id);
        this.lastSeen.delete(id);
        reaped = true;
        continue;
      }
      try { conn.send({ t: 'ping' } satisfies ProtoMsg); } catch { /* ignore */ }
    }
    if (reaped) {
      this.status.connected = this.connections.size;
      this.emit();
    }
  }

  /**
   * Heartbeat — fans out to all helper API servers via ServerSync, then
   * pulls aggregated stats back to surface network-wide peer/miner counts.
   */
  private async heartbeat(): Promise<void> {
    if (!this.myId) return;
    const stats = await this.serverSync.heartbeat({
      id: this.myId,
      height: this.chain.height,
      mining: this.isMining(),
    });
    if (stats) {
      this.status.serverPeerCount = stats.peerCount;
      this.status.serverMinersActive = stats.minersActive;
      this.emit();
    }
  }
}

/**
 * Resolve as soon as any one of the input promises fulfills. Reject only if
 * every single one rejects. Equivalent to `Promise.any` semantics but
 * preserves the rejection list for diagnostic purposes.
 */
async function firstSuccess<T>(promises: Promise<T>[], allFailedMsg: string): Promise<T> {
  // Promise.any is ES2021 and available everywhere we care about, but its
  // AggregateError isn't supported in some toolchains — wrap it just in case.
  try {
    return await Promise.any(promises);
  } catch {
    throw new Error(allFailedMsg);
  }
}
