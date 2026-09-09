import { describe, expect, test } from 'bun:test';
import type { Policy } from '@agile-agents/shared';
import { resolveGate } from './resolve';

function policy(gates: Policy['gates']): Policy {
  return { gates, breaker_signals: [] };
}

describe('resolveGate', () => {
  test('falls back to the repo-default policy when no override names the gate', () => {
    const ctx = { policy: policy({ demo: 'human' }) };
    expect(resolveGate('demo', ctx)).toBe('human');
  });

  test('team beats the repo default', () => {
    const ctx = { policy: policy({ unblock: 'em' }), team: { unblock: 'architect' } };
    expect(resolveGate('unblock', ctx)).toBe('architect');
  });

  test('epic beats team and the repo default', () => {
    const ctx = {
      policy: policy({ unblock: 'em' }),
      team: { unblock: 'architect' },
      epic: { unblock: 'human' },
    };
    expect(resolveGate('unblock', ctx)).toBe('human');
  });

  test('sprint beats epic, team, and the repo default (most specific wins)', () => {
    const ctx = {
      policy: policy({ unblock: 'em' }),
      team: { unblock: 'architect' },
      epic: { unblock: 'human' },
      sprint: { unblock: 'human_timeout:2h' },
    };
    expect(resolveGate('unblock', ctx)).toBe('human_timeout:2h');
  });

  test('missing levels fall through to the next-most-specific level', () => {
    const ctx = {
      policy: policy({ unblock: 'em' }),
      // no team, no epic
      sprint: { demo: 'human_timeout:1d' }, // sprint overrides a different gate
    };
    expect(resolveGate('unblock', ctx)).toBe('em');
  });

  test('an unknown gate name (absent at every level) resolves to human', () => {
    const ctx = { policy: policy({ demo: 'human' }) };
    expect(resolveGate('some_gate_nobody_configured', ctx)).toBe('human');
  });
});
