/** T349 (D36 D3): the status card's `question` state, and older cards still loading. */

import { describe, expect, test } from 'bun:test';
import { CARD_STATES, validateStatusCard } from './card';
import { ulid } from './ids';

function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node: ulid(),
    doing: 'adding salePrice',
    state: 'working',
    files: ['prices.ts'],
    exports_changed: [],
    relies_on: [],
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('StatusCardSchema', () => {
  test('a child waiting on the human is "question", distinct from "blocked"', () => {
    expect(CARD_STATES as readonly string[]).toContain('question');
    expect(CARD_STATES as readonly string[]).toContain('blocked');
    expect(validateStatusCard(card({ state: 'question' })).state).toBe('question');
  });

  test('a card written before "question" existed still loads', () => {
    for (const state of ['working', 'blocked', 'done', 'idle']) {
      expect(validateStatusCard(card({ state })).state as string).toBe(state);
    }
  });

  test('an unknown state and an extra key are refused (strict)', () => {
    expect(() => validateStatusCard(card({ state: 'waiting' }))).toThrow(/StatusCard/);
    expect(() => validateStatusCard(card({ extra: 1 }))).toThrow(/StatusCard/);
  });
});
