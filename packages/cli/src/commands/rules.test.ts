/**
 * T140: the printed shapes of `agile rules list` / `agile rules show`, the
 * `--example` grammar, and the PLAN-v1 decision parse the seed verb uses.
 * `ruleRows`/`showFields` are the data the printers take, so these assert
 * the shape without a daemon.
 */
import { describe, expect, test } from 'bun:test';
import { parsePlanV1Decisions, seedProposal } from '@agile-agents/daemon';
import { ruleReportRows as reportRowsFromDaemon } from '@agile-agents/daemon';
import { type Rule, type RuleInput, ulid, validateRule } from '@agile-agents/shared';
import {
  RULE_HEADERS,
  RULE_REPORT_HEADERS,
  parseExample,
  parseExamples,
  ruleReportRows,
  ruleRows,
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
  test('carry the id/status/tier/scope/text header (T140)', () => {
    expect(RULE_HEADERS).toEqual(['id', 'status', 'tier', 'scope', 'text']);
  });

  test('one row per rule, with the tier and the rendered scope', () => {
    const rows = ruleRows([
      rule(),
      rule({
        id: 'R-01ABCDEFGHJKMNPQRSTVWXYZ01',
        status: 'accepted',
        enforcement: 'pattern',
        pattern: { kind: 'no_push_protected' },
        critical: true,
        scope: { kind: 'repo', ref: 'alpha' },
        text: 'no pushes to main',
      }),
    ]);
    expect(rows).toEqual([
      [
        'R-01ABCDEFGHJKMNPQRSTVWXYZ00',
        'proposed',
        'guidance',
        'global',
        'never push to a protected branch',
      ],
      ['R-01ABCDEFGHJKMNPQRSTVWXYZ01', 'accepted', 'pattern!', 'repo:alpha', 'no pushes to main'],
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
