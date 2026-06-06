import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '../crypto/keys.js';
import {
  canonicalHelperRecordPayload,
  helperRecordHash,
  isHelperRecordUsable,
  signHelperRecord,
  type HelperRecordUnsigned,
  verifyHelperRecord,
} from './helperRecords.js';

const now = 1_780_000_000;

function unsigned(overrides: Partial<HelperRecordUnsigned> = {}): HelperRecordUnsigned {
  const kp = generateKeyPair();
  return {
    v: 1,
    network: 'browsercoin-pow-v5',
    roles: ['api', 'signaling'],
    api: 'https://api.example.org',
    signaling: 'https://peer.example.org',
    operator: kp.address,
    validFrom: now - 60,
    validUntil: now + 3600,
    ...overrides,
  };
}

describe('helper records', () => {
  it('canonicalizes independent of input key order and role order', () => {
    const a = unsigned({ roles: ['signaling', 'api'] });
    const b: HelperRecordUnsigned = {
      operator: a.operator,
      signaling: a.signaling,
      api: a.api,
      roles: ['api', 'signaling'],
      network: a.network,
      v: a.v,
      validUntil: a.validUntil,
      validFrom: a.validFrom,
    };

    expect(canonicalHelperRecordPayload(a)).toBe(canonicalHelperRecordPayload(b));
  });

  it('verifies a valid operator signature', () => {
    const kp = generateKeyPair();
    const rec = signHelperRecord(unsigned({ operator: kp.address }), kp.privateKey);

    expect(verifyHelperRecord(rec)).toBe(true);
    expect(isHelperRecordUsable(rec, { nowSeconds: now, network: 'browsercoin-pow-v5' })).toBeNull();
  });

  it('rejects a tampered record', () => {
    const kp = generateKeyPair();
    const rec = signHelperRecord(unsigned({ operator: kp.address }), kp.privateKey);
    const tampered = { ...rec, api: 'https://evil.example.org' };

    expect(verifyHelperRecord(tampered)).toBe(false);
  });

  it('rejects expired and wrong-network records', () => {
    const kp = generateKeyPair();
    const expired = signHelperRecord(unsigned({ operator: kp.address, validUntil: now - 1 }), kp.privateKey);
    expect(isHelperRecordUsable(expired, { nowSeconds: now, network: 'browsercoin-pow-v5' })).toBe('helper record expired');

    const wrongNetwork = signHelperRecord(unsigned({ operator: kp.address, network: 'other-network' }), kp.privateKey);
    expect(isHelperRecordUsable(wrongNetwork, { nowSeconds: now, network: 'browsercoin-pow-v5' })).toBe('helper record network mismatch');
  });

  it('rejects non-https production helper URLs', () => {
    const kp = generateKeyPair();
    const rec = signHelperRecord(unsigned({ operator: kp.address, api: 'http://api.example.org' }), kp.privateKey);

    expect(isHelperRecordUsable(rec, { nowSeconds: now, network: 'browsercoin-pow-v5', allowHttpLocalhost: false })).toBe('helper api URL must be https');
  });

  it('uses stable hashes for dedupe', () => {
    const kp = generateKeyPair();
    const rec = signHelperRecord(unsigned({ operator: kp.address }), kp.privateKey);

    expect(helperRecordHash(rec)).toMatch(/^[0-9a-f]{64}$/);
    expect(helperRecordHash(rec)).toBe(helperRecordHash({ ...rec }));
  });
});
