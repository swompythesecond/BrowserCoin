/**
 * Fork #3 dress rehearsal against the LIVE chain.
 *
 * Pulls real mainnet headers, replays them through the shipped consensus code to
 * prove the new branch changes nothing at or below SANDGLASS2_ANCHOR_HEIGHT,
 * then simulates forward across the boundary under a spread of hashrates to show
 * the chain restarts and converges instead of stalling.
 *
 *   npx tsx scripts/sim-fork3.mts [apiBase]
 */
import { decodeHeader, type BlockHeader } from '../src/chain/block.js';
import { nextDifficulty } from '../src/chain/consensus.js';
import {
  SANDGLASS2_ANCHOR_HEIGHT,
  SANDGLASS_FORK_HEIGHT,
  TARGET_BLOCK_TIME_S,
} from '../src/chain/genesis.js';
import { compactToTarget, hexToBytes } from '../src/util/binary.js';

const API = process.argv[2] ?? 'https://api1.browsercoin.org';
const HEADER_LEN = 148;

const attemptsFor = (compact: number) => Number((1n << 256n) / (compactToTarget(compact) + 1n));

async function fetchHeaders(from: number, to: number): Promise<BlockHeader[]> {
  const out: BlockHeader[] = [];
  for (let cursor = from; cursor <= to; ) {
    const r = await fetch(`${API}/headers?fromHeight=${cursor}&max=500`);
    const body = (await r.json()) as { count: number; headers: string };
    if (!body.count) break;
    const buf = hexToBytes(body.headers);
    for (let i = 0; i < body.count; i++) out.push(decodeHeader(buf, i * HEADER_LEN));
    cursor = out[out.length - 1]!.height + 1;
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

const tip = (await (await fetch(`${API}/tip`)).json()) as { height: number };
console.log(`live tip ${tip.height}  |  anchor ${SANDGLASS2_ANCHOR_HEIGHT}  |  ${SANDGLASS2_ANCHOR_HEIGHT - tip.height} blocks to go\n`);

// ── 1. Replay real history through the shipped rules. ────────────────────────
const from = SANDGLASS_FORK_HEIGHT - 60;
const real = await fetchHeaders(from, tip.height);
console.log(`replaying ${real.length} real headers (${real[0]!.height}..${real[real.length - 1]!.height})`);

// Capture the fork-#3 anchor as we walk past it, exactly as fastSync does. The
// lookback window would only hold it for RETARGET_LOOKBACK blocks, so relying on
// the window would make this script die once the live tip passes the anchor +60
// — i.e. the first time you run it to confirm the fork actually worked.
let replayAnchor: BlockHeader | null = null;
let mismatches = 0;
for (let i = 61; i < real.length; i++) {
  const h = real[i]!;
  const prevOfThis = real[i - 1]!;
  if (prevOfThis.height === SANDGLASS2_ANCHOR_HEIGHT) replayAnchor = prevOfThis;
  const expected = nextDifficulty(h.height, real.slice(Math.max(0, i - 60), i), h.timestamp, replayAnchor);
  if (expected !== h.difficulty) {
    if (mismatches < 5) console.log(`  MISMATCH h=${h.height} expected ${expected.toString(16)} got ${h.difficulty.toString(16)}`);
    mismatches++;
  }
}
console.log(mismatches === 0
  ? '  ✅ every mined block still validates — no consensus change below the anchor\n'
  : `  ❌ ${mismatches} mismatches — the patch would orphan real history\n`);

const post = real.filter((h) => h.height > SANDGLASS_FORK_HEIGHT);
const gaps = post.slice(1).map((h, i) => h.timestamp - post[i]!.timestamp);
console.log(`post-fork reality: mean gap ${mean(gaps).toFixed(1)}s (target ${TARGET_BLOCK_TIME_S}s)`);
console.log(`  difficulty pinned at ${(attemptsFor(post[post.length - 1]!.difficulty) / 1e6).toFixed(2)}M attempts/block`);
const tipH = real[real.length - 1]!;
const drift = tipH.timestamp - (real.find((h) => h.height === SANDGLASS_FORK_HEIGHT)!.timestamp)
  - (tipH.height - SANDGLASS_FORK_HEIGHT) * TARGET_BLOCK_TIME_S;
console.log(`  accumulated drift since fork #2: ${(drift / 3600).toFixed(2)} h  → old rules demand ~${Math.pow(2, -drift / 600).toExponential(2)}x difficulty at expiry\n`);

// ── 2. Simulate forward from the anchor under the new rules. ─────────────────
// The anchor's real timestamp is unknown until it is mined — which is the point:
// every one of these runs uses a DIFFERENT anchor time and none of them care.
const projectedAnchorTime = tipH.timestamp + (SANDGLASS2_ANCHOR_HEIGHT - tipH.height) * mean(gaps);

console.log('forward simulation past the boundary (constant hashrate, difficulty fed back):');
console.log('  hashrate    first gap   settled gap   settled difficulty   vs anchor');
for (const kHs of [50, 100, 200, 333, 600, 1200]) {
  for (const anchorSkew of [0]) {
    const anchorTime = Math.round(projectedAnchorTime) + anchorSkew;
    const anchor: BlockHeader = { ...tipH, height: SANDGLASS2_ANCHOR_HEIGHT, timestamp: anchorTime };
    let prev = anchor;
    let difficulty = anchor.difficulty;
    const sim: number[] = [];
    for (let i = 1; i <= 600; i++) {
      const gap = Math.max(1, Math.round(attemptsFor(difficulty) / (kHs * 1000)));
      sim.push(gap);
      const ts = prev.timestamp + gap;
      difficulty = nextDifficulty(SANDGLASS2_ANCHOR_HEIGHT + i, [prev], ts, anchor);
      prev = { ...anchor, height: SANDGLASS2_ANCHOR_HEIGHT + i, timestamp: ts, difficulty };
    }
    const settled = mean(sim.slice(-200));
    const ratio = attemptsFor(difficulty) / attemptsFor(anchor.difficulty);
    console.log(
      `  ${String(kHs).padStart(4)} kH/s   ${String(sim[0]).padStart(6)}s   ${settled.toFixed(1).padStart(9)}s   ` +
      `${(attemptsFor(difficulty) / 1e6).toFixed(1).padStart(14)}M   ${ratio.toFixed(2).padStart(7)}x`,
    );
  }
}

// ── 3. The property fork #2 lacked: anchor-time error is irrelevant. ─────────
console.log('\nanchor-time sensitivity (the fork-#2 killer), at 333 kH/s:');
for (const skewH of [-12, -1, 0, 1, 12]) {
  const anchorTime = Math.round(projectedAnchorTime) + skewH * 3600;
  const anchor: BlockHeader = { ...tipH, height: SANDGLASS2_ANCHOR_HEIGHT, timestamp: anchorTime };
  const first = nextDifficulty(SANDGLASS2_ANCHOR_HEIGHT + 1, [anchor], anchorTime + 60, anchor);
  console.log(
    `  anchor ${String(skewH).padStart(3)}h off:  first difficulty ${(attemptsFor(first) / 1e6).toFixed(2)}M ` +
    `(${first === anchor.difficulty ? 'carried over unchanged ✅' : 'DIFFERENT ❌'})`,
  );
}
