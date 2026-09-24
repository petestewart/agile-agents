/**
 * T140: the printed shapes of `agile rules list` / `agile rules show`, the
 * `--example` grammar, and the PLAN-v1 decision parse the seed verb uses.
 * `ruleRows`/`showFields` are the data the printers take, so these assert
 * the shape without a daemon.
 */
import { describe, expect, test } from 'bun:test';
import { parsePlanV1Decisions, seedProposal } from '@agile-agents/daemon';
import { ruleReportRows as reportRowsFromDaemon } from '@agile-agents/daemon';
import type { RuleEvalReport } from '@agile-agents/daemon';
import { type Rule, type RuleInput, ulid, validateRule } from '@agile-agents/shared';
import { parseArgs } from '../args';
import {
  RULE_HEADERS,
  RULE_REPORT_HEADERS,
  RULE_TEST_ACTION_MAX_CHARS,
  RULE_TEST_HEADERS,
  oneLine,
  parseCriteria,
  parseExample,
  parseExamples,
  ruleReportRows,
  ruleRows,
  ruleTestDeadlineMs,
  ruleTestRows,
  showFields,
} from './rules';

function rule(over: Partial<RuleInput> = {}): Rule {
  return validateRule({
    id: 'R-01ABCDEFGHJKMNPQRSTVWXYZ00',
    text: 'never push to a protected branch',
    scope: { kind: 'global' },
    status: 'proposed',
    enforcement: 'guidance',
    critical: false,
    provenance: { by: 'human' },
    stats: {},
    created_at: '2026-09-22T00:00:00.000Z',
    ...over,
  });
}

describe('rules list rows', () => {
  test('carry the id/name/status/tier/scope/text header (T140, T145)', () => {
    expect(RULE_HEADERS).toEqual(['id', 'name', 'status', 'tier', 'scope', 'text']);
  });

  test('one row per rule, with the tier and the rendered scope', () => {
    const rows = ruleRows([
      rule(),
      rule({
        id: 'R-01ABCDEFGHJKMNPQRSTVWXYZ01',
        status: 'accepted',
        enforcement: 'pattern',
        name: 'no_push_protected',
        pattern: { kind: 'no_push_protected' },
        critical: true,
        scope: { kind: 'repo', ref: 'alpha' },
        text: 'no pushes to main',
      }),
    ]);
    expect(rows).toEqual([
      [
        'R-01ABCDEFGHJKMNPQRSTVWXYZ00',
        // T145: only a built-in carries a name; a hand-written rule prints `-`.
        '-',
        'proposed',
        'guidance',
        'global',
        'never push to a protected branch',
      ],
      [
        'R-01ABCDEFGHJKMNPQRSTVWXYZ01',
        'no_push_protected',
        'accepted',
        'pattern!',
        'repo:alpha',
        'no pushes to main',
      ],
    ]);
  });
});

describe('rules show fields', () => {
  test('an undecided guidance rule prints no question and no decision', () => {
    const fields = showFields(rule());
    expect(fields).toContainEqual(['status', 'proposed']);
    expect(fields).toContainEqual(['stage', 'action']);
    expect(fields).toContainEqual(['decided', '-']);
    expect(fields.map(([k]) => k)).not.toContain('question');
    expect(fields.map(([k]) => k)).not.toContain('pattern');
  });

  test('a built-in prints its name; everything else prints `-` (T145)', () => {
    expect(showFields(rule({ name: 'no_push_protected' }))).toContainEqual([
      'name',
      'no_push_protected',
    ]);
    expect(showFields(rule())).toContainEqual(['name', '-']);
  });

  test('a classifier rule prints the default question; a decided rule prints who', () => {
    const fields = showFields(
      rule({
        enforcement: 'classifier',
        status: 'accepted',
        decided_at: '2026-09-22T01:00:00.000Z',
        decided_by: 'pete',
        examples: [
          { action: 'a', violates: true },
          { action: 'b', violates: false },
        ],
      }),
    );
    expect(fields).toContainEqual([
      'question',
      'Does this action violate: never push to a protected branch?',
    ]);
    expect(fields).toContainEqual(['decided', '2026-09-22T01:00:00.000Z by pete']);
  });

  test('provenance and stats read as one line each', () => {
    const stream = ulid();
    const fields = showFields(
      rule({
        provenance: { by: 'agent:01ABCDEFGHJKMNPQRSTVWXYZ02', stream },
        stats: { fired: 3, violated: 1, routed: 2, last_fired_at: '2026-09-22T02:00:00.000Z' },
      }),
    );
    expect(fields).toContainEqual([
      'provenance',
      `agent:01ABCDEFGHJKMNPQRSTVWXYZ02 · stream ${stream}`,
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

  test('every --example on the command line is kept, in order', () => {
    expect(parseExamples(['--text', 'x', '--example', 'a::true', '--example', 'b::false'])).toEqual(
      [
        { action: 'a', violates: true },
        { action: 'b', violates: false },
      ],
    );
    expect(() => parseExamples(['--example', '--critical'])).toThrow(/--example needs a value/);
  });
});

describe('rules seed (PLAN-v1 §9)', () => {
  const section = [
    '## 9. Discovered Issues Log',
    '',
    '- 2026-09-08 — T002 review round 1 FAIL. Decision: all shared schemas are `.strict()` by default so the store rejects unknown keys.',
    '- 2026-09-09 — T005 merged. Decisions (manager, yolo): (1) every store mutation emits exactly one events.jsonl line; (2) the store gets a generic validating putEntity trio so nothing writes around it.',
    '- 2026-09-10 — a plain note with no decision in it at all, which must not become a rule.',
    'Prose, not a bullet. Decision: ignored because the line is not a list item.',
    '',
    '## 10. Something else',
    '',
    '- 2026-09-11 — Decision: out of the section, never imported.',
  ].join('\n');

  test('one rule per decision sentence, and nothing else from the file', () => {
    expect(parsePlanV1Decisions(section)).toEqual([
      'all shared schemas are `.strict()` by default so the store rejects unknown keys.',
      'every store mutation emits exactly one events.jsonl line',
      'the store gets a generic validating putEntity trio so nothing writes around it.',
    ]);
  });

  test('a file with no §9 section yields nothing', () => {
    expect(parsePlanV1Decisions('# Plan\n\n- Decision: nowhere near the log\n')).toEqual([]);
  });

  test('the seeded proposal is a global guidance rule with seed provenance', () => {
    expect(seedProposal('x')).toEqual({
      text: 'x',
      scope: { kind: 'global' },
      enforcement: 'guidance',
      provenance: { by: 'seed:PLAN-v1' },
    });
  });
});

describe('rules report table (T142, §5.7)', () => {
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
          id: 'R-01ABCDEFGHJKMNPQRSTVWXYZ01',
          status: 'accepted',
          enforcement: 'classifier',
          critical: true,
          examples: [
            { action: 'git push origin main', violates: true },
            { action: 'git push origin feature', violates: false },
          ],
          stats: { fired: 4, violated: 2, routed: 1, last_fired_at: '2026-09-21T10:00:00.000Z' },
        }),
      ],
      { now: new Date('2026-09-22T00:00:00.000Z') },
    );
    expect(ruleReportRows(rows)).toEqual([
      [
        'R-01ABCDEFGHJKMNPQRSTVWXYZ00',
        '-',
        'guidance',
        'accepted',
        '0',
        '0',
        '0',
        '-',
        'never fired (14 days)',
      ],
      [
        'R-01ABCDEFGHJKMNPQRSTVWXYZ01',
        '-',
        'classifier!',
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
          id: 'R-01ABCDEFGHJKMNPQRSTVWXYZ00',
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
          id: 'R-01ABCDEFGHJKMNPQRSTVWXYZ00',
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
