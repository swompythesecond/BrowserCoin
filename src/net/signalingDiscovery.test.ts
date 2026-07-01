import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSignalingPeers } from './peer.js';

const originalFetch = globalThis.fetch;

function mockFetch(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  Object.defineProperty(globalThis, 'fetch', {
    value: vi.fn((url: string, init?: RequestInit) => impl(url, init)),
    configurable: true,
  });
}

/** A minimal fetch Response stand-in — only the fields fetchSignalingPeers reads. */
function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', { value: originalFetch, configurable: true });
  vi.restoreAllMocks();
});

describe('fetchSignalingPeers', () => {
  it('returns the registered peer ids on the happy path', async () => {
    mockFetch(() => jsonResponse(['browsercoin-aaa', 'browsercoin-bbb']));
    expect(await fetchSignalingPeers('https://peer1.example.org')).toEqual([
      'browsercoin-aaa',
      'browsercoin-bbb',
    ]);
  });

  it('queries the PeerJS discovery endpoint (path + default key)', async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      seen.push(String(url));
      return jsonResponse([]);
    });
    await fetchSignalingPeers('https://peer1.example.org');
    expect(seen[0]).toBe('https://peer1.example.org/peerjs/peerjs/peers');
  });

  it('filters out non-string and non-prefixed ids (untrusted input)', async () => {
    mockFetch(() => jsonResponse(['browsercoin-good', 'nope', 42, null, 'browsercoin-also']));
    expect(await fetchSignalingPeers('https://peer1.example.org')).toEqual([
      'browsercoin-good',
      'browsercoin-also',
    ]);
  });

  it('returns [] when the body is not an array', async () => {
    mockFetch(() => jsonResponse({ peers: ['browsercoin-x'] }));
    expect(await fetchSignalingPeers('https://peer1.example.org')).toEqual([]);
  });

  it('returns [] on a non-ok HTTP response', async () => {
    mockFetch(() => jsonResponse([], false));
    expect(await fetchSignalingPeers('https://peer1.example.org')).toEqual([]);
  });

  it('returns [] when fetch rejects (network error / abort)', async () => {
    mockFetch(() => Promise.reject(new Error('boom')));
    expect(await fetchSignalingPeers('https://peer1.example.org')).toEqual([]);
  });

  it('returns [] when the body fails to parse as JSON', async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => {
        throw new Error('bad json');
      },
    } as unknown as Response));
    expect(await fetchSignalingPeers('https://peer1.example.org')).toEqual([]);
  });

  it('returns [] for an unparseable base url without calling fetch', async () => {
    let called = false;
    mockFetch(() => {
      called = true;
      return jsonResponse([]);
    });
    expect(await fetchSignalingPeers('not a url')).toEqual([]);
    expect(called).toBe(false);
  });
});
