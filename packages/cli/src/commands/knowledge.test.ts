/**
 * T140/T260: the printed shapes of `agile knowledge list` / `show`, the
 * `--example` and `--enforcement` grammar, and how the flags become §14.3's
 * `check`. `knowledgeRows`/`showFields` are the data the printers take, so
 * these assert the shape without a daemon.
 */
import { describe, expect, test } from 'bun:test';
import { ruleReportRows as reportRowsFromDaemon } from '@agile-agents/daemon';
import type { RuleEvalReport } from '@agile-agents/daemon';
import {
  type KnowledgeItem,
  type KnowledgeItemInput,
  ulid,
  validateKnowledgeItem,
} from '@agile-agents/shared';
import { parseArgs } from '../args';
import {
  KNOWLEDGE_HEADERS,
  RULE_REPORT_HEADERS,
  RULE_TEST_ACTION_MAX_CHARS,
  RULE_TEST_HEADERS,
  buildCheck,
  knowledgeRows,
  oneLine,
  parseCriteria,
  parseEnforcement,
  parseExample,
  parseExamples,
  ruleReportRows,
  ruleTestDeadlineMs,
  ruleTestRows,
  showFields,
} from './knowledge';

function rule(over: Partial<KnowledgeItemInput> = {}): KnowledgeItem {
  return validateKnowledgeItem({
    id: 'K-01ABCDEFGHJKMNPQRSTVWXYZ00',
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
  });
}

const TWO = [
  { action: 'a', violates: true },
  { action: 'b', violates: false },
];

describe('knowledge list rows', () => {
  test('carry the id/name/kind/status/enforcement/scope/text header', () => {
    expect(KNOWLEDGE_HEADERS).toEqual([
      'id',
      'name',
      'kind',
      'status',
      'enforcement',
      'scope',
      'text',
    ]);
  });

  test('one row per item, with its name, the enforcement cell and the rendered scope', () => {
    const rows = knowledgeRows([
      rule(),
      rule({
        id: 'K-01ABCDEFGHJKMNPQRSTVWXYZ01',
        status: 'accepted',
        enforcement: 'action',
        name: 'no_push_protected',
        check: { by: 'pattern', pattern: { kind: 'no_push_protected' } },
        critical: true,
        scope: { kind: 'repo', repo: 'alpha' },
        text: 'no pushes to main',
      }),
    ]);
    expect(rows).toEqual([
      [
        'K-01ABCDEFGHJKMNPQRSTVWXYZ00',
        '-',
        'standard',
        'proposed',
        'tell',
        'global',
        'never push to a protected branch',
      ],
      [
        'K-01ABCDEFGHJKMNPQRSTVWXYZ01',
        'no_push_protected',
        'standard',
        'accepted',
        'action:pattern!',
        'repo:alpha',
        'no pushes to main',
      ],
    ]);
  });
});

describe('knowledge show fields', () => {
  test('an undecided tell item prints no check and no decision', () => {
    const fields = showFields(rule());
    expect(fields).toContainEqual(['status', 'proposed']);
    expect(fields).toContainEqual(['enforcement', 'tell']);
    expect(fields).toContainEqual(['paths', 'all']);
    expect(fields).toContainEqual(['decided', '-']);
    expect(fields.map(([k]) => k)).not.toContain('question');
    expect(fields.map(([k]) => k)).not.toContain('check');
  });

  test('the name prints; an item without one prints `-`', () => {
    expect(showFields(rule({ name: 'tests-with-changes' }))).toContainEqual([
      'name',
      'tests-with-changes',
    ]);
    expect(showFields(rule())).toContainEqual(['name', '-']);
  });

  test('a classifier check prints the default question; a decided item prints who', () => {
    const fields = showFields(
      rule({
        enforcement: 'ship',
        check: { by: 'classifier', examples: TWO },
        status: 'accepted',
        decided_at: '2026-09-22T01:00:00.000Z',
        decided_by: 'pete',
      }),
    );
    expect(fields).toContainEqual(['check', 'classifier']);
    expect(fields).toContainEqual([
      'question',
      'Does this action violate: never push to a protected branch?',
    ]);
    expect(fields).toContainEqual(['decided', '2026-09-22T01:00:00.000Z by pete']);
  });

  test('source and stats read as one line each', () => {
    const node = ulid();
    const fields = showFields(
      rule({
        source: { by: 'agent', session: '01ABCDEFGHJKMNPQRSTVWXYZ02', node },
        stats: { fired: 3, violated: 1, routed: 2, last_fired_at: '2026-09-22T02:00:00.000Z' },
      }),
    );
    expect(fields).toContainEqual([
      'source',
      `agent · node ${node} · session 01ABCDEFGHJKMNPQRSTVWXYZ02`,
    ]);
    expect(fields).toContainEqual([
      'stats',
      'fired 3 · violated 1 · routed 2 · last 2026-09-22T02:00:00.000Z',
    ]);
  });
});

describe('--example "<action>::<true|false>"', () => {
  test('splits on the last `::`, so a colon in the action survives', () => {
    expect(parseExample('git push origin main::true')).toEqual({
      action: 'git push origin main',
      violates: true,
    });
    expect(parseExample('curl https://x/y::false')).toEqual({
      action: 'curl https://x/y',
      violates: false,
    });
  });

  test('refuses a malformed example', () => {
    for (const spec of ['no separator', 'action::maybe', '::true']) {
      expect(() => parseExample(spec)).toThrow(/--example must look like/);
    }
  });

  test('every --example on the command line is kept, in order, commas and all', () => {
    expect(
      parseExamples(['--text', 'x', '--example', 'a, then b::true', '--example', 'b::false']),
    ).toEqual([
      { action: 'a, then b', violates: true },
      { action: 'b', violates: false },
    ]);
    expect(() => parseExamples(['--example', '--critical'])).toThrow(/--example needs a value/);
  });
});

describe('--enforcement (§6) and the old tiers under `rules`', () => {
  const enforcement = (...argv: string[]) => parseEnforcement(parseArgs(argv));

  test('the four settings parse as themselves', () => {
    for (const value of ['tell', 'action', 'ship', 'review'] as const) {
      expect(enforcement('--enforcement', value)).toBe(value);
    }
    expect(enforcement()).toBeUndefined();
  });

  test('the old tiers map as the migration maps them', () => {
    expect(enforcement('--enforcement', 'guidance')).toBe('tell');
    expect(enforcement('--enforcement', 'pattern')).toBe('action');
    expect(enforcement('--enforcement', 'classifier')).toBe('action');
    expect(enforcement('--enforcement', 'classifier', '--stage', 'diff')).toBe('ship');
  });

  test('anything else is refused, and --stage belongs to the old tiers', () => {
    expect(() => enforcement('--enforcement', 'vibes')).toThrow(/must be one of/);
    expect(() => enforcement('--enforcement', 'ship', '--stage', 'diff')).toThrow(/old tiers/);
    expect(() => enforcement('--stage', 'diff')).toThrow(/needs --enforcement/);
  });
});

describe('buildCheck (the flags as §14.3’s check)', () => {
  const examples = TWO;

  test('ship and action get a classifier check with the examples; tell and review get none', () => {
    expect(buildCheck('ship', { examples })).toEqual({ by: 'classifier', examples });
    expect(buildCheck('action', { examples: [], question: 'Adds a dep?' })).toEqual({
      by: 'classifier',
      question: 'Adds a dep?',
      examples: [],
    });
    expect(buildCheck('tell', { examples: [] })).toBeUndefined();
    expect(buildCheck('review', { examples: [] })).toBeUndefined();
  });

  test('a check flag on a tell or review item is refused, not dropped', () => {
    expect(() => buildCheck('tell', { examples })).toThrow(/carries no check/);
    expect(() => buildCheck('review', { examples: [], question: 'q?' })).toThrow(
      /carries no check/,
    );
  });

  test('a pattern is an action check only, and never mixed with classifier flags', () => {
    const pattern = { kind: 'no_push' as const, args: {} };
    expect(buildCheck('action', { examples: [], pattern })).toEqual({ by: 'pattern', pattern });
    expect(() => buildCheck('ship', { examples: [], pattern })).toThrow(/action check only/);
    expect(() => buildCheck('action', { examples, pattern })).toThrow(/two different checks/);
  });

  test('an edit keeps what it does not touch', () => {
    const current = { by: 'classifier' as const, question: 'q?', examples };
    expect(buildCheck('ship', { examples: [] }, current)).toEqual(current);
    expect(buildCheck('ship', { examples: [{ action: 'c', violates: true }] }, current)).toEqual({
      by: 'classifier',
      question: 'q?',
      examples: [{ action: 'c', violates: true }],
    });
  });
});

describe('knowledge report table (T142, §5.7)', () => {
  test('carries §5.7’s columns', () => {
    expect(RULE_REPORT_HEADERS).toEqual([
      'id',
      'name',
      'tier',
      'status',
      'fired',
      'violated',
      'routed',
      'last_fired',
      'flag',
    ]);
  });

  test('one cell per column, with the flag detail and `-` for a rule that never fired', () => {
    const rows = reportRowsFromDaemon(
      [
        rule({ status: 'accepted', created_at: '2026-01-01T00:00:00.000Z' }),
        rule({
          id: 'K-01ABCDEFGHJKMNPQRSTVWXYZ01',
          status: 'accepted',
          enforcement: 'ship',
          critical: true,
          check: {
            by: 'classifier',
            examples: [
              { action: 'git push origin main', violates: true },
              { action: 'git push origin feature', violates: false },
            ],
          },
          stats: { fired: 4, violated: 2, routed: 1, last_fired_at: '2026-09-21T10:00:00.000Z' },
        }),
      ],
      { now: new Date('2026-09-22T00:00:00.000Z') },
    );
    expect(ruleReportRows(rows)).toEqual([
      [
        'K-01ABCDEFGHJKMNPQRSTVWXYZ00',
        '-',
        'tell',
        'accepted',
        '0',
        '0',
        '0',
        '-',
        'never fired (14 days)',
      ],
      [
        'K-01ABCDEFGHJKMNPQRSTVWXYZ01',
        '-',
        'ship:classifier!',
        'accepted',
        '4',
        '2',
        '1',
        '2026-09-21T10:00:00.000Z',
        '-',
      ],
    ]);
  });
});

describe('rules test table (T153, §5.6)', () => {
  test('a multi-line diff example collapses to one truncated line (T155)', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1 +1 @@',
      '-export const a = 1;',
      '+export const a = 2;',
    ].join('\n');
    const report: RuleEvalReport = {
      bands: { deny_at: 0.8, allow_below: 0.4 },
      generated_at: '2026-09-22T00:00:00.000Z',
      rules: [
        {
          id: 'K-01ABCDEFGHJKMNPQRSTVWXYZ00',
          question: 'Does this diff change a public export?',
          critical: false,
          examples: [
            {
              action: diff,
              expected_violates: true,
              expected_band: 'deny',
              probability: 0.9,
              band: 'deny',
              agree: true,
            },
          ],
          agreed: 1,
          disagreed: 0,
          errors: 0,
        },
      ],
      total: 1,
      agreed: 1,
      disagreed: 0,
      errors: 0,
      agreement_rate: 1,
    };
    const cell = ruleTestRows(report)[0]?.[1] ?? '';
    expect(cell).not.toContain('\n');
    expect(cell.startsWith('diff --git a/src/index.ts b/src/index.ts --- a/src')).toBe(true);
    expect(cell.length).toBe(RULE_TEST_ACTION_MAX_CHARS);
    expect(cell.endsWith('…')).toBe(true);
    expect(oneLine('git push origin main')).toBe('git push origin main');
  });

  test('the deadline is examples × the classifier timeout, never under 5 s (T155)', () => {
    expect(ruleTestDeadlineMs({ rules: 2, examples: 4, timeout_ms: 25_000 })).toBe(105_000);
    expect(ruleTestDeadlineMs({ rules: 0, examples: 0, timeout_ms: 25_000 })).toBe(5_000);
  });

  test('carries §5.6’s columns', () => {
    expect(RULE_TEST_HEADERS).toEqual([
      'rule',
      'example',
      'expected',
      'probability',
      'band',
      'verdict',
    ]);
  });

  test('one row per example: the numbers, the band, and the verdict', () => {
    const report: RuleEvalReport = {
      bands: { deny_at: 0.8, allow_below: 0.4 },
      generated_at: '2026-09-22T00:00:00.000Z',
      rules: [
        {
          id: 'K-01ABCDEFGHJKMNPQRSTVWXYZ00',
          name: 'no_push_protected',
          question: 'Does this action violate: never push to a protected branch?',
          critical: true,
          examples: [
            {
              action: 'git push origin main',
              expected_violates: true,
              expected_band: 'deny',
              probability: 0.93,
              band: 'deny',
              agree: true,
            },
            {
              action: 'git push origin feature',
              expected_violates: false,
              expected_band: 'allow',
              probability: 0.62,
              band: 'route',
              agree: false,
            },
            {
              action: 'git push --force',
              expected_violates: true,
              expected_band: 'deny',
              agree: false,
              error: 'classifier unavailable (timeout): it timed out',
            },
          ],
          agreed: 1,
          disagreed: 1,
          errors: 1,
        },
      ],
      total: 3,
      agreed: 1,
      disagreed: 1,
      errors: 1,
      agreement_rate: 0.5,
    };
    expect(ruleTestRows(report)).toEqual([
      ['no_push_protected', 'git push origin main', 'deny', '0.930', 'deny', 'agree'],
      ['no_push_protected', 'git push origin feature', 'allow', '0.620', 'route', 'DISAGREE'],
      [
        'no_push_protected',
        'git push --force',
        'deny',
        '-',
        '-',
        'error: classifier unavailable (timeout): it timed out',
      ],
    ]);
  });
});

describe('--criteria-true / --criteria-false (T156)', () => {
  test('both give a criteria pair; neither gives none; one alone is refused', () => {
    expect(
      parseCriteria(parseArgs(['--criteria-true', 'broken', '--criteria-false', 'holds'])),
    ).toEqual({ true: 'broken', false: 'holds' });
    expect(parseCriteria(parseArgs(['--text', 'x']))).toBeUndefined();
    expect(() => parseCriteria(parseArgs(['--criteria-true', 'broken']))).toThrow(/together/);
  });
});
