import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair } from '../crypto/keys.js';
import { helperRecordHash, signHelperRecord, type HelperRecord, type HelperRecordUnsigned } from './helperRecords.js';
import { ServerSync } from './serverSync.js';
import {
  decodeHelpersMsg,
  encodeHelpersMsg,
  HELPER_DISCOVERY_NETWORK,
  helperWellKnownUrl,
  loadCachedHelperRecords,
  mergeHelperRecords,
  parseHelperResponse,
  selectHelperServers,
} from './helperDiscovery.js';

const now = 1_780_000_000;

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
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const originalFetch = globalThis.fetch;

Object.defineProperty(globalThis, 'localStorage', {
  value: storage,
  configurable: true,
});

function restoreGlobalTestState(): void {
  storage.clear();
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else Reflect.deleteProperty(globalThis, 'location');
  Object.defineProperty(globalThis, 'fetch', {
    value: originalFetch,
    configurable: true,
  });
}

function rec(host: string, overrides: Partial<HelperRecordUnsigned> = {}): HelperRecord {
  const kp = generateKeyPair();
  const unsigned: HelperRecordUnsigned = {
    v: 1,
    network: HELPER_DISCOVERY_NETWORK,
    roles: ['api', 'signaling'],
    api: `https://${host}`,
    signaling: `https://${host.replace('api', 'peer')}`,
    operator: kp.address,
    validFrom: now - 10,
    validUntil: now + 3600,
    ...overrides,
  };
  return signHelperRecord(unsigned, kp.privateKey);
}

function recFromOperator(host: string, operator: ReturnType<typeof generateKeyPair>): HelperRecord {
  return signHelperRecord({
    v: 1,
    network: HELPER_DISCOVERY_NETWORK,
    roles: ['api', 'signaling'],
    api: `https://${host}`,
    signaling: `https://${host.replace('api', 'peer')}`,
    operator: operator.address,
    validFrom: now - 10,
    validUntil: now + 3600,
  }, operator.privateKey);
}

describe('helper discovery', () => {
  beforeEach(() => storage.clear());
  afterEach(() => restoreGlobalTestState());

  it('dedupes records by signature hash and rejects unusable records', () => {
    const good = rec('api1.example.org');
    const expired = rec('api2.example.org', { validUntil: now - 1 });

    const merged = mergeHelperRecords([], [good, good, expired], {
      nowSeconds: now,
      network: HELPER_DISCOVERY_NETWORK,
      source: 'test',
    });

    expect(merged.records).toHaveLength(1);
    expect(merged.rejected).toEqual([{ source: 'test', reason: 'helper record expired' }]);
  });

  it('selects diverse API and signaling URLs', () => {
    const a = rec('api1.example.org');
    const b = rec('api2.example.net');
    const c = rec('api3.example.com');

    const selected = selectHelperServers([a, b, c], {
      nowSeconds: now,
      network: HELPER_DISCOVERY_NETWORK,
      maxPerOperator: 1,
      maxPerDomain: 1,
      maxServers: 2,
    });

    expect(selected.api).toHaveLength(2);
    expect(selected.signaling).toHaveLength(2);
    expect(new Set(selected.api).size).toBe(2);
  });

  it('caps selection by operator and registrable domain', () => {
    const kp = generateKeyPair();
    const a = recFromOperator('api1.example.org', kp);
    const b = recFromOperator('api2.example.org', kp);
    const c = rec('api3.other.org');

    const selected = selectHelperServers([a, b, c], {
      nowSeconds: now,
      network: HELPER_DISCOVERY_NETWORK,
      maxPerOperator: 1,
      maxPerDomain: 1,
      maxServers: 8,
    });

    expect(selected.api).toHaveLength(2);
    expect(selected.api.some((url) => url.includes('other.org'))).toBe(true);
    expect(selected.api.filter((url) => url.endsWith('example.org')).length).toBe(1);
  });

  it('only selects helper URLs for roles the record advertises', () => {
    const apiOnly = rec('api.role.example', {
      roles: ['api'],
      signaling: 'https://peer.role.example',
    });
    const signalingOnly = rec('peer.role.example', {
      roles: ['signaling'],
      api: 'https://api.not-advertised.example',
      signaling: 'https://peer.advertised.example',
    });

    const selected = selectHelperServers([apiOnly, signalingOnly], {
      nowSeconds: now,
      network: HELPER_DISCOVERY_NETWORK,
      maxServers: 8,
    });

    expect(selected.api).toEqual(['https://api.role.example']);
    expect(selected.signaling).toEqual(['https://peer.advertised.example']);
  });

  it('dedupes signaling URLs and caps signaling domains independently from API domains', () => {
    const records = Array.from({ length: 8 }, (_, i) => rec(`api${i}.unique${i}.example`, {
      signaling: 'https://peer.same.example',
    }));

    const selected = selectHelperServers(records, {
      nowSeconds: now,
      network: HELPER_DISCOVERY_NETWORK,
      maxPerDomain: 1,
      maxServers: 8,
    });

    expect(selected.api).toHaveLength(8);
    expect(selected.signaling).toEqual(['https://peer.same.example']);
  });

  it('falls back to supplied defaults when no records are usable', () => {
    const selected = selectHelperServers([], {
      nowSeconds: now,
      network: HELPER_DISCOVERY_NETWORK,
      defaults: {
        api: ['https://api1.browsercoin.org'],
        signaling: ['https://peer1.browsercoin.org'],
      },
    });

    expect(selected.api).toEqual(['https://api1.browsercoin.org']);
    expect(selected.signaling).toEqual(['https://peer1.browsercoin.org']);
  });

  it('caps cache slots per operator so one operator cannot flood the cache', () => {
    const kp = generateKeyPair();
    const flood = Array.from({ length: 40 }, (_, i) => recFromOperator(`api${i}.dom${i}.example`, kp));

    const merged = mergeHelperRecords([], flood, {
      nowSeconds: now,
      network: HELPER_DISCOVERY_NETWORK,
      source: 'test',
    });

    expect(merged.records).toHaveLength(8);
    expect(merged.records.every((r) => r.operator === kp.address)).toBe(true);
  });

  it('caps cache slots per registrable domain so one domain cannot flood the cache', () => {
    const flood = Array.from({ length: 40 }, (_, i) => rec(`api${i}.same.example`));

    const merged = mergeHelperRecords([], flood, {
      nowSeconds: now,
      network: HELPER_DISCOVERY_NETWORK,
      source: 'test',
    });

    expect(merged.records).toHaveLength(8);
  });

  it('keeps the seed defaults selectable even when the cache is fully poisoned', () => {
    const poison = Array.from({ length: 60 }, (_, i) => rec(`api${i}.evil${i}.example`));

    const selected = selectHelperServers(poison, {
      nowSeconds: now,
      network: HELPER_DISCOVERY_NETWORK,
      defaults: {
        api: ['https://api1.browsercoin.org'],
        signaling: ['https://peer1.browsercoin.org'],
      },
    });

    expect(selected.api).toContain('https://api1.browsercoin.org');
    expect(selected.signaling).toContain('https://peer1.browsercoin.org');
  });

  it('orders records by hash, giving no advantage to longer-validity records', () => {
    // Distinct validity windows so a validUntil-based sort would reorder them.
    const records = Array.from({ length: 6 }, (_, i) =>
      rec(`api${i}.order${i}.example`, { validUntil: now + (i + 1) * 24 * 3600 }));

    const merged = mergeHelperRecords([], records, {
      nowSeconds: now,
      network: HELPER_DISCOVERY_NETWORK,
      source: 'test',
    });

    const byHash = [...records].sort((a, b) => helperRecordHash(a).localeCompare(helperRecordHash(b)));
    expect(merged.records).toEqual(byHash);
  });

  it('bounds helper response size and ignores malformed entries', () => {
    const good = rec('api4.example.org');
    const tooMany = Array.from({ length: 250 }, (_, i) => rec(`api${i}.many.example`));

    const parsed = parseHelperResponse({ helpers: [good, { bad: true }, ...tooMany] });

    expect(parsed[0]).toEqual(good);
    expect(parsed).toHaveLength(200);
    expect(parsed.every((entry) => entry.v === 1)).toBe(true);
  });

  it('round-trips bounded helper gossip records', () => {
    const records = Array.from({ length: 75 }, (_, i) => rec(`api${i}.gossip.example`));

    const msg = encodeHelpersMsg(records);
    const decoded = decodeHelpersMsg(msg);

    expect(msg.t).toBe('helpers');
    expect(msg.records).toHaveLength(50);
    expect(decoded).toEqual(records.slice(0, 50));
  });

  it('builds same-origin well-known helper URL', () => {
    expect(helperWellKnownUrl('https://browsercoin.org/app/#/network')).toBe(
      'https://browsercoin.org/.well-known/browsercoin/helpers.json',
    );
  });

  it('pulls same-origin well-known helper records into the cache', async () => {
    const current = Math.floor(Date.now() / 1000);
    const incoming = rec('api.wellknown.example', {
      validFrom: current - 60,
      validUntil: current + 3600,
    });
    const requests: string[] = [];
    Object.defineProperty(globalThis, 'location', {
      value: { href: 'https://browsercoin.org/app/#/network' },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: async (url: string | URL) => {
        requests.push(String(url));
        return {
          ok: true,
          json: async () => ({ helpers: [incoming] }),
        };
      },
      configurable: true,
    });
    const sync = new ServerSync({} as never, {} as never, [], () => {});

    await sync.pullWellKnownHelperRecords();

    expect(requests).toEqual(['https://browsercoin.org/.well-known/browsercoin/helpers.json']);
    expect(loadCachedHelperRecords()).toEqual([incoming]);
  });
});
