import { ICE_SERVERS } from './ice.js';
import { MeshConn } from './meshConn.js';
import type {
  OpenOffer,
  PeerConn,
  SignalContext,
  SignalTransport,
} from './types.js';

/**
 * Turns signaling substrates into peer connections.
 *
 * The dialer owns every `RTCPeerConnection` that isn't PeerJS's, and runs the
 * swarm handshake described in `types.ts`: publish open offers, answer other
 * people's open offers, hand the resulting data channel to `peer.ts` as a
 * `PeerConn`. It knows nothing about which substrate carried the bytes, and
 * the substrates know nothing about WebRTC.
 *
 * Everything here is best-effort by construction. Offers expire, answers get
 * lost, relays drop frames, and peers vanish mid-handshake — so every path
 * either completes or is reaped on a timer, and none of them can wedge the
 * dialer into a state where it stops trying.
 */

/**
 * How many offers we keep live at once. Each is a real RTCPeerConnection
 * holding ICE state, so this is not free; but publishing only one means a
 * single peer grabbing it leaves us invisible until the next republish. Four
 * lets a handful of newcomers connect to us in the same round without letting
 * a popular node accumulate dozens of half-open connections.
 */
const OFFER_POOL = 4;
/** Give up on ICE gathering after this and publish whatever we have. */
const GATHER_TIMEOUT_MS = 5_000;
/** An unanswered offer is stale well before this; republish rather than hold. */
const OFFER_TTL_MS = 150_000;
/** An answered-but-never-opened connection is dead. Reap it. */
const PENDING_TTL_MS = 45_000;
const SWEEP_MS = 15_000;

interface PendingOffer {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  createdAt: number;
  /** Set once someone answers, so the sweeper uses the shorter TTL. */
  answeredAt: number | null;
  /** Peer id of whoever answered — the identity we adopt the link under. */
  answeredBy?: string;
}

interface PendingAnswer {
  pc: RTCPeerConnection;
  createdAt: number;
}

export interface SwarmOptions {
  /** Our peer id — the same one PeerJS uses, so dedupe works across both. */
  selfId: string;
  /**
   * Whether we currently want more peers. Consulted before publishing offers
   * and before answering someone else's, so a well-connected node stops
   * advertising instead of collecting links it will immediately close.
   */
  wantsPeers: () => boolean;
  /** Called when a mesh link is live and ready to be adopted by peer.ts. */
  onConnection: (conn: PeerConn) => void;
  /** True if we already hold (or are dialing) this peer via any path. */
  hasPeer: (id: string) => boolean;
}

export class SignalSwarm {
  private transports: SignalTransport[] = [];
  private offers = new Map<string, PendingOffer>();
  private answering = new Map<string, PendingAnswer>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(private opts: SwarmOptions) {}

  /**
   * Start every transport. Resolves if at least one comes up, rejects only if
   * they all fail — the same "any is enough" contract the signaling-server list
   * already uses, so a node with one working substrate is fully operational.
   */
  async start(transports: SignalTransport[]): Promise<void> {
    this.transports = transports;
    this.started = true;
    const ctx: SignalContext = {
      selfId: this.opts.selfId,
      onOffer: (from, offerId, sdp) => { void this.onOffer(from, offerId, sdp); },
      onAnswer: (from, offerId, sdp) => { void this.onAnswer(from, offerId, sdp); },
    };

    const results = await Promise.allSettled(
      transports.map((t) =>
        t.start(ctx).catch((e: Error) => {
          console.warn('[swarm]', t.id, 'failed to start:', e.message);
          throw e;
        }),
      ),
    );
    if (!results.some((r) => r.status === 'fulfilled')) {
      this.started = false;
      throw new Error('no signaling substrate available');
    }

    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    await this.refillOffers();
  }

  stop(): void {
    this.started = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const t of this.transports) {
      try { t.stop(); } catch { /* transport already down */ }
    }
    this.transports = [];
    for (const o of this.offers.values()) {
      try { o.pc.close(); } catch { /* ignore */ }
    }
    this.offers.clear();
    for (const a of this.answering.values()) {
      try { a.pc.close(); } catch { /* ignore */ }
    }
    this.answering.clear();
  }

  /** Live transports, for the network status panel. */
  status(): Array<{ id: string; label: string; up: boolean; endpoints: Array<{ url: string; up: boolean }> }> {
    return this.transports.map((t) => ({
      id: t.id,
      label: t.label,
      up: t.isUp(),
      endpoints: t.endpoints(),
    }));
  }

  /**
   * Top the offer pool back up and republish it. Called at startup, after a
   * peer is taken, and whenever the sweeper expires an offer.
   */
  private async refillOffers(): Promise<void> {
    if (!this.started) return;
    if (!this.opts.wantsPeers()) {
      // Well connected — go quiet in both directions. Existing offers stay
      // live so an in-flight answer still lands, but we stop minting new ones
      // and stop listening to everyone else's, which is what keeps substrate
      // load proportional to demand rather than to network size.
      this.setActive(false);
      return;
    }
    this.setActive(true);
    while (this.offers.size < OFFER_POOL) {
      const made = await this.mintOffer();
      if (!made) break; // WebRTC refused; try again on the next sweep
    }
    this.publishAll();
  }

  private setActive(active: boolean): void {
    for (const t of this.transports) {
      try { t.setActive(active); } catch (e) {
        console.warn('[swarm]', t.id, 'setActive failed:', (e as Error).message);
      }
    }
  }

  /** Create one RTCPeerConnection, gather, and park it as an open offer. */
  private async mintOffer(): Promise<boolean> {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch (e) {
      console.warn('[swarm] cannot create peer connection:', (e as Error).message);
      return false;
    }
    const offerId = randomId();
    try {
      const dc = pc.createDataChannel('browsercoin', { ordered: true });
      await pc.setLocalDescription(await pc.createOffer());
      await gatherComplete(pc, GATHER_TIMEOUT_MS);
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error('no local description after gathering');

      this.offers.set(offerId, { pc, dc, createdAt: Date.now(), answeredAt: null });
      // The channel opening is what tells us the far side accepted; until then
      // this is just a parked offer.
      dc.onopen = () => this.adoptOffered(offerId, dc, pc);
      return true;
    } catch (e) {
      console.warn('[swarm] mint offer failed:', (e as Error).message);
      try { pc.close(); } catch { /* ignore */ }
      this.offers.delete(offerId);
      return false;
    }
  }

  private publishAll(): void {
    const batch: OpenOffer[] = [];
    for (const [offerId, o] of this.offers) {
      if (o.answeredAt !== null) continue; // taken; don't re-advertise
      const sdp = o.pc.localDescription?.sdp;
      if (sdp) batch.push({ offerId, sdp });
    }
    for (const t of this.transports) {
      try { t.publishOffers(batch); } catch (e) {
        console.warn('[swarm]', t.id, 'publish failed:', (e as Error).message);
      }
    }
  }

  /** Someone answered one of our offers and the channel came up. */
  private adoptOffered(offerId: string, dc: RTCDataChannel, pc: RTCPeerConnection): void {
    const entry = this.offers.get(offerId);
    this.offers.delete(offerId);
    if (!entry) {
      // Already reaped — close rather than leak a connection nobody tracks.
      try { pc.close(); } catch { /* ignore */ }
      return;
    }
    const remoteId = entry.answeredBy ?? null;
    if (!remoteId) {
      try { pc.close(); } catch { /* ignore */ }
      return;
    }
    this.opts.onConnection(new MeshConn(remoteId, dc, pc));
    void this.refillOffers();
  }

  /** A remote peer published an offer we might take. */
  private async onOffer(from: string, offerId: string, sdp: string): Promise<void> {
    if (!this.started) return;
    if (from === this.opts.selfId) return;
    if (!this.opts.wantsPeers()) return;
    if (this.opts.hasPeer(from)) return;
    // One handshake per peer at a time. A peer publishes a batch of offers and
    // every relay echoes each one, so without this we'd answer the same node
    // four times over and immediately close three of the results.
    if (this.answering.has(from)) return;

    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch (e) {
      console.warn('[swarm] cannot create peer connection:', (e as Error).message);
      return;
    }
    this.answering.set(from, { pc, createdAt: Date.now() });

    pc.ondatachannel = (ev) => {
      this.answering.delete(from);
      const dc = ev.channel;
      const conn = new MeshConn(from, dc, pc);
      // The channel may already be open by the time this fires; MeshConn
      // handles both orderings.
      this.opts.onConnection(conn);
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gatherComplete(pc, GATHER_TIMEOUT_MS);
      const answerSdp = pc.localDescription?.sdp;
      if (!answerSdp) throw new Error('no local description after gathering');
      for (const t of this.transports) {
        try {
          t.publishAnswer({ toPeer: from, offerId, sdp: answerSdp });
        } catch (e) {
          console.warn('[swarm]', t.id, 'answer failed:', (e as Error).message);
        }
      }
    } catch (e) {
      console.warn('[swarm] answering', from, 'failed:', (e as Error).message);
      this.answering.delete(from);
      try { pc.close(); } catch { /* ignore */ }
    }
  }

  /** A remote peer answered one of our open offers. */
  private async onAnswer(from: string, offerId: string, sdp: string): Promise<void> {
    const entry = this.offers.get(offerId);
    if (!entry) return; // expired, or an answer to an offer we already gave away
    if (entry.answeredAt !== null) return; // first answer wins
    if (this.opts.hasPeer(from)) return;
    entry.answeredAt = Date.now();
    entry.answeredBy = from;
    try {
      await entry.pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (e) {
      console.warn('[swarm] bad answer from', from, (e as Error).message);
      entry.answeredAt = null;
      entry.answeredBy = undefined;
    }
  }

  /** Reap expired offers and stalled handshakes, then top the pool back up. */
  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [offerId, o] of this.offers) {
      const ttl = o.answeredAt === null ? OFFER_TTL_MS : PENDING_TTL_MS;
      const since = o.answeredAt ?? o.createdAt;
      if (now - since <= ttl) continue;
      try { o.pc.close(); } catch { /* ignore */ }
      this.offers.delete(offerId);
      changed = true;
    }
    for (const [peer, a] of this.answering) {
      if (now - a.createdAt <= PENDING_TTL_MS) continue;
      try { a.pc.close(); } catch { /* ignore */ }
      this.answering.delete(peer);
    }
    if (changed || this.offers.size < OFFER_POOL) void this.refillOffers();
  }
}

/**
 * Resolve when ICE gathering finishes, or after `timeoutMs` with whatever
 * candidates we have. We publish complete descriptions rather than trickling,
 * so this is the one place setup latency is spent — a second or two, which is
 * nothing for a gossip mesh and saves an order of magnitude of relay traffic.
 */
export function gatherComplete(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = (): void => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

function randomId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
