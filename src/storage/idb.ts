/**
 * Tiny IndexedDB wrapper — promise-flavoured, no deps.
 * Used to persist the canonical chain so a reopened tab can resume without re-syncing.
 */

const DB_NAME = 'browsercoin';
const DB_VERSION = 4;
const BLOCKS_STORE = 'blocks';   // key: hash hex, value: { encoded: Uint8Array, height: number }
const META_STORE = 'meta';       // key: string, value: arbitrary
const PEERS_STORE = 'peers';     // key: peer ID, value: StoredPeer (lastSeen, failures)
const LEGACY_CHAT_STORE = 'chat';

/**
 * Drop peers we haven't seen in a week — peer IDs are random per-tab, so a
 * stale entry is dead weight that adds noise to the dial pool.
 */
const PEER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Evict after this many consecutive dial failures. */
const MAX_PEER_FAILURES = 3;

let _db: IDBDatabase | null = null;

function open(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOCKS_STORE)) {
        const s = db.createObjectStore(BLOCKS_STORE, { keyPath: 'hash' });
        s.createIndex('height', 'height', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
      // v3 drops the legacy chat store. Browsers that opened earlier versions
      // still have it on disk — delete so the upgrade is a one-shot cleanup.
      if (db.objectStoreNames.contains(LEGACY_CHAT_STORE)) {
        db.deleteObjectStore(LEGACY_CHAT_STORE);
      }
      // v4 adds the peer cache so a returning tab can dial known peers without
      // depending on the bootstrap server's /peers list.
      if (!db.objectStoreNames.contains(PEERS_STORE)) {
        db.createObjectStore(PEERS_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface StoredBlock {
  hash: string;       // hex
  height: number;
  encoded: Uint8Array; // raw block bytes
}

export async function putBlock(hash: string, height: number, encoded: Uint8Array): Promise<void> {
  const db = await open();
  const tx = db.transaction(BLOCKS_STORE, 'readwrite');
  tx.objectStore(BLOCKS_STORE).put({ hash, height, encoded } satisfies StoredBlock);
  // NOTE: never `wrap(tx)` — IDBTransaction has no `onsuccess`, so that promise
  // never settles on the happy path. Harmless for fire-and-forget callers, but
  // it deterministically froze the first caller to actually await putBlock
  // (history backfill, stuck at "history 0%" after the first batch).
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

export async function getBlock(hash: string): Promise<StoredBlock | undefined> {
  const db = await open();
  return wrap(db.transaction(BLOCKS_STORE).objectStore(BLOCKS_STORE).get(hash));
}

export async function getAllBlocksOrdered(): Promise<StoredBlock[]> {
  const db = await open();
  const idx = db.transaction(BLOCKS_STORE).objectStore(BLOCKS_STORE).index('height');
  return wrap(idx.getAll());
}

export async function putMeta(key: string, value: unknown): Promise<void> {
  const db = await open();
  const tx = db.transaction(META_STORE, 'readwrite');
  tx.objectStore(META_STORE).put(value, key);
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  const db = await open();
  return wrap(db.transaction(META_STORE).objectStore(META_STORE).get(key)) as Promise<T | undefined>;
}

export async function delMeta(key: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(META_STORE, 'readwrite');
  tx.objectStore(META_STORE).delete(key);
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function clearAll(): Promise<void> {
  const db = await open();
  const tx = db.transaction([BLOCKS_STORE, META_STORE], 'readwrite');
  tx.objectStore(BLOCKS_STORE).clear();
  tx.objectStore(META_STORE).clear();
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

interface StoredPeer {
  id: string;
  lastSeen: number;   // ms epoch; entries older than PEER_TTL_MS are dropped on read
  failures: number;   // consecutive failed dials; entry evicted past MAX_PEER_FAILURES
}

/** Mark a peer as successfully seen — call from `adoptConnection.open`. */
export async function recordPeerSeen(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(PEERS_STORE, 'readwrite');
  const store = tx.objectStore(PEERS_STORE);
  store.put({ id, lastSeen: Date.now(), failures: 0 } satisfies StoredPeer);
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/** Increment failure count for a peer; evict if it exceeds the threshold. */
export async function recordPeerFailure(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(PEERS_STORE, 'readwrite');
  const store = tx.objectStore(PEERS_STORE);
  const existing = await wrap(store.get(id)) as StoredPeer | undefined;
  if (!existing) return;
  const next = { ...existing, failures: existing.failures + 1 };
  if (next.failures >= MAX_PEER_FAILURES) store.delete(id);
  else store.put(next);
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/**
 * Return cached peer IDs that aren't past TTL, newest-first. Stale entries
 * (lastSeen > PEER_TTL_MS ago) are pruned in the same transaction.
 */
export async function listCachedPeers(): Promise<string[]> {
  const db = await open();
  const tx = db.transaction(PEERS_STORE, 'readwrite');
  const store = tx.objectStore(PEERS_STORE);
  const all = await wrap(store.getAll()) as StoredPeer[];
  const cutoff = Date.now() - PEER_TTL_MS;
  const fresh: StoredPeer[] = [];
  for (const p of all) {
    if (p.lastSeen < cutoff) store.delete(p.id);
    else fresh.push(p);
  }
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  fresh.sort((a, b) => b.lastSeen - a.lastSeen);
  return fresh.map((p) => p.id);
}
