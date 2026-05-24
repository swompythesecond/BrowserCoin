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
 * A miner is "active" if they reported mining=true within this window. Set
 * to 3× the client heartbeat interval (30s) so a single missed heartbeat
 * doesn't make the count flicker.
 */
const MINING_TTL_MS = 90_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAIN_FILE = path.join(__dirname, `chain-${PORT}.json`);

const chain = new Blockchain();
const mempool = new Mempool();
/** Orphan blocks (parent unknown) keyed by their parent hash hex. */
const orphans = new Map<string, Block>();
const MAX_ORPHANS = 2048;

async function loadChainFromDisk(): Promise<void> {
  try {
    const text = await fs.readFile(CHAIN_FILE, 'utf-8');
    const data = JSON.parse(text) as { version: number; blocks: string[] };
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

async function saveChainToDiskNow(): Promise<void> {
  const blocks: string[] = [];
  for (const cb of chain.iterateCanonical()) {
    if (cb.block.header.height > 0) blocks.unshift(bytesToHex(encodeBlock(cb.block)));
  }
  const tmp = CHAIN_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify({ version: 1, blocks }));
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

/** Try to add `b`. If parent unknown, park as orphan. After success, drain. */
async function tryAdmitBlock(b: Block): Promise<{ status: 'added' | 'orphan' | 'invalid'; parentNeeded?: string; error?: string }> {
  const ownHashHex = bytesToHex(hashHeader(b.header));
  if (chain.hasBlock(ownHashHex)) return { status: 'added' };

  const err = await chain.addBlock(b);
  if (err === null) {
    mempool.removeMany(b.transactions);
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
    mempool.removeMany(waiting.transactions);
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
const server = http.createServer(app);

app.use(express.json({ limit: '2mb' }));
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/stats', (_req, res) => {
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

app.get('/peers', (_req, res) => {
  const ids = [...peers.keys()].slice(0, 64);
  res.json({ peers: ids });
});

app.post('/heartbeat', (req, res) => {
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

app.get('/tip', (_req, res) => {
  res.json({ height: chain.height, tipHash: bytesToHex(chain.tip.hash) });
});

app.get('/blocks', (req, res) => {
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

app.get('/mempool', (_req, res) => {
  const txs = mempool.list().map((tx) => bytesToHex(encodeTx(tx)));
  res.json({ txs });
});

app.post('/txs', (req, res) => {
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

app.post('/block', async (req, res) => {
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

app.get('/', (_req, res) => {
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
  server.listen(PORT, () => {
    console.log(`BrowserCoin API helper listening on :${PORT}`);
    console.log(`  Chain file:  ${path.basename(CHAIN_FILE)}`);
    console.log(`  Chain tip:   height=${chain.height}`);
    console.log(`  Stats:       http://localhost:${PORT}/stats`);
  });
}

void main();
