import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '../../crypto/hash.js';
import { bytesToHex, hexToBytes } from '../../util/binary.js';
import { MeshConn } from './meshConn.js';
import {
  buildEvent,
  openPayload,
  sealPayload,
  signalTopic,
} from './nostr.js';

// ---------------------------------------------------------------------------
// Test doubles for the two WebRTC objects MeshConn touches. Deliberately dumb:
// the point is to exercise our framing, not to model SCTP.
// ---------------------------------------------------------------------------

class FakeChannel {
  readyState: RTCDataChannelState = 'open';
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  peer: FakeChannel | null = null;
  /** Every frame this channel was asked to put on the wire. */
  sent: ArrayBuffer[] = [];
  /** When set, frames are recorded but not delivered (simulates loss). */
  blackhole = false;

  send(buf: ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('channel closed');
    this.sent.push(buf);
    if (this.blackhole) return;
    const peer = this.peer;
    if (!peer) return;
    queueMicrotask(() => peer.onmessage?.({ data: buf }));
  }

  close(): void {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class FakePeerConnection {
  iceConnectionState: RTCIceConnectionState = 'connected';
  oniceconnectionstatechange: (() => void) | null = null;
  closed = false;
  close(): void { this.closed = true; }
}

function linkedPair(): { a: MeshConn; b: MeshConn; chA: FakeChannel; chB: FakeChannel } {
  const chA = new FakeChannel();
  const chB = new FakeChannel();
  chA.peer = chB;
  chB.peer = chA;
  const a = new MeshConn('peer-b', chA as unknown as RTCDataChannel, new FakePeerConnection() as unknown as RTCPeerConnection);
  const b = new MeshConn('peer-a', chB as unknown as RTCDataChannel, new FakePeerConnection() as unknown as RTCPeerConnection);
  return { a, b, chA, chB };
}

/** Let queued microtasks (frame delivery) flush. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('MeshConn framing', () => {
  it('round-trips a small structured message in a single frame', async () => {
    const { a, b, chA } = linkedPair();
    const got: unknown[] = [];
    b.on('data', (d) => got.push(d));

    a.send({ t: 'hello', height: 42, tipHash: 'ab'.repeat(32), chainId: 7 });
    await flush();

    expect(chA.sent).toHaveLength(1);
    expect(got).toEqual([{ t: 'hello', height: 42, tipHash: 'ab'.repeat(32), chainId: 7 }]);
  });

  it('chunks and reassembles a message far larger than one SCTP frame', async () => {
    const { a, b, chA } = linkedPair();
    const got: unknown[] = [];
    b.on('data', (d) => got.push(d));

    // A realistic worst case: a 256 KB block, hex-encoded on the wire.
    const payload = { t: 'block', data: 'de'.repeat(256 * 1024) };
    a.send(payload);
    await flush();

    expect(chA.sent.length).toBeGreaterThan(30); // 512 KB / 16 KiB chunks
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(payload);
  });

  it('reassembles correctly when frames arrive out of order', async () => {
    const { a, b, chA, chB } = linkedPair();
    const got: unknown[] = [];
    b.on('data', (d) => got.push(d));

    // Capture frames without delivering, then replay them backwards.
    chA.blackhole = true;
    const payload = { t: 'blocks', data: ['ff'.repeat(40 * 1024), 'ee'.repeat(40 * 1024)] };
    a.send(payload);
    expect(chA.sent.length).toBeGreaterThan(2);

    for (const frame of [...chA.sent].reverse()) {
      chB.onmessage?.({ data: frame });
    }
    await flush();

    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(payload);
  });

  it('interleaves two concurrent multi-frame messages without mixing them', async () => {
    const { a, b, chA, chB } = linkedPair();
    const got: unknown[] = [];
    b.on('data', (d) => got.push(d));

    chA.blackhole = true;
    const first = { t: 'block', data: 'a1'.repeat(30 * 1024) };
    a.send(first);
    const firstFrames = [...chA.sent];
    chA.sent = [];
    const second = { t: 'block', data: 'b2'.repeat(30 * 1024) };
    a.send(second);
    const secondFrames = [...chA.sent];

    // Deliver alternating frames from the two messages.
    const maxLen = Math.max(firstFrames.length, secondFrames.length);
    for (let i = 0; i < maxLen; i++) {
      if (firstFrames[i]) chB.onmessage?.({ data: firstFrames[i]! });
      if (secondFrames[i]) chB.onmessage?.({ data: secondFrames[i]! });
    }
    await flush();

    expect(got).toHaveLength(2);
    expect(got).toContainEqual(first);
    expect(got).toContainEqual(second);
  });

  it('ignores malformed frames instead of surfacing them as messages', async () => {
    const { b, chB } = linkedPair();
    const got: unknown[] = [];
    const errors: unknown[] = [];
    b.on('data', (d) => got.push(d));
    b.on('error', (e) => errors.push(e));

    chB.onmessage?.({ data: new ArrayBuffer(3) });          // shorter than a header
    chB.onmessage?.({ data: 'not binary' });                 // wrong type entirely
    const bogus = new Uint8Array(16);
    new DataView(bogus.buffer).setUint16(4, 2);              // claims 2 chunks
    new DataView(bogus.buffer).setUint16(6, 9);              // index beyond count
    chB.onmessage?.({ data: bogus.buffer });
    await flush();

    expect(got).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('reports close once and closes the underlying peer connection', async () => {
    const chA = new FakeChannel();
    const pc = new FakePeerConnection();
    const conn = new MeshConn('peer-x', chA as unknown as RTCDataChannel, pc as unknown as RTCPeerConnection);
    let closes = 0;
    conn.on('close', () => { closes++; });

    conn.close();
    conn.close();          // idempotent
    chA.onclose?.();       // and a late event from the channel itself

    expect(closes).toBe(1);
    expect(pc.closed).toBe(true);
  });

  it('treats ICE failure as a disconnect', () => {
    const chA = new FakeChannel();
    const pc = new FakePeerConnection();
    const conn = new MeshConn('peer-x', chA as unknown as RTCDataChannel, pc as unknown as RTCPeerConnection);
    let closed = false;
    conn.on('close', () => { closed = true; });

    pc.iceConnectionState = 'failed';
    pc.oniceconnectionstatechange?.();

    expect(closed).toBe(true);
  });

  it('drops sends after close instead of throwing', () => {
    const { a } = linkedPair();
    a.close();
    expect(() => a.send({ t: 'ping' })).not.toThrow();
  });
});

describe('nostr signalling envelope', () => {
  const key = async (): Promise<CryptoKey> =>
    crypto.subtle.importKey(
      'raw',
      sha256(new TextEncoder().encode('browsercoin-signal-v1:test-net')) as BufferSource,
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );

  it('seals and opens a payload', async () => {
    const k = await key();
    const payload = { v: 1 as const, from: 'browsercoin-abc', offers: [{ o: 'deadbeef', s: 'v=0\r\n...' }] };
    const sealed = await sealPayload(k, payload);
    expect(sealed).not.toContain('browsercoin-abc'); // not sitting in plaintext
    await expect(openPayload(k, sealed)).resolves.toEqual(payload);
  });

  it('returns null for a payload sealed under a different network', async () => {
    const k = await key();
    const other = await crypto.subtle.importKey(
      'raw',
      sha256(new TextEncoder().encode('browsercoin-signal-v1:other-net')) as BufferSource,
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
    const sealed = await sealPayload(other, { v: 1, from: 'x' });
    expect(await openPayload(k, sealed)).toBeNull();
  });

  it('returns null for junk rather than throwing', async () => {
    const k = await key();
    expect(await openPayload(k, 'nothex')).toBeNull();
    expect(await openPayload(k, '00')).toBeNull();
    expect(await openPayload(k, '')).toBeNull();
  });

  it('rejects structurally invalid payloads after decryption', async () => {
    const k = await key();
    // Seal something shaped wrong: it decrypts fine but must not be accepted.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode(JSON.stringify({ v: 2, from: 'x' }));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, pt as BufferSource));
    const blob = new Uint8Array(iv.length + ct.length);
    blob.set(iv); blob.set(ct, iv.length);
    expect(await openPayload(k, btoa(String.fromCharCode(...blob)))).toBeNull();
  });

  it('encodes payloads compactly enough to be a polite relay guest', async () => {
    const k = await key();
    // A realistic announce: four open offers, each a full ~1 KB SDP.
    const sdp = 'v=0\r\n' + 'a=candidate:1 1 UDP 2122252543 192.0.2.1 50000 typ host\r\n'.repeat(16);
    const sealed = await sealPayload(k, {
      v: 1,
      from: 'browsercoin-abcdefghij',
      offers: [0, 1, 2, 3].map((i) => ({ o: `offer${i}`, s: sdp })),
    });
    // base64 costs ~4/3; hex would have cost 2x. Guard against a regression
    // back to hex, which would double what we push at six public relays.
    const plaintextLen = JSON.stringify({ v: 1, from: 'browsercoin-abcdefghij', offers: [0, 1, 2, 3].map((i) => ({ o: `offer${i}`, s: sdp })) }).length;
    expect(sealed.length).toBeLessThan(plaintextLen * 1.5);
  });

  it('builds events a relay will accept: correct id and valid schnorr signature', () => {
    const sk = schnorr.utils.randomSecretKey();
    const createdAt = 1_760_000_000;
    const ev = buildEvent(sk, 20808, [['t', 'browsercoin-abc']], 'ciphertext', createdAt);

    // id must be sha256 over NIP-01's canonical serialization
    const serialized = JSON.stringify([0, ev.pubkey, createdAt, 20808, [['t', 'browsercoin-abc']], 'ciphertext']);
    expect(ev.id).toBe(bytesToHex(sha256(new TextEncoder().encode(serialized))));
    expect(schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey))).toBe(true);
    expect(ev.pubkey).toHaveLength(64);
    expect(ev.sig).toHaveLength(128);
  });

  it('derives a stable, network-scoped rendezvous topic', () => {
    expect(signalTopic('browsercoin-main')).toBe(signalTopic('browsercoin-main'));
    expect(signalTopic('browsercoin-main')).not.toBe(signalTopic('browsercoin-test'));
    expect(signalTopic('browsercoin-main')).toMatch(/^browsercoin-[0-9a-f]{16}$/);
  });
});
