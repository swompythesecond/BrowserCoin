/**
 * BrowserCoin chain archiver.
 *
 * Pulls canonical blocks from the public API helper servers, validates them
 * with the exact same consensus code every node runs (including Argon2id PoW),
 * and writes them into a git-friendly archive layout:
 *
 *   <out>/<network>/
 *     manifest.json                 archived tip + chunk index
 *     snapshot.json                 account state AFTER the archived tip
 *     blocks/0000001-0002000.json   fixed-range chunks, immutable once full
 *
 * Designed to run from a GitHub Action in the browsercoin-archive repo (the
 * Action checks out this repo for the code and the archive repo for the data),
 * but works the same from a shell. The process is PULL-based on purpose: the
 * chain servers hold no credentials for the archive, so a compromised server
 * cannot touch archive history — and a forged block can't get in because every
 * new block goes through Blockchain.addBlock with full validation.
 *
 * Reorg safety: only blocks buried at least --confirmations (default 60,
 * ~2.5 h at 150 s spacing) below the best server tip are archived, so chunk
 * files never need rewriting. If the network ever reorgs deeper than that,
 * the archiver detects the mismatch and aborts without writing — that case
 * needs a human decision, not an automatic history rewrite.
 *
 * Incremental runs stay cheap via the same trick the browser client uses
 * (see Node.replayWithSnapshot): previously-archived blocks are re-linked
 * with seedHistoricalBlock (no state materialization), and the account state
 * at the archived tip is restored from snapshot.json. The snapshot needs no
 * trust: its recomputed stateRoot must match the archived tip header's
 * stateRoot, which is covered by that block's PoW.
 *
 * Usage:
 *   tsx server/tools/archive.ts --out <archive-repo-dir>
 *     [--servers https://a,https://b] [--confirmations 60] [--chunk-size 2000]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Blockchain } from '../../src/chain/blockchain.js';
import { decodeBlock, encodeBlock } from '../../src/chain/block.js';
import {
  deserializeState,
  serializeState,
  serializeLocks,
  stateRoot,
  type StateRow,
  type LockRow,
} from '../../src/chain/state.js';
import { bytesToHex, compareBytes, hexToBytes } from '../../src/util/binary.js';
import { BROWSERCOIN_NETWORK } from '../../src/net/network.js';

const DEFAULT_SERVERS = ['https://api1.browsercoin.org', 'https://api2.browsercoin.org'];
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_RETRIES = 5;
const BLOCKS_PER_REQUEST = 200; // server-side max for GET /blocks

interface ChunkRef {
  file: string;
  fromHeight: number;
  toHeight: number;
}

interface Manifest {
  v: 1;
  chainVersion: string;
  chunkSize: number;
  archivedHeight: number;
  archivedTipHash: string;
  updatedAt: string;
  chunks: ChunkRef[];
}

interface ChunkFile {
  v: 1;
  chainVersion: string;
  fromHeight: number;
  toHeight: number;
  blocks: string[]; // hex-encoded, height-ascending
}

/** Same shape idea as the client's StateSnapshot (src/node.ts), but on disk. */
interface SnapshotFile {
  v: 1;
  chainVersion: string;
  height: number;
  hashHex: string;
  accounts: StateRow[]; // state AFTER block `height`
  locks?: LockRow[];    // script locks live at block `height` (omitted pre-fork)
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(): { out: string; servers: string[]; confirmations: number; chunkSize: number } {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out = get('--out');
  if (!out) {
    console.error('usage: archive.ts --out <dir> [--servers a,b] [--confirmations N] [--chunk-size N]');
    process.exit(2);
  }
  const servers = (get('--servers') ?? DEFAULT_SERVERS.join(','))
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const confirmations = Number(get('--confirmations') ?? 60);
  const chunkSize = Number(get('--chunk-size') ?? 2000);
  if (!Number.isInteger(confirmations) || confirmations < 0) throw new Error('bad --confirmations');
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('bad --chunk-size');
  return { out: path.resolve(out), servers, confirmations, chunkSize };
}

// ─── Small helpers ───────────────────────────────────────────────────────────

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file);
}

function pad7(n: number): string {
  return String(n).padStart(7, '0');
}

/** Chunk index for a (1-based) block height. Genesis is never archived. */
function chunkIndexOf(height: number, chunkSize: number): number {
  return Math.floor((height - 1) / chunkSize);
}

function chunkRange(index: number, chunkSize: number): { from: number; to: number } {
  return { from: index * chunkSize + 1, to: (index + 1) * chunkSize };
}

function chunkFileName(index: number, chunkSize: number): string {
  const { from, to } = chunkRange(index, chunkSize);
  return `${pad7(from)}-${pad7(to)}.json`;
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.status === 429) {
        // Helper-server rate limit — back off a full limiter window fraction.
        lastErr = new Error('429 rate limited');
        await new Promise((r) => setTimeout(r, 15_000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e as Error;
      await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
    }
  }
  throw new Error(`${url}: ${lastErr?.message ?? 'fetch failed'}`);
}

// ─── Archive load (incremental seed) ─────────────────────────────────────────

interface LoadedArchive {
  chain: Blockchain;
  archivedHeight: number;
  archivedTipHash: string; // hex; genesis hash when nothing archived yet
}

/**
 * Rebuild an in-memory chain from the on-disk archive. Previously-archived
 * blocks were fully validated when first written, so they are re-linked
 * without state (fast); only the archived tip gets its state, restored from
 * snapshot.json and verified against the tip header's stateRoot.
 */
async function loadArchive(dir: string, chunkSize: number): Promise<LoadedArchive> {
  const chain = new Blockchain();
  const genesisHash = bytesToHex(chain.tip.hash);
  const manifest = await readJson<Manifest>(path.join(dir, 'manifest.json'));
  if (!manifest) return { chain, archivedHeight: 0, archivedTipHash: genesisHash };

  if (manifest.chainVersion !== BROWSERCOIN_NETWORK) {
    throw new Error(
      `manifest chainVersion "${manifest.chainVersion}" does not match build "${BROWSERCOIN_NETWORK}"`,
    );
  }
  if (manifest.chunkSize !== chunkSize) {
    throw new Error(
      `manifest chunkSize ${manifest.chunkSize} != --chunk-size ${chunkSize}; pass the matching value`,
    );
  }

  const snapshot = await readJson<SnapshotFile>(path.join(dir, 'snapshot.json'));
  if (!snapshot) throw new Error('manifest.json present but snapshot.json missing');
  if (snapshot.height !== manifest.archivedHeight || snapshot.hashHex !== manifest.archivedTipHash) {
    throw new Error('snapshot.json does not match manifest.json tip');
  }

  let expectedNext = 1;
  for (const ref of manifest.chunks) {
    if (ref.fromHeight !== expectedNext) {
      throw new Error(`chunk gap: expected fromHeight ${expectedNext}, got ${ref.fromHeight} (${ref.file})`);
    }
    const chunk = await readJson<ChunkFile>(path.join(dir, 'blocks', ref.file));
    if (!chunk) throw new Error(`chunk file missing: ${ref.file}`);
    if (chunk.blocks.length !== ref.toHeight - ref.fromHeight + 1) {
      throw new Error(`chunk ${ref.file} has ${chunk.blocks.length} blocks, manifest says ${ref.toHeight - ref.fromHeight + 1}`);
    }
    for (const hex of chunk.blocks) {
      const block = decodeBlock(hexToBytes(hex));
      const h = block.header.height;
      if (h !== expectedNext) throw new Error(`chunk ${ref.file}: expected height ${expectedNext}, got ${h}`);
      let err: string | null;
      if (h === manifest.archivedHeight) {
        // The archived tip carries the snapshot state. Trustless: the state's
        // recomputed merkle root must equal the header's stateRoot, which the
        // block's (already-archived) PoW commits to.
        const state = deserializeState(snapshot.accounts, snapshot.locks ?? []);
        if (compareBytes(stateRoot(state), block.header.stateRoot) !== 0) {
          throw new Error('snapshot.json stateRoot does not match archived tip header');
        }
        err = chain.seedHistoricalBlock(block, state);
      } else {
        err = chain.seedHistoricalBlock(block, null);
      }
      if (err) throw new Error(`replay height ${h}: ${err}`);
      expectedNext++;
    }
  }

  if (chain.height !== manifest.archivedHeight) {
    throw new Error(`archive replay ended at height ${chain.height}, manifest says ${manifest.archivedHeight}`);
  }
  const tipHex = bytesToHex(chain.tip.hash);
  if (tipHex !== manifest.archivedTipHash) {
    throw new Error(`archive tip hash ${tipHex} != manifest ${manifest.archivedTipHash}`);
  }
  return { chain, archivedHeight: manifest.archivedHeight, archivedTipHash: tipHex };
}

// ─── Flush (chunks + snapshot + manifest) ────────────────────────────────────

/**
 * Persist canonical blocks (prevHeight, chain.height] into chunk files and
 * refresh snapshot + manifest. Verifies first that the canonical chain still
 * passes through the previously archived tip — if not, the network reorged
 * deeper than the confirmation lag and we refuse to rewrite history.
 */
async function flush(dir: string, chain: Blockchain, prev: LoadedArchive, chunkSize: number): Promise<void> {
  const newHeight = chain.height;
  if (newHeight <= prev.archivedHeight) return;

  // Collect the new range from the canonical walk (tip → genesis).
  const newHexByHeight = new Map<number, string>();
  for (const cb of chain.iterateCanonical()) {
    const h = cb.block.header.height;
    if (h <= prev.archivedHeight) {
      if (h === prev.archivedHeight && bytesToHex(cb.hash) !== prev.archivedTipHash) {
        throw new Error(
          `canonical chain no longer contains archived tip at height ${h} — ` +
            'reorg deeper than the confirmation lag; refusing to rewrite archive history',
        );
      }
      break;
    }
    newHexByHeight.set(h, bytesToHex(encodeBlock(cb.block)));
  }

  const firstChunk = chunkIndexOf(prev.archivedHeight + 1, chunkSize);
  const lastChunk = chunkIndexOf(newHeight, chunkSize);
  for (let i = firstChunk; i <= lastChunk; i++) {
    const { from, to } = chunkRange(i, chunkSize);
    const file = path.join(dir, 'blocks', chunkFileName(i, chunkSize));
    let blocks: string[] = [];
    if (from <= prev.archivedHeight) {
      // Boundary chunk: keep the already-archived prefix from disk.
      const existing = await readJson<ChunkFile>(file);
      const wantExisting = prev.archivedHeight - from + 1;
      if (!existing || existing.fromHeight !== from || existing.blocks.length !== wantExisting) {
        throw new Error(`partial chunk ${path.basename(file)} inconsistent with manifest`);
      }
      blocks = existing.blocks;
    }
    for (let h = from + blocks.length; h <= Math.min(to, newHeight); h++) {
      const hex = newHexByHeight.get(h);
      if (!hex) throw new Error(`missing canonical block at height ${h}`);
      blocks.push(hex);
    }
    const body: ChunkFile = {
      v: 1,
      chainVersion: BROWSERCOIN_NETWORK,
      fromHeight: from,
      toHeight: from + blocks.length - 1,
      blocks,
    };
    await writeJsonAtomic(file, body);
  }

  const snapshot: SnapshotFile = {
    v: 1,
    chainVersion: BROWSERCOIN_NETWORK,
    height: newHeight,
    hashHex: bytesToHex(chain.tip.hash),
    accounts: serializeState(chain.tipState),
    locks: serializeLocks(chain.tipState),
  };
  await writeJsonAtomic(path.join(dir, 'snapshot.json'), snapshot);

  const chunks: ChunkRef[] = [];
  for (let i = 0; i <= lastChunk; i++) {
    const { from, to } = chunkRange(i, chunkSize);
    chunks.push({ file: chunkFileName(i, chunkSize), fromHeight: from, toHeight: Math.min(to, newHeight) });
  }
  const manifest: Manifest = {
    v: 1,
    chainVersion: BROWSERCOIN_NETWORK,
    chunkSize,
    archivedHeight: newHeight,
    archivedTipHash: snapshot.hashHex,
    updatedAt: new Date().toISOString(),
    chunks,
  };
  await writeJsonAtomic(path.join(dir, 'manifest.json'), manifest);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { out, servers, confirmations, chunkSize } = parseArgs();
  const dir = path.join(out, BROWSERCOIN_NETWORK);

  // Best reachable tip across all helpers; remaining servers stay as fallback.
  const tips = await Promise.allSettled(
    servers.map(async (s) => ({ server: s, tip: await fetchJson<{ height: number }>(`${s}/tip`) })),
  );
  const reachable = tips
    .filter((r): r is PromiseFulfilledResult<{ server: string; tip: { height: number } }> => r.status === 'fulfilled')
    .map((r) => r.value)
    .sort((a, b) => b.tip.height - a.tip.height);
  if (reachable.length === 0) throw new Error(`no API server reachable (tried: ${servers.join(', ')})`);
  const bestTip = reachable[0]!.tip.height;
  const orderedServers = reachable.map((r) => r.server);

  const target = bestTip - confirmations;
  console.log(`[archive] network=${BROWSERCOIN_NETWORK} serverTip=${bestTip} target=${target}`);

  let archive = await loadArchive(dir, chunkSize);
  console.log(`[archive] loaded archive at height ${archive.archivedHeight}`);
  if (target <= archive.archivedHeight) {
    console.log('[archive] up to date — nothing to do');
    return;
  }

  const startedAt = Date.now();
  const totalNew = target - archive.archivedHeight;
  let added = 0;

  while (archive.chain.height < target) {
    // Work one chunk-sized batch at a time, flushing and re-seeding between
    // batches so per-block materialized state never piles up in memory.
    const batchTarget = Math.min(target, archive.chain.height + chunkSize);
    while (archive.chain.height < batchTarget) {
      const fromHeight = archive.chain.height + 1;
      let body: { blocks: string[] } | null = null;
      for (const server of orderedServers) {
        try {
          body = await fetchJson<{ blocks: string[] }>(
            `${server}/blocks?fromHeight=${fromHeight}&max=${BLOCKS_PER_REQUEST}`,
          );
          break;
        } catch (e) {
          console.warn(`[archive] ${server} failed: ${(e as Error).message}`);
        }
      }
      if (!body || body.blocks.length === 0) {
        throw new Error(`no server could provide blocks from height ${fromHeight}`);
      }
      for (const hex of body.blocks) {
        const block = decodeBlock(hexToBytes(hex));
        if (block.header.height > batchTarget) break;
        const err = await archive.chain.addBlock(block);
        if (err !== null && err !== undefined) {
          throw new Error(`block at height ${block.header.height} rejected: ${err}`);
        }
        added++;
      }
      const rate = added / Math.max(1, (Date.now() - startedAt) / 1000);
      console.log(
        `[archive] validated ${added}/${totalNew} (height ${archive.chain.height}, ${rate.toFixed(1)} blk/s)`,
      );
    }
    await flush(dir, archive.chain, archive, chunkSize);
    console.log(`[archive] flushed through height ${archive.chain.height}`);
    if (archive.chain.height < target) {
      archive = await loadArchive(dir, chunkSize); // free per-block state memory
    }
  }

  // One-line summary for the Action's commit message. Lives at the archive
  // repo root and is gitignored there.
  const summary = `archive: ${BROWSERCOIN_NETWORK} height ${target} (+${totalNew} blocks)`;
  await fs.writeFile(path.join(out, 'commit-message.txt'), summary + '\n');
  console.log(`[archive] done — ${summary}`);
}

main().catch((e) => {
  console.error('[archive] FAILED:', (e as Error).message);
  process.exit(1);
});
