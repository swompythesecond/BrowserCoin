import { beforeEach, describe, expect, it } from 'vitest';
import { Node } from './node.js';
import { generateKeyPair } from './crypto/keys.js';
import {
  HELPER_DISCOVERY_NETWORK,
  saveCachedHelperRecords,
} from './net/helperDiscovery.js';
import { signHelperRecord, type HelperRecordUnsigned } from './net/helperRecords.js';
import { defaultServerLists } from './net/servers.js';

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
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
  const now = Math.floor(Date.now() / 1000);
  const unsigned: HelperRecordUnsigned = {
    v: 1,
    network: HELPER_DISCOVERY_NETWORK,
    roles: ['api', 'signaling'],
    api,
    signaling,
    operator: kp.address,
    validFrom: now - 60,
    validUntil: now + 3600,
  };
  return signHelperRecord(unsigned, kp.privateKey);
}

describe('Node helper discovery live application', () => {
  beforeEach(() => storage.clear());

  it('applies newly discovered helper lists live without persisting them as manual config', () => {
    const node = new Node();
    const apiUpdates: string[][] = [];
    const signalingUpdates: string[][] = [];
    node.serverSync = {
      setApiServers: (urls: string[]) => { apiUpdates.push(urls); },
    } as never;
    node.network = {
      getStatus: () => ({ connected: 0 }),
      setSignalingServers: async (urls: string[]) => { signalingUpdates.push(urls); },
    } as never;

    saveCachedHelperRecords([
      helper('https://api.live.example', 'https://peer.live.example'),
    ]);
    (node as never as { refreshServerListsFromDiscovery(): void }).refreshServerListsFromDiscovery();

    // Discovered helpers are applied live, appended to the always-retained seed
    // defaults — and never persisted as manual config.
    const defaults = defaultServerLists();
    expect(node.serverLists).toEqual({
      api: [...defaults.api, 'https://api.live.example'],
      signaling: [...defaults.signaling, 'https://peer.live.example'],
    });
    expect(apiUpdates).toEqual([[...defaults.api, 'https://api.live.example']]);
    expect(signalingUpdates).toEqual([[...defaults.signaling, 'https://peer.live.example']]);
    expect(storage.getItem('browsercoin:api-servers')).toBeNull();
    expect(storage.getItem('browsercoin:signaling-servers')).toBeNull();
  });

  it('does not tear down live P2P connections for newly discovered signaling helpers', () => {
    const node = new Node();
    const signalingUpdates: string[][] = [];
    node.serverSync = {
      setApiServers: () => {},
    } as never;
    node.network = {
      getStatus: () => ({ connected: 2 }),
      setSignalingServers: async (urls: string[]) => { signalingUpdates.push(urls); },
    } as never;

    saveCachedHelperRecords([
      helper('https://api.live.example', 'https://peer.blackhole.example'),
    ]);
    node.refreshServerListsFromDiscovery();

    const defaults = defaultServerLists();
    expect(node.serverLists.signaling).toEqual([...defaults.signaling, 'https://peer.blackhole.example']);
    expect(signalingUpdates).toEqual([]);
  });
});
