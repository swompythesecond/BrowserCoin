/**
 * Compact session descriptions.
 *
 * A browser emits ~720 bytes of SDP for a data-channel offer, but almost all
 * of it is boilerplate that both endpoints already know and can hardcode. Only
 * four things genuinely vary:
 *
 *   - the DTLS certificate fingerprint (32 bytes, irreducible)
 *   - the ICE password (24 bytes on Chromium, irreducible)
 *   - the ICE username fragment (4 bytes on Chromium, irreducible)
 *   - the candidate addresses (6 bytes for one IPv4 host/port)
 *
 * That is ~66 bytes of real information wrapped in 650 bytes of packaging.
 * Stripping the packaging matters in two places:
 *
 * 1. **Relay load.** Substrate traffic scales with announcement size, and the
 *    announcement is republished to every relay on a timer. Full descriptions
 *    are comfortable into the low thousands of nodes and antisocial beyond
 *    that; compact ones move the ceiling out by more than an order of
 *    magnitude. We are guests on infrastructure we do not pay for.
 *
 * 2. **Human signaling.** A person will paste ~100 characters into a chat.
 *    Nobody pastes 720 bytes of `a=` lines, so the manual handshake only
 *    exists at all if the string is small.
 *
 * ── What is deliberately dropped ───────────────────────────────────────────
 * mDNS host candidates (`<uuid>.local`) are kept, because they are how two
 * browsers on the same LAN reach each other directly, and a UUID packs into 16
 * bytes. Everything else that Chromium emits and the remote does not need
 * (foundations, priorities, generation, network-cost, the session id, `s=`,
 * `t=`, BUNDLE bookkeeping) is regenerated at the far end from a template.
 *
 * The reconstruction is not byte-identical to what the peer originally
 * produced, and does not need to be. ICE and DTLS care about the ufrag, the
 * password, the fingerprint and the candidate list; the rest is syntax.
 */

import { bytesToHex, hexToBytes } from '../../util/binary.js';

/** Wire format version, so a future change can be detected rather than misparsed. */
const VERSION = 1;

export type SetupRole = 'actpass' | 'active' | 'passive';

const SETUP_CODES: Record<SetupRole, number> = { actpass: 0, active: 1, passive: 2 };
const SETUP_NAMES: SetupRole[] = ['actpass', 'active', 'passive'];

/** Candidate kinds we can represent. Anything else is dropped on parse. */
export const enum CandKind {
  HostV4 = 0,
  SrflxV4 = 1,
  HostV6 = 2,
  /** Chromium's mDNS-obfuscated LAN candidate: a UUID that resolves over multicast DNS. */
  Mdns = 3,
}

export interface CompactCandidate {
  kind: CandKind;
  /** IPv4/IPv6 address, or the mDNS UUID in canonical text form. */
  address: string;
  port: number;
}

export interface CompactSdp {
  ufrag: string;
  pwd: string;
  /** 32-byte SHA-256 DTLS fingerprint. */
  fingerprint: Uint8Array;
  setup: SetupRole;
  candidates: CompactCandidate[];
}

/** Chromium's own priority values, reused so the far end sees plausible ICE. */
const PRIORITY = {
  host: 2113937151,
  srflx: 1677729535,
};

// ── Parsing ────────────────────────────────────────────────────────────────

/**
 * Pull the compact form out of a full session description. Returns null if the
 * description is missing anything mandatory, which is treated as "not usable"
 * rather than throwing, since the input may come from a hostile relay.
 */
export function parseSdp(sdp: string): CompactSdp | null {
  const ufrag = matchLine(sdp, /^a=ice-ufrag:(.+)$/m);
  const pwd = matchLine(sdp, /^a=ice-pwd:(.+)$/m);
  const fpHex = matchLine(sdp, /^a=fingerprint:sha-256 ([0-9A-Fa-f:]+)$/m);
  const setupRaw = matchLine(sdp, /^a=setup:(actpass|active|passive)$/m);
  if (!ufrag || !pwd || !fpHex || !setupRaw) return null;
  if (ufrag.length > 255 || pwd.length > 255) return null;

  const fingerprint = hexToBytes(fpHex.replace(/:/g, '').toLowerCase());
  if (fingerprint.length !== 32) return null;

  const candidates: CompactCandidate[] = [];
  const re = /^a=candidate:(\S+) (\d+) (udp|UDP|tcp|TCP) (\d+) (\S+) (\d+) typ (host|srflx|prflx|relay)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sdp)) !== null) {
    const transport = m[3]!.toLowerCase();
    const address = m[5]!;
    const port = Number(m[6]);
    const typ = m[7]!;
    // TCP candidates are not useful here: the data channel runs over
    // UDP/DTLS/SCTP, and TCP candidates only appear for relay fallbacks we
    // do not use.
    if (transport !== 'udp') continue;
    if (!Number.isInteger(port) || port < 0 || port > 65535) continue;
    const cand = classifyCandidate(address, typ, port);
    if (cand) candidates.push(cand);
  }
  // Duplicate candidates cost bytes and buy nothing.
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = `${c.kind}|${c.address}|${c.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length > 255) unique.length = 255;

  return { ufrag, pwd, fingerprint, setup: setupRaw as SetupRole, candidates: unique };
}

function classifyCandidate(address: string, typ: string, port: number): CompactCandidate | null {
  if (address.endsWith('.local')) {
    const uuid = address.slice(0, -'.local'.length);
    if (!/^[0-9a-fA-F-]{36}$/.test(uuid)) return null;
    return { kind: CandKind.Mdns, address: uuid.toLowerCase(), port };
  }
  if (isIpv4(address)) {
    // prflx/relay collapse onto srflx: all three mean "an address the far end
    // should try that is not on our local interface", and the distinction does
    // not survive reconstruction anyway.
    return { kind: typ === 'host' ? CandKind.HostV4 : CandKind.SrflxV4, address, port };
  }
  if (address.includes(':')) {
    const packed = packIpv6(address);
    if (!packed) return null;
    return { kind: CandKind.HostV6, address, port };
  }
  return null;
}

function matchLine(sdp: string, re: RegExp): string | null {
  const m = re.exec(sdp);
  return m ? m[1]!.trim() : null;
}

function isIpv4(a: string): boolean {
  const parts = a.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// ── Binary encoding ────────────────────────────────────────────────────────

/**
 * Layout, all big-endian:
 *
 *   u8   version << 2 | setup
 *   u8   ufrag length, then that many ASCII bytes
 *   u8   pwd length, then that many ASCII bytes
 *   32   DTLS fingerprint
 *   u8   candidate count, then per candidate:
 *          u8  kind
 *          4 / 4 / 16 / 16 address bytes
 *          u16 port
 */
export function encodeCompact(c: CompactSdp): Uint8Array {
  const ufrag = new TextEncoder().encode(c.ufrag);
  const pwd = new TextEncoder().encode(c.pwd);
  if (ufrag.length > 255 || pwd.length > 255) throw new Error('ICE credentials too long');
  if (c.fingerprint.length !== 32) throw new Error('fingerprint must be 32 bytes');

  const candBytes = c.candidates.map(encodeCandidate);
  let size = 1 + 1 + ufrag.length + 1 + pwd.length + 32 + 1;
  for (const b of candBytes) size += b.length;

  const out = new Uint8Array(size);
  let o = 0;
  out[o++] = (VERSION << 2) | SETUP_CODES[c.setup];
  out[o++] = ufrag.length;
  out.set(ufrag, o); o += ufrag.length;
  out[o++] = pwd.length;
  out.set(pwd, o); o += pwd.length;
  out.set(c.fingerprint, o); o += 32;
  out[o++] = candBytes.length;
  for (const b of candBytes) { out.set(b, o); o += b.length; }
  return out;
}

function encodeCandidate(c: CompactCandidate): Uint8Array {
  let addr: Uint8Array;
  switch (c.kind) {
    case CandKind.HostV4:
    case CandKind.SrflxV4:
      addr = packIpv4(c.address) ?? new Uint8Array(4);
      break;
    case CandKind.HostV6:
      addr = packIpv6(c.address) ?? new Uint8Array(16);
      break;
    case CandKind.Mdns:
      addr = packUuid(c.address) ?? new Uint8Array(16);
      break;
  }
  const out = new Uint8Array(1 + addr.length + 2);
  out[0] = c.kind;
  out.set(addr, 1);
  out[1 + addr.length] = (c.port >> 8) & 0xff;
  out[2 + addr.length] = c.port & 0xff;
  return out;
}

export function decodeCompact(buf: Uint8Array): CompactSdp | null {
  try {
    let o = 0;
    const need = (n: number): void => {
      if (o + n > buf.length) throw new Error('truncated');
    };
    need(1);
    const head = buf[o++]!;
    if ((head >> 2) !== VERSION) return null;
    const setup = SETUP_NAMES[head & 0x03];
    if (!setup) return null;

    need(1);
    const ufragLen = buf[o++]!;
    need(ufragLen);
    const ufrag = new TextDecoder().decode(buf.subarray(o, o + ufragLen)); o += ufragLen;

    need(1);
    const pwdLen = buf[o++]!;
    need(pwdLen);
    const pwd = new TextDecoder().decode(buf.subarray(o, o + pwdLen)); o += pwdLen;

    need(32);
    const fingerprint = buf.slice(o, o + 32); o += 32;

    need(1);
    const count = buf[o++]!;
    const candidates: CompactCandidate[] = [];
    for (let i = 0; i < count; i++) {
      need(1);
      const kind = buf[o++]! as CandKind;
      const alen = kind === CandKind.HostV6 || kind === CandKind.Mdns ? 16 : 4;
      need(alen + 2);
      const addrBytes = buf.subarray(o, o + alen); o += alen;
      const port = (buf[o]! << 8) | buf[o + 1]!; o += 2;
      let address: string;
      if (kind === CandKind.HostV4 || kind === CandKind.SrflxV4) address = unpackIpv4(addrBytes);
      else if (kind === CandKind.HostV6) address = unpackIpv6(addrBytes);
      else if (kind === CandKind.Mdns) address = unpackUuid(addrBytes);
      else return null;
      candidates.push({ kind, address, port });
    }
    if (!ufrag || !pwd) return null;
    return { ufrag, pwd, fingerprint, setup, candidates };
  } catch {
    return null;
  }
}

// ── Reconstruction ─────────────────────────────────────────────────────────

/**
 * Rebuild a full session description the browser will accept. Values the
 * remote never inspects (session id, candidate foundations) are synthesised.
 */
export function buildSdp(c: CompactSdp): string {
  // The m-line port and c-line address must agree with a real candidate or
  // Chromium treats the description as having no usable address. Prefer a
  // routable candidate; fall back to the "no address yet" form, which is what
  // a browser itself emits when it only has mDNS candidates.
  const routable = c.candidates.find(
    (x) => x.kind === CandKind.SrflxV4 || x.kind === CandKind.HostV4,
  );
  const mPort = routable ? routable.port : 9;
  const cLine = routable ? `c=IN IP4 ${routable.address}` : 'c=IN IP4 0.0.0.0';

  const lines = [
    'v=0',
    `o=- ${randomSessionId()} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    `m=application ${mPort} UDP/DTLS/SCTP webrtc-datachannel`,
    cLine,
  ];

  let foundation = 1000000000;
  for (const cand of c.candidates) {
    foundation += 7;
    lines.push(candidateLine(cand, foundation));
  }

  lines.push(
    `a=ice-ufrag:${c.ufrag}`,
    `a=ice-pwd:${c.pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${formatFingerprint(c.fingerprint)}`,
    `a=setup:${c.setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  );
  // SDP is CRLF-delimited and must end with a trailing separator.
  return lines.join('\r\n') + '\r\n';
}

function candidateLine(c: CompactCandidate, foundation: number): string {
  const addr = c.kind === CandKind.Mdns ? `${c.address}.local` : c.address;
  const typ = c.kind === CandKind.SrflxV4 ? 'srflx' : 'host';
  const priority = typ === 'srflx' ? PRIORITY.srflx : PRIORITY.host;
  const tail = typ === 'srflx' ? ' raddr 0.0.0.0 rport 0' : '';
  return `a=candidate:${foundation} 1 udp ${priority} ${addr} ${c.port} typ ${typ}${tail} generation 0`;
}

function formatFingerprint(fp: Uint8Array): string {
  const hex = bytesToHex(fp).toUpperCase();
  const pairs: string[] = [];
  for (let i = 0; i < hex.length; i += 2) pairs.push(hex.slice(i, i + 2));
  return pairs.join(':');
}

function randomSessionId(): string {
  // 19 digits, the shape Chromium emits. Never inspected by the far end.
  let s = '';
  const b = new Uint8Array(19);
  crypto.getRandomValues(b);
  for (let i = 0; i < 19; i++) s += String(b[i]! % 10);
  return s.replace(/^0+/, '1');
}

// ── Text form, for relays and for humans ───────────────────────────────────

/** base64url, so the string survives URLs, chat clients and QR codes unescaped. */
export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array | null {
  try {
    const norm = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Full SDP to compact text. Returns null if the SDP is unusable. */
export function compactFromSdp(sdp: string): string | null {
  const parsed = parseSdp(sdp);
  if (!parsed) return null;
  return toBase64Url(encodeCompact(parsed));
}

/** Compact text back to a full SDP. Returns null if the text is not ours. */
export function sdpFromCompact(text: string): string | null {
  const bytes = fromBase64Url(text.trim());
  if (!bytes) return null;
  const parsed = decodeCompact(bytes);
  if (!parsed) return null;
  return buildSdp(parsed);
}

// ── Address packing ────────────────────────────────────────────────────────

function packIpv4(a: string): Uint8Array | null {
  const parts = a.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out[i] = n;
  }
  return out;
}

function unpackIpv4(b: Uint8Array): string {
  return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
}

function packIpv6(a: string): Uint8Array | null {
  // Strip a zone index (fe80::1%eth0); it is meaningless to the far end.
  const addr = a.split('%')[0]!;
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const groups = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 2 && groups < 0) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  const all = [...head, ...new Array<string>(groups).fill('0'), ...tail];
  if (all.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(all[i]!)) return null;
    const v = parseInt(all[i]!, 16);
    out[i * 2] = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

function unpackIpv6(b: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) groups.push(((b[i * 2]! << 8) | b[i * 2 + 1]!).toString(16));
  // Collapse the longest run of zero groups, per RFC 5952.
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === '0') {
      if (curStart < 0) { curStart = i; curLen = 0; }
      curLen++;
      if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  if (bestLen < 2) return groups.join(':');
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLen).join(':')}`;
}

function packUuid(u: string): Uint8Array | null {
  const hex = u.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return hexToBytes(hex);
}

function unpackUuid(b: Uint8Array): string {
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
