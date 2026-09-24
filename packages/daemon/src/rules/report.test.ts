/**
 * T142: §5.7's pruning report. Two things can go wrong here — a flag that
 * fires on the wrong rule (which sends the human to retire a rule that is
 * working), and a count read from anywhere other than the stored `stats`
 * (which would be a second source of truth the hook path never updates).
 *
 * The flag rules are asserted as a pure function over fixtures; the RPC
 * edge and the "a retired rule stops being injected" acceptance criterion
 * are asserted against a real temp state home.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Rule, type RuleInput, ulid, validateRule } from '@agile-agents/shared';
import { runInit } from '../init';
import type { RpcMethodHandler } from '../rpc';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import {
  RULE_REPORT_DEFAULT_DAYS,
  type RuleReport,
  buildRuleReport,
  ruleReportRows,
} from './report';
import { buildRuleRpcMethods } from './rpc';
import { RulesService } from './service';

const NOW = new Date('2026-09-22T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** `days` ago, as an ISO `created_at`. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function fixture(over: Partial<RuleInput> = {}): Rule {
  return validateRule({
    id: `R-${ulid()}`,
    text: 'never push to a protected branch',
    scope: { kind: 'global' },
    status: 'accepted',
    enforcement: 'classifier',
    critical: false,
    provenance: { by: 'human' },
    stats: {},
    created_at: daysAgo(30),
    ...over,
  });
}

const flagOf = (rule: Rule, days?: number): string => {
  const [row] = ruleReportRows([rule], { now: NOW, ...(days !== undefined ? { days } : {}) });
  return row?.flag ?? 'no row';
};

describe('the three pruning signals (§5.7)', () => {
  test('an accepted rule that never fired inside the window is flagged, with the window named', () => {
    const rows = ruleReportRows([fixture({ created_at: daysAgo(30) })], { now: NOW });
    expect(rows[0]?.flag).toBe('never fired');
    expect(rows[0]?.flag_detail).toBe(`never fired (${RULE_REPORT_DEFAULT_DAYS} days)`);
  });

  test('a rule younger than the window is not yet a prune candidate', () => {
    expect(flagOf(fixture({ created_at: daysAgo(3) }))).toBe('-');
    expect(flagOf(fixture({ created_at: daysAgo(3) }), 2)).toBe('never fired');
  });

  test('only an accepted rule can be flagged never fired — a proposed one never had the chance', () => {
    expect(flagOf(fixture({ status: 'proposed' }))).toBe('-');
    expect(flagOf(fixture({ status: 'retired' }))).toBe('-');
  });

  test('fired often and never violated is flagged: the agents already behave', () => {
    expect(flagOf(fixture({ stats: { fired: 10, violated: 0 } }))).toBe('never violated');
    // Below the floor the silence is not yet evidence.
    expect(flagOf(fixture({ stats: { fired: 9, violated: 0 } }))).toBe('-');
    expect(flagOf(fixture({ stats: { fired: 40, violated: 1 } }))).toBe('-');
  });

  test('a pattern rule that fires is never flagged never violated (T145)', () => {
    // A pattern rule's firing *is* the enforcement: it matched and the call
    // was denied, so `violated: 0` means the rule works. Flagging it told
    // the operator to retire `no_push_protected` for being effective.
    const pattern: Partial<RuleInput> = {
      enforcement: 'pattern',
      pattern: { kind: 'no_push_protected', args: {} },
      name: 'no_push_protected',
    };
    expect(flagOf(fixture({ ...pattern, stats: { fired: 500, violated: 0 } }))).toBe('-');
    // …and it keeps the two signals that still mean something for it.
    expect(flagOf(fixture({ ...pattern, stats: { fired: 0 } }))).toBe('never fired');
    expect(flagOf(fixture({ ...pattern, stats: { fired: 10, violated: 0, routed: 5 } }))).toBe(
      'routes often',
    );
  });

  test('the built-in’s name rides on the row, and nothing else has one (T145)', () => {
    const [named] = ruleReportRows([fixture({ name: 'no_push_protected' })], { now: NOW });
    expect(named?.name).toBe('no_push_protected');
    expect(ruleReportRows([fixture()], { now: NOW })[0]?.name).toBeUndefined();
  });

  test('routing a third of its firings is flagged: the rule is ambiguous', () => {
    expect(flagOf(fixture({ stats: { fired: 10, violated: 2, routed: 3 } }))).toBe('routes often');
    expect(flagOf(fixture({ stats: { fired: 10, violated: 2, routed: 2 } }))).toBe('-');
    // One route out of two firings is a ratio, not a signal.
    expect(flagOf(fixture({ stats: { fired: 2, violated: 1, routed: 2 } }))).toBe('-');
  });

  test('counters absent from the record read as zero, never as unknown', () => {
    const rows = ruleReportRows([fixture({ stats: {}, created_at: daysAgo(1) })], { now: NOW });
    expect(rows[0]).toMatchObject({ fired: 0, violated: 0, routed: 0, flag: '-' });
    expect(rows[0]?.last_fired).toBeUndefined();
  });
});

describe('the row', () => {
  test('carries the tier with the critical marker and the last firing', () => {
    const rows = ruleReportRows(
      [
        fixture({
          id: 'R-01ABCDEFGHJKMNPQRSTVWXYZ00',
          enforcement: 'pattern',
          pattern: { kind: 'no_push_protected' },
          critical: true,
          stats: { fired: 3, violated: 1, routed: 0, last_fired_at: daysAgo(1) },
        }),
      ],
      { now: NOW },
    );
    expect(rows[0]).toEqual({
      id: 'R-01ABCDEFGHJKMNPQRSTVWXYZ00',
      tier: 'pattern!',
      status: 'accepted',
      fired: 3,
      violated: 1,
      routed: 0,
      last_fired: daysAgo(1),
      flag: '-',
      flag_detail: '-',
    });
  });

  test('flagged rules sort first, then by fired descending', () => {
    const quiet = fixture({ id: 'R-01ABCDEFGHJKMNPQRSTVWXYZ01', stats: { fired: 0 } });
    const busy = fixture({ id: 'R-01ABCDEFGHJKMNPQRSTVWXYZ02', stats: { fired: 7, violated: 4 } });
    const ok = fixture({ id: 'R-01ABCDEFGHJKMNPQRSTVWXYZ03', stats: { fired: 2, violated: 1 } });
    const chatty = fixture({
      id: 'R-01ABCDEFGHJKMNPQRSTVWXYZ04',
      stats: { fired: 20, violated: 0 },
    });
    const rows = ruleReportRows([ok, quiet, busy, chatty], { now: NOW });
    expect(rows.map((r) => [r.id.slice(-2), r.flag])).toEqual([
      ['04', 'never violated'],
      ['01', 'never fired'],
      ['02', '-'],
      ['03', '-'],
    ]);
  });
});

// ------------------------------------------------- against a real home

let home: string;
let store: StateStore;
let streams: StreamService;
let rules: RulesService;
let methods: Record<string, RpcMethodHandler>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-rule-report-'));
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  rules = new RulesService({ store, streams });
  methods = buildRuleRpcMethods(rules);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const call = async <T>(method: string, params?: unknown): Promise<T> => {
  const handler = methods[method];
  if (!handler) throw new Error(`no such method: ${method}`);
  return (await handler(params)) as T;
};

describe('rule.report over the store', () => {
  test('the counts are the stats the hook path wrote, not a recount', async () => {
    const rule = await rules.create('human', { text: 'no new dependencies without asking' });
    await rules.accept(rule.id, 'pete');
    // What T151/T152 do on a firing: bump the counters as the daemon.
    await store.updateRule('daemon', rule.id, (before) => ({
      ...before,
      stats: { fired: 12, violated: 0, routed: 1, last_fired_at: NOW.toISOString() },
    }));

    const report = await call<RuleReport>('rule.report', {});
    expect(report.days).toBe(RULE_REPORT_DEFAULT_DAYS);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      id: rule.id,
      fired: 12,
      violated: 0,
      routed: 1,
      last_fired: NOW.toISOString(),
      flag: 'never violated',
    });
  });

  test('--days narrows the never-fired window', async () => {
    // Created two days ago, so the default 14-day window is silent and a
    // one-day window flags it.
    const dated = new RulesService({
      store,
      streams,
      clock: () => new Date(Date.now() - 2 * DAY),
    });
    const rule = await dated.create('human', { text: 'keep commits scoped' });
    await dated.accept(rule.id, 'pete');
    expect((await call<RuleReport>('rule.report', {})).rows[0]?.flag).toBe('-');
    const narrow = await call<RuleReport>('rule.report', { days: 1 });
    expect(narrow.days).toBe(1);
    expect(narrow.rows[0]?.flag).toBe('never fired');
  });

  test.each([{ days: 0 }, { days: -3 }, { days: 1.5 }, { days: 'soon' }])(
    'rejects %o as invalid params, never a TypeError',
    async (params) => {
      await expect(call('rule.report', params)).rejects.toMatchObject({ code: -32602 });
    },
  );

  test('a numeric string from the CLI is accepted', async () => {
    expect((await call<RuleReport>('rule.report', { days: '7' })).days).toBe(7);
  });

  test('the report reads every status, so a retired rule is still visible', async () => {
    const rule = await rules.create('human', { text: 'a rule that will be retired' });
    await rules.accept(rule.id, 'pete');
    await rules.retire(rule.id, 'pete');
    const report = buildRuleReport(rules, { now: NOW });
    expect(report.rows.map((r) => r.status)).toEqual(['retired']);
  });
});

/**
 * The acceptance criterion, end to end: pruning is a status change (§5.7)
 * and §5.3's filter is the only injection path, so retiring a rule is
 * enough to stop it reaching the next session's brief — no restart, no
 * cache, nothing else to invalidate.
 */
test('a retired rule stops being injected on the next session', async () => {
  const stream = await streams.create('human', { title: 'a stream', goal: 'g' });
  const rule = await rules.create('human', { text: 'always run the repo scripts' });
  await rules.accept(rule.id, 'pete');
  expect(rules.inScope(stream.id).map((r) => r.id)).toEqual([rule.id]);

  await rules.retire(rule.id, 'pete');

  expect(rules.inScope(stream.id)).toEqual([]);
  // Still on the board, with its counts, for the report — nothing is deleted.
  expect(rules.get(rule.id).status).toBe('retired');
  expect(buildRuleReport(rules, { now: NOW }).rows.map((r) => r.id)).toEqual([rule.id]);
});
