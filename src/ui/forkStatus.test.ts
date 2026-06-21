import { afterEach, describe, expect, it } from 'vitest';
import { forkAdoptionText, forkCountdown } from './forkStatus.js';
import { resetForkActivationTimeForTesting, setForkActivationTimeForTesting } from '../chain/fork.js';

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
});
