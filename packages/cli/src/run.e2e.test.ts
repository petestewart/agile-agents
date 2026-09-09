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
 * planted SPEC contradiction / discovery / DEC / ripple / re-refine cycle,
 * and its seeded rule-violation / request_changes / fix / re-review cycle)
 * closes: every ticket reaches `done` and is merged into `integration`, and
 * the oversized-file hook denies the engineer's read with a reason.
 *
 * The offline test below always pins `fake: true` regardless of the
 * environment — it is a determinism test and must never silently flip
 * behaviour depending on `AGILE_LIVE` (opus review round 1 blocker 2: the
 * old single test let `runDemoSprint`'s own `fake ?? AGILE_LIVE !== '1'`
 * default decide, so `AGILE_LIVE=1 bun run e2e` — the ticket's own
 * Validation Steps command — silently became a live attempt with no wait
 * loop and failed in ~3s, on a logged-in host too). The separate `live`
 * test below is what that command is actually meant to exercise; it's
 * skipped (not failed) whenever this run can't plausibly go live — either
 * `AGILE_LIVE` isn't set, or it is but no vendor login is detected — with
 * the reason visible in the test name.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliInit } from './commands/init';
import { runDemoSprint } from './commands/run';

const FIXTURE_ROOT = join(import.meta.dir, '..', '..', '..', 'fixtures', 'demo-project');

/**
 * Best-effort local signal that a *keyed* Claude login is available to spawn
 * against (`providers.ts`'s own "ambient login (`claude login`, or
 * `ANTHROPIC_API_KEY`)" header comment names both forms, but only the key
 * form is safely detectable here): a `claude login`'d session's own state
 * lives at `~/.claude.json`, which is indistinguishable from "a Claude Code
 * CLI happens to be installed" — this exact container has that file
 * (Claude Code's own config) with no vendor login behind it, so checking
 * for it is a false positive proven live, not a hypothetical (an earlier
 * round of this fix hung for a full `AGILE_LIVE=1` timeout because of it).
 * `ANTHROPIC_API_KEY` has no such ambiguity, so it's the only signal this
 * checks; a real `claude login`-only host needs to export it (or a person
 * confirming the login is in place is what `AGILE_LIVE=1` already assumes
 * for every other `live.test.ts` in this repo — this test only adds a
 * *cheaper* false-negative-safe skip on top, never a stricter gate).
 */
function hasVendorLogin(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const liveRequested = process.env.AGILE_LIVE === '1';
const canRunLive = liveRequested && hasVendorLogin();

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
  test('drives the seeded demo epic to done: assign -> engineer -> review -> QA -> merge, discovery/DEC/ripple/re-refine, seeded rule violation -> request_changes -> fix -> approve, oversized-file hook deny', async () => {
    const result = await runDemoSprint({
      cwd: repo,
      seed: join(FIXTURE_ROOT, 'seed', 'epic.json'),
      fake: true, // never let AGILE_LIVE decide this test's mode — see file header.
      maxTicks: 80,
    });

    expect(result.ticketOutcomes).toHaveLength(3);
    for (const outcome of result.ticketOutcomes) {
      expect(outcome.status).toBe('done');
      expect(outcome.merged).toBe(true);
    }

    expect(result.oversizedReadDecision).toMatch(/^deny:/);
    expect(result.oversizedReadDecision).toMatch(/read_summary/);

    // The seeded rule violation (T021 scope, QA round 1 / opus round 1
    // blocker 1): TKT-1001 alone took a round-1 request_changes + round-2
    // approve; the other two tickets converged in one round.
    const byTicket = Object.fromEntries(result.ticketOutcomes.map((o) => [o.ticket, o]));
    expect(byTicket['TKT-1001']?.reviewRounds).toBe(2);
    expect(byTicket['TKT-1002']?.reviewRounds).toBe(1);
    expect(byTicket['TKT-1003']?.reviewRounds).toBe(1);

    // The report file itself was written under fixtures/demo-project/runs'
    // convention (here: the temp repo's own `runs/`, per CLAUDE.md layout).
    const report = await Bun.file(result.reportPath).text();
    expect(report).toContain('## Per-ticket outcome');
    expect(report).toContain('TKT-1001: status=done, merged=yes');
    expect(report).toContain('TKT-1002: status=done, merged=yes');
    expect(report).toContain('TKT-1003: status=done, merged=yes');
    expect(report).toContain('## Review rounds per ticket');
    expect(report).toContain('TKT-1001: 2 rounds (request_changes then approve)');

    const { StateStore } = await import('@agile-agents/daemon');
    const store = StateStore.open(join(repo, '.agile'));

    // The discovery actually happened: TKT-1002/TKT-1003 both went
    // through a `stale` hop (the oracle ripple off DEC-0001) before
    // landing back on `ready` and finishing.
    for (const id of ['TKT-1002', 'TKT-1003'] as const) {
      const history = store.getTicket(id as never).history;
      expect(history.some((h) => h.includes('-> stale'))).toBe(true);
      expect(history.some((h) => h.includes('re-refined'))).toBe(true);
    }

    // The round-1 verdict actually cited RULE-001 against the real
    // planted line, and the round-2 verdict is a clean approve with the
    // violation gone — not just a round count, the finding's own content.
    const round1 = store.getEntity(
      'board/reviews/TKT-1001-r1.yaml',
      (v) => v as { verdict: string; findings: Array<{ rule?: string; message: string }> },
    );
    expect(round1.verdict).toBe('request_changes');
    expect(round1.findings).toHaveLength(1);
    expect(round1.findings[0]?.rule).toBe('RULE-001');
    const round2 = store.getEntity(
      'board/reviews/TKT-1001-r2.yaml',
      (v) => v as { verdict: string; findings: unknown[] },
    );
    expect(round2.verdict).toBe('approve');
    expect(round2.findings).toHaveLength(0);

    // The real code landed on `integration`, not just the ticket status —
    // and the merged tasks.ts no longer carries the debug line the reviewer
    // cited (the fix pass actually removed it, not just the reviewer's
    // saying so).
    const integrationTasks = Bun.spawnSync(['git', 'show', 'integration:src/tasks.ts'], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    }).stdout.toString();
    expect(integrationTasks).toContain('completeTask');
    expect(integrationTasks).toContain('dueDate.localeCompare');
    expect(integrationTasks).not.toContain('console.log(');
    const integrationOverdue = Bun.spawnSync(['git', 'show', 'integration:src/overdue.ts'], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    }).stdout.toString();
    expect(integrationOverdue).toContain('overdueTasks');

    // The per-criterion QA commands actually targeted the tests the
    // engineer's own commits added (opus review round 1 blocker 3) — a
    // bare `bun test` would pass identically whether or not the criteria
    // held; these command strings are what makes the verdict evidence.
    const qaTkt1002 = store.getEntity(
      'board/qa/TKT-1002-r1.yaml',
      (v) => v as { lines: Array<{ command?: string }> },
    );
    expect(qaTkt1002.lines[0]?.command).toContain('sorts ascending by dueDate');
  }, 60_000);
});

describe('agile run (live, real ACP — only with AGILE_LIVE=1 and a vendor login)', () => {
  const title = liveRequested
    ? canRunLive
      ? 'drives the seeded demo epic to done against a real Claude session'
      : 'drives the seeded demo epic to done against a real Claude session (skipped: AGILE_LIVE=1 but no vendor login detected — see hasVendorLogin())'
    : 'drives the seeded demo epic to done against a real Claude session (skipped: AGILE_LIVE not set)';

  test.skipIf(!canRunLive)(
    title,
    async () => {
      // Live mode has no scripted engineer/reviewer/QA turns (`run.ts`'s own
      // `if (fake)` gate) — real ACP sessions answer `assignReady`'s spawn,
      // the review protocol, and the QA protocol on their own, so this only
      // waits on the daemon's real ceremony tick (opus review round 1
      // blocker 2: the old loop had no wait at all and burned `maxTicks` in
      // milliseconds regardless of a real session's progress).
      const result = await runDemoSprint({
        cwd: repo,
        seed: join(FIXTURE_ROOT, 'seed', 'epic.json'),
        fake: false,
        tickIntervalMs: 5_000,
        liveTimeoutMs: 10 * 60_000,
      });

      expect(result.ticketOutcomes).toHaveLength(3);
      for (const outcome of result.ticketOutcomes) {
        expect(outcome.status).toBe('done');
        expect(outcome.merged).toBe(true);
      }
      // Not asserted here: the exact discovery/rule-violation script — a
      // real model isn't guaranteed to reproduce the SPEC-tasks-002
      // contradiction or leave/catch the console.log the same way the fake
      // driver scripts it. The offline test above is what pins that exact
      // narrative; this test's job is only "a real vendor session, driven
      // by nothing but the real daemon+briefs, converges to done+merged".
    },
    15 * 60_000,
  );
});
