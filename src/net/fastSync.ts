/**
 * Headers-first fast sync.
 *
 * Lets a fresh tab start mining in about a minute instead of replaying the
 * whole chain from genesis. Every block header commits a `stateRoot` (a merkle
 * root of the full account state) inside the Argon2id PoW pre-image, so a
 * snapshot of the account state at height H is verifiable against header H —
 * no server is trusted at any point:
 *
 *   1. Download all canonical headers (148 B each) from a helper's /headers.
 *   2. Verify EVERY header cheaply: height sequence, sha256 prev-hash linkage
 *      back to the hardcoded genesis, the exact ASERT difficulty schedule, and
 *      MTP/future-time timestamp rules.
 *   3. Cross-check the resulting tip against the other helpers' /tip.
 *   4. Verify Argon2id PoW on the last HEADER_POW_RECENT headers ending at the
 *      anchor plus HEADER_POW_SAMPLES random earlier heights (worker pool).
 *      Random sampling means a forged chain needs real work ≈ honest mining.
 *      The remaining headers get full PoW verification in the background as
 *      history backfill re-downloads their blocks (see backfill.ts).
 *   5. Download /snapshot (the account state after some finalized height H),
 *      require stateRoot(snapshot) === header[H].stateRoot.
 *   6. Seed the chain: header-only entries below H, the anchor at H carrying
 *      the snapshot state. The caller then pulls the tail H+1..tip as full,
 *      fully-validated blocks through the normal sync path.
 *
 * Failure at ANY step falls back to the existing full sync — helper servers
 * stay strictly optional accelerators. A helper without these endpoints (404)
 * is marked unsupported for the session without dinging its health score.
 * Even a wrongly-accepted chain only wastes this miner's own hashpower: every
 * other node validates all blocks, so the network is never at risk.
 */

import type { Blockchain } from '../chain/blockchain.js';
import {
  HEADER_LEN,
  decodeHeader,
  hashHeader,
  type Block,
  type BlockHeader,
} from '../chain/block.js';
import { GENESIS, MAX_FUTURE_TIME_S, MTP_WINDOW, SANDGLASS2_ANCHOR_HEIGHT } from '../chain/genesis.js';
import { medianTimePast, nextDifficulty } from '../chain/consensus.js';
import { deserializeState, stateRoot, type LockRow, type StateRow } from '../chain/state.js';
import { bytesToHex, compareBytes, hexToBytes } from '../util/binary.js';
import { noteFailure, noteSuccess, readJsonCapped } from './apiFanout.js';
import { BROWSERCOIN_NETWORK } from './network.js';

/**
 * Only fast-sync when the backlog is worth it. Within this many blocks of the
 * tip, replaying the tail as full blocks is cheaper than re-pulling every
 * header plus a snapshot, so the normal block-by-block path wins. Beyond it we
 * always fast-sync — including a tab resuming a large partial chain, which
 * otherwise ground through a slow full-verify of the whole gap.
 */
export const FAST_SYNC_MIN_BACKLOG = 2000;
/** Headers per /headers request: 4000 × 148 B ≈ 592 KB raw (~1.2 MB hex). */
export const HEADERS_BATCH = 4000;
/** Argon2id-verify this many headers ending at the anchor (≥ retarget lookback). */
export const HEADER_POW_RECENT = 160;
/** Plus this many uniformly-random earlier headers. */
export const HEADER_POW_SAMPLES = 64;
/** Reject a snapshot anchored more than this far below the fetched tip. */
export const FAST_SYNC_MAX_TAIL = 1000;
/** Hostile-helper OOM defense on response bodies. */
const MAX_HEADERS_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
/** Yield to the event loop every this many headers during cheap verification. */
const VERIFY_CHUNK = 2048;

export interface FastSyncProgress {
  phase: 'headers' | 'snapshot';
  done: number;
  total: number;
}

/** Everything the caller needs to persist for instant restore on reload. */
export interface FastSyncPersistData {
  anchorHeight: number;
  anchorHashHex: string;
  /** encodeHeader() of heights 1..anchorHeight, concatenated (148 B each). */
  headerBytes: Uint8Array;
  accounts: StateRow[];
  locks: LockRow[];
}

export interface FastSyncDeps {
  chain: Blockchain;
  servers: string[];
  /** Injected fetch (ServerSync's fetchWithTimeout; a stub in tests). */
  fetchImpl: (url: string) => Promise<Response>;
  /** Argon2id verifier — VerifierPool in production, checkPoW-based in tests. */
  verifier: { verifyAll(blocks: Block[]): Promise<boolean[]> };
  onProgress?: (p: FastSyncProgress) => void;
  persist?: (data: FastSyncPersistData) => Promise<void>;
  /** Random height picker for PoW sampling — injectable for deterministic tests. */
  sampler?: (maxExclusive: number) => number;
}

export type FastSyncResult =
  | { status: 'ok'; anchorHeight: number }
  | { status: 'skipped' }
  | { status: 'unsupported' }
  /**
   * `retryable` separates transient trouble (fetch timeouts on a flaky mobile
   * connection, a snapshot mid-rebuild, helpers disagreeing during a reorg)
   * from hard verification failures (broken linkage, bad PoW, bad state root)
   * where the served data itself is wrong and retrying would just re-download
   * the same poison. Callers may re-attempt retryable failures; a hard failure
   * should fall back to full sync for the session.
   */
  | { status: 'failed'; reason: string; retryable: boolean };

interface HeadersWire {
  v: number;
  fromHeight: number;
  count: number;
  headers: string;
}

interface SnapshotWire {
  v: number;
  chainVersion: string;
  height: number;
  hashHex: string;
  accounts: StateRow[];
  locks?: LockRow[];
}

export function fastSyncEligible(localHeight: number, serverHeight: number): boolean {
  // Gate purely on the backlog — how far behind the tip we are — not on the
  // local height. A tab resuming a big partial chain (e.g. interrupted at
  // 12k with the tip at 28k) is exactly the case that most needs the fast
  // path; the old `localHeight < FAST_SYNC_MIN_BACKLOG` clause locked it out
  // and forced a slow full-verify of the whole gap. Seeding is idempotent by
  // block hash, so running fast sync over an existing prefix is safe: blocks
  // we already hold become no-ops and only the missing gap is seeded.
  return serverHeight - localHeight > FAST_SYNC_MIN_BACKLOG;
}

export async function attemptFastSync(
  deps: FastSyncDeps,
  serverTip: { height: number; tipHash: string },
): Promise<FastSyncResult> {
  if (!fastSyncEligible(deps.chain.height, serverTip.height)) return { status: 'skipped' };
  if (deps.servers.length === 0) return { status: 'unsupported' };

  // Servers that 404'd /headers or /snapshot this session — old builds, not
  // unhealthy ones, so they're skipped locally WITHOUT noteFailure.
  const unsupported = new Set<string>();

  // ── 1. Pull all headers, height-ascending from 1 (genesis is hardcoded). ──
  const target = serverTip.height;
  const headers: BlockHeader[] = [];
  const rawHeaders: Uint8Array[] = []; // exact wire bytes, reused for hashing + persistence
  let cursor = 1;
  while (cursor <= target) {
    const batch = await fetchHeadersBatch(deps, unsupported, cursor, Math.min(HEADERS_BATCH, target - cursor + 1));
    if (batch === 'unsupported') return { status: 'unsupported' };
    if (batch === null) return { status: 'failed', reason: 'headers fetch failed on every server', retryable: true };
    if (batch.count === 0) break; // server has fewer blocks than the /tip we saw
    const buf = hexToBytes(batch.headers);
    for (let off = 0; off + HEADER_LEN <= buf.length; off += HEADER_LEN) {
      rawHeaders.push(buf.subarray(off, off + HEADER_LEN));
      headers.push(decodeHeader(buf, off));
    }
    cursor += batch.count;
    deps.onProgress?.({ phase: 'headers', done: Math.min(headers.length, target), total: target });
  }
  // Allow a slightly-shrunk server chain (tiny reorg mid-pull), nothing bigger.
  if (headers.length < target - 64) {
    return { status: 'failed', reason: `expected ~${target} headers, got ${headers.length}`, retryable: true };
  }
  const topHeight = headers.length;

  // ── 2. Cheap full-chain verification (linkage, schedule, timestamps). ──────
  // Equivalent to addBlockInternal's header checks: nextDifficulty only reads
  // the parent + grandparent, and MTP reads the last MTP_WINDOW headers — so a
  // rolling window replaces the full getRecentHeaders walk.
  const hashes: Uint8Array[] = [];
  let prevHash = hashHeader(GENESIS.header);
  const window: BlockHeader[] = [GENESIS.header];
  // Fork-#3 ASERT anchor. The rolling MTP window is far too short to still hold
  // it once we're past SANDGLASS2_ANCHOR_HEIGHT + RETARGET_LOOKBACK, so capture
  // it as we walk by. We verify strictly height-ascending from 1, so it is
  // always in hand before the first block that needs it.
  let sandglass2Anchor: BlockHeader | null = null;
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    if (h.height !== i + 1) return { status: 'failed', reason: `height sequence broken at index ${i}`, retryable: false };
    if (compareBytes(h.prevHash, prevHash) !== 0) {
      return { status: 'failed', reason: `header linkage broken at height ${h.height}`, retryable: false };
    }
    if (h.difficulty !== nextDifficulty(h.height, window, h.timestamp, sandglass2Anchor)) {
      return { status: 'failed', reason: `difficulty schedule violated at height ${h.height}`, retryable: false };
    }
    const mtp = medianTimePast(window);
    if (mtp > 0 && h.timestamp <= mtp) {
      return { status: 'failed', reason: `timestamp below median-time-past at height ${h.height}`, retryable: false };
    }
    if (h.timestamp > now + MAX_FUTURE_TIME_S) {
      return { status: 'failed', reason: `timestamp too far in future at height ${h.height}`, retryable: false };
    }
    if (h.height === SANDGLASS2_ANCHOR_HEIGHT) sandglass2Anchor = h;
    prevHash = hashHeader(h);
    hashes.push(prevHash);
    window.push(h);
    if (window.length > MTP_WINDOW) window.shift();
    if (i % VERIFY_CHUNK === VERIFY_CHUNK - 1) {
      await yieldToEventLoop();
      deps.onProgress?.({ phase: 'headers', done: i + 1, total: target });
    }
  }

  // ── 3. Cross-check the fetched chain against other helpers' /tip. ──────────
  // A helper confirms if its tip is one of our fetched headers, or if it
  // reports at least our height (it may have advanced past our pull — sampled
  // PoW still protects us). With ≥2 tip responses, require ≥2 confirmations.
  if (deps.servers.length > 1) {
    const recentHashes = new Set<string>();
    for (let i = Math.max(0, hashes.length - FAST_SYNC_MAX_TAIL); i < hashes.length; i++) {
      recentHashes.add(bytesToHex(hashes[i]!));
    }
    let responses = 0;
    let confirming = 0;
    await Promise.allSettled(deps.servers.map(async (base) => {
      try {
        const r = await deps.fetchImpl(new URL('/tip', base).toString());
        if (!r.ok) return;
        const v = (await r.json()) as { height: number; tipHash: string };
        responses++;
        if (recentHashes.has(v.tipHash) || v.height >= topHeight) confirming++;
      } catch { /* unreachable server — not a vote */ }
    }));
    if (responses >= 2 && confirming < 2) {
      return { status: 'failed', reason: 'tip cross-check failed (helpers disagree with fetched chain)', retryable: true };
    }
  }

  // ── 4. Fetch + verify the state snapshot against its PoW-committed root. ───
  deps.onProgress?.({ phase: 'snapshot', done: 0, total: 1 });
  const snap = await fetchSnapshot(deps, unsupported, headers, hashes, topHeight);
  if (snap === 'unsupported') return { status: 'unsupported' };
  if (snap === null) return { status: 'failed', reason: 'no server produced a verifiable snapshot', retryable: true };
  const anchorIdx = snap.height - 1;

  // ── 5. Sampled Argon2id PoW: recent window ending at the anchor + randoms. ─
  const sampler = deps.sampler ?? ((maxExclusive: number) => Math.floor(Math.random() * maxExclusive));
  const powIdxs = new Set<number>();
  const recentStart = Math.max(0, anchorIdx - HEADER_POW_RECENT + 1);
  for (let i = recentStart; i <= anchorIdx; i++) powIdxs.add(i);
  if (recentStart > 0) {
    for (let k = 0; k < HEADER_POW_SAMPLES; k++) {
      powIdxs.add(Math.max(0, Math.min(recentStart - 1, sampler(recentStart))));
    }
  }
  const powBlocks: Block[] = [...powIdxs].map((i) => ({ header: headers[i]!, transactions: [] }));
  const powResults = await deps.verifier.verifyAll(powBlocks);
  if (powResults.some((ok) => !ok)) {
    return { status: 'failed', reason: 'sampled PoW verification failed', retryable: false };
  }

  // ── 6. Seed the chain: headers below the anchor, the anchor with state. ────
  // Headers ABOVE the anchor are deliberately NOT seeded — the tail arrives as
  // full blocks via the normal pull, and a pre-seeded header would make
  // addBlock's hash-dedup silently swallow the real body.
  const state = deserializeState(snap.accounts, snap.locks ?? []);
  for (let i = 0; i < anchorIdx; i++) {
    const err = deps.chain.seedHeader(headers[i]!);
    if (err) {
      deps.chain.reset();
      return { status: 'failed', reason: `seed h=${i + 1}: ${err}`, retryable: false };
    }
  }
  const anchorErr = deps.chain.seedAnchor(headers[anchorIdx]!, state);
  if (anchorErr) {
    deps.chain.reset();
    return { status: 'failed', reason: `seed anchor: ${anchorErr}`, retryable: false };
  }

  // ── 7. Persist for instant restore on reload (best-effort). ────────────────
  if (deps.persist) {
    const headerBytes = new Uint8Array((anchorIdx + 1) * HEADER_LEN);
    for (let i = 0; i <= anchorIdx; i++) headerBytes.set(rawHeaders[i]!, i * HEADER_LEN);
    try {
      await deps.persist({
        anchorHeight: snap.height,
        anchorHashHex: snap.hashHex,
        headerBytes,
        accounts: snap.accounts,
        locks: snap.locks ?? [],
      });
    } catch (e) {
      console.warn('[fastSync] persist failed (reload will re-sync):', (e as Error).message);
    }
  }

  return { status: 'ok', anchorHeight: snap.height };
}

/** One /headers page from the first supporting, responsive server. */
async function fetchHeadersBatch(
  deps: FastSyncDeps,
  unsupported: Set<string>,
  fromHeight: number,
  max: number,
): Promise<HeadersWire | 'unsupported' | null> {
  let anySupported = false;
  for (const base of deps.servers) {
    if (unsupported.has(base)) continue;
    anySupported = true;
    try {
      const r = await deps.fetchImpl(new URL(`/headers?fromHeight=${fromHeight}&max=${max}`, base).toString());
      if (r.status === 404 || r.status === 501) {
        unsupported.add(base); // old build — skip for the session, no health penalty
        continue;
      }
      if (!r.ok) {
        noteFailure(base);
        continue;
      }
      const body = (await readJsonCapped(r, MAX_HEADERS_RESPONSE_BYTES)) as HeadersWire;
      if (
        body?.v !== 1 ||
        typeof body.headers !== 'string' ||
        typeof body.count !== 'number' ||
        body.count < 0 || body.count > max ||
        body.headers.length !== body.count * HEADER_LEN * 2
      ) {
        noteFailure(base);
        continue;
      }
      noteSuccess(base);
      return body;
    } catch {
      noteFailure(base);
    }
  }
  if (!anySupported || unsupported.size === deps.servers.length) return 'unsupported';
  return null;
}

/** The first snapshot any server serves that verifies against our header chain. */
async function fetchSnapshot(
  deps: FastSyncDeps,
  unsupported: Set<string>,
  headers: BlockHeader[],
  hashes: Uint8Array[],
  topHeight: number,
): Promise<SnapshotWire | 'unsupported' | null> {
  let anySupported = false;
  for (const base of deps.servers) {
    if (unsupported.has(base)) continue;
    anySupported = true;
    try {
      const r = await deps.fetchImpl(new URL('/snapshot', base).toString());
      if (r.status === 404 || r.status === 501) {
        unsupported.add(base);
        continue;
      }
      if (!r.ok) continue; // 503 = snapshot not built yet — try the next server
      const body = (await readJsonCapped(r, MAX_SNAPSHOT_BYTES)) as SnapshotWire;
      if (
        body?.v !== 1 ||
        body.chainVersion !== BROWSERCOIN_NETWORK ||
        typeof body.height !== 'number' ||
        typeof body.hashHex !== 'string' ||
        !Array.isArray(body.accounts) ||
        (body.locks !== undefined && !Array.isArray(body.locks))
      ) {
        noteFailure(base);
        continue;
      }
      if (body.height < 1 || body.height > topHeight || topHeight - body.height > FAST_SYNC_MAX_TAIL) {
        continue; // stale or out-of-range snapshot — not this server's fault, just unusable
      }
      if (body.hashHex !== bytesToHex(hashes[body.height - 1]!)) {
        noteFailure(base); // claims a block we've proven isn't canonical
        continue;
      }
      const state = deserializeState(body.accounts, body.locks ?? []);
      if (compareBytes(stateRoot(state), headers[body.height - 1]!.stateRoot) !== 0) {
        noteFailure(base); // state doesn't hash to the PoW-committed root
        continue;
      }
      noteSuccess(base);
      return body;
    } catch {
      noteFailure(base);
    }
  }
  if (!anySupported || unsupported.size === deps.servers.length) return 'unsupported';
  return null;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
