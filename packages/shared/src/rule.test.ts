/**
 * T140 — the `Rule` record (cockpit design §5.1) and the two pure checks
 * beside it: the principal split (**D4**) and the tier invariants (§5.2,
 * §5.6).
 */
import { describe, expect, test } from 'bun:test';
import { ulid } from './ids';
import {
  CLASSIFIER_MIN_EXAMPLES,
  type Rule,
  type RuleInput,
  RuleWriteError,
  assertRuleAcceptable,
  assertRuleWrite,
  classifierQuestion,
  validateRule,
  validateRuleProposal,
} from './rule';

function input(over: Partial<RuleInput> = {}): RuleInput {
  return {
    id: `R-${ulid()}`,
    text: 'never push to a protected branch',
    scope: { kind: 'global' },
    status: 'proposed',
    enforcement: 'guidance',
    critical: false,
    provenance: { by: 'human' },
    stats: {},
    created_at: '2026-09-22T00:00:00.000Z',
    ...over,
  };
}

function rule(over: Partial<RuleInput> = {}): Rule {
  return validateRule(input(over));
}

describe('Rule schema (§5.1)', () => {
  test('accepts the minimal record and defaults stage/examples/stats', () => {
    const parsed = rule();
    expect(parsed.stage).toBe('action');
    expect(parsed.examples).toEqual([]);
    expect(parsed.stats).toEqual({ fired: 0, violated: 0, routed: 0 });
  });

  test('is strict — an unknown key is rejected', () => {
    expect(() => validateRule({ ...input(), tier: 'pattern' })).toThrow(/invalid Rule/);
  });

  test('the id is R-<ulid>', () => {
    expect(() => validateRule(input({ id: 'RULE-012' }))).toThrow(/must look like R-<ulid>/);
  });

  test.each(['repo', 'stream'] as const)('a %s-scoped rule must name its ref', (kind) => {
    expect(() => validateRule(input({ scope: { kind } }))).toThrow(/must name its ref/);
  });

  test('a global rule may not carry a ref', () => {
    expect(() => validateRule(input({ scope: { kind: 'global', ref: 'alpha' } }))).toThrow(
      /global rule has no ref/,
    );
  });

  test('a stream-scoped ref must be a ULID', () => {
    const streamId = ulid();
    expect(rule({ scope: { kind: 'stream', ref: streamId } }).scope.ref).toBe(streamId);
  });

  test('rejects an unknown status, enforcement, stage or pattern kind', () => {
    expect(() => validateRule(input({ status: 'accepted_ish' as never }))).toThrow(/invalid Rule/);
    expect(() => validateRule(input({ enforcement: 'vibes' as never }))).toThrow(/invalid Rule/);
    expect(() => validateRule(input({ stage: 'commit' as never }))).toThrow(/invalid Rule/);
    expect(() =>
      validateRule(input({ enforcement: 'pattern', pattern: { kind: 'no_ff' as never } })),
    ).toThrow(/invalid Rule/);
  });

  test('a pattern defaults its args to an empty object', () => {
    const parsed = rule({ enforcement: 'pattern', pattern: { kind: 'no_push_protected' } });
    expect(parsed.pattern).toEqual({ kind: 'no_push_protected', args: {} });
  });

  test('examples carry {action, violates}', () => {
    const parsed = rule({
      examples: [
        { action: 'git push origin main', violates: true },
        { action: 'git push origin T140-x', violates: false },
      ],
    });
    expect(parsed.examples).toHaveLength(2);
  });

  test('caps the rule text at the body cap', () => {
    expect(() => validateRule(input({ text: 'x'.repeat(801) }))).toThrow(/invalid Rule/);
  });
});

describe('RuleProposal (what a caller may supply)', () => {
  test('accepts text alone', () => {
    expect(validateRuleProposal({ text: 'prefer zod over hand-rolled parsing' }).text).toBe(
      'prefer zod over hand-rolled parsing',
    );
  });

  test('refuses the daemon-owned fields', () => {
    for (const forged of [{ status: 'accepted' }, { id: `R-${ulid()}` }, { decided_by: 'pete' }]) {
      expect(() => validateRuleProposal({ text: 'x', ...forged })).toThrow(/invalid RuleProposal/);
    }
  });
});

describe('classifierQuestion (§5.1 default)', () => {
  test('defaults to "Does this action violate: <text>?"', () => {
    expect(classifierQuestion({ text: 'no new deps' })).toBe(
      'Does this action violate: no new deps?',
    );
  });

  test('keeps an explicit question', () => {
    expect(classifierQuestion({ text: 'no new deps', question: 'Adds a dependency?' })).toBe(
      'Adds a dependency?',
    );
  });
});

describe('assertRuleWrite — the principal split (§5.1, D4)', () => {
  test('an agent may create a proposed rule', () => {
    const proposed = rule({ provenance: { by: `agent:${ulid()}` } });
    expect(assertRuleWrite('agent', undefined, proposed)).toBe(proposed);
  });

  test('an agent creating an accepted rule is rejected', () => {
    expect(() => assertRuleWrite('agent', undefined, rule({ status: 'accepted' }))).toThrow(
      RuleWriteError,
    );
  });

  test('an agent setting status: accepted on an existing rule is rejected', () => {
    const before = rule();
    const after = { ...before, status: 'accepted' as const };
    expect(() => assertRuleWrite('agent', before, after)).toThrow(/may not change status/);
  });

  test.each(['decided_at', 'decided_by'] as const)('an agent setting %s is rejected', (field) => {
    const before = rule();
    const after = { ...before, [field]: '2026-09-22T00:00:00.000Z' };
    expect(() => assertRuleWrite('agent', before, after)).toThrow(RuleWriteError);
  });

  test('an agent may still edit its own proposal text', () => {
    const before = rule();
    const after = { ...before, text: 'reworded' };
    expect(assertRuleWrite('agent', before, after).text).toBe('reworded');
  });

  test.each(['human', 'daemon'] as const)('%s may accept a rule', (principal) => {
    const before = rule();
    const after = {
      ...before,
      status: 'accepted' as const,
      decided_at: '2026-09-22T00:00:00.000Z',
      decided_by: 'pete',
    };
    expect(assertRuleWrite(principal, before, after).status).toBe('accepted');
  });

  test('no principal may change the id', () => {
    const before = rule();
    expect(() => assertRuleWrite('human', before, { ...before, id: `R-${ulid()}` })).toThrow(
      /may not change to/,
    );
  });
});

describe('assertRuleAcceptable — the tier invariants (§5.2, §5.6)', () => {
  test('a pattern rule without a pattern is refused', () => {
    expect(() => assertRuleAcceptable(rule({ enforcement: 'pattern' }))).toThrow(
      /must carry a pattern/,
    );
  });

  test('an accepted classifier rule needs two examples', () => {
    const one = rule({
      enforcement: 'classifier',
      status: 'accepted',
      examples: [{ action: 'add a dependency', violates: true }],
    });
    expect(() => assertRuleAcceptable(one)).toThrow(/at least 2 examples/);
    expect(CLASSIFIER_MIN_EXAMPLES).toBe(2);
  });

  test('a proposed classifier rule with one example is fine', () => {
    const one = rule({
      enforcement: 'classifier',
      examples: [{ action: 'add a dependency', violates: true }],
    });
    expect(assertRuleAcceptable(one)).toBe(one);
  });

  test('an accepted classifier rule with two examples passes', () => {
    const ok = rule({
      enforcement: 'classifier',
      status: 'accepted',
      examples: [
        { action: 'add a dependency', violates: true },
        { action: 'read a file', violates: false },
      ],
    });
    expect(assertRuleAcceptable(ok)).toBe(ok);
  });

  test('a guidance rule never needs examples or a pattern', () => {
    const ok = rule({ status: 'accepted' });
    expect(assertRuleAcceptable(ok)).toBe(ok);
  });
});
