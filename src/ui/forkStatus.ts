/**
 * Presentational helpers for the script hard-fork countdown + adoption gauge.
 * Purely informational — consensus activation is driven by the chain's
 * median-time-past, never by this wall-clock estimate (see chain/fork.ts).
 */
import { forkActivationTime } from '../chain/fork.js';
import {
  SANDGLASS_FORK_HEIGHT,
  SANDGLASS_ANCHOR_TIMESTAMP,
  TARGET_BLOCK_TIME_S,
} from '../chain/genesis.js';

function formatDuration(secs: number): string {
  if (secs <= 0) return 'now';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export interface ForkCountdown {
  activated: boolean;
  line: string;
}

/** Countdown text relative to the local clock (approximate; chain time decides). */
export function forkCountdown(now = Date.now()): ForkCountdown {
  const remaining = forkActivationTime() - Math.floor(now / 1000);
  if (remaining <= 0) return { activated: true, line: 'Scripts are LIVE on the network' };
  return { activated: false, line: `Scripts activate in ~${formatDuration(remaining)}` };
}

/** "X of Y nodes upgraded (Z%)" from the helper-server adoption counters. */
export function forkAdoptionText(forkReadyCount: number, peerCount: number): string {
  if (peerCount <= 0) return 'awaiting adoption data…';
  const pct = Math.round((forkReadyCount / peerCount) * 100);
  return `${forkReadyCount} of ${peerCount} reporting nodes upgraded (${pct}%)`;
}

/** Human-readable activation date (UTC) for display. */
export function forkActivationDateUTC(): string {
  return new Date(forkActivationTime() * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

// ─── Fork #2: Sandglass PoW (height-gated) ──────────────────────────────────

export interface SandglassCountdown {
  activated: boolean;
  blocksRemaining: number;
  line: string;
}

/**
 * Countdown to the Sandglass PoW fork. Height-gated, so the accurate measure is
 * BLOCKS remaining (fork height − current height); the time is estimated from
 * that at the target block spacing. Consensus activation is by height, never by
 * this estimate.
 */
export function sandglassCountdown(currentHeight: number): SandglassCountdown {
  const remaining = SANDGLASS_FORK_HEIGHT - currentHeight;
  if (remaining <= 0) {
    return { activated: true, blocksRemaining: 0, line: 'Sandglass mining is LIVE on the network' };
  }
  const eta = formatDuration(remaining * TARGET_BLOCK_TIME_S);
  return {
    activated: false,
    blocksRemaining: remaining,
    line: `New mining algorithm activates at block ${SANDGLASS_FORK_HEIGHT.toLocaleString()} — ${remaining.toLocaleString()} blocks to go (~${eta})`,
  };
}

/** Announced Sandglass activation date (UTC) for display. */
export function sandglassActivationDateUTC(): string {
  return new Date(SANDGLASS_ANCHOR_TIMESTAMP * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}
