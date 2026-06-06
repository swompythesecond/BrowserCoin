import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair } from '../crypto/keys.js';
import { signHelperRecord, type HelperRecord, type HelperRecordUnsigned } from './helperRecords.js';
import {
  HELPER_DISCOVERY_NETWORK,
  loadCachedHelperRecords,
} from './helperDiscovery.js';
import { ServerSync } from './serverSync.js';

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
