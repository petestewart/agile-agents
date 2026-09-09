/**
 * `agile run` (T021 — PLAN.md §6 "Definition of Done" Run section, ticket
 * T021 "Demo fixture and end-to-end sprint").
 *
 * Drives one sprint layer of an already-`agile init`'d repo unattended:
 * plan -> assign -> engineer -> review -> QA -> merge, plus the scripted
 * discovery/DEC/ripple/re-refine path when `--seed` names a fixture that
 * has one (`fixtures/demo-project/seed/epic.json`).
 *
 * There is no live vendor login in this container (session constraint), so
 * this command runs the whole daemon object graph *in-process* (no socket
 * hop — `startDaemon`'s `store`/`bus`/`runner`/`emLoop`/`gateService`/
 * `mergeOwner`/`reviewProtocol`/`qaProtocol` fields, added for this ticket)
 * rather than requiring a separately-running `agiled` for a caller to poll
 * over RPC:
 *
 *  - `--fake` (the default unless `--live`/`AGILE_LIVE=1`): every engineer/
 *    reviewer/qa ACP session is `runner/fake-driver.ts`'s subprocess (no
 *    vendor, no login), and this module itself plays every model's turn —
 *    the actual file edits an engineer would make, the verdict a reviewer
 *    would submit, the plan/run/submit a QA turn would call — through the
 *    same daemon-side functions a real session's MCP calls would hit
 *    (`board_post`'s equivalent via `store.appendStanza`, `bus.send`,
 *    `reviewSubmit`, `registerQaTools`, `registerArchitectTools`). This is
 *    the "offline, deterministic" e2e T021's session overrides ask for.
 *  - `--live` (requires a real vendor login and is not exercised by this
 *    container): every session runs the real ACP transport; this module
 *    only plans the sprint, seeds the fixture, and polls until the sprint
 *    completes or `--max-ticks` is exhausted — the daemon's own ceremony
 *    tick (`daemon.ts`) does the actual driving once a live EM/engineer/
 *    reviewer/qa loop is answering its own gates and bus messages. (An
 *    actual architect ACP session for a *live* discovery still needs the
 *    wiring gap named in `.pipeline-report.md`; `--fake` mode sidesteps it
 *    by calling the architect's own verbs directly, deterministically.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudePreToolUsePayload, DaemonHandle } from '@agile-agents/daemon';
import {
  HookService,
  advanceDoneTickets,
  advanceQaSpawns,
  advanceReviewRequests,
  agentIdFor,
  createFakeSpawn,
  discoverConfig,
  planSprint,
  reRefineStale,
  registerArchitectTools,
  registerQaTools,
  reviewSubmit,
  startDaemon,
} from '@agile-agents/daemon';
import type { OracleEntry, Ticket, TicketId } from '@agile-agents/shared';
import { ulid, validateTicket } from '@agile-agents/shared';

export interface RunOptions {
  cwd: string;
  /** Path to a seed JSON (`fixtures/demo-project/seed/epic.json`'s shape) — oracle entries + tickets loaded before planning, only if the repo has none yet. */
  seed?: string;
  /** Offline/no-vendor mode: fake ACP transport + this module plays every model turn. Default true unless `--live` or `AGILE_LIVE=1`. */
  fake?: boolean;
  /** Ceremony-tick budget before giving up (each iteration is synchronous, no real delay) — default 200. */
  maxTicks?: number;
  /** Where to write the run report. Defaults to `<cwd>/runs`. */
  reportDir?: string;
}

interface SeedFile {
  productMd?: string;
  oracle?: Array<{ entry: OracleEntry; body: string }>;
  tickets?: unknown[];
  discovery?: {
    reporterTicket: TicketId;
    tier: 'local' | 'scoped' | 'global';
    affectsOracle: string[];
    proposed: string;
    decision: { entry: OracleEntry; body: string };
  };
}

function loadSeed(path: string): SeedFile {
  return JSON.parse(readFileSync(path, 'utf8')) as SeedFile;
}

/** `oracle/product.md` is a plain bootstrap file (`init.ts`'s own stub, not a `StateStore` entity) — seeding it follows the same convention. */
function seedProductMd(stateRoot: string, markdown: string): void {
  writeFileSync(join(stateRoot, 'oracle', 'product.md'), markdown);
  Bun.spawnSync(['git', 'add', 'oracle/product.md'], { cwd: stateRoot });
  Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed: product.md'], {
    cwd: stateRoot,
  });
}

async function seedFixture(handle: DaemonHandle, seed: SeedFile): Promise<void> {
  const { store } = handle;
  if (!store) throw new Error('agile run: daemon has no store (run `agile init` first)');

  if (seed.productMd) seedProductMd(handle.config.stateRoot, seed.productMd);
  for (const { entry, body } of seed.oracle ?? []) {
    await store.putOracleEntry(entry, body);
  }
  for (const raw of seed.tickets ?? []) {
    const ticket = validateTicket({
      depends: [],
      history: [],
      oracle_refs: [],
      ...(raw as object),
    });
    await store.putTicket(ticket);
  }
  // "policy.yaml delegating every gate to em" (PLAN.md §6) — the demo's
  // whole point is running unattended; `gateDelegate` (below) is what
  // actually resolves an `em`-owned gate without a human/live EM.
  await store.putPolicy({
    gates: {
      approve_plan: 'em',
      approve_decision: 'em',
      sprint_review: 'em',
      unblock: 'em',
      demo: 'em',
    },
    breaker_signals: [],
  });
}

/** Every ticket id the seed named — the loop's completion condition. */
function seedTicketIds(seed: SeedFile): TicketId[] {
  return (seed.tickets ?? []).map((t) => (t as { id: TicketId }).id);
}

function allMerged(handle: DaemonHandle, ids: TicketId[]): boolean {
  if (!handle.store || !handle.mergeOwner) return false;
  return ids.every((id) => {
    const record = handle.mergeOwner?.status(id) as { status?: string } | undefined;
    return record?.status === 'merged';
  });
}

/**
 * Runs the scripted discovery/DEC/ripple/re-refine cycle for `seed.discovery`
 * (T021's "a scripted discovery exercising the halt/standup path") once its
 * `reporterTicket` has gone `in_progress` — synchronous by design: everyone
 * this touches (the architect verbs, the halt quorum) is a plain daemon-
 * side function, no ACP session in the loop, so there is nothing to poll
 * except the quorum check itself.
 */
interface ScriptedDiscoveryResult {
  resolved: boolean;
  /** Tickets the ripple staled — including the reporter itself, when its own `oracle_refs` also names the affected spec (the write guard's ripple has no "except the reporter" carve-out; only the halt's *scope* — quorum/standup — excludes it, per `triage.ts`'s header). */
  staled: TicketId[];
}

async function runScriptedDiscovery(
  handle: DaemonHandle,
  discovery: SeedFile['discovery'],
): Promise<ScriptedDiscoveryResult> {
  if (!discovery || !handle.store) return { resolved: false, staled: [] };
  const store = handle.store;
  const architect = registerArchitectTools({ store });
  const ctx = { agent: 'architect' as const };

  const triage = (await architect.callTool(ctx, 'discovery_triage', {
    reporterTicket: discovery.reporterTicket,
    discovery: {
      tier: discovery.tier,
      affects: discovery.affectsOracle,
      proposed: discovery.proposed,
    },
  })) as { tier: string; affected: TicketId[]; halt: { id: string; scope: unknown } | null };

  if (!triage.halt) return { resolved: true, staled: [] }; // tier resolved to `local` — nothing to publish.

  // Every agent the halt actually affects (live engineers on a scoped
  // ticket, `halts/index.ts`'s own computation) reports in immediately —
  // deterministic stand-in for "the engineer notices the halt at its next
  // tool call and calls standup_report" (§5), since there is no live
  // session here to notice anything on its own.
  const halt = store.getHalt(triage.halt.id as never);
  for (const agent of halt.affected ?? []) {
    await handle.bus?.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: agent,
      to: ['em'],
      kind: 'standup_report',
      priority: 'normal',
      body: 'checked in for the open halt; no local WIP to protect',
      refs: [halt.id],
      requires_ack: false,
    });
  }
  await handle.emLoop?.tick(); // folds the reports in, evaluates quorum.

  const published = (await architect.callTool(ctx, 'decision_publish', {
    entry: discovery.decision.entry,
    body: discovery.decision.body,
    haltId: triage.halt.id,
  })) as { released: boolean; oracle?: { stale: TicketId[] } };
  if (!published.released) return { resolved: false, staled: [] }; // quorum didn't reach in one tick — caller retries next loop pass.

  const staled = published.oracle?.stale ?? [];
  for (const staleId of staled) {
    await reRefineStale(store, staleId, { kind: 'unchanged' }, { by: 'architect' });
  }
  return { resolved: true, staled };
}

/**
 * The scripted engineer's one turn on `ticket`: writes a real, minimal
 * implementation of its contract into the worktree, commits, and either
 * raises the seeded discovery (first time only, `seed.discovery`'s
 * reporter) or signals done — `board_post` (`store.appendStanza`) +
 * `bus_send(review_request)` (`bus.send`), the same two calls
 * `tools/builtins.ts`'s real verbs would make for a live engineer.
 */
async function driveEngineerWork(
  handle: DaemonHandle,
  ticket: Ticket,
  seed: SeedFile,
): Promise<void> {
  const { store, bus } = handle;
  if (!store || !bus || !ticket.worktree) return;
  const worktreePath = join(handle.config.repoRoot, ticket.worktree);
  const agent = agentIdFor('engineer', ticket.id);

  applyEngineerChange(worktreePath, ticket.id);
  // `git add src` only — never `-A`: the worktree also carries the
  // daemon's own `.claude/settings.json` (`runner/session.ts`'s
  // `writeClaudeSettings`, rewritten with a different `agentId` whenever
  // the reviewer's session later starts on this same shared worktree,
  // §12). Sweeping it into the ticket's own history with `-A` is what a
  // real engineer's commit never does either, and left it as a tracked,
  // uncommitted diff by the time `MergeOwner.onTicketDone` tried to rebase
  // — a real failure mode this driver hit and fixed here, not a defect in
  // `merge/owner.ts` (see `.pipeline-report.md`).
  Bun.spawnSync(['git', 'add', 'src'], { cwd: worktreePath });
  Bun.spawnSync(
    ['git', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `${ticket.id}: implement`],
    { cwd: worktreePath },
  );

  if (seed.discovery && seed.discovery.reporterTicket === ticket.id) {
    await store.appendStanza({
      ts: new Date().toISOString(),
      ticket: ticket.id,
      agent,
      kind: 'discovery',
      summary: 'SPEC-0002 clauses 1 and 2 contradict each other',
      discovery: {
        tier: seed.discovery.tier,
        affects: seed.discovery.affectsOracle as never,
        proposed: seed.discovery.proposed,
      },
    });
    await bus.send({
      id: ulid(),
      ts: new Date().toISOString(),
      from: agent,
      to: ['em'],
      kind: 'discovery',
      priority: 'normal',
      ticket: ticket.id,
      body: `${ticket.id}: SPEC-0002 clauses 1 and 2 contradict each other`,
      refs: [],
      requires_ack: false,
    });
  }

  await store.appendStanza({
    ts: new Date().toISOString(),
    ticket: ticket.id,
    agent,
    kind: 'review_submitted',
    summary: 'implementation complete, ready for review',
  });
  await bus.send({
    id: ulid(),
    ts: new Date().toISOString(),
    from: agent,
    to: [agentIdFor('reviewer', ticket.id)],
    kind: 'review_request',
    priority: 'normal',
    ticket: ticket.id,
    body: `${ticket.id}: ready for review`,
    refs: [],
    requires_ack: false,
  });
}

/** The demo epic's three tickets, hand-written per ticket id (small and fixed — a generic "apply this contract" engine is out of this driver's scope). */
function applyEngineerChange(worktreePath: string, ticketId: TicketId): void {
  const tasksPath = join(worktreePath, 'src', 'tasks.ts');
  const current = readFileSync(tasksPath, 'utf8');

  if (ticketId === 'TKT-1001') {
    writeFileSync(
      tasksPath,
      current.replace(
        '  getTask(id: string): Task | undefined {\n    return this.tasks.get(id);\n  }\n}',
        [
          '  getTask(id: string): Task | undefined {',
          '    return this.tasks.get(id);',
          '  }',
          '',
          '  /** Marks a task done and returns it. Throws a descriptive Error for an unknown id (SPEC-0001 clause 1). */',
          '  completeTask(id: string): Task {',
          '    const task = this.tasks.get(id);',
          '    if (!task) throw new Error(`completeTask: no task with id "${id}"`);',
          '    task.done = true;',
          '    return task;',
          '  }',
          '}',
        ].join('\n'),
      ),
    );
  } else if (ticketId === 'TKT-1002') {
    // DEC-0001: ascending by dueDate wins (SPEC-tasks-002 clause 1; clause 2 retired).
    writeFileSync(
      tasksPath,
      current.replace(
        '  listTasks(): Task[] {\n    return [...this.tasks.values()];\n  }',
        [
          '  /** Ascending by dueDate — DEC-0001 (SPEC-tasks-002 clause 1 wins; clause 2 retired). */',
          '  listTasks(): Task[] {',
          '    return [...this.tasks.values()].sort((a, b) => a.dueDate.localeCompare(b.dueDate));',
          '  }',
        ].join('\n'),
      ),
    );
  } else if (ticketId === 'TKT-1003') {
    // A separate file, not a `tasks.ts` edit — TKT-1001 and TKT-1002 both
    // land in `tasks.ts` too, and this offline driver doesn't script
    // conflict resolution for `MergeOwner.onTicketDone`'s rebase (a real
    // engineer would rebase and fix it up; see `.pipeline-report.md`).
    // Consumes `listTasks()` however DEC-0001 leaves it (built on top of
    // TKT-1002's change once the ripple re-refines this ticket).
    writeFileSync(
      join(worktreePath, 'src', 'overdue.ts'),
      [
        "import type { TaskStore } from './tasks';",
        '',
        "/** Every task due before `now` (ISO date/time), in listTasks()'s order (DEC-0001). */",
        'export function overdueTasks(store: TaskStore, now: string) {',
        '  return store.listTasks().filter((t) => t.dueDate < now);',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(worktreePath, 'src', 'overdue.test.ts'),
      [
        "import { describe, expect, test } from 'bun:test';",
        "import { TaskStore } from './tasks';",
        "import { overdueTasks } from './overdue';",
        '',
        "describe('overdueTasks', () => {",
        "  test('returns only tasks due before now', () => {",
        '    const store = new TaskStore();',
        "    store.createTask('old', '2026-01-01');",
        "    store.createTask('future', '2099-01-01');",
        "    expect(overdueTasks(store, '2026-06-01').map((t) => t.title)).toEqual(['old']);",
        '  });',
        '});',
        '',
      ].join('\n'),
    );
  }
}

/** The scripted reviewer's one turn: a plain `approve` (T021's offline driver doesn't script a request_changes round — see `.pipeline-report.md`). */
async function driveReviewerWork(handle: DaemonHandle, ticket: Ticket): Promise<void> {
  if (!handle.reviewProtocol || !handle.store) return;
  const deps = {
    protocol: handle.reviewProtocol,
    store: handle.store,
    stateRoot: handle.config.stateRoot,
  };
  await reviewSubmit(
    deps,
    { agent: agentIdFor('reviewer', ticket.id), ticket: ticket.id },
    { round: 1, pass: 'primary', verdict: 'approve', findings: [] },
  );
}

/** The scripted QA turn: map every criterion to `bun test` (the fixture's own real suite, run for real in the fresh QA clone) and submit. */
async function driveQaWork(handle: DaemonHandle, ticket: Ticket): Promise<void> {
  if (!handle.qaProtocol) return;
  const tools = registerQaTools(handle.qaProtocol);
  const ctx = { agent: agentIdFor('qa', ticket.id), ticket: ticket.id };
  const plan: Record<string, string> = {};
  ticket.contract.acceptance.forEach((_c, i) => {
    plan[String(i)] = 'bun test';
  });
  const planTool = tools.find((t) => t.name === 'qa_plan');
  const runTool = tools.find((t) => t.name === 'qa_run');
  const submitTool = tools.find((t) => t.name === 'qa_submit');
  if (!planTool || !runTool || !submitTool) return;
  await planTool.handler(ctx, { plan });
  await runTool.handler(ctx, {});
  await submitTool.handler(ctx, {});
}

/** Exercises the pre-tool-use hook's big-read deny against the fixture's seeded oversized file (T021: "the engineer's attempt to read the fixture's oversized file is denied by the hook with a reason") — once, against whichever engineer worktree exists first. */
async function checkOversizedReadDenied(
  handle: DaemonHandle,
  worktreePath: string,
): Promise<string> {
  if (!handle.store || !handle.bus || !handle.gateService) return 'skipped: daemon not ready';
  const hooks = new HookService(handle.store, handle.bus, {
    repoRoot: handle.config.repoRoot,
    gates: handle.gateService,
  });
  const payload: ClaudePreToolUsePayload = {
    hook_event_name: 'PreToolUse',
    cwd: worktreePath,
    tool_name: 'Read',
    tool_input: { file_path: join(worktreePath, 'src', 'legacy', 'dump.ts') },
  };
  const result = await hooks.preToolUse(payload);
  const { permissionDecision, permissionDecisionReason } = result.hookSpecificOutput;
  return `${permissionDecision}: ${permissionDecisionReason ?? '(no reason)'}`;
}

export interface RunResult {
  reportPath: string;
  ticketOutcomes: Array<{ ticket: TicketId; status: string; merged: boolean }>;
  oversizedReadDecision: string;
  ticksUsed: number;
}

export async function runDemoSprint(opts: RunOptions): Promise<RunResult> {
  const config = discoverConfig({ cwd: opts.cwd });
  if (!existsSync(config.stateRoot)) {
    throw new Error('agile run: no .agile/ state found — run `agile init` first');
  }
  const fake = opts.fake ?? process.env.AGILE_LIVE !== '1';
  const maxTicks = opts.maxTicks ?? 200;

  const handle = await startDaemon({
    cwd: opts.cwd,
    port: 0,
    runnerSpawn: fake ? createFakeSpawn() : undefined,
    gateDelegate: fake
      ? () => ({ decision: 'approve', by: 'em', rationale: 'automated (agile run --fake)' })
      : undefined,
  });

  try {
    if (
      !handle.store ||
      !handle.bus ||
      !handle.emLoop ||
      !handle.gateService ||
      !handle.runner ||
      !handle.mergeOwner ||
      !handle.reviewProtocol
    ) {
      throw new Error('agile run: daemon did not construct its object graph (no .agile/ state?)');
    }
    const { store, bus, emLoop, gateService, runner, mergeOwner, reviewProtocol } = handle;

    let seed: SeedFile = {};
    if (opts.seed) {
      seed = loadSeed(opts.seed);
      if (store.listTickets().length === 0) await seedFixture(handle, seed);
    }
    const trackedIds = seedTicketIds(seed);

    if (store.listSprints().length === 0) {
      await planSprint(store, { goal: 'Demo epic layer 1' });
    }

    const seenReview = new Set<string>();
    const qaSpawned = new Set<TicketId>();
    const mergedDone = new Set<TicketId>();
    const engineerHandled = new Set<TicketId>();
    const reviewerHandled = new Set<TicketId>();
    const qaHandled = new Set<TicketId>();
    let discoveryRaised = false;
    let discoveryResolved = !seed.discovery;
    let oversizedReadDecision = 'not checked (no --seed)';

    let tick = 0;
    for (; tick < maxTicks; tick++) {
      await gateService.tick();
      await emLoop.tick();
      await advanceReviewRequests(store, bus, reviewProtocol, seenReview);
      await advanceQaSpawns(store, runner, qaSpawned);
      await advanceDoneTickets(store, mergeOwner, mergedDone);

      if (fake) {
        for (const ticket of store.listTickets()) {
          if (
            ticket.status === 'in_progress' &&
            !engineerHandled.has(ticket.id) &&
            ticket.worktree
          ) {
            engineerHandled.add(ticket.id);
            if (oversizedReadDecision.startsWith('not checked')) {
              oversizedReadDecision = await checkOversizedReadDenied(
                handle,
                join(handle.config.repoRoot, ticket.worktree),
              );
            }
            await driveEngineerWork(handle, ticket, seed);
            if (seed.discovery?.reporterTicket === ticket.id) discoveryRaised = true;
          }
          if (
            ticket.status === 'in_review' &&
            !reviewerHandled.has(ticket.id) &&
            store.getAgent(agentIdFor('reviewer', ticket.id))
          ) {
            reviewerHandled.add(ticket.id);
            await driveReviewerWork(handle, ticket);
          }
          if (
            ticket.status === 'in_qa' &&
            !qaHandled.has(ticket.id) &&
            store.getAgent(agentIdFor('qa', ticket.id))
          ) {
            qaHandled.add(ticket.id);
            await driveQaWork(handle, ticket);
          }
        }

        if (discoveryRaised && !discoveryResolved) {
          const result = await runScriptedDiscovery(handle, seed.discovery);
          discoveryResolved = result.resolved;
          // A staled ticket's engineer agent is already live (spawned before
          // the ripple hit) — `assignReady`'s "already running" swallow
          // (assign.ts's own doc comment) means it will never re-spawn one,
          // by design: the same session is expected to keep working once
          // resumed. This offline driver has no live model polling its own
          // inbox to notice that on its own, so it resumes the ticket and
          // re-drives that same scripted turn directly.
          for (const staledId of result.staled) {
            const staled = store.getTicket(staledId);
            if (staled.status !== 'ready' || !store.getAgent(agentIdFor('engineer', staledId))) {
              continue; // never had a live engineer — assignReady will spawn one normally.
            }
            let resumed = await store.transitionTicket(staledId, 'assigned', {
              by: 'architect',
            });
            resumed = await store.transitionTicket(staledId, 'in_progress', {
              by: resumed.assignee ?? agentIdFor('engineer', staledId),
            });
            if (!engineerHandled.has(staledId)) {
              engineerHandled.add(staledId);
              await driveEngineerWork(handle, resumed, seed);
            }
          }
        }
      }

      const sprintReviewed = store.listSprints().some((s) => s.review_at !== undefined);
      if (
        trackedIds.length > 0 &&
        allMerged(handle, trackedIds) &&
        discoveryResolved &&
        sprintReviewed
      ) {
        break;
      }
    }

    const reportDir = opts.reportDir ?? join(opts.cwd, 'runs');
    mkdirSync(reportDir, { recursive: true });
    const ticketOutcomes = trackedIds.map((id) => {
      const ticket = store.getTicket(id);
      return {
        ticket: id,
        status: ticket.status,
        merged: (mergeOwner.status(id) as { status?: string } | undefined)?.status === 'merged',
      };
    });
    const reportPath = join(reportDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    writeFileSync(reportPath, renderReport(handle, ticketOutcomes, oversizedReadDecision, tick));

    // `handle.stop()` (below, `daemon.ts`) stops every still-live session
    // but deliberately doesn't wait on each one's own async exit/crash
    // cleanup ("never blocks shutdown on a slow-to-die agent" — its own
    // doc comment) — a background `finish()` (`runner/session.ts`: an
    // escalate message + `store.flush()`) can still be in flight after
    // `stop()` resolves. Every ticket this driver ran finished (`done`,
    // never explicitly stopped mid-flight — see the file header), so
    // draining each one's `exited` here first is safe and gives the
    // report's own writes, plus the daemon's shutdown flush, a fully
    // quiesced store to land in: a caller that removes `cwd` right after
    // `runDemoSprint` resolves (this driver's own e2e test does) would
    // otherwise race that background write into a "not a git repository"
    // failure once `cwd` is gone.
    for (const session of runner.list()) {
      session.stop();
      await session.exited;
    }

    return { reportPath, ticketOutcomes, oversizedReadDecision, ticksUsed: tick };
  } finally {
    await handle.stop();
  }
}

function renderReport(
  handle: DaemonHandle,
  outcomes: RunResult['ticketOutcomes'],
  oversizedReadDecision: string,
  ticksUsed: number,
): string {
  const sprints = handle.store?.listSprints() ?? [];
  const spendByRole = new Map<string, { in: number; out: number; cost: number }>();
  for (const sprint of sprints) {
    for (const line of handle.store?.listLedger(sprint.id) ?? []) {
      const cur = spendByRole.get(line.kind) ?? { in: 0, out: 0, cost: 0 };
      cur.in += line.in_tokens;
      cur.out += line.out_tokens;
      cur.cost += line.cost_usd;
      spendByRole.set(line.kind, cur);
    }
  }
  const spendLines =
    spendByRole.size === 0
      ? ['(no ledger lines — fake-agent sessions default to a single `usage_update`; see notes)']
      : [...spendByRole.entries()].map(
          ([role, s]) => `- ${role}: ${s.in} in / ${s.out} out tokens, $${s.cost.toFixed(4)}`,
        );

  const ticketLines = outcomes.map(
    (o) => `- ${o.ticket}: status=${o.status}, merged=${o.merged ? 'yes' : 'no'}`,
  );

  return [
    `# agile run report — ${new Date().toISOString()}`,
    '',
    `Ceremony ticks used: ${ticksUsed}`,
    '',
    '## Per-ticket outcome',
    ...ticketLines,
    '',
    '## Token spend per role (ledger)',
    ...spendLines,
    '',
    '## Oversized-file hook check',
    `- ${oversizedReadDecision}`,
    '',
  ].join('\n');
}
