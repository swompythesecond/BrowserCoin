import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPair } from '../crypto/keys.js';
import { PeerNetwork } from './peer.js';
import {
  HELPER_DISCOVERY_NETWORK,
  loadCachedHelperRecords,
  mergeHelperRecords,
  saveCachedHelperRecords,
} from './helperDiscovery.js';
import { signHelperRecord, type HelperRecord, type HelperRecordUnsigned } from './helperRecords.js';

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

class FakeConnection {
  readonly sent: unknown[] = [];
  private handlers = new Map<string, Array<(value?: unknown) => void>>();

  constructor(readonly peer: string) {}

  on(event: string, fn: (value?: unknown) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(fn);
    this.handlers.set(event, handlers);
  }

  send(value: unknown): void {
    this.sent.push(value);
  }

  close(): void {
    this.emit('close');
  }

  emit(event: string, value?: unknown): void {
    for (const fn of this.handlers.get(event) ?? []) fn(value);
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

function peerNetwork(): PeerNetwork {
  const chain = {
    height: 0,
    tip: {
      block: { header: { height: 0 } },
      hash: new Uint8Array(32),
    },
    hasBlock: () => false,
  };
  const mempool = {
    hashes: () => [],
    has: () => false,
    add: () => null,
    get: () => null,
  };
  // Mirror ServerSync.ingestHelperRecords — the single validate+merge+save
  // chokepoint the real PeerNetwork delegates gossip to.
  const serverSync = {
    fetchPeers: async () => [],
    heartbeat: async () => null,
    ingestHelperRecords: (records: HelperRecord[], source: string) => {
      const merged = mergeHelperRecords(loadCachedHelperRecords(), records, {
        nowSeconds: Math.floor(Date.now() / 1000),
        network: HELPER_DISCOVERY_NETWORK,
        source,
      });
      saveCachedHelperRecords(merged.records);
    },
  };
  return new PeerNetwork(chain as never, mempool as never, [], serverSync as never, () => {});
}

describe('peer helper gossip', () => {
  beforeEach(() => storage.clear());

  it('asks newly-opened peers for helper records', () => {
    const net = peerNetwork();
    const conn = new FakeConnection('browsercoin-peer-a');

    (net as never as { adoptConnection(conn: FakeConnection): void }).adoptConnection(conn);
    conn.emit('open');

    expect(conn.sent).toContainEqual({ t: 'getHelpers', max: 50 });
  });

  it('serves cached helper records with a bounded response', () => {
    saveCachedHelperRecords(Array.from({ length: 75 }, (_, i) => helper(`api${i}.cache.example`)));
    const net = peerNetwork();
    const conn = new FakeConnection('browsercoin-peer-b');

    (net as never as { onIncoming(conn: FakeConnection, msg: unknown): void }).onIncoming(conn, {
      t: 'getHelpers',
      max: 500,
    });

    const response = conn.sent.find((msg) => typeof msg === 'object' && msg !== null && (msg as { t?: string }).t === 'helpers');
    expect((response as { records: unknown[] }).records).toHaveLength(50);
  });

  it('merges peer-supplied helper records into the local cache', () => {
    const incoming = helper('api.peer.example');
    const net = peerNetwork();
    const conn = new FakeConnection('browsercoin-peer-c');

    (net as never as { onIncoming(conn: FakeConnection, msg: unknown): void }).onIncoming(conn, {
      t: 'helpers',
      records: [incoming],
    });

    expect(loadCachedHelperRecords()).toEqual([incoming]);
  });

  it('throttles repeated helper gossip from the same peer', () => {
    const first = helper('api.first.example');
    const second = helper('api.second.example');
    const net = peerNetwork();
    const conn = new FakeConnection('browsercoin-peer-d');
    const onIncoming = (net as never as { onIncoming(conn: FakeConnection, msg: unknown): void }).onIncoming.bind(net);

    onIncoming(conn, { t: 'helpers', records: [first] });
    // Second message arrives within the cooldown window → ignored.
    onIncoming(conn, { t: 'helpers', records: [second] });

    expect(loadCachedHelperRecords()).toEqual([first]);
  });
});

describe('peer connection cap', () => {
  beforeEach(() => storage.clear());

  const adopt = (net: PeerNetwork, conn: FakeConnection): void => {
    (net as never as { adoptConnection(c: FakeConnection): void }).adoptConnection(conn);
    conn.emit('open');
  };
  const setCap = (net: PeerNetwork, n: number): void =>
    (net as never as { setMaxConnections(n: number): void }).setMaxConnections(n);

  it('caps total connections at the ceiling and rejects the rest', () => {
    const net = peerNetwork();
    setCap(net, 6);
    for (let i = 0; i < 12; i++) adopt(net, new FakeConnection(`browsercoin-peer-${i}`));
    expect(net.getStatus().connected).toBe(6);
  });

  it('trims excess connections immediately when the cap is lowered', () => {
    const net = peerNetwork();
    setCap(net, 10);
    for (let i = 0; i < 10; i++) adopt(net, new FakeConnection(`browsercoin-peer-${i}`));
    expect(net.getStatus().connected).toBe(10);
    setCap(net, 6);
    expect(net.getStatus().connected).toBe(6);
  });
});
