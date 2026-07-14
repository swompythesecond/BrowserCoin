import { describe, expect, it } from 'vitest';
import { Blockchain } from '../chain/blockchain.js';
import {
  HEADER_LEN,
  computeTxRoot,
  encodeHeader,
  hashHeader,
  type BlockHeader,
} from '../chain/block.js';
import {
  GENESIS,
  GENESIS_DIFFICULTY_COMPACT,
  GENESIS_TIMESTAMP,
  SNAPSHOT_DEPTH,
  TARGET_BLOCK_TIME_S,
} from '../chain/genesis.js';
import {
  deserializeState,
  getAccount,
  serializeState,
  stateRoot,
  type State,
} from '../chain/state.js';
import { bytesToHex } from '../util/binary.js';
import { BROWSERCOIN_NETWORK } from './network.js';
import {
  FAST_SYNC_MIN_BACKLOG,
  attemptFastSync,
  fastSyncEligible,
  type FastSyncDeps,
  type FastSyncPersistData,
} from './fastSync.js';

/**
 * Fast sync's cheap verification checks linkage + the difficulty schedule +
 * timestamps, but Argon2id PoW goes through the injected verifier — so a test
 * chain needs consistent headers (blocks at exact target pace keep ASERT at
 * the genesis floor) but NO actual mining. That's what makes a 2000+-header
 * chain constructible in milliseconds here.
 */
const TOP = FAST_SYNC_MIN_BACKLOG + 100; // 2100
const ANCHOR = TOP - SNAPSHOT_DEPTH;     // 2000

interface Fixture {
  headers: BlockHeader[]; // heights 1..TOP
  state: State;           // committed by the anchor header's stateRoot
  tipHashHex: string;
  anchorHashHex: string;
}

function buildFixture(): Fixture {
  const state = deserializeState([[
    '11'.repeat(32), '5000000000', 3,
  ]]);
  const anchorRoot = stateRoot(state);
  const headers: BlockHeader[] = [];
  let prevHash = hashHeader(GENESIS.header);
  for (let height = 1; height <= TOP; height++) {
    const h: BlockHeader = {
      height,
      prevHash,
      txRoot: computeTxRoot([]),
      stateRoot: height === ANCHOR ? anchorRoot : new Uint8Array(32),
      timestamp: GENESIS_TIMESTAMP + height * TARGET_BLOCK_TIME_S,
      difficulty: GENESIS_DIFFICULTY_COMPACT, // exact target pace → floor forever
      nonce: 0,
      miner: new Uint8Array(32),
    };
    headers.push(h);
    prevHash = hashHeader(h);
  }
  return {
    headers,
    state,
    tipHashHex: bytesToHex(prevHash),
    anchorHashHex: bytesToHex(hashHeader(headers[ANCHOR - 1]!)),
  };
}

/** Fake helper server: serves /headers, /tip, /snapshot from a fixture. */
function makeFetch(fx: Fixture, overrides: {
  tamperHeaders?: (headers: BlockHeader[]) => BlockHeader[];
  snapshotAccounts?: ReturnType<typeof serializeState>;
  status404?: boolean;
  tip?: { height: number; tipHash: string };
} = {}): (url: string) => Promise<Response> {
  const served = overrides.tamperHeaders ? overrides.tamperHeaders([...fx.headers]) : fx.headers;
  const respond = (data: unknown): Response =>
    ({ ok: true, status: 200, json: async () => data } as unknown as Response);
  const notFound = (): Response =>
    ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);

  return async (url: string) => {
    const u = new URL(url);
    if (overrides.status404) return notFound();
    if (u.pathname === '/tip') {
      return respond(overrides.tip ?? { height: served.length, tipHash: fx.tipHashHex });
    }
    if (u.pathname === '/headers') {
      const from = Number(u.searchParams.get('fromHeight') ?? 1);
      const max = Number(u.searchParams.get('max') ?? 4000);
      const slice = served.slice(from - 1, from - 1 + max);
      return respond({
        v: 1,
        fromHeight: from,
        count: slice.length,
        headers: slice.map((h) => bytesToHex(encodeHeader(h))).join(''),
      });
    }
    if (u.pathname === '/snapshot') {
      return respond({
        v: 1,
        chainVersion: BROWSERCOIN_NETWORK,
        height: ANCHOR,
        hashHex: fx.anchorHashHex,
        accounts: overrides.snapshotAccounts ?? serializeState(fx.state),
        locks: [],
      });
    }
    return notFound();
  };
}

function makeDeps(fx: Fixture, fetchImpl: (url: string) => Promise<Response>, extra: Partial<FastSyncDeps> = {}): FastSyncDeps {
  return {
    chain: new Blockchain(),
    servers: ['http://helper-a'],
    fetchImpl,
    verifier: { verifyAll: async (blocks) => blocks.map(() => true) },
    sampler: (max) => max - 1, // deterministic
    ...extra,
  };
}

const tip = (fx: Fixture) => ({ height: fx.headers.length, tipHash: fx.tipHashHex });

describe('attemptFastSync', () => {
  it('happy path: seeds a verified anchor + header prefix and persists', async () => {
    const fx = buildFixture();
    let persisted: FastSyncPersistData | null = null;
    const deps = makeDeps(fx, makeFetch(fx), {
      persist: async (d) => { persisted = d; },
    });

    const res = await attemptFastSync(deps, tip(fx));
    expect(res).toEqual({ status: 'ok', anchorHeight: ANCHOR });

    expect(deps.chain.height).toBe(ANCHOR);
    expect(bytesToHex(deps.chain.tip.hash)).toBe(fx.anchorHashHex);
    expect(deps.chain.bodylessCount).toBe(ANCHOR);
    expect(deps.chain.hasFullHistory).toBe(false);
    // The snapshot state is live at the tip.
    expect(getAccount(deps.chain.tipState, '11'.repeat(32)).balance).toBe(5000000000n);

    expect(persisted).not.toBeNull();
    expect(persisted!.anchorHeight).toBe(ANCHOR);
    expect(persisted!.anchorHashHex).toBe(fx.anchorHashHex);
    expect(persisted!.headerBytes.length).toBe(ANCHOR * HEADER_LEN);
  });

  it('is skipped when the backlog is too small', async () => {
    const fx = buildFixture();
    const deps = makeDeps(fx, makeFetch(fx));
    expect(await attemptFastSync(deps, { height: 100, tipHash: fx.tipHashHex }))
      .toEqual({ status: 'skipped' });
  });

  it('gates on backlog only, not local height', () => {
    const big = FAST_SYNC_MIN_BACKLOG + 1;
    // Fresh tab, deep backlog → eligible.
    expect(fastSyncEligible(0, big)).toBe(true);
    // Non-fresh tab resuming a large partial chain → still eligible (the case
    // the old `localHeight < FAST_SYNC_MIN_BACKLOG` clause wrongly locked out).
    expect(fastSyncEligible(12290, 12290 + big)).toBe(true);
    // Within the threshold of the tip → skip, whatever the local height.
    expect(fastSyncEligible(0, FAST_SYNC_MIN_BACKLOG)).toBe(false);
    expect(fastSyncEligible(50000, 50000 + FAST_SYNC_MIN_BACKLOG)).toBe(false);
  });

  it('reports unsupported when every server 404s the endpoints', async () => {
    const fx = buildFixture();
    const deps = makeDeps(fx, makeFetch(fx, { status404: true }));
    expect(await attemptFastSync(deps, tip(fx))).toEqual({ status: 'unsupported' });
    expect(deps.chain.height).toBe(0);
  });

  it('rejects a chain with broken hash linkage', async () => {
    const fx = buildFixture();
    const deps = makeDeps(fx, makeFetch(fx, {
      tamperHeaders: (hs) => {
        hs[1500] = { ...hs[1500]!, prevHash: new Uint8Array(32) };
        return hs;
      },
    }));
    const res = await attemptFastSync(deps, tip(fx));
    expect(res.status).toBe('failed');
    expect((res as { reason: string }).reason).toMatch(/linkage/);
    expect(deps.chain.height).toBe(0);
  });

  it('rejects a chain that violates the difficulty schedule', async () => {
    const fx = buildFixture();
    const deps = makeDeps(fx, makeFetch(fx, {
      tamperHeaders: (hs) => {
        // Halve the claimed difficulty at one height (and keep linkage broken
        // beyond it irrelevant — the schedule check fires first).
        hs[800] = { ...hs[800]!, difficulty: 0x20010000 };
        return hs;
      },
    }));
    const res = await attemptFastSync(deps, tip(fx));
    expect(res.status).toBe('failed');
    expect((res as { reason: string }).reason).toMatch(/difficulty/);
  });

  it('rejects the chain when sampled PoW verification fails', async () => {
    const fx = buildFixture();
    const deps = makeDeps(fx, makeFetch(fx), {
      verifier: { verifyAll: async (blocks) => blocks.map((_, i) => i !== 3) },
    });
    const res = await attemptFastSync(deps, tip(fx));
    expect(res.status).toBe('failed');
    expect((res as { reason: string }).reason).toMatch(/PoW/);
    expect(deps.chain.height).toBe(0); // nothing seeded
  });

  it('rejects a snapshot whose state does not hash to the committed stateRoot', async () => {
    const fx = buildFixture();
    const deps = makeDeps(fx, makeFetch(fx, {
      snapshotAccounts: serializeState(deserializeState([[
        '22'.repeat(32), '999', 0, // wrong state → wrong merkle root
      ]])),
    }));
    const res = await attemptFastSync(deps, tip(fx));
    expect(res.status).toBe('failed');
    expect((res as { reason: string }).reason).toMatch(/snapshot/);
    expect(deps.chain.height).toBe(0);
  });

  it('fails the tip cross-check when other helpers disagree with the fetched chain', async () => {
    const fx = buildFixture();
    const goodFetch = makeFetch(fx);
    const disagreeing = makeFetch(fx, { tip: { height: 10, tipHash: 'ab'.repeat(32) } });
    const deps = makeDeps(fx, async (url) =>
      url.includes('helper-b') ? disagreeing(url) : goodFetch(url), {
      servers: ['http://helper-a', 'http://helper-b'],
    });
    const res = await attemptFastSync(deps, tip(fx));
    expect(res.status).toBe('failed');
    expect((res as { reason: string }).reason).toMatch(/cross-check/);
  });

  it('passes the cross-check when a second helper confirms the same chain', async () => {
    const fx = buildFixture();
    const goodFetch = makeFetch(fx);
    const deps = makeDeps(fx, goodFetch, {
      servers: ['http://helper-a', 'http://helper-b'],
    });
    const res = await attemptFastSync(deps, tip(fx));
    expect(res.status).toBe('ok');
  });
});
