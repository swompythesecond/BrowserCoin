import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair } from '../crypto/keys.js';
import { signHelperRecord, type HelperRecord, type HelperRecordUnsigned } from './helperRecords.js';
import {
  HELPER_DISCOVERY_NETWORK,
  loadCachedHelperRecords,
} from './helperDiscovery.js';
import { ServerSync, readJsonCapped } from './serverSync.js';

/** A Response whose body streams the given chunks, like a real fetch body. */
function streamResponse(chunks: Uint8Array[]): Response {
  let i = 0;
  return {
    body: {
      getReader() {
        return {
          read: async () =>
            i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
          cancel: async () => {},
        };
      },
    },
    json: async () => {
      throw new Error('json() must not be called when a body stream is present');
    },
  } as unknown as Response;
}

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  clear(): void {
    this.values.clear();
  }
}

const storage = new MemoryStorage();

Object.defineProperty(globalThis, 'localStorage', {
  value: storage,
  configurable: true,
});

function helper(host: string): HelperRecord {
  const kp = generateKeyPair();
  const now = Math.floor(Date.now() / 1000);
  const unsigned: HelperRecordUnsigned = {
    v: 1,
    network: HELPER_DISCOVERY_NETWORK,
    roles: ['api', 'signaling'],
    api: `https://${host}`,
    signaling: `https://${host.replace('api', 'peer')}`,
    operator: kp.address,
    validFrom: now - 60,
    validUntil: now + 3600,
  };
  return signHelperRecord(unsigned, kp.privateKey);
}

describe('ServerSync helper discovery', () => {
  beforeEach(() => storage.clear());

  afterEach(() => {
    vi.unstubAllGlobals();
    storage.clear();
  });

  it('merges helper records from all API helpers instead of first response only', async () => {
    const discovered = helper('api.second.example');
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(url.toString());
      requests.push(u.origin + u.pathname);
      if (u.origin === 'https://api1.example') {
        return { ok: true, json: async () => ({ helpers: [] }) };
      }
      return { ok: true, json: async () => ({ helpers: [discovered] }) };
    }));
    const sync = new ServerSync(
      {} as never,
      {} as never,
      ['https://api1.example', 'https://api2.example'],
      () => {},
    );

    await sync.pullHelperRecords();

    expect(requests).toEqual([
      'https://api1.example/helpers',
      'https://api2.example/helpers',
    ]);
    expect(loadCachedHelperRecords()).toEqual([discovered]);
  });

  it('does not let one hanging API helper block helper discovery', async () => {
    const discovered = helper('api.timeout.example');
    vi.stubGlobal('fetch', vi.fn((url: string | URL) => {
      const u = new URL(url.toString());
      if (u.origin === 'https://hang.example') return new Promise(() => {});
      return Promise.resolve({ ok: true, json: async () => ({ helpers: [discovered] }) });
    }));
    const sync = new ServerSync(
      {} as never,
      {} as never,
      ['https://good.example', 'https://hang.example'],
      () => {},
      () => false,
      () => {},
      10,
    );

    const result = await Promise.race([
      sync.pullHelperRecords().then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(result).toBe('done');
    expect(loadCachedHelperRecords()).toEqual([discovered]);
  });

  it('keeps later-source helper records when an earlier source returns many records', async () => {
    const spam = Array.from({ length: 200 }, (_, i) => helper(`api${i}.evil.example`));
    const honest = helper('api.honest.example');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = new URL(url.toString());
      return {
        ok: true,
        json: async () => ({
          helpers: u.origin === 'https://evil.example' ? spam : [honest],
        }),
      };
    }));
    const sync = new ServerSync(
      {} as never,
      {} as never,
      ['https://evil.example', 'https://honest.example'],
      () => {},
    );

    await sync.pullHelperRecords();

    expect(loadCachedHelperRecords().some((record) => record.api === 'https://api.honest.example')).toBe(true);
  });

  it('notifies when helper records are merged so owners can apply live server lists', () => {
    const discovered = helper('api.notify.example');
    let notifications = 0;
    const sync = new ServerSync(
      {} as never,
      {} as never,
      [],
      () => {},
      () => false,
      () => { notifications++; },
    );

    sync.ingestHelperRecords([discovered], 'test');

    expect(loadCachedHelperRecords()).toEqual([discovered]);
    expect(notifications).toBe(1);
  });
});

describe('readJsonCapped', () => {
  it('rejects a response body larger than the cap', async () => {
    const big = new TextEncoder().encode('x'.repeat(2000));
    await expect(readJsonCapped(streamResponse([big]), 1000)).rejects.toThrow('too large');
  });

  it('reads a JSON body within the cap', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ helpers: [] }));
    await expect(readJsonCapped(streamResponse([bytes]), 1000)).resolves.toEqual({ helpers: [] });
  });

  it('falls back to json() when the runtime has no streaming body', async () => {
    const res = { json: async () => ({ ok: 1 }) } as unknown as Response;
    await expect(readJsonCapped(res, 1000)).resolves.toEqual({ ok: 1 });
  });
});
