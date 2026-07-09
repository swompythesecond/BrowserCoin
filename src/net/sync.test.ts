import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blockchain } from '../chain/blockchain.js';
import { hashHeader, type Block } from '../chain/block.js';
import { emptyMine } from '../chain/testutil.js';
import { generateKeyPair } from '../crypto/keys.js';
import { bytesToHex } from '../util/binary.js';
import { Mempool } from '../chain/mempool.js';
import { ServerSync } from './serverSync.js';
import { signTx } from '../chain/transaction.js';

/**
 * Regression test for the bug the user hit: two browsers mined independent chains
 * from genesis, then connected — neither could reconcile, so heights diverged
 * forever. The fix is an orphan pool that walks back link-by-link to a common
 * ancestor and then drains forward. This test reimplements that algorithm
 * inline (the network-layer impl is in src/net/peer.ts) so we can verify the
 * algorithm itself without spinning up PeerJS.
 */

/** Inline simulation of peer.ts's orphan-pool / drainOrphans logic. */
async function syncFrom(receiver: Blockchain, sender: Blockchain): Promise<void> {
  const orphans = new Map<string, Block>();
  const fifo: Block[] = [sender.tip.block];

  while (fifo.length) {
    const block = fifo.shift()!;
    const ownHash = bytesToHex(hashHeader(block.header));
    if (receiver.hasBlock(ownHash)) continue;
    const err = await receiver.addBlock(block);
    if (err === null) {
      // drain forward
      let cursor: string | undefined = ownHash;
      while (cursor) {
        const waiting = orphans.get(cursor);
        if (!waiting) break;
        orphans.delete(cursor);
        const e2 = await receiver.addBlock(waiting);
        if (e2 !== null) break;
        cursor = bytesToHex(hashHeader(waiting.header));
      }
      continue;
    }
    if (err === 'parent block unknown') {
      orphans.set(bytesToHex(block.header.prevHash), block);
      // request parent from sender
      const parentEntry = sender.getBlock(bytesToHex(block.header.prevHash));
      if (parentEntry) fifo.push(parentEntry.block);
      continue;
    }
    throw new Error(`unexpected add error: ${err}`);
  }
}

describe('peer sync (orphan-pool reconciliation)', () => {
  it('reconciles two divergent solo-mined chains', async () => {
    const minerA = generateKeyPair();
    const minerB = generateKeyPair();
    const chainA = new Blockchain();
    const chainB = new Blockchain();

    // Both started from genesis and mined independently.
    for (let i = 0; i < 3; i++) await chainA.addBlock(await emptyMine(chainA, minerA.publicKey));
    for (let i = 0; i < 5; i++) await chainB.addBlock(await emptyMine(chainB, minerB.publicKey));

    expect(chainA.height).toBe(3);
    expect(chainB.height).toBe(5);
    expect(bytesToHex(chainA.tip.hash)).not.toBe(bytesToHex(chainB.tip.hash));

    // A learns about B's tip via "hello" and starts the orphan-pool walk.
    await syncFrom(chainA, chainB);

    expect(chainA.height).toBe(5);
    expect(bytesToHex(chainA.tip.hash)).toBe(bytesToHex(chainB.tip.hash));
  });

  it('lighter chain ignores sync from heavier-but-equal-height peer', async () => {
    // Both at height 2 with equal difficulty → first-seen wins, no reorg.
    const minerA = generateKeyPair();
    const minerB = generateKeyPair();
    const chainA = new Blockchain();
    const chainB = new Blockchain();
    for (let i = 0; i < 2; i++) await chainA.addBlock(await emptyMine(chainA, minerA.publicKey));
    for (let i = 0; i < 2; i++) await chainB.addBlock(await emptyMine(chainB, minerB.publicKey));

    const originalTipA = bytesToHex(chainA.tip.hash);
    await syncFrom(chainA, chainB);
    // A should now know about B's branch but stay on its own tip (equal work).
    expect(chainA.height).toBe(2);
    expect(bytesToHex(chainA.tip.hash)).toBe(originalTipA);
  });

  it('reorgs onto the heavier branch when it arrives', async () => {
    const minerA = generateKeyPair();
    const minerB = generateKeyPair();
    const chainA = new Blockchain();
    const chainB = new Blockchain();
    for (let i = 0; i < 4; i++) await chainA.addBlock(await emptyMine(chainA, minerA.publicKey));
    for (let i = 0; i < 7; i++) await chainB.addBlock(await emptyMine(chainB, minerB.publicKey));

    await syncFrom(chainA, chainB);

    expect(chainA.height).toBe(7);
    expect(bytesToHex(chainA.tip.hash)).toBe(bytesToHex(chainB.tip.hash));
  });
});

/**
 * The server bridge is what feeds a NAT-stuck / server-only miner: peered nodes
 * learn txs over P2P, so ServerSync only pulls the server mempool when the node
 * is isolated (0 peers) or actively mining. These tests stub `fetch` and drive
 * `syncOnce` directly to assert exactly when /mempool gets pulled.
 */
describe('server bridge mempool gating', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A fetch stub that records request paths and reports the server as being at
  // our genesis tip (so no block sync runs and we isolate the mempool logic).
  function stubFetch(chain: Blockchain): string[] {
    const paths: string[] = [];
    const tipHash = bytesToHex(chain.tip.hash);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(url.toString());
      paths.push(`${init?.method ?? 'GET'} ${u.pathname}`);
      const json = (data: unknown) => ({ ok: true, json: async () => data });
      if (u.pathname === '/tip') return json({ height: 0, tipHash });
      if (u.pathname === '/mempool') return json({ txs: [] });
      if (u.pathname === '/blocks') return json({ blocks: [] });
      if (u.pathname === '/txs') return json({ admitted: 0, errors: [] });
      return json({});
    }));
    return paths;
  }

  // syncOnce is private; drive it directly for a deterministic, awaitable test.
  const runSync = (s: ServerSync) =>
    (s as unknown as { syncOnce(): Promise<void> }).syncOnce();

  it('pulls the server mempool when isolated (0 peers)', async () => {
    const chain = new Blockchain();
    const sync = new ServerSync(chain, new Mempool(), ['http://x'], () => {});
    const paths = stubFetch(chain);
    await runSync(sync); // peerCount defaults to 0
    expect(paths).toContain('GET /mempool');
  });

  it('does NOT pull the server mempool when peered and not mining', async () => {
    const chain = new Blockchain();
    const sync = new ServerSync(chain, new Mempool(), ['http://x'], () => {});
    const paths = stubFetch(chain);
    sync.setPeerCount(2);
    await runSync(sync);
    expect(paths).not.toContain('GET /mempool');
  });

  it('pulls the server mempool when mining even if peered', async () => {
    const chain = new Blockchain();
    const sync = new ServerSync(chain, new Mempool(), ['http://x'], () => {}, () => true);
    const paths = stubFetch(chain);
    sync.setPeerCount(2);
    await runSync(sync);
    expect(paths).toContain('GET /mempool');
  });

  it('tries fast sync once on a deep backlog, then falls back to full sync', async () => {
    const chain = new Blockchain();
    const sync = new ServerSync(chain, new Mempool(), ['http://x'], () => {});
    const paths: string[] = [];
    const tipHash = bytesToHex(chain.tip.hash);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(url.toString());
      paths.push(`${init?.method ?? 'GET'} ${u.pathname}`);
      const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
      // Deep backlog → fast-sync eligible; /headers 404s (old server build).
      if (u.pathname === '/tip') return json({ height: 5000, tipHash });
      if (u.pathname === '/headers') return { ok: false, status: 404, json: async () => ({}) };
      if (u.pathname === '/blocks') return json({ blocks: [] });
      if (u.pathname === '/mempool') return json({ txs: [] });
      return json({});
    }));

    await runSync(sync);
    expect(paths.filter((p) => p === 'GET /headers').length).toBe(1);
    expect(paths).toContain('GET /blocks'); // fell back to the normal pull

    // Second tick: fast sync is once-per-session — no /headers retry.
    await runSync(sync);
    expect(paths.filter((p) => p === 'GET /headers').length).toBe(1);
  });

  it('pushTx POSTs the authored tx to the server for durability', async () => {
    const chain = new Blockchain();
    const sync = new ServerSync(chain, new Mempool(), ['http://x'], () => {});
    const paths = stubFetch(chain);
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const tx = signTx(
      { from: alice.publicKey, to: bob.publicKey, amount: 1n, fee: 200n, nonce: 0 },
      alice.privateKey,
    );
    sync.pushTx(tx);
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget POST resolve
    expect(paths).toContain('POST /txs');
  });
});
