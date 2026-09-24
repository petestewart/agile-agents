/**
 * T260 — §17.1 step 2: a legacy rule record becomes knowledge items, for
 * every enforcement × stage combination (P6 splits classifier `both`).
 */
import { describe, expect, test } from 'bun:test';
import { ulid } from './ids';
import {
  type KnowledgeEnforcement,
  assertKnowledgeAcceptable,
  validateKnowledgeItem,
} from './knowledge';
import {
  LEGACY_RULE_ENFORCEMENTS,
  LEGACY_RULE_STAGES,
  type LegacyRuleInput,
  legacyEnforcement,
  migrateRuleRecord,
  validateLegacyRule,
} from './rule';

const examples = [
  { action: 'git push origin main', violates: true },
  { action: 'git push origin T1-x', violates: false },
];

function legacy(over: Partial<LegacyRuleInput> = {}) {
  return validateLegacyRule({
    id: `R-${ulid()}`,
    text: 'never push to a protected branch',
    scope: { kind: 'global' },
    status: 'accepted',
    enforcement: 'guidance',
    critical: false,
    provenance: { by: 'human' },
    stats: { fired: 3, violated: 1, routed: 0 },
    created_at: '2026-09-22T00:00:00.000Z',
    decided_at: '2026-09-22T01:00:00.000Z',
    decided_by: 'pete',
    ...over,
  });
}

const EXPECTED: Record<string, KnowledgeEnforcement[]> = {
  'pattern/action': ['action'],
  'pattern/diff': ['action'],
  'pattern/both': ['action'],
  'classifier/action': ['action'],
  'classifier/diff': ['ship'],
  'classifier/both': ['action', 'ship'],
  'guidance/action': ['tell'],
  'guidance/diff': ['tell'],
  'guidance/both': ['tell'],
};

describe('migrateRuleRecord (§17.1 step 2, P6)', () => {
  for (const enforcement of LEGACY_RULE_ENFORCEMENTS) {
    for (const stage of LEGACY_RULE_STAGES) {
      test(`${enforcement} at ${stage}`, () => {
        const rule = legacy({
          enforcement,
          stage,
          ...(enforcement === 'pattern' ? { pattern: { kind: 'no_push_protected' } } : {}),
          ...(enforcement === 'classifier' ? { examples, question: 'Pushes to main?' } : {}),
        });
        const shipId = `K-${ulid()}`;
        const items = migrateRuleRecord(rule, shipId).map((raw) =>
          assertKnowledgeAcceptable(validateKnowledgeItem(raw)),
        );
        expect(items.map((i) => i.enforcement)).toEqual(EXPECTED[`${enforcement}/${stage}`] ?? []);
        const [first, second] = items;
        expect(first?.id).toBe(`K-${rule.id.slice(2)}`);
        expect(first?.kind).toBe('standard');
        expect(first?.status).toBe('accepted');
        expect(first?.decided_by).toBe('pete');
        expect(first?.stats.fired).toBe(3);
        if (enforcement === 'pattern') expect(first?.check?.by).toBe('pattern');
        if (enforcement === 'classifier') {
          expect(first?.check).toEqual({ by: 'classifier', question: 'Pushes to main?', examples });
        }
        if (enforcement === 'guidance') expect(first?.check).toBeUndefined();
        if (second !== undefined) {
          expect(second.id).toBe(shipId);
          expect(second.check).toEqual(first?.check);
          expect(second.stats.fired).toBe(0);
          expect(second.source.finding).toContain(rule.id);
        }
      });
    }
  }

  test('scopes: stream becomes subtree; repo keeps its name', () => {
    const node = ulid();
    expect(
      migrateRuleRecord(legacy({ scope: { kind: 'stream', ref: node } }), '')[0]?.scope,
    ).toEqual({
      kind: 'subtree',
      node,
    });
    expect(
      migrateRuleRecord(legacy({ scope: { kind: 'repo', ref: 'api' } }), '')[0]?.scope,
    ).toEqual({
      kind: 'repo',
      repo: 'api',
    });
  });

  test('provenance becomes source', () => {
    const node = ulid();
    const source = (by: string) =>
      migrateRuleRecord(legacy({ provenance: { by, stream: node, session: 's1' } }), '')[0]?.source;
    expect(source('agent:s1')).toEqual({ by: 'agent', node, session: 's1' });
    expect(source('builtin')?.by).toBe('builtin');
    expect(source('human')?.by).toBe('human');
    expect(source('seed:PLAN-v1')?.by).toBe('migration');
  });

  test('legacyEnforcement maps the old tier and stage', () => {
    expect(legacyEnforcement('guidance')).toBe('tell');
    expect(legacyEnforcement('classifier')).toBe('action');
    expect(legacyEnforcement('classifier', 'diff')).toBe('ship');
    expect(legacyEnforcement('pattern', 'diff')).toBe('action');
  });
});
