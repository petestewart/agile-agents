import { describe, expect, test } from 'bun:test';
import { GATE_KINDS, type Policy } from '@agile-agents/shared';
import { resolveGate } from './resolve';

function policy(gates: Policy['gates']): Policy {
  return { gates, breaker_signals: [] };
}

/**
 * T121: the multi-level override walk is gone with the ceremony layer,
 * epics and teams. One lookup, one fail-safe default.
 */
describe('resolveGate', () => {
  test('reads the owner off the repo-default policy', () => {
    expect(resolveGate('land', { policy: policy({ land: 'human_timeout:1h' }) })).toBe(
      'human_timeout:1h',
    );
    expect(
      resolveGate('rule_accept', { policy: policy({ rule_accept: 'human_timeout:2h' }) }),
    ).toBe('human_timeout:2h');
  });

  test('a gate with no policy row resolves to human, never to a silent auto-approve', () => {
    for (const gate of GATE_KINDS) {
      expect(resolveGate(gate, { policy: policy({}) })).toBe('human');
    }
  });

  test('the closed set is exactly the three surviving kinds (§3.1)', () => {
    expect([...GATE_KINDS]).toEqual(['land', 'rule_accept', 'classifier_review']);
  });
});
