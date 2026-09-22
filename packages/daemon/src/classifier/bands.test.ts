/**
 * T156 (**D14**): the three bands decide on the raw Noul value only. There
 * is no confidence floor and no derived confidence; the route band is the
 * low-confidence case.
 */

import { describe, expect, test } from 'bun:test';
import { validateClassifierConfig } from '@agile-agents/shared';
import { bandFor } from './bands';

const bands = { deny_at: 0.8, allow_below: 0.4 };

describe('bandFor (§6.3, D14)', () => {
  test('deny at and above deny_at', () => {
    expect(bandFor({ probability: 0.8 }, bands)).toBe('deny');
    expect(bandFor({ probability: 0.95 }, bands)).toBe('deny');
    expect(bandFor({ probability: 1 }, bands)).toBe('deny');
  });

  test('allow strictly below allow_below', () => {
    expect(bandFor({ probability: 0.3999 }, bands)).toBe('allow');
    // 0.26 sat under the old floor's reach (0.25 < p < 0.75) and routed; now it allows.
    expect(bandFor({ probability: 0.26 }, bands)).toBe('allow');
    expect(bandFor({ probability: 0 }, bands)).toBe('allow');
  });

  test('route in between, edges included', () => {
    expect(bandFor({ probability: 0.4 }, bands)).toBe('route');
    expect(bandFor({ probability: 0.5 }, bands)).toBe('route');
    expect(bandFor({ probability: 0.7999 }, bands)).toBe('route');
  });

  test('the default config bands are the same two numbers, nothing else', () => {
    expect(validateClassifierConfig({}).bands).toEqual({ deny_at: 0.8, allow_below: 0.4 });
  });
});
