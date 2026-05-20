/**
 * Tiny IndexedDB wrapper — promise-flavoured, no deps.
 * Used to persist the canonical chain so a reopened tab can resume without re-syncing.
 */

const DB_NAME = 'wwwcoin';
const DB_VERSION = 3;
const BLOCKS_STORE = 'blocks';   // key: hash hex, value: { encoded: Uint8Array, height: number }
const META_STORE = 'meta';       // key: string, value: arbitrary
const LEGACY_CHAT_STORE = 'chat';

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

interface StoredBlock {
  hash: string;       // hex
  height: number;
  encoded: Uint8Array; // raw block bytes
}

export async function putBlock(hash: string, height: number, encoded: Uint8Array): Promise<void> {
  const db = await open();
  const tx = db.transaction(BLOCKS_STORE, 'readwrite');
  tx.objectStore(BLOCKS_STORE).put({ hash, height, encoded } satisfies StoredBlock);
  await wrap(tx as unknown as IDBRequest<void>).catch(() => {}); // tx complete via onsuccess of empty
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
