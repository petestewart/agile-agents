/**
 * T049 defect 5 — the chat header's `vendor / model` label. The ticket is
 * explicit that `claude / unknown` is not acceptable once the session has
 * reported, so the label never prints the daemon's "not yet" sentinel.
 */

import { describe, expect, test } from 'bun:test';
import { emLabel } from './feed-types';

describe('emLabel', () => {
  test('names the vendor and the reported model', () => {
    expect(emLabel({ vendor: 'claude', model: 'claude-opus-4-1' })).toBe(
      'claude / claude-opus-4-1',
    );
  });

  test("a session that has not reported a model yet says so instead of 'unknown'", () => {
    expect(emLabel({ vendor: 'claude', model: 'unknown' })).not.toContain('unknown');
    expect(emLabel({ vendor: 'claude', model: 'unknown' })).toContain('claude');
  });
});
