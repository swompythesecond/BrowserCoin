import type { PeerConn } from './types.js';

/**
 * Adapts a raw `RTCDataChannel` to the `PeerConn` shape the gossip layer
 * expects from PeerJS, so `peer.ts` can hold connections from either source
 * without caring which.
 *
 * Two things PeerJS was doing for us that we now have to do ourselves:
 *
 * 1. **Structured values.** PeerJS lets you `send({t:'block', ...})` directly.
 *    A raw data channel only takes strings and binary, so we JSON-encode on
 *    the way out and decode on the way in.
 *
 * 2. **Chunking.** This is the one that bites. SCTP will not carry an
 *    arbitrarily large message: 16 KiB is the only size every implementation
 *    reliably accepts, and oversized sends fail — or worse, silently tear the
 *    channel down. browserCoin routinely exceeds that: a block is capped at
 *    256 KB, and the wire format hex-encodes it, so a single `block` message
 *    can approach 512 KB, and a `blocks` range response is larger still.
 *    PeerJS chunked transparently; without an equivalent here, block sync over
 *    a mesh link would break exactly when it matters most.
 *
 * The framing is deliberately minimal — an 8-byte binary header per chunk:
 *
 *     u32 msgId | u16 chunkCount | u16 chunkIndex | payload…
 *
 * Chunks of one message may interleave with chunks of another (we send
 * whole messages at a time, but a peer need not), so reassembly is keyed by
 * msgId rather than assuming ordered arrival of complete messages.
 */

/** Conservative SCTP-safe chunk size; every browser handles 16 KiB. */
const CHUNK_BYTES = 16 * 1024;
const HEADER_BYTES = 8;
/**
 * Reassembly ceiling. Our largest legitimate message is a `blocks` range
 * response — 64 blocks × 256 KB, hex-encoded — but we never request ranges
 * that big in practice and a peer claiming to send tens of megabytes is
 * attacking us, not serving us. 8 MB is comfortably above real traffic and far
 * below anything that threatens a tab.
 */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Cap concurrent partial messages so a peer can't pin memory with holes. */
const MAX_PARTIALS = 8;
/**
 * Pause sending when the channel's outbound buffer reaches this, and resume at
 * half. Without backpressure, pushing a 512 KB block as 32 chunks in a tight
 * loop can balloon the send buffer and, in Chrome, close the channel outright.
 */
const BUFFER_HIGH = 1024 * 1024;
const BUFFER_LOW = 256 * 1024;

interface Partial {
  chunks: Array<Uint8Array | undefined>;
  received: number;
  total: number;
  bytes: number;
}

type Handlers = {
  open: Array<() => void>;
  data: Array<(d: unknown) => void>;
  close: Array<() => void>;
  error: Array<(e: { message: string }) => void>;
};

export class MeshConn implements PeerConn {
  private handlers: Handlers = { open: [], data: [], close: [], error: [] };
  private partials = new Map<number, Partial>();
  private nextMsgId = 1;
  private sendQueue: Uint8Array[] = [];
  private draining = false;
  private closed = false;

  constructor(
    readonly peer: string,
    private dc: RTCDataChannel,
    private pc: RTCPeerConnection,
  ) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_LOW;

    if (dc.readyState === 'open') {
      // Already open before we wrapped it — defer so the caller can attach
      // handlers first, otherwise the `open` event is lost to a race.
      queueMicrotask(() => this.fire('open'));
    }
    dc.onopen = () => this.fire('open');
    dc.onmessage = (ev) => this.onFrame(ev.data);
    dc.onclose = () => this.teardown();
    dc.onerror = (ev) => {
      const msg = (ev as RTCErrorEvent).error?.message ?? 'datachannel error';
      for (const fn of this.handlers.error) fn({ message: msg });
    };
    dc.onbufferedamountlow = () => { void this.drain(); };
    // A dead peer usually surfaces as ICE failure long before the channel
    // notices, so treat it as a close and let peer.ts reap the entry.
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'failed' || s === 'closed') this.teardown();
    };
  }

  on(event: 'open', fn: () => void): void;
  on(event: 'data', fn: (data: unknown) => void): void;
  on(event: 'close', fn: () => void): void;
  on(event: 'error', fn: (err: { message: string }) => void): void;
  on(event: keyof Handlers, fn: (...args: never[]) => void): void {
    (this.handlers[event] as Array<(...a: never[]) => void>).push(fn);
  }

  private fire(event: 'open' | 'close'): void {
    for (const fn of this.handlers[event]) fn();
  }

  send(data: unknown): void {
    if (this.closed) return;
    let body: Uint8Array;
    try {
      body = new TextEncoder().encode(JSON.stringify(data));
    } catch (e) {
      console.warn('[mesh] encode failed', (e as Error).message);
      return;
    }
    const msgId = this.nextMsgId++;
    // u32 wraps at ~4.3 billion messages; reset well before that so the header
    // stays a fixed 8 bytes rather than needing a varint.
    if (this.nextMsgId > 0xffff_fffe) this.nextMsgId = 1;

    const total = Math.max(1, Math.ceil(body.length / CHUNK_BYTES));
    if (total > 0xffff) {
      console.warn('[mesh] message too large to frame:', body.length);
      return;
    }
    for (let i = 0; i < total; i++) {
      const slice = body.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      const frame = new Uint8Array(HEADER_BYTES + slice.length);
      const view = new DataView(frame.buffer);
      view.setUint32(0, msgId);
      view.setUint16(4, total);
      view.setUint16(6, i);
      frame.set(slice, HEADER_BYTES);
      this.sendQueue.push(frame);
    }
    void this.drain();
  }

  /** Push queued frames until the channel's buffer fills; resume on drain. */
  private async drain(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (this.sendQueue.length > 0) {
        if (this.dc.readyState !== 'open') break;
        if (this.dc.bufferedAmount > BUFFER_HIGH) break; // onbufferedamountlow resumes
        const frame = this.sendQueue.shift()!;
        try {
          // Each frame owns its buffer exactly (allocated in `send`), so the
          // whole ArrayBuffer is the frame — no slicing or copying needed.
          this.dc.send(frame.buffer as ArrayBuffer);
        } catch (e) {
          console.warn('[mesh] send failed', (e as Error).message);
          this.sendQueue.length = 0;
          break;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private onFrame(raw: unknown): void {
    if (!(raw instanceof ArrayBuffer)) return;
    if (raw.byteLength < HEADER_BYTES) return;
    const view = new DataView(raw);
    const msgId = view.getUint32(0);
    const total = view.getUint16(4);
    const index = view.getUint16(6);
    if (total === 0 || index >= total) return;
    const payload = new Uint8Array(raw, HEADER_BYTES);

    // Single-chunk fast path — the overwhelming majority of gossip (ping,
    // hello, invTxs, a small tx) fits in one frame and never touches the
    // reassembly map.
    if (total === 1) {
      this.deliver(payload);
      return;
    }

    let part = this.partials.get(msgId);
    if (!part) {
      if (this.partials.size >= MAX_PARTIALS) {
        // Drop the oldest incomplete message rather than growing without
        // bound. The sender will retry at the protocol level (block gossip and
        // tx inv are both idempotent and re-announced).
        const oldest = this.partials.keys().next().value;
        if (oldest !== undefined) this.partials.delete(oldest);
      }
      part = { chunks: new Array<Uint8Array | undefined>(total), received: 0, total, bytes: 0 };
      this.partials.set(msgId, part);
    }
    if (part.total !== total || part.chunks[index] !== undefined) return;
    part.chunks[index] = payload;
    part.received++;
    part.bytes += payload.length;
    if (part.bytes > MAX_MESSAGE_BYTES) {
      this.partials.delete(msgId);
      console.warn('[mesh] oversized message from', this.peer);
      return;
    }
    if (part.received < part.total) return;

    this.partials.delete(msgId);
    const body = new Uint8Array(part.bytes);
    let off = 0;
    for (const c of part.chunks) {
      if (!c) return; // cannot happen once received === total, but be safe
      body.set(c, off);
      off += c.length;
    }
    this.deliver(body);
  }

  private deliver(bytes: Uint8Array): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      // Malformed frame from a peer. peer.ts already tolerates junk messages;
      // dropping here keeps it from even reaching the dispatch switch.
      return;
    }
    for (const fn of this.handlers.data) fn(parsed);
  }

  close(): void {
    this.teardown();
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    this.sendQueue.length = 0;
    this.partials.clear();
    try { this.dc.close(); } catch { /* already gone */ }
    try { this.pc.close(); } catch { /* already gone */ }
    this.fire('close');
  }
}
