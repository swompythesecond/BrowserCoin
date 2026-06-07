import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair } from '../crypto/keys.js';
import { HELPER_DISCOVERY_NETWORK, saveCachedHelperRecords } from './helperDiscovery.js';
import { signHelperRecord, type HelperRecordUnsigned } from './helperRecords.js';
import { defaultServerLists, loadServerLists } from './servers.js';

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

function helper(api: string, signaling: string) {
  const kp = generateKeyPair();
  const unsigned: HelperRecordUnsigned = {
    v: 1,
    network: HELPER_DISCOVERY_NETWORK,
    roles: ['api', 'signaling'],
    api,
    signaling,
    operator: kp.address,
    validFrom: Math.floor(Date.now() / 1000) - 60,
    validUntil: Math.floor(Date.now() / 1000) + 3600,
  };
  return signHelperRecord(unsigned, kp.privateKey);
}

describe('server list loading', () => {
  beforeEach(() => storage.clear());

  it('keeps the seed defaults and adds discovered helpers when no manual config exists', () => {
    saveCachedHelperRecords([
      helper('https://api.community.example', 'https://peer.community.example'),
    ]);

    // The hardcoded seed defaults are always retained (the eclipse anchor); a
    // discovered helper augments them rather than replacing them.
    const defaults = defaultServerLists();
    expect(loadServerLists()).toEqual({
      api: [...defaults.api, 'https://api.community.example'],
      signaling: [...defaults.signaling, 'https://peer.community.example'],
    });
  });

  it('still prefers manual config over discovery and defaults', () => {
    localStorage.setItem('browsercoin:api-servers', JSON.stringify(['https://manual.example']));
    localStorage.setItem('browsercoin:signaling-servers', JSON.stringify(['https://manual-peer.example']));
    saveCachedHelperRecords([
      helper('https://api.community.example', 'https://peer.community.example'),
    ]);

    expect(loadServerLists()).toEqual({
      api: ['https://manual.example'],
      signaling: ['https://manual-peer.example'],
    });
  });
});
