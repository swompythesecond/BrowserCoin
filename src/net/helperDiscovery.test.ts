import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '../crypto/keys.js';
import { signHelperRecord, type HelperRecord, type HelperRecordUnsigned } from './helperRecords.js';
import {
  decodeHelpersMsg,
  encodeHelpersMsg,
  HELPER_DISCOVERY_NETWORK,
  mergeHelperRecords,
  parseHelperResponse,
  selectHelperServers,
} from './helperDiscovery.js';

const now = 1_780_000_000;

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
});
