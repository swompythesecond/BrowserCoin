/**
 * Script hard-fork activation gate. Kept in its own tiny module so the
 * activation time can be overridden in tests / local dev without poking the
 * `genesis.ts` constants (which other invariants assume are immutable).
 *
 * Activation is driven by a block's median-time-past — a value every node
 * derives identically from the chain, never from a local wall clock — so the
 * "date-based switch" flips deterministically and in lock-step across the
 * network.
 */
import { FORK1_ACTIVATION_TIME } from './genesis.js';

let activationTime = FORK1_ACTIVATION_TIME;

export function forkActivationTime(): number {
  return activationTime;
}

/**
 * TEST / LOCAL-DEV ONLY. Override the script-fork activation time so the
 * boundary can be exercised without waiting for the real date. Never call this
 * from production code paths.
 */
export function setForkActivationTimeForTesting(t: number): void {
  activationTime = t;
}

/** Restore the compiled-in activation time (test teardown helper). */
export function resetForkActivationTimeForTesting(): void {
  activationTime = FORK1_ACTIVATION_TIME;
}

/**
 * Scripts are active for a block whose median-time-past (the median of its
 * parent and the 10 headers before it) has reached the activation time.
 */
export function scriptsActiveForMtp(blockMtp: number): boolean {
  return blockMtp >= activationTime;
}
