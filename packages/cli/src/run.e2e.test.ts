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
import { LiveVendorUnavailableError, runDemoSprint } from './commands/run';

const FAKE_AGENT_PATH = join(
  import.meta.dir,
  '..',
  '..',
  'daemon',
  'src',
  'runner',
  'fake-agent.ts',
);

/** Writes a fake-agent script file under `repo` and returns a `liveSpawnForTest` spawn function that runs it. */
function fakeAgentSpawn(repo: string, name: string, steps: unknown[]) {
  const scriptPath = join(repo, `${name}.json`);
  // `logFile`: what the fake agent received/sent, for `AGILE_LIVE_KEEP=1` post-mortems.
  writeFileSync(
    scriptPath,
    JSON.stringify({ steps, logFile: join(repo, `${name}.fake-agent.log`) }),
  );
  return (opts: Parameters<typeof spawnSession>[0]) =>
    spawnSession({
      ...opts,
      cmd: 'bun',
      args: [FAKE_AGENT_PATH],
      envOverrides: { ...opts.envOverrides, AGILE_FAKE_AGENT_SCRIPT: scriptPath },
    });
}

/**
 * A real, monotonic clock that runs `factor`x faster than the wall clock
 * (T021 round 5, QA round 4 finding 1) — `runDemoSprint`'s `testNow` seam
 * threads this into both `AgentRecord.last_seen` writes (via `Bus`'s own
 * heartbeat coalescing, `store.ts`'s `HEARTBEAT_COALESCE_MS`) and the
 * stall watchdog's own timing, so a test can clear a real 30s coalescing
 * window and a real multi-minute `stallTimeoutMs` in a small fraction of a
 * real second — without a counter-stepped mock, which would lose the real
 * proportional gaps between events (and could let a test pass for a reason
 * that has nothing to do with the real coalescing/threshold logic).
 */
function acceleratedClock(factor: number): () => Date {
  const realStart = Date.now();
  return () => new Date(realStart + (Date.now() - realStart) * factor);
}

const FIXTURE_ROOT = join(import.meta.dir, '..', '..', '..', 'fixtures', 'demo-project');

/**
 * A one-ticket seed (T035 deflake), matching the ticket shape in
 * `fixtures/demo-project/seed/epic.json` but with a single entry. Used by
 * the two stall-watchdog tests that spawn a controllable transport (the
 * "genuinely silent session" and "healthy long turn" tests below) — neither
 * needs the full three-ticket demo epic, and each real spawn is a real OS
 * subprocess + a real `git worktree add`, so one ticket instead of three
 * bounds that unavoidable real cost for both. The third test in this
 * `describe` ("no vendor reachable") still seeds from the real `epic.json`
 * — it never reaches a spawn at all (it fails at the pre-flight), so the
 * three-agent fan-in path there is moot and unaffected. Written into `repo`
 * (never the checked-in fixture) the same way `fakeAgentSpawn` writes its
 * own script file.
 *
 * For the "genuinely silent session" test, this is a cost optimization
 * only — its determinism comes from its own `liveTimeoutMs`, pinned past
 * this file's bun-test timeout (see that test's comment). For the "healthy
 * long turn" test (T035 round 3), it is load-bearing: bounding real
 * spawn/handshake latency to a single subprocess is part of what keeps that
 * test's `stallTimeoutMs < liveTimeoutMs` margin (see that test's comment)
 * safe under load.
 */
function writeSingleTicketSeed(repo: string): string {
  const seed = {
    tickets: [
      {
        id: 'TKT-9001',
        title: 'Stall-watchdog probe ticket',
        status: 'ready',
        oracle_refs: [],
        contract: { acceptance: ['n/a — never actually worked by a live session'], env: 'clone' },
      },
    ],
  };
  const path = join(repo, 'stall-watchdog-seed.json');
  writeFileSync(path, JSON.stringify(seed));
  return path;
}

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
  // `AGILE_LIVE_KEEP=1` leaves the temp repo in place so a failed live run's
  // artifacts (`.agile/log/events.jsonl`, `.agile/bus/agents/*.yaml`,
  // `.agile/board/hil/*`, `.agile-daemon-cache/sessions/*.stderr.log`,
  // `runs/*.md`) can be inspected after the test — the default cleanup
  // otherwise removes exactly the evidence a live failure needs.
  if (process.env.AGILE_LIVE_KEEP === '1') {
    console.log(`agile run e2e: AGILE_LIVE_KEEP=1 — keeping ${repo}`);
    return;
  }
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
      // Printed up front, not only from `afterEach`: the offline test's own
      // keep line comes first in the output, and mid-run this is the only
      // way to know which temp repo is the live one.
      if (process.env.AGILE_LIVE_KEEP === '1') console.log(`live e2e: repo is ${repo}`);
      let result: Awaited<ReturnType<typeof runDemoSprint>>;
      try {
        result = await runDemoSprint({
          cwd: repo,
          seed: join(FIXTURE_ROOT, 'seed', 'epic.json'),
          fake: false,
          tickIntervalMs: 5_000,
          liveTimeoutMs: 10 * 60_000,
        });
      } catch (err) {
        // T021 round 4 (opus review round 3): `AGILE_LIVE=1` alone doesn't
        // prove a working vendor login is actually present on this host —
        // the pre-flight (`run.ts`'s `preflightLiveVendor`) is what
        // answers that, fast, and this is the one place a caller is
        // expected to treat "nothing reachable" as an honest skip rather
        // than a failure, exactly as the ticket's own Validation Step
        // (`AGILE_LIVE=1 bun run e2e`) needs to on a login-less host.
        if (err instanceof LiveVendorUnavailableError) {
          console.log(`live e2e: ${err.message}`);
          return;
        }
        throw err;
      }

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

describe('agile run --live stall watchdog (offline, deterministic — opus review round 3 blocker)', () => {
  test('a genuinely silent session (spawns, then never sends another event) trips the watchdog after the threshold', async () => {
    // Reproduces the failure mode the watchdog exists for — an unreachable
    // vendor that spawns fine, registers, and then never responds
    // (`fake-agent.ts`'s own `hang` step) — deterministically and fast, via
    // `liveSpawnForTest` (a test-only seam, `run.ts`'s own doc comment):
    // exercises the real `!fake` code path (the live tick loop,
    // `tickIntervalMs`/`stallTimeoutMs`), just with a controllable
    // transport standing in for a real vendor.
    //
    // `stallTimeoutMs` floors at 30s (`run.ts`'s own `Math.max`) —
    // `testNow`'s accelerated clock is what lets this test actually observe
    // that real 30s threshold firing without a real 30-second sleep.
    //
    // T035: `run.ts:927` bounds the loop with `clockNow() - start <
    // liveTimeoutMs`, and `run.ts:1068` fires the watchdog on `clockNow() -
    // lastLivenessAt >= stallTimeoutMs` — both read the *same* injected,
    // 600x-amplified `clockNow`, so real time burned inside a tick (a real
    // OS subprocess spawn + a real `git worktree add`, `assignReady`'s own
    // wall-clock cost) counts against *both* budgets at once. A finite
    // `liveTimeoutMs` therefore races real spawn latency against the
    // watchdog's own threshold — the flake this test used to have.
    // `liveTimeoutMs` is pinned past this test's own 10s bun-test timeout
    // at this 600x factor (10_000 * 600 = 6_000_000, rounded up) — the same
    // idiom the third test in this `describe` uses for `preflightTimeoutMs`
    // ("pinned huge ... specifically so the test can only pass if [the
    // intended mechanism] is what's actually stopping it"). With the loop
    // bound now unreachable inside any run this file's own timeout permits,
    // the only way this test can end is the watchdog throwing once 50ms of
    // real time (30_000 / 600) have passed since the (silent) agent
    // registered — which always happens, on any host, under any load — or
    // the bun-test timeout itself failing loudly if the watchdog ever
    // regresses.
    const hangSpawn = fakeAgentSpawn(repo, 'hang', [{ type: 'hang' }]);
    const testNow = acceleratedClock(600); // 30s of clock time in ~50ms real.

    await expect(
      runDemoSprint({
        cwd: repo,
        seed: writeSingleTicketSeed(repo),
        fake: false,
        liveSpawnForTest: hangSpawn,
        testNow,
        // Real (non-`testNow`) budget for the pre-flight `initialize`
        // handshake (`run.ts`'s `preflightLiveVendor`, a plain
        // `setTimeout`) — pinned generously above any observed real
        // subprocess-spawn+handshake cost (measured well under 1s even
        // under heavy load) so a slow host fails this test loudly via the
        // bun-test timeout rather than as a wrong-message
        // `LiveVendorUnavailableError` rejection.
        preflightTimeoutMs: 5_000,
        tickIntervalMs: 5,
        liveTimeoutMs: 60_000_000, // pinned past this test's own 10s bun-test timeout at 600x — see comment above; the loop bound can never end the run.
        stallTimeoutMs: 1, // clamped up to the real 30s floor by run.ts itself.
      }),
    ).rejects.toThrow(/no session liveness \(AgentRecord\.last_seen\) observed for 30000ms/);
  }, 10_000);

  test('a session blocked on a hil-routed permission is announced as it happens and named by the watchdog, not reported as "unreachable"', async () => {
    // The failure mode the first real `test:live` run on a laptop actually
    // hit: in live mode nothing auto-approves (`run.ts` passes no
    // `gateDelegate`), so a `hil`-routed `session/request_permission`
    // (`permissions/policy-tables.ts` — here a force-push) is left
    // unanswered by the responder and the vendor session blocks silently.
    // `last_seen` stops advancing, and five minutes later the watchdog
    // aborted with "no vendor session appears reachable" — true of the
    // symptom, wrong about the cause. This pins the two things that change
    // that: (1) the pending HIL is announced (`onNotice`) on the tick it
    // appears, with the `agile approve <id>` that unblocks it; (2) the
    // watchdog's error enumerates the pending HIL(s) and the registered
    // agents' last_seen ages instead of guessing.
    const blockedSpawn = fakeAgentSpawn(repo, 'hil-blocked', [
      {
        type: 'request_permission',
        toolCall: {
          toolCallId: 'push-1',
          kind: 'execute',
          title: 'Run git push --force origin main',
          rawInput: { command: 'git push --force origin main' },
        },
        options: [
          { optionId: 'allow', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      },
      { type: 'hang' },
    ]);
    // 20x, not the silent-session test's 600x: at 600x the 30s watchdog
    // floor is 50ms of real time, which fires before the fake agent (a real
    // `bun` subprocess) has even received its first prompt — fine for a test
    // that only needs *some* stall, useless for one that needs the
    // permission request to actually arrive first. At 20x the floor is 1.5s
    // real: comfortably past spawn + prompt + request_permission on any
    // host, still well inside this test's own timeout.
    const testNow = acceleratedClock(20);
    const notices: string[] = [];

    let thrown: unknown;
    try {
      await runDemoSprint({
        cwd: repo,
        seed: writeSingleTicketSeed(repo),
        fake: false,
        liveSpawnForTest: blockedSpawn,
        testNow,
        onNotice: (line) => notices.push(line),
        preflightTimeoutMs: 5_000,
        tickIntervalMs: 5,
        liveTimeoutMs: 60_000_000, // pinned past this test's own timeout at 20x, same idiom as the silent-session test: only the watchdog can end this run.
        stallTimeoutMs: 1, // clamped up to the real 30s floor by run.ts itself.
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/no session liveness \(AgentRecord\.last_seen\) observed for 30000ms/);
    expect(message).toMatch(
      /1 pending hil_request\(s\) — the blocked session\(s\) were waiting on a human/,
    );
    expect(message).toMatch(/force-push is never automatic/);
    expect(message).toMatch(/agile approve HIL-/);
    expect(message).toMatch(
      /Registered agents \(last_seen age\):\n {2}eng-9001: engineer TKT-9001/,
    );
    expect(message).toContain(join(repo, '.agile-daemon-cache', 'sessions'));

    const hilNotices = notices.filter((line) => line.includes('HIL needed:'));
    expect(hilNotices).toHaveLength(1); // announced once, not once per tick.
    expect(hilNotices[0]).toMatch(/permission:engineer TKT-9001/);
    expect(hilNotices[0]).toContain(
      '`git push --force origin main`: force-push is never automatic',
    );
    expect(hilNotices[0]).toContain(`(cd ${repo} && agile approve HIL-`);
  }, 30_000);

  test('a healthy long turn with steady events does not trip the watchdog, even while a ticket sits in_progress the whole time', async () => {
    // T021 round 4 (opus review round 3 blocker): round 3's watchdog keyed
    // on ticket-*status* stasis and aborted a real, healthy run mid-turn.
    // This proves the fix's other half, not just that the watchdog fires —
    // a session that keeps emitting events (`usage_update`, spaced by
    // `fake-agent.ts`'s `delay` step — T021 round 4's addition) for longer
    // than `stallTimeoutMs` must never trip it, because `AgentRecord.
    // last_seen` keeps advancing.
    //
    // `last_seen` writes are coalesced to at most once per
    // `HEARTBEAT_COALESCE_MS` (30s, `store.ts`) — a genuine, deliberate
    // "signal over volume" behavior, not a bug — so proving this
    // meaningfully (not just compressing every timeout below that window,
    // which would pass for the wrong reason) needs the *real* coalescing
    // logic to actually run. `testNow`'s accelerated clock (T021 round 5,
    // QA round 4 finding 1) is what lets this happen in well under a
    // second of real wall time instead of the ~36-39s round 4 shipped: the
    // pulses still land at real, short (millisecond) intervals — only the
    // clock both `Bus`'s heartbeat coalescing and this loop's own
    // watchdog read is sped up, so the real proportional relationship
    // between "how often an event lands" and "how wide the coalescing/
    // stall windows are" is preserved, just compressed in wall-clock terms.
    //
    // T035 round 3 (opus review round 2 blocker): a `stallTimeoutMs` set
    // *above* `liveTimeoutMs` (round 2's shipped fix) makes the watchdog
    // throw at `run.ts:1068` mathematically unreachable regardless of what
    // the heartbeat path does — proven by the reviewer's mutation probe: a
    // healthy spawn emitting zero liveness pulses passed 3/3 against that
    // config. A watchdog test whose watchdog cannot fire is vacuous, so the
    // fix keeps the ordering the real property needs —
    // `HEARTBEAT_COALESCE_MS(30s) << stallTimeoutMs < liveTimeoutMs` — and
    // buys determinism by (a) shrinking `factor` and (b) using
    // `writeSingleTicketSeed` here too, instead of disabling the check:
    //
    // (a) at the old 400x, one real ~150ms scheduling hiccup between pulses
    //     (round 2's own measurement, under load) becomes 60,000ms of
    //     virtual time — able to consume the *entire* old margin between
    //     the coalescing window and `stallTimeoutMs` on its own. At this
    //     file's `factor = 50`, the same hiccup is only 7,500ms of virtual
    //     time — an order of magnitude smaller than the margins below.
    // (b) the three-ticket epic's three concurrent real spawns/handshakes
    //     (the same real, unavoidable wall-clock cost the target test's
    //     round-2 comment describes) push the *first* pulse-driven
    //     heartbeat back by however long that handshake burst takes —
    //     measured up to ~54,000ms of virtual time here with three
    //     concurrent spawns, which left too little of `liveTimeoutMs`
    //     for a genuinely silent run to ever reach `stallTimeoutMs` before
    //     the loop's own bound ended it (a distinct, second way the old
    //     shape could go vacuous, caught by re-running the mutation probe
    //     below rather than assumed away). One real spawn measures
    //     ~10,000-13,000ms of virtual time instead — comfortably inside
    //     the margins chosen below.
    const factor = 50;
    const pulses = 100; // 100 * 15 * 50 = 75_000ms of virtual pulsing — 2.5x the coalescing window, so multiple real coalesced writes actually land.
    const pulseDelayMs = 15; // real ms between pulses -> `pulseDelayMs * factor` ms of clock time each.
    const testNow = acceleratedClock(factor);
    const steps: unknown[] = [];
    for (let i = 0; i < pulses; i++) {
      steps.push({ type: 'usage_update', used: 5 });
      steps.push({ type: 'delay', ms: pulseDelayMs });
    }
    // `hang` at the end, deliberately: no `end_turn`, so the session (and
    // the ticket's `in_progress` status) is still open/live for the whole
    // test — this test's job is only "steady events keep the watchdog
    // quiet while they're happening", not "it stays quiet forever with no
    // events" (the earlier test already covers "eventually goes silent").
    steps.push({ type: 'hang' });
    const healthySpawn = fakeAgentSpawn(repo, 'healthy', steps);
    const totalPulseVirtualMs = pulses * pulseDelayMs * factor; // 75_000
    const liveTimeoutMs = totalPulseVirtualMs + 15_000; // 90_000 — a deliberately small tail past the last pulse (see `stallTimeoutMs` below), not the loop's whole remaining budget.
    // `HEARTBEAT_COALESCE_MS(30_000) << stallTimeoutMs < liveTimeoutMs`.
    // Double the coalescing window (comfortably above the worst healthy-run
    // gap — one coalesced write cycle, ~30_750ms, or the single-spawn
    // handshake delay before the first pulse, ~10_000-13_000ms — both far
    // under 60_000) and clearly below `liveTimeoutMs` (90_000, a 30_000ms
    // margin) so a genuinely silent session — no pulses at all — trips this
    // well before `liveTimeoutMs` would end the loop on its own. Verified
    // both directions (T035 round 3, see `.pipeline-report.md`): the real
    // (healthy) script here never trips it, and a mutant with the pulse
    // steps replaced by bare delays (same seed, same timeouts, zero
    // liveness events) trips reliably.
    const stallTimeoutMs = 60_000;

    let sawInProgress = false;
    const { StateStore } = await import('@agile-agents/daemon');
    const pollDeadlineRealMs = Date.now() + 5_000; // real-time deadline — this test's own real budget, independent of the accelerated clock above.
    const pollForStatus = (async () => {
      while (Date.now() < pollDeadlineRealMs) {
        try {
          const store = StateStore.open(join(repo, '.agile'));
          if (store.getTicket('TKT-9001' as never).status === 'in_progress') sawInProgress = true;
        } catch {
          // Not seeded/assigned yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    })();

    // Not `.rejects`/`.toThrow` — the assertion here is that this
    // *resolves* at all (the watchdog never aborted it); a genuinely
    // unfinished demo epic resolving normally via `liveTimeoutMs` running
    // out is the expected, non-error outcome for this test.
    const result = await runDemoSprint({
      cwd: repo,
      seed: writeSingleTicketSeed(repo),
      fake: false,
      liveSpawnForTest: healthySpawn,
      testNow,
      preflightTimeoutMs: 5_000,
      tickIntervalMs: 5,
      liveTimeoutMs,
      stallTimeoutMs,
    });
    expect(result.ticketOutcomes.every((o) => o.status === 'in_progress')).toBe(true);
    await pollForStatus;
    expect(sawInProgress).toBe(true);
  }, 10_000);

  test('no vendor reachable at all skips fast via the pre-flight, instead of burning stallTimeoutMs/liveTimeoutMs', async () => {
    // T021 round 4 (opus review round 3 blocker, "on a host with no vendor
    // login ... skip fast"): a nonexistent binary reproduces "vendor
    // unreachable" cleanly (ENOENT from the real `child_process.spawn`,
    // surfaced by `acp-client`'s own `error` handling) without depending on
    // any real vendor's specific auth-failure shape. The pre-flight must
    // catch this before a single ceremony tick runs — `liveTimeoutMs`/
    // `stallTimeoutMs` are pinned huge here specifically so the test can
    // only pass if the pre-flight (bounded by `preflightTimeoutMs`) is
    // what's actually stopping it, not one of the other two timeouts.
    const before = Date.now();
    const unreachableSpawn = (opts: Parameters<typeof spawnSession>[0]) =>
      spawnSession({ ...opts, cmd: 'agile-agents-nonexistent-vendor-binary-xyz', args: [] });

    await expect(
      runDemoSprint({
        cwd: repo,
        seed: join(FIXTURE_ROOT, 'seed', 'epic.json'),
        fake: false,
        liveSpawnForTest: unreachableSpawn,
        preflightTimeoutMs: 3_000,
        stallTimeoutMs: 10 * 60_000,
        liveTimeoutMs: 10 * 60_000,
      }),
    ).rejects.toThrow(LiveVendorUnavailableError);
    expect(Date.now() - before).toBeLessThan(10_000); // fast skip, nowhere near either 10-minute timeout.
  }, 20_000);
});
