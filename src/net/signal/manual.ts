/**
 * Signaling by human being.
 *
 * Every other substrate is a network that might be blocked, shut down, or
 * simply absent. This one is a person pasting a short string to another
 * person, and it is the rung the whole argument finally rests on: below it
 * there is no infrastructure left to disable, because anything that can
 * suppress it can suppress conversation.
 *
 * The exchange is a round trip and both people have to be present:
 *
 *   1. A creates an invite and sends the code to B by any means at all.
 *   2. B pastes it, gets a reply code, and sends that back.
 *   3. A pastes the reply. The two browsers connect directly.
 *
 * No server is involved at any point except STUN, which only tells each side
 * its own address. That residual is discussed in the whitepaper; it is
 * stateless, carries nothing, and is replaceable by any of many operators.
 *
 * ── Why this is worth building even though it is inconvenient ──────────────
 * It happens once. A node that completes a single manual handshake is inside
 * the mesh, and from then on learns about other peers from the peers it
 * already has. The manual path is a door, not a commute. A community cut off
 * from every relay at once can rebuild its connectivity from one person
 * pasting one line into a group chat.
 *
 * ── Code format ────────────────────────────────────────────────────────────
 * `BC1` followed by base64url of:
 *
 *   u8   version
 *   u8   peer id length, then that many ASCII bytes
 *   u16  checksum of everything after it
 *   ...  compact session description (see sdp.ts)
 *
 * The peer id travels in the code because `peer.ts` keys connections by it,
 * and without it a manual link could not be deduplicated against the same
 * peer arriving over a relay. It costs ~22 bytes and is worth it.
 *
 * The checksum exists because humans truncate pastes. Without it a short
 * paste fails somewhere deep in SDP parsing and the user is told the code is
 * invalid; with it they are told it is incomplete, which is the thing they
 * can actually act on.
 */

import { ICE_SERVERS } from './ice.js';
import { MeshConn } from './meshConn.js';
import {
  compactFromSdp,
  fromBase64Url,
  sdpFromCompact,
  toBase64Url,
} from './sdp.js';
import { gatherComplete } from './swarm.js';
import type { PeerConn } from './types.js';

const VERSION = 1;
const PREFIX = 'BC1';

/** Give up ICE gathering after this and use whatever we have. */
const GATHER_TIMEOUT_MS = 5_000;
/** After the reply is pasted, ICE checks normally finish within a few seconds. */
const OPEN_TIMEOUT_MS = 30_000;
/**
 * How long a half-finished handshake stays alive. Generous compared with the
 * swarm's timers because a human is in the loop: they have to copy a string
 * into a chat, wait for the other person to notice it, and paste a reply back.
 */
const HANDSHAKE_TTL_MS = 15 * 60_000;
const SWEEP_MS = 30_000;

export interface ManualOptions {
  /** Our peer id, shared with every other path so dedupe works across all of them. */
  selfId: string;
  /** Called when a manual link is live and ready to be adopted by peer.ts. */
  onConnection: (conn: PeerConn) => void;
  /** True if we already hold, or are dialing, this peer by any route. */
  hasPeer: (id: string) => boolean;
}

/** Everything that can go wrong with a pasted code, as something showable. */
export type ManualError =
  | 'not-a-code'
  | 'incomplete'
  | 'wrong-version'
  | 'own-code'
  | 'already-connected'
  | 'webrtc-failed';

export class ManualHandshakeError extends Error {
  constructor(readonly kind: ManualError, message: string) {
    super(message);
    this.name = 'ManualHandshakeError';
  }
}

interface Pending {
  pc: RTCPeerConnection;
  createdAt: number;
  /** Peer id of the far side, known from the moment their code is read. */
  remoteId?: string;
}

export class ManualHandshake {
  /** The invite we are currently offering, if any. At most one at a time. */
  private invite: (Pending & { dc: RTCDataChannel; code: string }) | null = null;
  /** Invites from other people that we have answered and are waiting to open. */
  private answering = new Map<string, Pending>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: ManualOptions) {}

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.cancelInvite();
    for (const p of this.answering.values()) closeQuietly(p.pc);
    this.answering.clear();
  }

  /** The code currently on offer, so the UI can redisplay it without regenerating. */
  currentInvite(): string | null {
    return this.invite?.code ?? null;
  }

  /**
   * Step 1, offerer. Mint an invite code to send to somebody. Replaces any
   * invite already outstanding, since offering two at once helps nobody and
   * each one holds a real peer connection open.
   */
  async createInvite(): Promise<string> {
    this.cancelInvite();
    this.start();

    let pc: RTCPeerConnection;
    try {
      pc = newPeerConnection();
    } catch (e) {
      throw new ManualHandshakeError('webrtc-failed', (e as Error).message);
    }

    try {
      const dc = pc.createDataChannel('browsercoin', { ordered: true });
      await pc.setLocalDescription(await pc.createOffer());
      await gatherComplete(pc, GATHER_TIMEOUT_MS);
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error('no local description after gathering');
      const code = encodeCode(this.opts.selfId, sdp);
      if (!code) throw new Error('could not compact the offer');

      this.invite = { pc, dc, code, createdAt: Date.now() };
      dc.onopen = () => this.adoptInvite(dc, pc);
      return code;
    } catch (e) {
      closeQuietly(pc);
      throw new ManualHandshakeError('webrtc-failed', (e as Error).message);
    }
  }

  /** Drop the outstanding invite and free the connection behind it. */
  cancelInvite(): void {
    if (!this.invite) return;
    closeQuietly(this.invite.pc);
    this.invite = null;
  }

  /**
   * Step 2, answerer. Read somebody's invite and produce the reply code they
   * need to finish. The connection opens once they paste it back.
   */
  async acceptInvite(codeText: string): Promise<string> {
    const decoded = decodeCode(codeText);
    if (!decoded) throw new ManualHandshakeError('not-a-code', 'That is not a browserCoin invite code.');
    if (decoded === 'incomplete') {
      throw new ManualHandshakeError('incomplete', 'That code looks cut off. Copy the whole thing and try again.');
    }
    if (decoded === 'version') {
      throw new ManualHandshakeError('wrong-version', 'That code was made by a newer version of browserCoin.');
    }
    const { peerId, sdp } = decoded;
    if (peerId === this.opts.selfId) {
      throw new ManualHandshakeError('own-code', 'That is your own invite code. Send it to someone else.');
    }
    if (this.opts.hasPeer(peerId)) {
      throw new ManualHandshakeError('already-connected', 'You are already connected to that peer.');
    }

    this.start();
    const existing = this.answering.get(peerId);
    if (existing) {
      closeQuietly(existing.pc);
      this.answering.delete(peerId);
    }

    let pc: RTCPeerConnection;
    try {
      pc = newPeerConnection();
    } catch (e) {
      throw new ManualHandshakeError('webrtc-failed', (e as Error).message);
    }

    this.answering.set(peerId, { pc, createdAt: Date.now(), remoteId: peerId });
    pc.ondatachannel = (ev) => {
      this.answering.delete(peerId);
      this.opts.onConnection(new MeshConn(peerId, ev.channel, pc));
    };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gatherComplete(pc, GATHER_TIMEOUT_MS);
      const answerSdp = pc.localDescription?.sdp;
      if (!answerSdp) throw new Error('no local description after gathering');
      const reply = encodeCode(this.opts.selfId, answerSdp);
      if (!reply) throw new Error('could not compact the answer');
      return reply;
    } catch (e) {
      this.answering.delete(peerId);
      closeQuietly(pc);
      throw new ManualHandshakeError('webrtc-failed', (e as Error).message);
    }
  }

  /**
   * Step 3, offerer. Feed back the reply code. Resolves only once the data
   * channel is actually open (the link also arrives through `onConnection`
   * like any other), and rejects if ICE fails or never gets there, so the UI
   * never reports a connection that does not exist.
   */
  async completeInvite(codeText: string): Promise<void> {
    const decoded = decodeCode(codeText);
    if (!decoded) throw new ManualHandshakeError('not-a-code', 'That is not a browserCoin reply code.');
    if (decoded === 'incomplete') {
      throw new ManualHandshakeError('incomplete', 'That code looks cut off. Copy the whole thing and try again.');
    }
    if (decoded === 'version') {
      throw new ManualHandshakeError('wrong-version', 'That code was made by a newer version of browserCoin.');
    }
    const { peerId, sdp } = decoded;
    if (peerId === this.opts.selfId) {
      throw new ManualHandshakeError('own-code', 'That is your own code, not a reply from someone else.');
    }
    const invite = this.invite;
    if (!invite) {
      throw new ManualHandshakeError('webrtc-failed', 'That invite has expired. Create a new one.');
    }
    if (this.opts.hasPeer(peerId)) {
      throw new ManualHandshakeError('already-connected', 'You are already connected to that peer.');
    }

    invite.remoteId = peerId;
    const opened = waitForOpen(invite.dc, invite.pc, OPEN_TIMEOUT_MS);
    try {
      await invite.pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (e) {
      invite.remoteId = undefined;
      throw new ManualHandshakeError('webrtc-failed', (e as Error).message);
    }
    if (!(await opened)) {
      // The invite's connection is spent either way; free it so the UI offers a fresh one.
      if (this.invite === invite) this.cancelInvite();
      throw new ManualHandshakeError(
        'webrtc-failed',
        'The codes were accepted but no direct link could be opened between your two networks. ' +
          'Create a new invite and try again, or try again from a different network.',
      );
    }
  }

  /** Our invite was answered and the channel came up. */
  private adoptInvite(dc: RTCDataChannel, pc: RTCPeerConnection): void {
    const invite = this.invite;
    if (!invite || invite.pc !== pc) {
      closeQuietly(pc);
      return;
    }
    this.invite = null;
    const remoteId = invite.remoteId;
    if (!remoteId) {
      // Opened without us ever having read a reply code, which should be
      // impossible. Close rather than adopt a link with no identity.
      closeQuietly(pc);
      return;
    }
    this.opts.onConnection(new MeshConn(remoteId, dc, pc));
  }

  private sweep(): void {
    const now = Date.now();
    if (this.invite && now - this.invite.createdAt > HANDSHAKE_TTL_MS) {
      closeQuietly(this.invite.pc);
      this.invite = null;
    }
    for (const [peer, p] of this.answering) {
      if (now - p.createdAt <= HANDSHAKE_TTL_MS) continue;
      closeQuietly(p.pc);
      this.answering.delete(peer);
    }
  }
}

// ── Code encoding ──────────────────────────────────────────────────────────

/** Wrap a peer id and a session description into a pasteable code. */
export function encodeCode(peerId: string, sdp: string): string | null {
  const compact = compactFromSdp(sdp);
  if (!compact) return null;
  const body = fromBase64Url(compact);
  if (!body) return null;

  const id = new TextEncoder().encode(peerId);
  if (id.length > 255) return null;

  const out = new Uint8Array(1 + 1 + id.length + 2 + body.length);
  let o = 0;
  out[o++] = VERSION;
  out[o++] = id.length;
  out.set(id, o); o += id.length;
  const sum = checksum(body);
  out[o++] = (sum >> 8) & 0xff;
  out[o++] = sum & 0xff;
  out.set(body, o);
  return PREFIX + toBase64Url(out);
}

export interface DecodedCode {
  peerId: string;
  /** Full session description, rebuilt from the compact form. */
  sdp: string;
}

/**
 * Read a pasted code. Returns the decoded pair, or a string naming why it
 * could not be read so the caller can say something useful. Never throws:
 * the input is whatever a human had on their clipboard.
 */
export function decodeCode(text: string): DecodedCode | 'incomplete' | 'version' | null {
  // Junk first, prefix second. A chat client that wrapped the code in quotes
  // leaves `"BC1...`, and stripping the prefix before the quotes would leave
  // `BC1` sitting inside the payload where it corrupts the decode.
  const cleaned = text.replace(/[^A-Za-z0-9_-]/g, '');
  // The prefix is what distinguishes "a browserCoin code someone mangled" from
  // "a sentence that happens to contain letters". Codes usually keep it, but
  // some clients eat it, so a prefix-less string is still tried; it just has to
  // be complete and well-formed to count, rather than earning a diagnosis.
  const hadPrefix = cleaned.startsWith(PREFIX);
  const payload = hadPrefix ? cleaned.slice(PREFIX.length) : cleaned;
  // Report a problem only when we are confident this was meant to be a code.
  const bad = (why: 'incomplete' | 'version'): 'incomplete' | 'version' | null =>
    (hadPrefix ? why : null);
  if (payload.length === 0) return null;

  const buf = fromBase64Url(payload);
  if (!buf || buf.length < 4) return bad('incomplete');

  let o = 0;
  const version = buf[o++]!;
  if (version !== VERSION) return bad('version');
  const idLen = buf[o++]!;
  if (idLen === 0) return bad('incomplete');
  if (o + idLen + 2 > buf.length) return bad('incomplete');
  const peerId = new TextDecoder().decode(buf.subarray(o, o + idLen)); o += idLen;
  const sum = (buf[o]! << 8) | buf[o + 1]!; o += 2;
  const body = buf.subarray(o);
  if (body.length === 0) return bad('incomplete');
  if (checksum(body) !== sum) return bad('incomplete');

  const sdp = sdpFromCompact(toBase64Url(body));
  if (!sdp) return bad('incomplete');
  if (!peerId) return null;
  return { peerId, sdp };
}

/** Fletcher-16. Cheap, catches truncation and transposition, two bytes. */
function checksum(b: Uint8Array): number {
  let a = 0, s = 0;
  for (const x of b) {
    a = (a + x) % 255;
    s = (s + a) % 255;
  }
  return ((s << 8) | a) & 0xffff;
}

/** A peer connection, or an error a person can act on when the browser has no WebRTC. */
function newPeerConnection(): RTCPeerConnection {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new Error(
      'This browser cannot make direct connections (WebRTC is missing or switched off). ' +
        'Try a current Chrome, Edge, Firefox or Safari.',
    );
  }
  return new RTCPeerConnection({ iceServers: ICE_SERVERS });
}

function closeQuietly(pc: RTCPeerConnection): void {
  try { pc.close(); } catch { /* already gone */ }
}

/** True once `dc` opens; false if the connection fails, closes, or `ms` passes first. */
function waitForOpen(dc: RTCDataChannel, pc: RTCPeerConnection, ms: number): Promise<boolean> {
  if (dc.readyState === 'open') return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      dc.removeEventListener('open', onOpen);
      pc.removeEventListener('connectionstatechange', onState);
      resolve(ok);
    };
    const onOpen = (): void => done(true);
    const onState = (): void => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') done(false);
    };
    const timer = setTimeout(() => done(false), ms);
    dc.addEventListener('open', onOpen);
    pc.addEventListener('connectionstatechange', onState);
  });
}
