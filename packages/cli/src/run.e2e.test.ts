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
 * gated purely on `AGILE_LIVE=1` (round 3 — same convention as every other
 * `live.test.ts` in this repo), skipped with the reason in its own name
 * when unset. `runDemoSprint`'s stall watchdog (`run.ts`) is what turns a
 * set-but-unreachable `AGILE_LIVE=1` into a fast, diagnosed failure rather
 * than a silent multi-minute hang.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSession } from '@agile-agents/acp-client';
import { runCliInit } from './commands/init';
import { runDemoSprint } from './commands/run';

const FIXTURE_ROOT = join(import.meta.dir, '..', '..', '..', 'fixtures', 'demo-project');

// T021 round 3 (opus review round 2 nit): gate purely on `AGILE_LIVE=1`,
// same as every other `live.test.ts` in this repo
// (`acp-client/src/live.test.ts`, `daemon/src/em/live.test.ts`,
// `daemon/src/hook/live.test.ts`, `test:integration`'s own `--grep live`
// convention) — the ticket's own Validation Steps command IS
// `AGILE_LIVE=1 bun run e2e`, so gating on anything narrower (round 2's
// `ANTHROPIC_API_KEY` check) means it can never fire on the host CLAUDE.md
// actually describes (a Claude Max `claude login`, no API key), passing
// vacuously by skipping every time. `runDemoSprint`'s own stall watchdog
// (`run.ts`) is what turns "AGILE_LIVE=1 but nothing reachable" into a
// fast, clear failure instead of ten minutes of silent churn — this test
// no longer tries to predict that up front.
const liveRequested = process.env.AGILE_LIVE === '1';

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

describe('agile run (live, real ACP — only with AGILE_LIVE=1)', () => {
  const title = liveRequested
    ? 'drives the seeded demo epic to done against a real Claude session'
    : 'drives the seeded demo epic to done against a real Claude session (skipped: AGILE_LIVE not set)';

  test.skipIf(!liveRequested)(
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

describe('agile run --live stall watchdog (offline, deterministic — opus review round 2 nit)', () => {
  test('aborts fast with a clear diagnosis when a live-mode session never progresses, instead of waiting out liveTimeoutMs', async () => {
    // Reproduces the exact failure mode the nit named — an unreachable
    // vendor (there, a bogus `ANTHROPIC_API_KEY`; here, a session that
    // spawns fine, registers, and then never responds, via `fake-agent.ts`'s
    // own `hang` step) — deterministically and fast, via `liveSpawnForTest`
    // (a test-only seam, `run.ts`'s own doc comment): this exercises the
    // real `!fake` code path (the live tick loop, `tickIntervalMs`/
    // `stallTimeoutMs`), just with a controllable transport standing in
    // for a real vendor, so this test needs no login and never spawns a
    // real vendor CLI.
    const fakeAgentPath = join(
      import.meta.dir,
      '..',
      '..',
      'daemon',
      'src',
      'runner',
      'fake-agent.ts',
    );
    const hangScriptPath = join(repo, 'hang-script.json');
    writeFileSync(hangScriptPath, JSON.stringify({ steps: [{ type: 'hang' }] }));
    const hangSpawn = (opts: Parameters<typeof spawnSession>[0]) =>
      spawnSession({
        ...opts,
        cmd: 'bun',
        args: [fakeAgentPath],
        envOverrides: { ...opts.envOverrides, AGILE_FAKE_AGENT_SCRIPT: hangScriptPath },
      });

    await expect(
      runDemoSprint({
        cwd: repo,
        seed: join(FIXTURE_ROOT, 'seed', 'epic.json'),
        fake: false,
        liveSpawnForTest: hangSpawn,
        tickIntervalMs: 100,
        liveTimeoutMs: 30_000,
        stallTimeoutMs: 500,
      }),
    ).rejects.toThrow(/no progress .* for 500ms/);
  }, 20_000);
});
