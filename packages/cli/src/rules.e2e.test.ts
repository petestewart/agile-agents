/**
 * T140 acceptance, end to end: `agile rules add|list|show|accept|retire|
 * seed` against a real in-process daemon over a real unix socket on a temp
 * `AGILE_HOME`. No vendor, no network.
 *
 * The principal split (**D4**) is the point of the accept path: the CLI is
 * the human's edge, so `rules accept` works here — and nothing on this
 * surface can write a rule as an agent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxItem, Rule } from '@agile-agents/shared';
import { runCli } from './index';
import { type TestDaemon, startTestDaemon } from './test-support';

let daemon: TestDaemon;

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(String(msg));
  try {
    const code = await runCli(argv, daemon.repo);
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

async function add(text: string, extra: string[] = []): Promise<Rule> {
  const result = await cli(['rules', 'add', '--text', text, ...extra, '--json']);
  expect(result.code).toBe(0);
  return JSON.parse(result.out) as Rule;
}

beforeEach(async () => {
  daemon = await startTestDaemon('agile-rules-e2e-');
});

afterEach(async () => {
  await daemon.cleanup();
});

describe('agile rules against a daemon on a temp AGILE_HOME', () => {
  test('add/list/show/accept/retire round-trips and writes the home file', async () => {
    const rule = await add('prefer the repo scripts over a second toolchain');
    expect(rule.status).toBe('proposed');
    expect(existsSync(join(daemon.home, 'rules', `${rule.id}.yaml`))).toBe(true);

    const listed = await cli(['rules', 'list']);
    const lines = listed.out.split('\n');
    expect(lines[0]?.trimEnd().split(/\s{2,}/)).toEqual([
      'id',
      'name',
      'status',
      'tier',
      'scope',
      'text',
    ]);
    expect(lines[1]).toContain(rule.id);
    expect(lines[1]).toContain('proposed');
    expect(lines[1]).toContain('global');

    const shown = await cli(['rules', 'show', rule.id]);
    expect(shown.out).toContain('prefer the repo scripts over a second toolchain');
    expect(shown.out).toContain('enforcement  guidance');
    // T145: only a built-in has a name; a rule a human wrote prints `-`.
    expect(shown.out).toContain('name         -');

    const accepted = await cli(['rules', 'accept', rule.id, '--by', 'pete']);
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain('is accepted');
    expect(daemon.rulesService.get(rule.id).decided_by).toBe('pete');

    const retired = await cli(['rules', 'retire', rule.id]);
    expect(retired.out).toContain('is retired');
    // Retiring is a status change; nothing is deleted (§5.7).
    expect(existsSync(join(daemon.home, 'rules', `${rule.id}.yaml`))).toBe(true);
  });

  test('--status and --scope filter the list', async () => {
    const stream = daemon.streamService;
    const s = await stream.create('human', { title: 'parser', goal: 'pick a dialect' });
    const global = await add('a global rule');
    const scoped = await add('a stream rule', ['--scope', `stream:${s.id}`]);
    await cli(['rules', 'accept', global.id]);

    const proposed = await cli(['rules', 'list', '--status', 'proposed', '--json']);
    expect((JSON.parse(proposed.out) as { rules: Rule[] }).rules.map((r) => r.id)).toEqual([
      scoped.id,
    ]);
    const byScope = await cli(['rules', 'list', '--scope', `stream:${s.id}`, '--json']);
    expect((JSON.parse(byScope.out) as { rules: Rule[] }).rules.map((r) => r.id)).toEqual([
      scoped.id,
    ]);
  });

  test('a classifier rule needs two examples before it can be accepted (§5.6)', async () => {
    const thin = await add('do not add a dependency without asking', [
      '--enforcement',
      'classifier',
      '--critical',
      '--example',
      'bun add lodash::true',
    ]);
    expect(thin.critical).toBe(true);
    expect(thin.examples).toEqual([{ action: 'bun add lodash', violates: true }]);

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    try {
      expect(await runCli(['rules', 'accept', thin.id], daemon.repo)).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join('\n')).toContain('at least 2 examples');
    expect(daemon.rulesService.get(thin.id).status).toBe('proposed');
  });

  test('a proposed rule is a rule_accept inbox item, and accepting clears it', async () => {
    const rule = await add('a global rule');
    const inbox = await cli(['inbox', '--json']);
    const items = (JSON.parse(inbox.out) as { items: InboxItem[] }).items;
    expect(items.map((i) => [i.kind, i.id])).toEqual([['rule_accept', rule.id]]);
    await cli(['rules', 'accept', rule.id]);
    expect(
      (JSON.parse((await cli(['inbox', '--json'])).out) as { items: InboxItem[] }).items,
    ).toEqual([]);
  });

  test('seed imports a PLAN-v1 §9 decision log once, and is idempotent', async () => {
    const plan = join(daemon.repo, 'PLAN-v1.md');
    writeFileSync(
      plan,
      [
        '## 9. Discovered Issues Log',
        '',
        '- 2026-09-08 — T002 FAIL. Decision: all shared schemas are `.strict()` so the store rejects unknown keys.',
        '- 2026-09-09 — T005 merged. Decisions (manager, yolo): (1) every store mutation emits exactly one events.jsonl line; (2) hooks enforce and prompts express intent.',
        '',
      ].join('\n'),
    );

    const first = await cli(['rules', 'seed', '--from', plan, '--json']);
    expect(first.code).toBe(0);
    const firstResult = JSON.parse(first.out) as { created: string[]; skipped: number };
    expect(firstResult.created).toHaveLength(3);
    expect(firstResult.skipped).toBe(0);

    const seeded = daemon.rulesService.list();
    expect(seeded).toHaveLength(3);
    for (const rule of seeded) {
      expect(rule.status).toBe('proposed');
      expect(rule.enforcement).toBe('guidance');
      expect(rule.scope).toEqual({ kind: 'global' });
      expect(rule.provenance).toEqual({ by: 'seed:PLAN-v1' });
    }

    const second = await cli(['rules', 'seed', '--from', plan, '--json']);
    const secondResult = JSON.parse(second.out) as { created: string[]; skipped: number };
    expect(secondResult.created).toEqual([]);
    expect(secondResult.skipped).toBe(3);
    expect(daemon.rulesService.list()).toHaveLength(3);
  });

  test('an accepted rule in scope reaches a session brief; a proposed one does not', async () => {
    const stream = await daemon.streamService.create('human', {
      title: 'parser',
      goal: 'pick a dialect',
    });
    const accepted = await add('always run the integration suite');
    await cli(['rules', 'accept', accepted.id]);
    await add('not yet accepted');

    expect(daemon.rulesService.inScope(stream.id).map((r) => r.text)).toEqual([
      'always run the integration suite',
    ]);
  });
});
