import { HALVING_INTERVAL, INITIAL_REWARD } from '../chain/genesis.js';
import { compactToTarget } from '../util/binary.js';
import { short } from './activityIndex.js';

/**
 * Shared bits for the explorer sub-views: internal links (plain anchors —
 * `wireNav` turns them into SPA navigations) and small formatters. All inputs
 * are hex strings or numbers produced by our own encoders, so interpolating
 * them into innerHTML is safe.
 */

export function addressLink(addrHex: string, label?: string): string {
  return `<a class="addr" href="/explorer?address=${addrHex}" title="${addrHex}">${label ?? short(addrHex)}</a>`;
}

export function blockLink(hashHex: string, label?: string): string {
  return `<a class="hash" href="/explorer?block=${hashHex}" title="${hashHex}">${label ?? hashHex.slice(0, 12) + '…'}</a>`;
}

export function heightLink(height: number): string {
  return `<a class="hash" href="/explorer?block=${height}">#${height}</a>`;
}

export function txLink(txHashHex: string, label?: string): string {
  return `<a class="hash" href="/explorer?tx=${txHashHex}" title="${txHashHex}">${label ?? txHashHex.slice(0, 12) + '…'}</a>`;
}

/** Leading-zero bits implied by a compact difficulty — matches the topbar. */
export function difficultyBits(compact: number): number {
  const target = compactToTarget(compact);
  return target <= 0n ? 256 : 256 - target.toString(2).length;
}

/**
 * Total coins issued up to and including block `height` — a closed-form sum
 * over halving eras, no chain walk. Genesis (height 0) credits nobody.
 */
export function circulatingSupply(height: number): bigint {
  let supply = 0n;
  for (let era = 0; ; era++) {
    const eraStart = era * HALVING_INTERVAL;
    const reward = INITIAL_REWARD >> BigInt(era);
    if (eraStart > height || reward === 0n) break;
    const from = Math.max(eraStart, 1);
    const to = Math.min(height, (era + 1) * HALVING_INTERVAL - 1);
    if (to < from) continue;
    supply += BigInt(to - from + 1) * reward;
  }
  return supply;
}

/** Two-decimal percentage of `part` in `total`, computed without floats on bigint. */
export function percentOf(part: bigint, total: bigint): string {
  if (total <= 0n) return '0';
  return (Number((part * 10_000n) / total) / 100).toFixed(2);
}

/** A view fragment the explorer shell repaints on chain changes + ticks. */
export interface SubView {
  repaint(): void;
}
