import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '../../crypto/hash.js';
import { bytesToHex, hexToBytes } from '../../util/binary.js';
import { compactFromSdp, sdpFromCompact } from './sdp.js';
import { BROWSERCOIN_NETWORK } from '../network.js';
import type {
  OpenOffer,
  SignalAnswer,
  SignalContext,
  SignalEndpointStatus,
  SignalTransport,
} from './types.js';

/**
 * Nostr relays as a signaling substrate.
 *
 * Nostr is a good fit for reasons that have nothing to do with social media:
 * there are hundreds of independently-operated public relays, writes are
 * permissionless by design rather than by courtesy, the wire protocol is four
 * JSON message types over a plain WebSocket, and the spec already reserves an
 * event range (kinds 20000–29999) for exactly this — "ephemeral" events that
 * relays forward to current subscribers and are explicitly not expected to
 * store. We are a well-behaved user of that range, not a squatter in it.
 *
 * WebSocket is not subject to CORS, so a browserCoin tab can reach any of them
 * from any origin — including from a page opened straight off the filesystem.
 *
 * No relay is trusted. A relay can decline to forward our offers, or forward
 * only offers from peers it likes, which is a partition/eclipse risk exactly
 * like a hostile DNS seed in Bitcoin. It is bounded the same way: we run many
 * relays at once, we keep the other substrates alongside, and every block that
 * arrives over a link brokered here is validated locally, so the worst a relay
 * can do is fail to introduce us to people.
 */

/** Ephemeral kind: relays forward to live subscribers and drop, never store. */
const KIND_SIGNAL = 20808;

/**
 * Default relays. Chosen for independent operators across different hosts and
 * jurisdictions rather than for popularity — the point of the list is that no
 * single failure or single operator takes signaling down. Users can replace it
 * entirely in Settings; the list is a seed, not an authority.
 */
export const DEFAULT_NOSTR_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
  'wss://nostr.wine',
  'wss://relay.snort.social',
];

/** Re-announce cadence. Ephemeral events reach only current subscribers, so a
 *  node that joins after our last publish learns nothing until the next one. */
const REPUBLISH_MS = 45_000;
/** Ignore anything older than this, so a laggy relay can't replay stale SDP. */
const MAX_EVENT_AGE_S = 120;
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 120_000;
/** Bound the dedupe set so a long-lived tab doesn't grow it without limit. */
const MAX_SEEN_IDS = 4_000;
/** Drop oversized frames before parsing — a hostile relay could stream junk. */
const MAX_FRAME_BYTES = 256 * 1024;

interface SignalPayload {
  v: 1;
  /** Publisher's browserCoin peer id (matches the PeerJS id for dedupe). */
  from: string;
  /** Open offers, when this is an announce. */
  offers?: Array<{ o: string; s: string }>;
  /** Answer fields, when this is a reply to one specific offer. */
  to?: string;
  a?: string;
  s?: string;
}

/**
 * Derive the AES key that wraps every payload, from the network name alone.
 *
 * This is deliberately *obfuscation*, not confidentiality: the key is
 * derivable by anyone who reads this file. Its job is to keep browserCoin
 * nodes' public IP addresses — which appear in SDP candidate lines — out of
 * the plaintext firehose that public relays expose to any scraper, and out of
 * the permanent archives that index it. A determined observer who wants our
 * node list can still have it; a bulk collector who is hoovering up all Nostr
 * traffic gets ciphertext instead of a ready-made map of every node's IP.
 *
 * Worth being clear-eyed: PeerJS signaling already showed our IP to whoever
 * ran the server, so this is not a regression either way. It is a small,
 * cheap improvement over publishing it in the clear.
 */
async function topicKey(network: string): Promise<CryptoKey> {
  const raw = sha256(new TextEncoder().encode(`browsercoin-signal-v1:${network}`));
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Tag value every node subscribes to. Public — it's the rendezvous point. */
export function signalTopic(network: string): string {
  return `browsercoin-${bytesToHex(sha256(new TextEncoder().encode(network))).slice(0, 16)}`;
}

/**
 * base64 rather than hex: hex would double the payload while base64 adds only
 * a third. Descriptions are already compacted by `sdp.ts` before they get
 * here, so a four-offer batch is a few hundred bytes rather than several KB;
 * over six relays every 45 seconds, on infrastructure we don't pay for, both
 * savings are worth the ten lines.
 * Chunked so a large payload can't blow the argument limit on `fromCharCode`.
 */
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sealPayload(key: CryptoKey, payload: SignalPayload): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt as BufferSource),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64(out);
}

export async function openPayload(key: CryptoKey, b64: string): Promise<SignalPayload | null> {
  try {
    const buf = fromBase64(b64);
    if (buf.length < 13) return null;
    const iv = buf.slice(0, 12);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      buf.slice(12) as BufferSource,
    );
    const parsed = JSON.parse(new TextDecoder().decode(pt)) as unknown;
    return isSignalPayload(parsed) ? parsed : null;
  } catch {
    // Wrong network, wrong version, corrupt frame, or simply not ours. All the
    // same to us: ignore it. Relays carry everyone's traffic, so seeing
    // undecryptable events is the normal case, not an error worth logging.
    return null;
  }
}

function isSignalPayload(v: unknown): v is SignalPayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  if (p.v !== 1 || typeof p.from !== 'string' || p.from.length === 0 || p.from.length > 128) {
    return false;
  }
  if (p.offers !== undefined) {
    if (!Array.isArray(p.offers) || p.offers.length > 16) return false;
    for (const o of p.offers) {
      if (!o || typeof o !== 'object') return false;
      const e = o as Record<string, unknown>;
      if (typeof e.o !== 'string' || typeof e.s !== 'string') return false;
    }
  }
  if (p.to !== undefined && typeof p.to !== 'string') return false;
  if (p.a !== undefined && typeof p.a !== 'string') return false;
  if (p.s !== undefined && typeof p.s !== 'string') return false;
  return true;
}

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Build a signed Nostr event. Exported for tests. */
export function buildEvent(
  secretKey: Uint8Array,
  kind: number,
  tags: string[][],
  content: string,
  createdAt: number,
): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
  // NIP-01 id: sha256 of a canonical, compact JSON array. Field order is fixed
  // by the spec — JSON.stringify on an array gives exactly that, with no
  // whitespace, so no custom serializer is needed.
  const serialized = JSON.stringify([0, pubkey, createdAt, kind, tags, content]);
  const id = bytesToHex(sha256(new TextEncoder().encode(serialized)));
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey));
  return { id, pubkey, created_at: createdAt, kind, tags, content, sig };
}

export class NostrTransport implements SignalTransport {
  readonly id = 'nostr';
  readonly label = 'Nostr relays';

  private sockets = new Map<string, WebSocket>();
  private up = new Set<string>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectDelay = new Map<string, number>();
  private ctx: SignalContext | null = null;
  private key: CryptoKey | null = null;
  private topic = '';
  private republishTimer: ReturnType<typeof setInterval> | null = null;
  private lastOffers: OpenOffer[] = [];
  private seenIds = new Set<string>();
  private stopped = false;
  /**
   * Whether we're currently subscribed to other people's offers. Starts true —
   * a node that just came up has no peers and is definitionally looking — and
   * the swarm flips it off as soon as we hit the peer target.
   */
  private active = true;

  /**
   * Throwaway per-session Nostr keypair. We are not building a Nostr identity —
   * the relay needs a valid signature to accept an event, and that is all this
   * is for. A fresh key per session also means our signaling traffic isn't
   * linkable across sessions by pubkey.
   */
  private secretKey: Uint8Array = schnorr.utils.randomSecretKey();

  constructor(
    private relays: string[] = DEFAULT_NOSTR_RELAYS,
    private network: string = BROWSERCOIN_NETWORK,
  ) {}

  async start(ctx: SignalContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    this.key = await topicKey(this.network);
    this.topic = signalTopic(this.network);

    // Open every relay in parallel and resolve as soon as one is usable. A
    // relay that is slow or down must never hold up the others.
    const opens = this.relays.map((url) => this.connect(url));
    try {
      await Promise.any(opens);
    } catch {
      throw new Error('no nostr relay reachable');
    }

    this.republishTimer = setInterval(() => {
      if (this.lastOffers.length > 0) this.publishOffers(this.lastOffers);
    }, REPUBLISH_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.republishTimer) clearInterval(this.republishTimer);
    this.republishTimer = null;
    for (const t of this.reconnectTimers.values()) clearTimeout(t);
    this.reconnectTimers.clear();
    this.reconnectDelay.clear();
    for (const ws of this.sockets.values()) {
      try { ws.close(); } catch { /* already closing */ }
    }
    this.sockets.clear();
    this.up.clear();
    this.lastOffers = [];
    this.seenIds.clear();
  }

  isUp(): boolean {
    return this.up.size > 0;
  }

  endpoints(): SignalEndpointStatus[] {
    return this.relays.map((url) => ({ url, up: this.up.has(url) }));
  }

  /**
   * Subscribe or unsubscribe from the rendezvous tag. Unsubscribing is what
   * keeps a large network's load on public relays roughly proportional to how
   * many nodes are *looking* for peers rather than to how many exist.
   */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    for (const [url, ws] of this.sockets) {
      if (!this.up.has(url)) continue;
      try {
        ws.send(active ? JSON.stringify(['REQ', 'bc', this.filter()]) : JSON.stringify(['CLOSE', 'bc']));
      } catch { /* relay dropped; the reconnect path re-applies `active` */ }
    }
  }

  private filter(): Record<string, unknown> {
    return {
      kinds: [KIND_SIGNAL],
      '#t': [this.topic],
      // Keeps a relay from replaying stale SDP at us on every reconnect — an
      // offer more than a couple of minutes old is certainly dead anyway.
      since: Math.floor(Date.now() / 1000) - MAX_EVENT_AGE_S,
    };
  }

  publishOffers(offers: OpenOffer[]): void {
    this.lastOffers = offers;
    if (offers.length === 0 || !this.ctx) return;
    // Compacted here rather than in the dialer: the interface deals in full
    // descriptions, and how a transport encodes them on its own wire is its
    // own business. This is the transport paying somebody else's bandwidth
    // bill, so it is the one that cares.
    const compact: Array<{ o: string; s: string }> = [];
    for (const o of offers) {
      const s = compactFromSdp(o.sdp);
      if (s) compact.push({ o: o.offerId, s });
      else console.warn('[nostr] could not compact offer', o.offerId);
    }
    if (compact.length === 0) return;
    void this.publish({ v: 1, from: this.ctx.selfId, offers: compact });
  }

  publishAnswer(answer: SignalAnswer): void {
    if (!this.ctx) return;
    const s = compactFromSdp(answer.sdp);
    if (!s) {
      console.warn('[nostr] could not compact answer for', answer.toPeer);
      return;
    }
    void this.publish({
      v: 1,
      from: this.ctx.selfId,
      to: answer.toPeer,
      a: answer.offerId,
      s,
    });
  }

  private async publish(payload: SignalPayload): Promise<void> {
    if (!this.key) return;
    let content: string;
    try {
      content = await sealPayload(this.key, payload);
    } catch (e) {
      console.warn('[nostr] seal failed', (e as Error).message);
      return;
    }
    const ev = buildEvent(
      this.secretKey,
      KIND_SIGNAL,
      [['t', this.topic]],
      content,
      Math.floor(Date.now() / 1000),
    );
    const frame = JSON.stringify(['EVENT', ev]);
    // Fan out to every live relay. One relay accepting is enough for a peer to
    // hear us, so partial failure is a non-event.
    for (const [url, ws] of this.sockets) {
      if (!this.up.has(url)) continue;
      try { ws.send(frame); } catch { /* relay dropped mid-send */ }
    }
  }

  private connect(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(e as Error);
        return;
      }
      this.sockets.set(url, ws);
      let opened = false;

      ws.onopen = () => {
        opened = true;
        this.up.add(url);
        this.reconnectDelay.delete(url);
        // Only subscribe if we're actually looking for peers right now. A
        // reconnect that happens while we're full stays silent until the swarm
        // flips us active again.
        if (this.active) {
          try {
            ws.send(JSON.stringify(['REQ', 'bc', this.filter()]));
          } catch { /* closed between open and send */ }
        }
        // Re-publish immediately so a freshly-connected relay learns our offers
        // rather than waiting out the republish interval.
        if (this.lastOffers.length > 0) this.publishOffers(this.lastOffers);
        resolve();
      };

      ws.onmessage = (ev) => { void this.onFrame(ev.data); };

      ws.onerror = () => {
        if (!opened) reject(new Error(`relay unreachable: ${url}`));
      };

      ws.onclose = () => {
        this.up.delete(url);
        this.sockets.delete(url);
        if (!opened) reject(new Error(`relay closed before open: ${url}`));
        this.scheduleReconnect(url);
      };
    });
  }

  /**
   * Reconnect with exponential backoff and jitter. Without jitter, a relay
   * restart would make every browserCoin tab in the world reconnect on the
   * same tick — the sort of thundering herd that gets a project banned from
   * free public infrastructure.
   */
  private scheduleReconnect(url: string): void {
    if (this.stopped || this.reconnectTimers.has(url)) return;
    if (!this.relays.includes(url)) return;
    const base = this.reconnectDelay.get(url) ?? RECONNECT_BASE_MS;
    this.reconnectDelay.set(url, Math.min(base * 2, RECONNECT_MAX_MS));
    const delay = base / 2 + Math.random() * base;
    this.reconnectTimers.set(
      url,
      setTimeout(() => {
        this.reconnectTimers.delete(url);
        if (this.stopped) return;
        this.connect(url).catch(() => {
          // Failure re-enters onclose, which re-arms this with a longer delay.
        });
      }, delay),
    );
  }

  private async onFrame(data: unknown): Promise<void> {
    if (typeof data !== 'string' || data.length > MAX_FRAME_BYTES) return;
    if (!this.ctx || !this.key) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg[0] !== 'EVENT') return;
    const ev = msg[2] as NostrEvent | undefined;
    if (!ev || typeof ev.id !== 'string' || typeof ev.content !== 'string') return;
    if (ev.kind !== KIND_SIGNAL) return;

    // Every relay we're on forwards the same event, so dedupe by id.
    if (this.seenIds.has(ev.id)) return;
    if (this.seenIds.size >= MAX_SEEN_IDS) this.seenIds.clear();
    this.seenIds.add(ev.id);

    const age = Math.floor(Date.now() / 1000) - (ev.created_at ?? 0);
    if (!Number.isFinite(age) || age > MAX_EVENT_AGE_S || age < -MAX_EVENT_AGE_S) return;

    // Deliberately NOT verifying the Nostr signature. It authenticates a
    // throwaway key that means nothing to us, and the payload underneath is
    // AEAD-sealed — a forged event simply fails to decrypt. Skipping it saves
    // a schnorr verify per relayed frame on every tab.
    const payload = await openPayload(this.key, ev.content);
    if (!payload) return;
    if (payload.from === this.ctx.selfId) return; // our own event, echoed back

    // Expand back to a full description before handing it up. A string that
    // does not decode is a malformed or hostile publisher, not an error worth
    // logging on every frame, so it is simply skipped.
    if (payload.offers) {
      for (const o of payload.offers) {
        const sdp = sdpFromCompact(o.s);
        if (sdp) this.ctx.onOffer(payload.from, o.o, sdp);
      }
      return;
    }
    if (payload.to === this.ctx.selfId && payload.a && payload.s) {
      const sdp = sdpFromCompact(payload.s);
      if (sdp) this.ctx.onAnswer(payload.from, payload.a, sdp);
    }
  }
}
