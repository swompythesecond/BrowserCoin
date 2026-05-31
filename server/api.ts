/**
 * BrowserCoin HTTP API helper server.
 *
 * Role: chain backup + peer discovery + heartbeat. NO PeerJS signaling here
 * — that's a separate service (`server/peerjs.ts`) so the two can fail
 * independently.
 *
 * HTTP endpoints:
 *   GET  /                          plain-text info page
 *   GET  /tip                       latest known height + tip hash
 *   GET  /blocks?fromHeight=N&max=M canonical blocks (oldest-first), up to max
 *   POST /block                     submit a block; server validates + persists
 *   GET  /stats                     informational (peer count etc.)
 *   GET  /peers                     active peer ids for browsers to dial
 *   POST /heartbeat                 browsers keep themselves in /peers; mining flag tracks active miners
 *   GET  /mempool                   pending tx hex list
 *   POST /txs                       submit pending transactions
 *
 * Disk layout: each port gets its own `chain-${PORT}.json` file so multiple
 * local instances don't clobber each other. Existing deployments using the
 * legacy `chain.json` should rename it to `chain-9000.json` on first run.
 *
 * NOT an authority — every block is validated by the local Blockchain like
 * any peer-relayed block; browsers verify everything themselves anyway.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Blockchain } from '../src/chain/blockchain.js';
import { decodeBlock, encodeBlock, hashHeader, type Block } from '../src/chain/block.js';
import { bytesToHex, hexToBytes } from '../src/util/binary.js';
import { Mempool } from '../src/chain/mempool.js';
import { decodeTx, encodeTx, type Transaction } from '../src/chain/transaction.js';
import { parsePort } from './lib/cli.js';

const PORT = parsePort(9000);
const STALE_PEER_MS = 60_000;

/**
 * Chain-format version stamp written into the saved JSON. Must match the
 * client's CHAIN_VERSION (src/node.ts) and the PoW salt (src/crypto/pow.ts).
 * Bump when any of those change so the server auto-wipes its on-disk chain
 * on first startup of the new build instead of trying — and failing — to
 * replay blocks the new validator rejects.
 */
const CHAIN_VERSION = 'browsercoin-pow-v5';
/**
 * A miner is "active" if they reported mining=true within this window. Set
 * to 3× the client heartbeat interval (30s) so a single missed heartbeat
 * doesn't make the count flicker.
 */
const MINING_TTL_MS = 90_000;

/**
 * Per-IP rate limits. In-memory only — Redis would only be needed if this
 * API ran as multiple instances sharing limiter state, which is not the
 * current deployment shape (one process per port, one `chain-${PORT}.json`).
 */
const heavyLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const readHeavyLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const cheapLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAIN_FILE = path.join(__dirname, `chain-${PORT}.json`);

// Tiered chain checkpoints (grandfather-father-son rotation). The server keeps
// only one live chain file; these backups are point-in-time copies we can
// restore from. They are thinned as they age: twice-daily for the first week,
// then weekly out to 4 weeks, then monthly forever.
const BACKUP_DIR = path.join(__dirname, `backups-${PORT}`);
const BACKUP_INTERVAL_MS = 12 * 60 * 60 * 1000; // twice a day
const BACKUP_CHECK_MS = 1 * 60 * 60 * 1000; // re-evaluate hourly (survives restarts)
const TIER_DENSE_MS = 7 * 24 * 60 * 60 * 1000; // < 7d:    keep every backup (twice-daily)
const TIER_WEEKLY_MS = 28 * 24 * 60 * 60 * 1000; // 7-28d:   keep one per week
// >= 28d: keep one per calendar month, indefinitely

const chain = new Blockchain();
const mempool = new Mempool();
// Mempool eviction hangs off canonical-tip moves only — a tx must not be
// dropped just because it appeared in some accepted-but-non-canonical fork
// block. Reorg-displaced txs are returned to the pool to be re-mined.
chain.onTipChanged(({ confirmed, restored }) => {
  for (const tx of restored) mempool.add(tx, chain.tipState);
  mempool.removeMany(confirmed);
});
/** Orphan blocks (parent unknown) keyed by their parent hash hex. */
const orphans = new Map<string, Block>();
const MAX_ORPHANS = 2048;

async function loadChainFromDisk(): Promise<void> {
  try {
    const text = await fs.readFile(CHAIN_FILE, 'utf-8');
    const data = JSON.parse(text) as { version: number; chainVersion?: string; blocks: string[] };
    // Version gate: if the on-disk chain was written by an incompatible
    // build, wipe it and start from genesis. Without this, an upgraded
    // server would try (and noisily fail) to replay every old block under
    // the new consensus rules until an operator manually deleted the file.
    if (data.chainVersion !== CHAIN_VERSION) {
      const found = data.chainVersion ?? '<unset>';
      console.warn(
        `[chain] disk chain version "${found}" does not match build "${CHAIN_VERSION}" — ` +
          `wiping ${path.basename(CHAIN_FILE)} and starting fresh from genesis`,
      );
      await fs.rm(CHAIN_FILE, { force: true });
      return;
    }
    let replayed = 0;
    for (const hex of data.blocks) {
      const b = decodeBlock(hexToBytes(hex));
      const err = await chain.addBlock(b);
      if (err === null) replayed++;
      else console.warn('[chain] disk block rejected:', err);
    }
    console.log(`[chain] restored ${replayed} blocks from disk; tip height=${chain.height}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[chain] load failed:', (e as Error).message);
    } else {
      console.log(`[chain] no ${path.basename(CHAIN_FILE)} yet — starting fresh from genesis`);
    }
  }
}

/** Serialize the canonical chain (excluding genesis) to the on-disk JSON shape. */
function serializeChain(): string {
  const blocks: string[] = [];
  for (const cb of chain.iterateCanonical()) {
    if (cb.block.header.height > 0) blocks.unshift(bytesToHex(encodeBlock(cb.block)));
  }
  return JSON.stringify({ version: 1, chainVersion: CHAIN_VERSION, blocks });
}

async function saveChainToDiskNow(): Promise<void> {
  const tmp = CHAIN_FILE + '.tmp';
  await fs.writeFile(tmp, serializeChain());
  await fs.rename(tmp, CHAIN_FILE);
}

/**
 * Coalescing serializer for chain saves. Concurrent block POSTs used to race
 * on the same chain.json.tmp file — first rename consumed it, second rename
 * hit ENOENT. We now keep at most one save in flight; any saves requested
 * while it's running just set a "do one more after this" flag, then a single
 * trailing save captures the latest chain state.
 */
let saveInFlight = false;
let savePending = false;

async function saveChainToDisk(): Promise<void> {
  if (saveInFlight) {
    savePending = true;
    return;
  }
  saveInFlight = true;
  try {
    do {
      savePending = false;
      await saveChainToDiskNow();
    } while (savePending);
  } finally {
    saveInFlight = false;
  }
}

// ─── Tiered chain checkpoints ────────────────────────────────────────────────

const BACKUP_PREFIX = `chain-${PORT}-`;

/** UTC, colon-free (Windows-safe) timestamp for a backup filename: YYYY-MM-DD_HHmmZ. */
function backupStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `_${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`
  );
}

/** Parse the UTC timestamp back out of a backup filename. Returns null if unparseable. */
function parseBackupStamp(name: string): number | null {
  const m = name.match(/-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})Z\.json$/);
  if (!m) return null;
  const [, y, mo, da, h, mi] = m;
  const t = Date.UTC(+y, +mo - 1, +da, +h, +mi);
  return Number.isNaN(t) ? null : t;
}

interface BackupEntry {
  name: string;
  time: number; // ms epoch, from filename (preferred) or mtime (fallback)
}

/** List existing backups with their effective timestamps, newest first. */
async function listBackups(): Promise<BackupEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(BACKUP_DIR);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const entries: BackupEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(BACKUP_PREFIX) || !name.endsWith('.json')) continue;
    let time = parseBackupStamp(name);
    if (time === null) {
      try {
        time = (await fs.stat(path.join(BACKUP_DIR, name))).mtimeMs;
      } catch {
        continue;
      }
    }
    entries.push({ name, time });
  }
  entries.sort((a, b) => b.time - a.time);
  return entries;
}

/** Write a checkpoint of the current in-memory chain to the backup dir. */
async function writeBackupNow(): Promise<void> {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const name = `${BACKUP_PREFIX}${backupStamp(new Date())}.json`;
  const dest = path.join(BACKUP_DIR, name);
  const tmp = dest + '.tmp';
  await fs.writeFile(tmp, serializeChain());
  await fs.rename(tmp, dest);
  console.log(`[backup] wrote ${name} (height=${chain.height})`);
}

/**
 * Thin aged backups per the retention tiers. Keeps every backup younger than
 * TIER_DENSE_MS, one per ISO-week between TIER_DENSE_MS and TIER_WEEKLY_MS, and
 * one per calendar month beyond that (kept indefinitely). Within each week/month
 * bucket the newest backup is kept; the rest are deleted.
 */
async function pruneBackups(): Promise<void> {
  const entries = await listBackups(); // newest first
  const now = Date.now();
  const seen = new Set<string>(); // bucket keys already claimed by a kept backup
  const toDelete: string[] = [];

  for (const e of entries) {
    const age = now - e.time;
    if (age < TIER_DENSE_MS) continue; // dense tier: keep all

    const d = new Date(e.time);
    let bucket: string;
    if (age < TIER_WEEKLY_MS) {
      bucket = `w:${isoYearWeek(d)}`;
    } else {
      bucket = `m:${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
    }
    // entries are newest-first, so the first one we see in a bucket is the
    // newest — keep it, drop any older sibling in the same bucket.
    if (seen.has(bucket)) toDelete.push(e.name);
    else seen.add(bucket);
  }

  for (const name of toDelete) {
    await fs.rm(path.join(BACKUP_DIR, name), { force: true });
  }
  if (toDelete.length > 0) {
    console.log(`[backup] pruned ${toDelete.length} aged checkpoint(s)`);
  }
}

/** ISO-8601 year-week key (e.g. "2026-22") for weekly bucketing, in UTC. */
function isoYearWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Shift to the Thursday of this week, then count weeks from Jan 1.
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

/**
 * Take a checkpoint if one is due, then prune. "Due" is derived from the newest
 * existing backup's timestamp (not an in-memory tick) so the schedule survives
 * restarts: no double-backup on restart, no skipped slot after brief downtime.
 */
async function backupTick(): Promise<void> {
  try {
    const entries = await listBackups();
    const newest = entries[0]?.time ?? -Infinity;
    if (Date.now() - newest >= BACKUP_INTERVAL_MS - 60_000) {
      await writeBackupNow();
    }
    await pruneBackups();
  } catch (e) {
    console.warn('[backup] tick failed:', (e as Error).message);
  }
}

/** Try to add `b`. If parent unknown, park as orphan. After success, drain. */
async function tryAdmitBlock(b: Block): Promise<{ status: 'added' | 'orphan' | 'invalid'; parentNeeded?: string; error?: string }> {
  const ownHashHex = bytesToHex(hashHeader(b.header));
  if (chain.hasBlock(ownHashHex)) return { status: 'added' };

  const err = await chain.addBlock(b);
  if (err === null) {
    // Mempool reconciliation happens in the onTipChanged handler.
    await drainOrphans(ownHashHex);
    return { status: 'added' };
  }
  if (err === 'parent block unknown') {
    const parentHex = bytesToHex(b.header.prevHash);
    if (orphans.size >= MAX_ORPHANS) {
      const firstKey = orphans.keys().next().value;
      if (firstKey !== undefined) orphans.delete(firstKey);
    }
    orphans.set(parentHex, b);
    return { status: 'orphan', parentNeeded: parentHex };
  }
  return { status: 'invalid', error: err };
}

async function drainOrphans(addedHashHex: string): Promise<void> {
  let cursor: string | undefined = addedHashHex;
  while (cursor) {
    const waiting = orphans.get(cursor);
    if (!waiting) return;
    orphans.delete(cursor);
    const err = await chain.addBlock(waiting);
    if (err !== null) return;
    // Mempool reconciliation happens in the onTipChanged handler.
    cursor = bytesToHex(hashHeader(waiting.header));
  }
}

interface PeerState {
  id: string;
  lastSeen: number;
  reportedHeight: number;
  /**
   * Timestamp of the most recent heartbeat where the peer reported mining=true.
   * null = never reported mining. Compared against MINING_TTL_MS to decide
   * whether the peer counts as "actively mining right now."
   */
  lastMiningAt: number | null;
}
const peers = new Map<string, PeerState>();

function activeMinerCount(now: number): number {
  let n = 0;
  for (const p of peers.values()) {
    if (p.lastMiningAt !== null && now - p.lastMiningAt < MINING_TTL_MS) n++;
  }
  return n;
}

/**
 * Sweep stale peer entries. With signaling now in a separate process, this
 * server has no direct WebSocket-disconnect signal — the only liveness
 * evidence is the client's HTTP heartbeat (every 30s). After STALE_PEER_MS
 * with no heartbeat the entry is dropped from /peers.
 */
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of peers) {
    if (now - s.lastSeen > STALE_PEER_MS) peers.delete(id);
  }
}, 10_000);

const app = express();
// Trust one proxy hop (Netlify/Cloudflare/Caddy/nginx) so `req.ip` reflects
// the real client IP from `X-Forwarded-For`. Without this, per-IP limits
// would bucket every request under the proxy's address. Update the hop
// count if the deployment topology changes.
app.set('trust proxy', 1);
const server = http.createServer(app);

app.use(express.json({ limit: '2mb' }));
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/stats', cheapLimiter, (_req, res) => {
  const now = Date.now();
  const heights = [...peers.values()].map((p) => p.reportedHeight).sort((a, b) => b - a);
  res.json({
    peerCount: peers.size,
    minersActive: activeMinerCount(now),
    serverHeight: chain.height,
    serverTip: bytesToHex(chain.tip.hash),
    latestHeight: Math.max(chain.height, heights[0] ?? 0),
    medianHeight: heights[Math.floor(heights.length / 2)] ?? 0,
    serverTime: now,
  });
});

app.get('/peers', cheapLimiter, (_req, res) => {
  const ids = [...peers.keys()].slice(0, 64);
  res.json({ peers: ids });
});

app.post('/heartbeat', cheapLimiter, (req, res) => {
  const { id, height, mining } = req.body as { id?: string; height?: number; mining?: boolean };
  if (typeof id !== 'string' || typeof height !== 'number') {
    res.status(400).json({ error: 'bad heartbeat' });
    return;
  }
  const now = Date.now();
  const existing = peers.get(id);
  if (existing) {
    existing.lastSeen = now;
    existing.reportedHeight = height;
    if (mining === true) existing.lastMiningAt = now;
  } else {
    peers.set(id, {
      id,
      lastSeen: now,
      reportedHeight: height,
      lastMiningAt: mining === true ? now : null,
    });
  }
  res.json({ ok: true });
});

app.get('/tip', cheapLimiter, (_req, res) => {
  res.json({ height: chain.height, tipHash: bytesToHex(chain.tip.hash) });
});

app.get('/blocks', readHeavyLimiter, (req, res) => {
  const fromHeight = Math.max(0, Number(req.query.fromHeight ?? 0));
  const max = Math.max(1, Math.min(200, Number(req.query.max ?? 100)));
  // Walk canonical newest-first, unshift to get oldest-first.
  const blocks: string[] = [];
  for (const cb of chain.iterateCanonical()) {
    if (cb.block.header.height >= fromHeight) {
      blocks.unshift(bytesToHex(encodeBlock(cb.block)));
    }
  }
  res.json({ blocks: blocks.slice(0, max) });
});

app.get('/mempool', cheapLimiter, (_req, res) => {
  const txs = mempool.list().map((tx) => bytesToHex(encodeTx(tx)));
  res.json({ txs });
});

app.post('/txs', heavyLimiter, (req, res) => {
  const body = req.body as { txs?: string[] };
  if (!Array.isArray(body?.txs)) {
    res.status(400).json({ status: 'invalid', error: 'missing txs array' });
    return;
  }
  let admitted = 0;
  const errors: string[] = [];
  for (const hex of body.txs) {
    let tx: Transaction;
    try {
      tx = decodeTx(hexToBytes(hex)).tx;
    } catch (e) {
      errors.push((e as Error).message);
      continue;
    }
    const err = mempool.add(tx, chain.tipState);
    if (err === null) admitted++;
    else errors.push(err);
  }
  res.json({ admitted, errors });
});

app.post('/block', heavyLimiter, async (req, res) => {
  const body = req.body as { block?: string };
  if (!body?.block) {
    res.status(400).json({ status: 'invalid', error: 'missing block field' });
    return;
  }
  try {
    const b = decodeBlock(hexToBytes(body.block));
    const result = await tryAdmitBlock(b);
    if (result.status === 'added') {
      saveChainToDisk().catch((e) => console.warn('[chain] save failed:', e.message));
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ status: 'invalid', error: (e as Error).message });
  }
});

app.get('/', cheapLimiter, (_req, res) => {
  res.type('text/plain').send(
    [
      'BrowserCoin API helper server',
      `chain height: ${chain.height}  tip: ${bytesToHex(chain.tip.hash).slice(0, 16)}…`,
      `peers known: ${peers.size}`,
      '',
      'This is the HTTP API helper only — WebRTC signaling is a separate service.',
      '',
      'endpoints:',
      '  /stats       — JSON network + chain stats',
      '  /peers       — JSON list of active peer ids',
      '  /heartbeat   — POST { id, height, mining }  browser keepalive',
      '  /tip         — JSON { height, tipHash }',
      '  /blocks      — GET ?fromHeight=N&max=M  canonical blocks',
      '  /block       — POST { block: <hex> }    submit a block',
      '  /mempool     — JSON list of pending tx hex',
      '  /txs         — POST { txs: [<hex>, …] } submit pending transactions',
    ].join('\n'),
  );
});

async function main(): Promise<void> {
  await loadChainFromDisk();
  // Checkpoint scheduler: only starts after the chain is loaded so the first
  // backup reflects real state. backupTick decides "due" from existing files.
  await backupTick();
  setInterval(() => {
    void backupTick();
  }, BACKUP_CHECK_MS);
  server.listen(PORT, () => {
    console.log(`BrowserCoin API helper listening on :${PORT}`);
    console.log(`  Chain file:  ${path.basename(CHAIN_FILE)}`);
    console.log(`  Chain tip:   height=${chain.height}`);
    console.log(`  Backups:     ${path.basename(BACKUP_DIR)}/ (12h, tiered retention)`);
    console.log(`  Stats:       http://localhost:${PORT}/stats`);
  });
}

void main();
