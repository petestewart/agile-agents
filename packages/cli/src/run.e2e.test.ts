/**
 * `agile run`'s offline/deterministic e2e (T021 — PLAN.md §6 "Definition of
 * Done" Run section, ticket T021's session overrides: "an `e2e` root
 * script that runs the demo with the fake ACP agent ... offline,
 * deterministic, must pass in `bun test`/CI").
 *
 * Copies `fixtures/demo-project` into a fresh temp git repo (never mutates
 * the checked-in fixture), `agile init`s it, then drives
 * `runDemoSprint({ seed })` — the whole daemon object graph in-process,
 * fake ACP sessions, this module playing every engineer/reviewer/qa/
 * architect turn — and asserts the seeded three-ticket epic (including its
 * planted SPEC contradiction / discovery / DEC / ripple / re-refine cycle)
 * closes: every ticket reaches `done` and is merged into `integration`, and
 * the oversized-file hook denies the engineer's read with a reason.
 *
 * No vendor login is used or required (`fake: true`, the default) — see
 * `.pipeline-report.md` for what still needs `AGILE_LIVE=1` against a real
 * Claude session.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliInit } from './commands/init';
import { runDemoSprint } from './commands/run';

const FIXTURE_ROOT = join(import.meta.dir, '..', '..', '..', 'fixtures', 'demo-project');

let repo: string;

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-run-e2e-'));
  cpSync(FIXTURE_ROOT, repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['add', '-A'], repo);
  git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], repo);
  // `MergeOwner.mergeIntegrationToMain` needs its own worktree on `main` —
  // it can't be the branch already checked out at the repo root.
  git(['checkout', '-q', '-b', 'workspace'], repo);
  runCliInit(repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('agile run (offline, fake ACP)', () => {
  test('drives the seeded demo epic to done: assign -> engineer -> review -> QA -> merge, discovery/DEC/ripple/re-refine, oversized-file hook deny', async () => {
    const result = await runDemoSprint({
      cwd: repo,
      seed: join(FIXTURE_ROOT, 'seed', 'epic.json'),
      maxTicks: 80,
    });

    expect(result.ticketOutcomes).toHaveLength(3);
    for (const outcome of result.ticketOutcomes) {
      expect(outcome.status).toBe('done');
      expect(outcome.merged).toBe(true);
    }

    expect(result.oversizedReadDecision).toMatch(/^deny:/);
    expect(result.oversizedReadDecision).toMatch(/read_summary/);

    // The report file itself was written under fixtures/demo-project/runs'
    // convention (here: the temp repo's own `runs/`, per CLAUDE.md layout).
    const report = await Bun.file(result.reportPath).text();
    expect(report).toContain('## Per-ticket outcome');
    expect(report).toContain('TKT-1001: status=done, merged=yes');
    expect(report).toContain('TKT-1002: status=done, merged=yes');
    expect(report).toContain('TKT-1003: status=done, merged=yes');

    // The discovery actually happened: TKT-1002/TKT-1003 both went
    // through a `stale` hop (the oracle ripple off DEC-0001) before
    // landing back on `ready` and finishing.
    const { StateStore } = await import('@agile-agents/daemon');
    const store = StateStore.open(join(repo, '.agile'));
    for (const id of ['TKT-1002', 'TKT-1003'] as const) {
      const history = store.getTicket(id as never).history;
      expect(history.some((h) => h.includes('-> stale'))).toBe(true);
      expect(history.some((h) => h.includes('re-refined'))).toBe(true);
    }

    // The real code landed on `integration`, not just the ticket status.
    const integrationTasks = Bun.spawnSync(['git', 'show', 'integration:src/tasks.ts'], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    }).stdout.toString();
    expect(integrationTasks).toContain('completeTask');
    expect(integrationTasks).toContain('dueDate.localeCompare');
    const integrationOverdue = Bun.spawnSync(['git', 'show', 'integration:src/overdue.ts'], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    }).stdout.toString();
    expect(integrationOverdue).toContain('overdueTasks');
  }, 60_000);
});
