import { afterEach, describe, expect, it } from 'vitest';
import {
  forkActivationTime,
  resetForkActivationTimeForTesting,
  scriptsActiveForMtp,
  setForkActivationTimeForTesting,
} from './fork.js';
import { FORK1_ACTIVATION_TIME } from './genesis.js';

describe('fork activation gate', () => {
  afterEach(() => resetForkActivationTimeForTesting());

  it('defaults to the compiled-in activation time', () => {
    expect(forkActivationTime()).toBe(FORK1_ACTIVATION_TIME);
  });

  it('scripts inactive strictly before activation, active at/after', () => {
    setForkActivationTimeForTesting(1_000_000);
    expect(scriptsActiveForMtp(999_999)).toBe(false);
    expect(scriptsActiveForMtp(1_000_000)).toBe(true);
    expect(scriptsActiveForMtp(1_000_001)).toBe(true);
  });

  it('override is reset by the test helper', () => {
    setForkActivationTimeForTesting(42);
    resetForkActivationTimeForTesting();
    expect(forkActivationTime()).toBe(FORK1_ACTIVATION_TIME);
  });
});
