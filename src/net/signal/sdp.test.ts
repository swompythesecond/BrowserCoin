import { describe, expect, it } from 'vitest';
import {
  CandKind,
  compactFromSdp,
  decodeCompact,
  encodeCompact,
  fromBase64Url,
  parseSdp,
  buildSdp,
  sdpFromCompact,
  toBase64Url,
  type CompactSdp,
} from './sdp.js';

/** A real Chromium data-channel offer, captured from Edge via Playwright. */
const REAL_OFFER = [
  'v=0',
  'o=- 5100484116977507289 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 62955 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 92.208.229.62',
  'a=candidate:1626842732 1 udp 2113937151 73e69f81-c5ba-4d70-b1db-e9f7d5314221.local 58809 typ host generation 0 network-cost 999',
  'a=candidate:2002698819 1 udp 1677729535 92.208.229.62 62955 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  'a=ice-ufrag:PxS3',
  'a=ice-pwd:h6IFG6v4gUIDAJEi0vWs1tDn',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 5A:77:21:6C:D5:59:90:8E:6E:A5:28:50:59:2C:53:B8:14:E9:07:5A:A0:BA:7E:40:55:47:25:8E:35:34:A6:B4',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

const REAL_ANSWER = REAL_OFFER
  .replace('a=setup:actpass', 'a=setup:active')
  .replace('a=ice-ufrag:PxS3', 'a=ice-ufrag:X5Wn');

describe('SDP parsing', () => {
  it('extracts the four things that actually vary', () => {
    const c = parseSdp(REAL_OFFER)!;
    expect(c).not.toBeNull();
    expect(c.ufrag).toBe('PxS3');
    expect(c.pwd).toBe('h6IFG6v4gUIDAJEi0vWs1tDn');
    expect(c.fingerprint.length).toBe(32);
    expect(c.fingerprint[0]).toBe(0x5a);
    expect(c.fingerprint[31]).toBe(0xb4);
    expect(c.setup).toBe('actpass');
  });

  it('keeps the srflx candidate and the mDNS candidate, dropping neither', () => {
    const c = parseSdp(REAL_OFFER)!;
    expect(c.candidates).toHaveLength(2);
    const mdns = c.candidates.find((x) => x.kind === CandKind.Mdns)!;
    expect(mdns.address).toBe('73e69f81-c5ba-4d70-b1db-e9f7d5314221');
    expect(mdns.port).toBe(58809);
    const srflx = c.candidates.find((x) => x.kind === CandKind.SrflxV4)!;
    expect(srflx.address).toBe('92.208.229.62');
    expect(srflx.port).toBe(62955);
  });

  it('returns null rather than throwing when a mandatory field is missing', () => {
    expect(parseSdp(REAL_OFFER.replace(/^a=ice-pwd:.*$/m, ''))).toBeNull();
    expect(parseSdp(REAL_OFFER.replace(/^a=fingerprint:.*$/m, ''))).toBeNull();
    expect(parseSdp(REAL_OFFER.replace(/^a=ice-ufrag:.*$/m, ''))).toBeNull();
    expect(parseSdp('not an sdp at all')).toBeNull();
    expect(parseSdp('')).toBeNull();
  });

  it('rejects a fingerprint that is not 32 bytes', () => {
    expect(parseSdp(REAL_OFFER.replace(/a=fingerprint:sha-256 .*/, 'a=fingerprint:sha-256 AA:BB'))).toBeNull();
  });

  it('skips tcp candidates, which cannot carry the data channel', () => {
    const withTcp = REAL_OFFER.replace(
      'a=ice-ufrag:PxS3',
      'a=candidate:1 1 tcp 1518214911 10.0.0.5 9 typ host tcptype active generation 0\r\na=ice-ufrag:PxS3',
    );
    expect(parseSdp(withTcp)!.candidates).toHaveLength(2);
  });

  it('collapses duplicate candidates', () => {
    const dup = REAL_OFFER.replace(
      'a=ice-ufrag:PxS3',
      'a=candidate:999 1 udp 1677729535 92.208.229.62 62955 typ srflx raddr 0.0.0.0 rport 0 generation 0\r\na=ice-ufrag:PxS3',
    );
    expect(parseSdp(dup)!.candidates).toHaveLength(2);
  });
});

describe('compact encoding', () => {
  it('round-trips every field exactly', () => {
    const orig = parseSdp(REAL_OFFER)!;
    const back = decodeCompact(encodeCompact(orig))!;
    expect(back.ufrag).toBe(orig.ufrag);
    expect(back.pwd).toBe(orig.pwd);
    expect(back.setup).toBe(orig.setup);
    expect([...back.fingerprint]).toEqual([...orig.fingerprint]);
    expect(back.candidates).toEqual(orig.candidates);
  });

  it('fits an offer in under 100 bytes and a paste in under 140 characters', () => {
    const text = compactFromSdp(REAL_OFFER)!;
    const bytes = fromBase64Url(text)!;
    expect(bytes.length).toBeLessThan(100);
    expect(text.length).toBeLessThan(140);
    // The whole point: an order of magnitude off the wire size.
    expect(REAL_OFFER.length / bytes.length).toBeGreaterThan(5);
  });

  it('preserves the answer role, which decides who starts DTLS', () => {
    const c = parseSdp(REAL_ANSWER)!;
    expect(c.setup).toBe('active');
    expect(decodeCompact(encodeCompact(c))!.setup).toBe('active');
  });

  it('produces url-safe text with no padding', () => {
    const text = compactFromSdp(REAL_OFFER)!;
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns null for junk instead of throwing', () => {
    expect(sdpFromCompact('!!!! not base64 !!!!')).toBeNull();
    expect(sdpFromCompact('')).toBeNull();
    expect(decodeCompact(new Uint8Array(0))).toBeNull();
    expect(decodeCompact(new Uint8Array([4, 1, 65]))).toBeNull(); // truncated
  });

  it('rejects a future wire version rather than misreading it', () => {
    const bytes = encodeCompact(parseSdp(REAL_OFFER)!);
    bytes[0] = (2 << 2) | (bytes[0]! & 0x03);
    expect(decodeCompact(bytes)).toBeNull();
  });

  it('survives every single-byte truncation without throwing', () => {
    const full = encodeCompact(parseSdp(REAL_OFFER)!);
    for (let i = 0; i < full.length; i++) {
      expect(() => decodeCompact(full.subarray(0, i))).not.toThrow();
    }
  });
});

describe('SDP reconstruction', () => {
  it('carries the credentials the far end verifies', () => {
    const rebuilt = sdpFromCompact(compactFromSdp(REAL_OFFER)!)!;
    expect(rebuilt).toContain('a=ice-ufrag:PxS3');
    expect(rebuilt).toContain('a=ice-pwd:h6IFG6v4gUIDAJEi0vWs1tDn');
    expect(rebuilt).toContain(
      'a=fingerprint:sha-256 5A:77:21:6C:D5:59:90:8E:6E:A5:28:50:59:2C:53:B8:14:E9:07:5A:A0:BA:7E:40:55:47:25:8E:35:34:A6:B4',
    );
    expect(rebuilt).toContain('a=setup:actpass');
  });

  it('rebuilds both candidates in a form the browser parses', () => {
    const rebuilt = sdpFromCompact(compactFromSdp(REAL_OFFER)!)!;
    expect(rebuilt).toContain('92.208.229.62 62955 typ srflx');
    expect(rebuilt).toContain('73e69f81-c5ba-4d70-b1db-e9f7d5314221.local 58809 typ host');
  });

  it('points the m-line and c-line at a routable candidate', () => {
    const rebuilt = sdpFromCompact(compactFromSdp(REAL_OFFER)!)!;
    expect(rebuilt).toContain('m=application 62955 UDP/DTLS/SCTP webrtc-datachannel');
    expect(rebuilt).toContain('c=IN IP4 92.208.229.62');
  });

  it('falls back to the no-address form when only mDNS candidates exist', () => {
    const mdnsOnly: CompactSdp = {
      ufrag: 'abcd',
      pwd: 'x'.repeat(24),
      fingerprint: new Uint8Array(32).fill(7),
      setup: 'active',
      candidates: [{ kind: CandKind.Mdns, address: '73e69f81-c5ba-4d70-b1db-e9f7d5314221', port: 1234 }],
    };
    const sdp = buildSdp(mdnsOnly);
    expect(sdp).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
    expect(sdp).toContain('c=IN IP4 0.0.0.0');
  });

  it('uses CRLF line endings and a trailing separator, as SDP requires', () => {
    const rebuilt = sdpFromCompact(compactFromSdp(REAL_OFFER)!)!;
    expect(rebuilt.startsWith('v=0\r\n')).toBe(true);
    expect(rebuilt.endsWith('\r\n')).toBe(true);
    expect(rebuilt).not.toMatch(/[^\r]\n/);
  });

  it('handles an IPv6 host candidate', () => {
    const sdp = REAL_OFFER.replace(
      'a=ice-ufrag:PxS3',
      'a=candidate:7 1 udp 2113937151 2001:db8::1 5555 typ host generation 0\r\na=ice-ufrag:PxS3',
    );
    const c = parseSdp(sdp)!;
    const v6 = c.candidates.find((x) => x.kind === CandKind.HostV6)!;
    expect(v6.address).toBe('2001:db8::1');
    const back = decodeCompact(encodeCompact(c))!;
    expect(back.candidates.find((x) => x.kind === CandKind.HostV6)!.address).toBe('2001:db8::1');
  });

  it('strips an IPv6 zone index, which is meaningless to the far end', () => {
    const sdp = REAL_OFFER.replace(
      'a=ice-ufrag:PxS3',
      'a=candidate:7 1 udp 2113937151 fe80::1%eth0 5555 typ host generation 0\r\na=ice-ufrag:PxS3',
    );
    const c = parseSdp(sdp)!;
    const back = decodeCompact(encodeCompact(c))!;
    expect(back.candidates.find((x) => x.kind === CandKind.HostV6)!.address).toBe('fe80::1');
  });
});

describe('base64url helpers', () => {
  it('round-trips arbitrary bytes', () => {
    for (const len of [0, 1, 2, 3, 64, 255]) {
      const b = new Uint8Array(len);
      for (let i = 0; i < len; i++) b[i] = (i * 37) & 0xff;
      expect([...fromBase64Url(toBase64Url(b))!]).toEqual([...b]);
    }
  });

  it('tolerates surrounding whitespace, since humans paste with it', () => {
    const text = compactFromSdp(REAL_OFFER)!;
    // The `o=` line carries a fresh random session id on every rebuild, so
    // compare everything the far end actually inspects.
    const meaningful = (s: string | null): string =>
      s!.split('\r\n').filter((l) => !l.startsWith('o=')).join('\r\n');
    expect(meaningful(sdpFromCompact(`  ${text}\n`))).toBe(meaningful(sdpFromCompact(text)));
    expect(sdpFromCompact(`\t${text}  `)).not.toBeNull();
  });
});
