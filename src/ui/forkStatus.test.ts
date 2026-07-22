import { afterEach, describe, expect, it } from 'vitest';
import { forkAdoptionText, forkCountdown, fork3Status } from './forkStatus.js';
import { resetForkActivationTimeForTesting, setForkActivationTimeForTesting } from '../chain/fork.js';
import { SANDGLASS2_ANCHOR_HEIGHT } from '../chain/genesis.js';

describe('forkStatus helpers', () => {
  afterEach(() => resetForkActivationTimeForTesting());

  it('counts down before activation and reports live after', () => {
    setForkActivationTimeForTesting(2000);
    const before = forkCountdown(1000 * 1000); // now = 1000s
    expect(before.activated).toBe(false);
    expect(before.line).toContain('activate');

    const after = forkCountdown(3000 * 1000); // now = 3000s, past activation
    expect(after.activated).toBe(true);
    expect(after.line).toContain('LIVE');
  });

  it('formats adoption percentage', () => {
    expect(forkAdoptionText(3, 4)).toBe('3 of 4 reporting nodes upgraded (75%)');
    expect(forkAdoptionText(0, 0)).toContain('awaiting');
  });

  it('fork3Status counts down before the anchor and reports live at/after it', () => {
    const before = fork3Status(SANDGLASS2_ANCHOR_HEIGHT - 10);
    expect(before.activated).toBe(false);
    expect(before.blocksRemaining).toBe(10);
    expect(before.line).toContain(SANDGLASS2_ANCHOR_HEIGHT.toLocaleString());

    // Exactly at the anchor is not yet "past" it — the first repaired block is
    // anchor+1, so activation flips only above the anchor height.
    expect(fork3Status(SANDGLASS2_ANCHOR_HEIGHT).activated).toBe(true);
    const after = fork3Status(SANDGLASS2_ANCHOR_HEIGHT + 5);
    expect(after.activated).toBe(true);
    expect(after.blocksRemaining).toBe(0);
    expect(after.line).toContain('LIVE');
  });
});
