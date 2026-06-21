import { blockWork } from '../chain/consensus.js';
import {
  HALVING_INTERVAL,
  MAX_MONEY,
  TARGET_BLOCK_TIME_S,
  blockReward,
} from '../chain/genesis.js';
import { txHash } from '../chain/transaction.js';
import { isBurnAddress } from '../chain/burnAddresses.js';
import { bytesToHex } from '../util/binary.js';
import { formatAmount } from '../node.js';
import type { Node } from '../node.js';
import { TICKER } from '../brand.js';
import { blockTime } from './activityIndex.js';
import type { BlockSummary, ExplorerIndex } from './explorerIndex.js';
import {
  addressLink,
  circulatingSupply,
  difficultyBits,
  heightLink,
  percentOf,
  txLink,
  type SubView,
} from './explorerShared.js';
import { barsSVG, sparklineSVG } from './sparkline.js';

/** How many recent blocks feed the hashrate / block-time estimates. */
const RATE_WINDOW = 50;
/** How many recent blocks to scan for the largest-transfers table. */
const BIG_TX_WINDOW = 500;
/** Upper bound of summaries fetched for the 24 h activity numbers. */
const DAY_SCAN_CAP = 5000;

interface LargeTx {
  hashHex: string;
  fromHex: string;
  toHex: string;
  amount: bigint;
  height: number;
  ts: number;
}

interface ComputedStats {
  hashrate: number | null;
  avgBlockTimeS: number | null;
  txs24h: number;
  blocks24h: number;
  scanCovers24h: boolean;
  largest: LargeTx[];
  blocksPerHour: number[];
  difficultySeries: number[];
}

/** Network stats dashboard: supply, halving, hashrate, activity, charts. */
export function renderStatsView(container: HTMLElement, node: Node, index: ExplorerIndex): SubView {
  let cachedVersion = -1;
  let cached: ComputedStats | null = null;

  function compute(): ComputedStats {
    if (cached && cachedVersion === index.version) return cached;
    const now = Math.floor(Date.now() / 1000);
    const daySummaries = index.blockSummaries(Math.min(node.chain.height, DAY_SCAN_CAP));

    // Hashrate + pace from the last RATE_WINDOW blocks: expected attempts per
    // block at compact difficulty d is blockWork(d), so total expected hashes
    // over the window divided by its wall-clock span estimates the rate.
    const recent = daySummaries.slice(-(RATE_WINDOW + 1));
    let hashrate: number | null = null;
    let avgBlockTimeS: number | null = null;
    if (recent.length >= 2) {
      const span = recent[recent.length - 1]!.ts - recent[0]!.ts;
      let work = 0n;
      for (let i = 1; i < recent.length; i++) work += blockWork(recent[i]!.difficulty);
      if (span > 0) {
        hashrate = Number(work) / span;
        avgBlockTimeS = span / (recent.length - 1);
      }
    }

    const dayAgo = now - 86_400;
    let txs24h = 0;
    let blocks24h = 0;
    const hourBins = new Array<number>(24).fill(0);
    for (const s of daySummaries) {
      if (s.ts < dayAgo) continue;
      blocks24h++;
      txs24h += s.txCount;
      const bin = Math.min(23, Math.max(0, Math.floor((s.ts - dayAgo) / 3600)));
      hourBins[bin] = (hourBins[bin] ?? 0) + 1;
    }
    const oldest = daySummaries[0];
    const scanCovers24h = node.chain.height <= DAY_SCAN_CAP || (oldest !== undefined && oldest.ts <= dayAgo);

    cached = {
      hashrate,
      avgBlockTimeS,
      txs24h,
      blocks24h,
      scanCovers24h,
      largest: collectLargestTxs(node, daySummaries),
      blocksPerHour: hourBins,
      difficultySeries: daySummaries.slice(-200).map((s) => difficultyBits(s.difficulty)),
    };
    cachedVersion = index.version;
    return cached;
  }

  function paint(): void {
    const height = node.chain.height;
    const stats = compute();
    const supply = circulatingSupply(height);

    const nextHalving = (Math.floor(height / HALVING_INTERVAL) + 1) * HALVING_INTERVAL;
    const blocksLeft = nextHalving - height;
    const halvingEta = formatDuration(blocksLeft * TARGET_BLOCK_TIME_S);
    const rewardNow = blockReward(height);
    const rewardAfter = blockReward(nextHalving);

    const paceOk = stats.avgBlockTimeS !== null
      && Math.abs(stats.avgBlockTimeS - TARGET_BLOCK_TIME_S) <= TARGET_BLOCK_TIME_S * 0.25;

    container.innerHTML = `
      <div class="grid grid-3 explorer-tiles">
        <div class="stat-tile accent">
          <div class="stat-label">Circulating supply</div>
          <div class="stat-value">${formatAmount(supply)} <span class="muted">${TICKER}</span></div>
          <div class="stat-sub">${percentOf(supply, MAX_MONEY)}% of the 21,000,000 cap</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Next halving</div>
          <div class="stat-value">${blocksLeft.toLocaleString()} <span class="muted">blocks</span></div>
          <div class="stat-sub">~${halvingEta} · reward ${formatAmount(rewardNow)} → ${formatAmount(rewardAfter)} ${TICKER}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Est. network hashrate</div>
          <div class="stat-value">${stats.hashrate === null ? '—' : formatHashrate(stats.hashrate)}</div>
          <div class="stat-sub">from the last ${RATE_WINDOW} blocks</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Avg block time</div>
          <div class="stat-value ${stats.avgBlockTimeS === null ? '' : paceOk ? 'green' : 'amber'}">${stats.avgBlockTimeS === null ? '—' : formatDuration(stats.avgBlockTimeS)}</div>
          <div class="stat-sub">target ${formatDuration(TARGET_BLOCK_TIME_S)}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Transactions</div>
          <div class="stat-value">${stats.txs24h.toLocaleString()} <span class="muted">/ 24 h</span></div>
          <div class="stat-sub">${index.totalTxCount().toLocaleString()} all-time · ${stats.blocks24h.toLocaleString()}${stats.scanCovers24h ? '' : '+'} blocks in 24 h</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">Addresses</div>
          <div class="stat-value">${node.chain.tipState.size.toLocaleString()} <span class="muted">holders</span></div>
          <div class="stat-sub">${index.addressCount().toLocaleString()} ever seen on-chain</div>
        </div>
      </div>

      <div class="grid grid-2 mt-md explorer-tiles">
        <section class="card">
          <h3 class="card-title">Blocks per hour (24 h)</h3>
          <div class="mt-md">${barsSVG(stats.blocksPerHour, { w: 480, h: 72 })}</div>
        </section>
        <section class="card">
          <h3 class="card-title">Difficulty (last 200 blocks)</h3>
          <div class="mt-md">${stats.difficultySeries.length >= 2 ? sparklineSVG(stats.difficultySeries, { w: 480, h: 72 }) : '<span class="muted text-sm">Not enough blocks yet.</span>'}</div>
        </section>
      </div>

      <section class="card mt-md">
        <div class="card-header">
          <h3 class="card-title">Largest recent transfers</h3>
          <span class="card-spacer"></span>
          <span class="muted text-sm">last ${BIG_TX_WINDOW} blocks</span>
        </div>
        <div class="table-scroll">
          <table class="table">
            <thead><tr><th>tx</th><th>from</th><th class="col-hide-sm">to</th><th>amount</th><th>block</th><th class="col-hide-sm">time</th></tr></thead>
            <tbody>${stats.largest.length === 0
              ? `<tr class="table-empty"><td colspan="6">No transfers yet.</td></tr>`
              : stats.largest.map((t) => `<tr>
                <td>${txLink(t.hashHex, t.hashHex.slice(0, 10) + '…')}</td>
                <td>${addressLink(t.fromHex)}</td>
                <td class="col-hide-sm">${addressLink(t.toHex)}${isBurnAddress(t.toHex) ? ' <span class="badge" style="background:#b4231f;border-color:#b4231f;color:#fff;">burn</span>' : ''}</td>
                <td class="mono">${formatAmount(t.amount)} ${TICKER}</td>
                <td>${heightLink(t.height)}</td>
                <td class="muted col-hide-sm">${blockTime(t.ts)}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </section>
    `;
  }

  paint();
  return { repaint: paint };
}

function collectLargestTxs(node: Node, daySummaries: BlockSummary[]): LargeTx[] {
  const out: LargeTx[] = [];
  for (const s of daySummaries.slice(-BIG_TX_WINDOW)) {
    if (s.txCount === 0) continue;
    const cb = node.chain.getBlock(s.hash);
    if (!cb) continue;
    for (const tx of cb.block.transactions) {
      out.push({
        hashHex: bytesToHex(txHash(tx)),
        fromHex: bytesToHex(tx.from),
        toHex: bytesToHex(tx.to),
        amount: tx.amount,
        height: s.height,
        ts: s.ts,
      });
    }
  }
  out.sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  return out.slice(0, 10);
}

function formatHashrate(hs: number): string {
  if (hs >= 1e9) return `${(hs / 1e9).toFixed(2)} GH/s`;
  if (hs >= 1e6) return `${(hs / 1e6).toFixed(2)} MH/s`;
  if (hs >= 1e3) return `${(hs / 1e3).toFixed(2)} kH/s`;
  return `${hs.toFixed(1)} H/s`;
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 90) return `${s}s`;
  if (s < 600) return `${(s / 60).toFixed(1).replace(/\.0$/, '')} min`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86_400).toFixed(1)} days`;
}
