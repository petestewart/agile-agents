import { describe, expect, it } from 'bun:test';
import { PI_ENGINEER_CANDIDATES, PI_REVIEWER_CANDIDATES } from './pi-route-candidates';

describe('Pi route candidates', () => {
  it('names pi as the vendor for every engineer candidate', () => {
    expect(PI_ENGINEER_CANDIDATES.length).toBeGreaterThan(0);
    for (const c of PI_ENGINEER_CANDIDATES) {
      expect(c.vendor).toBe('pi');
      expect(c.account).toBeTruthy();
      expect(c.model).toBeTruthy();
    }
  });

  it('names pi as the vendor for every reviewer candidate', () => {
    expect(PI_REVIEWER_CANDIDATES.length).toBeGreaterThan(0);
    for (const c of PI_REVIEWER_CANDIDATES) {
      expect(c.vendor).toBe('pi');
      expect(c.account).toBeTruthy();
      expect(c.model).toBeTruthy();
    }
  });

  it('is frozen so no caller can mutate the shared route table', () => {
    expect(Object.isFrozen(PI_ENGINEER_CANDIDATES)).toBe(true);
    expect(Object.isFrozen(PI_ENGINEER_CANDIDATES[0])).toBe(true);
  });
});
