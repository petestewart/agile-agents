/**
 * T260 — the `KnowledgeItem` record (projects-design §14.3) and the two
 * pure checks beside it: the principal split (**D4**) and the check
 * invariants (§6, cockpit §5.6). Ported from the T140 rule tests.
 */
import { describe, expect, test } from 'bun:test';
import { ulid } from './ids';
import {
  CLASSIFIER_MIN_EXAMPLES,
  type KnowledgeItem,
  type KnowledgeItemInput,
  KnowledgeWriteError,
  RULE_EXAMPLES_MAX,
  assertKnowledgeAcceptable,
  assertKnowledgeWrite,
  classifierQuestion,
  formatKnowledgeScope,
  formatRulePattern,
  parseKnowledgeScope,
  rulePatternArgs,
  rulePatternFromArgs,
  validateKnowledgeItem,
  validateKnowledgeProposal,
} from './knowledge';

function input(over: Partial<KnowledgeItemInput> = {}): KnowledgeItemInput {
  return {
    id: `K-${ulid()}`,
    kind: 'standard',
    text: 'never push to a protected branch',
    scope: { kind: 'global' },
    status: 'proposed',
    enforcement: 'tell',
    critical: false,
    source: { by: 'human' },
    stats: {},
    created_at: '2026-09-22T00:00:00.000Z',
    ...over,
  };
}

function item(over: Partial<KnowledgeItemInput> = {}): KnowledgeItem {
  return validateKnowledgeItem(input(over));
}

const twoExamples = [
  { action: 'add a dependency', violates: true },
  { action: 'read a file', violates: false },
];

describe('KnowledgeItem schema (§14.3)', () => {
  test('accepts the minimal record and defaults stats', () => {
    expect(item().stats).toEqual({ fired: 0, violated: 0, routed: 0 });
  });

  test('is strict — an unknown key or the old rule fields are rejected', () => {
    expect(() => validateKnowledgeItem({ ...input(), stage: 'action' })).toThrow(
      /invalid KnowledgeItem/,
    );
    expect(() => validateKnowledgeItem({ ...input(), provenance: { by: 'human' } })).toThrow(
      /invalid KnowledgeItem/,
    );
  });

  test('the id is K-<ulid>', () => {
    expect(() => validateKnowledgeItem(input({ id: `R-${ulid()}` }))).toThrow(
      /must look like K-<ulid>/,
    );
  });

  test('the four scopes, each with its own ref', () => {
    const node = ulid();
    const project = `P-${ulid()}`;
    expect(item({ scope: { kind: 'repo', repo: 'api' } }).scope).toEqual({
      kind: 'repo',
      repo: 'api',
    });
    expect(item({ scope: { kind: 'project', project } }).scope).toEqual({
      kind: 'project',
      project,
    });
    expect(item({ scope: { kind: 'subtree', node } }).scope).toEqual({ kind: 'subtree', node });
    expect(() => validateKnowledgeItem(input({ scope: { kind: 'repo' } as never }))).toThrow();
    expect(() =>
      validateKnowledgeItem(input({ scope: { kind: 'global', repo: 'x' } as never })),
    ).toThrow();
    expect(() =>
      validateKnowledgeItem(input({ scope: { kind: 'project', project: 'Shop' } as never })),
    ).toThrow();
  });

  test('rejects an unknown kind, status, enforcement, source or pattern kind', () => {
    expect(() => validateKnowledgeItem(input({ kind: 'rule' as never }))).toThrow();
    expect(() => validateKnowledgeItem(input({ status: 'accepted_ish' as never }))).toThrow();
    expect(() => validateKnowledgeItem(input({ enforcement: 'guidance' as never }))).toThrow();
    expect(() => validateKnowledgeItem(input({ source: { by: 'seed:PLAN' as never } }))).toThrow();
    expect(() =>
      validateKnowledgeItem(
        input({
          enforcement: 'action',
          check: { by: 'pattern', pattern: { kind: 'no_ff' as never } },
        }),
      ),
    ).toThrow();
  });

  test('a pattern defaults its args; a classifier check defaults its examples', () => {
    expect(
      item({
        enforcement: 'action',
        check: { by: 'pattern', pattern: { kind: 'no_push_protected' } },
      }).check,
    ).toEqual({ by: 'pattern', pattern: { kind: 'no_push_protected', args: {} } });
    expect(item({ enforcement: 'ship', check: { by: 'classifier' } }).check).toEqual({
      by: 'classifier',
      examples: [],
    });
  });

  test('carries optional name and paths; caps the text', () => {
    const parsed = item({ name: 'tests-with-changes', paths: ['src/**'] });
    expect(parsed.name).toBe('tests-with-changes');
    expect(parsed.paths).toEqual(['src/**']);
    expect(() => validateKnowledgeItem(input({ text: 'x'.repeat(801) }))).toThrow();
  });
});

describe('KnowledgeProposal (what a caller may supply)', () => {
  test('accepts text alone', () => {
    expect(validateKnowledgeProposal({ text: 'prefer zod' }).text).toBe('prefer zod');
  });

  test('refuses the daemon-owned fields', () => {
    for (const forged of [{ status: 'accepted' }, { id: `K-${ulid()}` }, { decided_by: 'pete' }]) {
      expect(() => validateKnowledgeProposal({ text: 'x', ...forged })).toThrow(
        /invalid KnowledgeProposal/,
      );
    }
  });

  test(`a classifier check carries at most ${RULE_EXAMPLES_MAX} examples`, () => {
    const examples = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ action: `a${i}`, violates: i % 2 === 0 }));
    const propose = (n: number) =>
      validateKnowledgeProposal({
        text: 'x',
        enforcement: 'ship',
        check: { by: 'classifier', examples: examples(n) },
      });
    expect(() => propose(RULE_EXAMPLES_MAX)).not.toThrow();
    expect(() => propose(RULE_EXAMPLES_MAX + 1)).toThrow(`at most ${RULE_EXAMPLES_MAX} examples`);
  });
});

describe('scope grammar', () => {
  test('parses and formats every scope; stream:<id> reads as subtree', () => {
    const node = ulid();
    const project = `P-${ulid()}`;
    for (const text of ['global', 'repo:api', `project:${project}`, `subtree:${node}`]) {
      expect(formatKnowledgeScope(parseKnowledgeScope(text))).toBe(text);
    }
    expect(parseKnowledgeScope(`stream:${node}`)).toEqual({ kind: 'subtree', node });
    for (const bad of ['repo', 'repo:', 'project:Shop', 'subtree:nope', 'world']) {
      expect(() => parseKnowledgeScope(bad)).toThrow(/invalid knowledge scope/);
    }
  });
});

describe('classifierQuestion (cockpit §5.1 default)', () => {
  test('defaults to "Does this action violate: <text>?"', () => {
    expect(classifierQuestion({ text: 'no new deps' })).toBe(
      'Does this action violate: no new deps?',
    );
  });

  test("keeps the check's explicit question", () => {
    expect(
      classifierQuestion({
        text: 'no new deps',
        check: { by: 'classifier', question: 'Adds a dependency?', examples: [] },
      }),
    ).toBe('Adds a dependency?');
  });
});

describe('assertKnowledgeWrite — the principal split (D4)', () => {
  test('an agent may create a proposed item', () => {
    const proposed = item({ source: { by: 'agent', session: ulid() } });
    expect(assertKnowledgeWrite('agent', undefined, proposed)).toBe(proposed);
  });

  test('an agent creating an accepted item is rejected', () => {
    expect(() => assertKnowledgeWrite('agent', undefined, item({ status: 'accepted' }))).toThrow(
      KnowledgeWriteError,
    );
  });

  test('an agent setting status: accepted on an existing item is rejected', () => {
    const before = item();
    expect(() =>
      assertKnowledgeWrite('agent', before, { ...before, status: 'accepted' as const }),
    ).toThrow(/may not change status/);
  });

  test.each(['decided_at', 'decided_by'] as const)('an agent setting %s is rejected', (field) => {
    const before = item();
    const after = { ...before, [field]: '2026-09-22T00:00:00.000Z' };
    expect(() => assertKnowledgeWrite('agent', before, after)).toThrow(KnowledgeWriteError);
  });

  test('an agent may still edit its own proposal text', () => {
    const before = item();
    expect(assertKnowledgeWrite('agent', before, { ...before, text: 'reworded' }).text).toBe(
      'reworded',
    );
  });

  test.each(['human', 'daemon'] as const)('%s may accept an item', (principal) => {
    const before = item();
    const after = {
      ...before,
      status: 'accepted' as const,
      decided_at: '2026-09-22T00:00:00.000Z',
      decided_by: 'pete',
    };
    expect(assertKnowledgeWrite(principal, before, after).status).toBe('accepted');
  });

  test('no principal may change the id', () => {
    const before = item();
    expect(() => assertKnowledgeWrite('human', before, { ...before, id: `K-${ulid()}` })).toThrow(
      /may not change to/,
    );
  });
});

describe('assertKnowledgeAcceptable — the check invariants (§14.3, cockpit §5.6)', () => {
  test.each(['action', 'ship'] as const)('an %s item without a check is refused', (enforcement) => {
    expect(() => assertKnowledgeAcceptable(item({ enforcement }))).toThrow(/needs a check/);
  });

  test.each(['tell', 'review'] as const)('a %s item may not carry a check', (enforcement) => {
    expect(() =>
      assertKnowledgeAcceptable(item({ enforcement, check: { by: 'classifier' } })),
    ).toThrow(/carries no check/);
  });

  test('a pattern check is an action check only', () => {
    expect(() =>
      assertKnowledgeAcceptable(
        item({ enforcement: 'ship', check: { by: 'pattern', pattern: { kind: 'no_push' } } }),
      ),
    ).toThrow(/action check only/);
  });

  test('an accepted classifier check needs two examples; a proposed one does not', () => {
    const one = { by: 'classifier' as const, examples: [twoExamples[0] as never] };
    expect(() =>
      assertKnowledgeAcceptable(item({ enforcement: 'ship', status: 'accepted', check: one })),
    ).toThrow(/at least 2 examples/);
    expect(CLASSIFIER_MIN_EXAMPLES).toBe(2);
    const proposed = item({ enforcement: 'ship', check: one });
    expect(assertKnowledgeAcceptable(proposed)).toBe(proposed);
    const ok = item({
      enforcement: 'action',
      status: 'accepted',
      check: { by: 'classifier', examples: twoExamples },
    });
    expect(assertKnowledgeAcceptable(ok)).toBe(ok);
  });

  test('tell and review items never need examples', () => {
    for (const enforcement of ['tell', 'review'] as const) {
      const ok = item({ enforcement, status: 'accepted' });
      expect(assertKnowledgeAcceptable(ok)).toBe(ok);
    }
  });
});

describe('T167: pattern helpers', () => {
  test('rulePatternFromArgs builds each kind and formatRulePattern prints it', () => {
    const deny = rulePatternFromArgs('command_deny', ['rm -rf', 'git reset --hard']);
    expect(deny).toEqual({
      kind: 'command_deny',
      args: { patterns: ['rm -rf', 'git reset --hard'] },
    });
    expect(formatRulePattern(deny)).toBe('command_deny: "rm -rf", "git reset --hard"');
    expect(rulePatternArgs(deny)).toEqual(['rm -rf', 'git reset --hard']);
    expect(rulePatternFromArgs('path_deny', ['secrets/**', ' '])).toEqual({
      kind: 'path_deny',
      args: { globs: ['secrets/**'] },
    });
    expect(formatRulePattern(rulePatternFromArgs('no_push'))).toBe('no_push');
    expect(() => rulePatternFromArgs('no_push_protected', ['main'])).toThrow('takes no arguments');
    expect(() => rulePatternFromArgs('nope')).toThrow('invalid pattern kind');
  });
});
