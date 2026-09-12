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
 *    reviewer/qa/architect loop is answering its own gates and bus
 *    messages.
 *
 * T031: `runScriptedDiscovery` below now spawns a real architect session
 * (`Runner.spawn('architect', ...)`, `pipeline-glue.ts`'s
 * `ensureArchitectSpawned` — singleton, reused for every discovery this run
 * raises) over the same fake ACP transport every other role's `--fake`
 * session runs on, instead of calling `registerArchitectTools` with no
 * agent involved at all. The scripted driver still invokes the architect's
 * verbs (`discovery_triage`/`decision_publish`) directly against that
 * registry — exactly the same "spawn a real session, then drive its verbs
 * by direct daemon-side call rather than scripting the ACP transport
 * itself" shape `driveQaWork` already uses for QA (`fake-driver.ts`'s own
 * header: "the demo driver does its actual work through direct daemon-side
 * calls ..., not by scripting this transport").
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AcpProviderConfig,
  type SpawnSessionOptions,
  type SpawnedSession,
  resolveAcpProvider,
  spawnSession,
} from '@agile-agents/acp-client';
import type {
  AgentSessionOptions,
  ClaudePreToolUsePayload,
  DaemonHandle,
  DelegateFn,
  GateService,
  StateStore,
} from '@agile-agents/daemon';
import {
  DEFAULT_LIVENESS_TIMEOUT_MS,
  HookService,
  NotFoundError,
  PRODUCT_MD_STUB,
  advanceDoneTickets,
  advanceQaSpawns,
  advanceReviewRequests,
  agentIdFor,
  createEmSessionDelegate,
  createFakeSpawn,
  discoverConfig,
  ensureArchitectSpawned,
  planSprint,
  reRefineStale,
  registerArchitectTools,
  registerQaTools,
  reviewRecordRelPath,
  reviewSubmit,
  sandboxedSubprocessEnv,
  startDaemon,
  validateReviewRecord,
} from '@agile-agents/daemon';
import type { HilRequest, OracleEntry, Ticket, TicketId } from '@agile-agents/shared';
import { ulid, validateTicket } from '@agile-agents/shared';

export interface RunOptions {
  cwd: string;
  /** Path to a seed JSON (`fixtures/demo-project/seed/epic.json`'s shape) — oracle entries + tickets loaded before planning, only if the repo has none yet. */
  seed?: string;
  /** Offline/no-vendor mode: fake ACP transport + this module plays every model turn. Default true unless `--live` or `AGILE_LIVE=1`. */
  fake?: boolean;
  /** Ceremony-tick budget before giving up in `--fake` mode (each iteration is synchronous, no real delay) — default 200. Live mode instead bounds itself by `liveTimeoutMs`, wall-clock. */
  maxTicks?: number;
  /** Wait between ticks — real ACP sessions need this to make progress; fake ones don't. Defaults to 0 (`--fake`) or 30s (`--live`, the heartbeat tunable). */
  tickIntervalMs?: number;
  /** Wall-clock budget for `--live` mode before giving up (fake mode uses `maxTicks` instead, since it never actually waits). Defaults to 10 minutes (the quorum-timeout tunable). */
  liveTimeoutMs?: number;
  /**
   * `--live` mode only: abort with a diagnosis if no tracked session has
   * shown any liveness signal (a fresh `AgentRecord.last_seen` — the exact
   * field `Bus.checkLiveness`'s own liveness sweep keys on, §5) for this
   * many ms, instead of waiting out the rest of `liveTimeoutMs`. Round 3
   * keyed this on ticket-*status* stasis instead and a 2-minute default —
   * opus review round 3 reproduced it aborting a *healthy* run mid-turn
   * (45 real `tool_call` events already logged) because a real engineer
   * turn can sit `in_progress` far longer than 2 minutes while genuinely
   * working. Defaults to `DEFAULT_LIVENESS_TIMEOUT_MS` (5 min, this repo's
   * own liveness tunable) — never lower in real usage; only test code
   * should inject something shorter. Ignored in `--fake` mode.
   */
  stallTimeoutMs?: number;
  /**
   * `--live` mode only: bounds the one-off pre-flight handshake probe
   * (`preflightLiveVendor`) run before any ceremony ticks — if the ACP
   * `initialize` round trip with the routed provider doesn't complete
   * within this many ms, `runDemoSprint` rejects immediately with
   * `LiveVendorUnavailableError` instead of proceeding into a run that was
   * never going to see a live session (opus review round 3: "on a host
   * with no vendor login, `AGILE_LIVE=1` must detect that up front ...
   * and skip fast"). Defaults to 20s. Ignored in `--fake` mode.
   */
  preflightTimeoutMs?: number;
  /**
   * Test-only seam: overrides the ACP transport `--live` mode spawns
   * every session on (including the pre-flight probe), exactly like
   * `--fake`'s `createFakeSpawn()` does for fake mode — lets the live-mode
   * wait/pre-flight/stall-watchdog logic itself
   * (`tickIntervalMs`/`liveTimeoutMs`/`preflightTimeoutMs`/`stallTimeoutMs`
   * above) be exercised deterministically in `bun test`/CI without a real
   * vendor login. Real `agile run --live` usage never sets this. Ignored
   * when `fake` is true.
   */
  liveSpawnForTest?: AgentSessionOptions['spawn'];
  /**
   * Test-only seam: overrides `startDaemon`'s own clock (`Bus`'s heartbeat
   * timestamps/coalescing, `Runner`'s per-session `now`) and this
   * function's own `--live`-mode loop-bound/stall-watchdog clock, so both
   * sides read the same time. Lets a test clear the store's real 30s
   * heartbeat-coalescing window and a real multi-minute `stallTimeoutMs`
   * in well under a second of actual wall-clock time (e.g. an accelerated
   * clock — `now => new Date(anchor + (Date.now() - anchor) * factor)` —
   * keeps real relative ordering/proportional gaps, unlike a manually
   * stepped counter). Real `agile run --live` usage never sets this.
   */
  testNow?: () => Date;
  /** Where to write the run report. Defaults to `<cwd>/runs`. */
  reportDir?: string;
  /** HTTP port for the in-process daemon's feed + control room. Defaults to 0 (OS-assigned); `agile run --port 4600` pins it so the URL is predictable. */
  port?: number;
  /**
   * Where `--live` progress notices go (a newly raised `hil_request` that a
   * human must answer before the blocked session can continue, with the
   * `agile approve <id>` to run). Defaults to `console.error`. Tests inject
   * a collector.
   */
  onNotice?: (line: string) => void;
  /**
   * `--live` only: who decides `em`/`architect`-owned gates. `agile run
   * --live` passes `createEmSessionDelegate` (a one-shot EM vendor session
   * per decision); tests leave it unset so a `hil`-routed request stays
   * pending, which the stall watchdog then reports.
   */
  gateDelegate?: DelegateFn;
}

/**
 * Thrown by `runDemoSprint`'s `--live` pre-flight when no vendor session
 * could be reached at all — distinct from every other failure this
 * function can throw so a caller (the live e2e test) can tell "there is
 * nothing to run against" apart from a genuine bug and treat it as a fast,
 * clearly-labeled skip instead of a failure (opus review round 3: on a
 * login-less host, `AGILE_LIVE=1 bun run e2e` — the ticket's own
 * Validation Step — must skip fast with a reason, not fail after burning
 * the stall-watchdog's timeout).
 */
export class LiveVendorUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `agile run --live: no vendor session reachable (${reason}) — skipping instead of running a sprint with nothing to answer it. Set up the vendor login (or point --live at a working one) before retrying.`,
    );
    this.name = 'LiveVendorUnavailableError';
  }
}

/**
 * `--live` pre-flight (opus review round 3 blocker): before any ceremony
 * ticks run, spawn one throwaway probe session against the same provider a
 * real engineer spawn would use (`resolveAcpProvider`'s own default —
 * unrouted tickets resolve to Claude, `runner.ts`'s own doc comment) and
 * wait for just the ACP `initialize` handshake, bounded by `timeoutMs`.
 * This answers "is there anyone to talk to at all" cheaply — a host with
 * no vendor login (or an unreachable bridge, e.g. `npx` unable to fetch
 * the ACP adapter package) fails or hangs right here, turning what would
 * otherwise be the stall watchdog's full liveness-tunable-sized wait (>= 5
 * min) into a single bounded probe. Never reused for real work — closed
 * immediately either way, regardless of outcome.
 */
async function preflightLiveVendor(
  spawnOverride: AgentSessionOptions['spawn'] | undefined,
  timeoutMs: number,
): Promise<{ reachable: true } | { reachable: false; reason: string }> {
  const provider: AcpProviderConfig = resolveAcpProvider(undefined);
  const spawnFn: (opts: SpawnSessionOptions) => SpawnedSession =
    spawnOverride ?? ((opts) => spawnSession(opts));
  let probe: SpawnedSession | undefined;
  try {
    probe = spawnFn({
      cmd: provider.command,
      args: [...provider.args],
      cwd: tmpdir(),
      envOverrides: provider.envOverrides,
      clientCapabilities: provider.clientCapabilities,
    });
    await Promise.race([
      probe.initialized,
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`initialize handshake timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
    return { reachable: true };
  } catch (err) {
    return { reachable: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    probe?.close();
  }
}

interface SeedFile {
  /** The sprint goal the first planned sprint gets. Falls back to the product brief's first heading — see `resolveSprintGoal` (T046 defect 2). */
  sprintGoal?: string;
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
  /** `.agile/rules/<id>.md` files to seed (T016 loader format, `review/rules.ts`'s "`# RULE-id: title`" markdown shape) — the fixture's "one seeded rule violation opportunity" (T021 scope) needs a rule for a reviewer to actually cite. */
  rules?: Array<{ id: string; markdown: string }>;
  /**
   * The one ticket whose first engineer pass deliberately trips a rule
   * (QA round 1 gap, opus review round 1 blocker 1): `pattern` is the
   * literal source text `driveReviewerWork` greps the ticket's worktree for
   * to build the round-1 finding's line number — it must appear verbatim in
   * whatever `applyEngineerChange`'s first pass writes for `ticket`, and
   * disappear on the second pass (the engineer's fix), or the scripted
   * reviewer has nothing to cite / nothing to confirm fixed.
   */
  violation?: {
    ticket: TicketId;
    ruleId: string;
    pattern: string;
    message: string;
    severity: 'blocker' | 'major' | 'minor' | 'nit';
  };
}

function loadSeed(path: string): SeedFile {
  return JSON.parse(readFileSync(path, 'utf8')) as SeedFile;
}

/** First `# `/`## ` heading of a markdown document, without its hashes. */
function firstHeading(markdown: string): string | undefined {
  for (const line of markdown.split('\n')) {
    const match = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * The goal the *first* sprint of a run is planned with (T046 defect 2 — this
 * used to be the literal string `Demo epic layer 1`, so every run of every
 * repo announced the demo fixture's goal). Precedence, most specific first:
 *
 *   1. the seed's own `sprintGoal`;
 *   2. the product brief's first heading (`oracle/product.md`, or the seed's
 *      `productMd` before it has been written) — but never the untouched
 *      `agile init` stub, whose heading is the placeholder `# Product`;
 *   3. nothing — `planSprint` then names it after the sprint id (`Sprint S-1`).
 *
 * Later sprints are planned by the EM (`em/review.ts`), not here.
 */
export function resolveSprintGoal(seed: SeedFile, stateRoot: string): string | undefined {
  const seeded = seed.sprintGoal?.trim();
  if (seeded) return seeded;
  let brief = seed.productMd;
  if (brief === undefined) {
    const path = join(stateRoot, 'oracle', 'product.md');
    brief = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  }
  if (brief === undefined || brief.trim() === PRODUCT_MD_STUB.trim()) return undefined;
  return firstHeading(brief);
}

/** `oracle/product.md` is a plain bootstrap file (`init.ts`'s own stub, not a `StateStore` entity) — seeding it follows the same convention. */
function seedProductMd(stateRoot: string, repoRoot: string, markdown: string): void {
  const env = sandboxedSubprocessEnv(repoRoot, 'git');
  writeFileSync(join(stateRoot, 'oracle', 'product.md'), markdown);
  Bun.spawnSync(['git', 'add', 'oracle/product.md'], { cwd: stateRoot, env });
  Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed: product.md'], {
    cwd: stateRoot,
    env,
  });
}

/**
 * `.agile/rules/<id>.md` — also a plain file `review/rules.ts`'s `loadRules`
 * reads directly off disk (not a `StateStore` entity), same convention as
 * `seedProductMd` above. Without at least one seeded rule, `rulesList`
 * has nothing for a reviewer to cite and T021's "one seeded rule-violation
 * opportunity" (PLAN.md scope) can't be exercised at all (QA round 1 /
 * opus review round 1 blocker 1).
 */
function seedRules(stateRoot: string, repoRoot: string, rules: SeedFile['rules']): void {
  if (!rules || rules.length === 0) return;
  const env = sandboxedSubprocessEnv(repoRoot, 'git');
  mkdirSync(join(stateRoot, 'rules'), { recursive: true });
  for (const rule of rules) {
    writeFileSync(join(stateRoot, 'rules', `${rule.id}.md`), rule.markdown);
  }
  Bun.spawnSync(['git', 'add', 'rules'], { cwd: stateRoot, env });
  Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed: rules'], {
    cwd: stateRoot,
    env,
  });
}

async function seedFixture(handle: DaemonHandle, seed: SeedFile): Promise<void> {
  const { store } = handle;
  if (!store) throw new Error('agile run: daemon has no store (run `agile init` first)');

  if (seed.productMd) {
    seedProductMd(handle.config.stateRoot, handle.config.repoRoot, seed.productMd);
  }
  seedRules(handle.config.stateRoot, handle.config.repoRoot, seed.rules);
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
 * Counts `ticket`'s stored primary review rounds directly off
 * `board/reviews/<ticket>-r<n>.yaml` — the same durable records
 * `ReviewProtocol.nextPrimaryRound` walks — rather than the driver's own
 * `reviewRoundsByTicket` bookkeeping (opus review round 2 nit: that map is
 * only ever populated inside the `if (fake)` scripted branch, so a
 * *live* run's report claimed "0 rounds" for every ticket even though the
 * real review records existed). Correct in both modes since it reads what
 * actually happened, not what this driver scripted.
 */
function listReviewVerdicts(store: NonNullable<DaemonHandle['store']>, ticket: TicketId): string[] {
  const verdicts: string[] = [];
  for (let round = 1; ; round++) {
    try {
      const record = store.getEntity(
        reviewRecordRelPath(ticket, round, 'primary'),
        validateReviewRecord,
      );
      verdicts.push(record.verdict);
    } catch (err) {
      if (err instanceof NotFoundError) return verdicts;
      throw err;
    }
  }
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

  // T031: a real spawned session first (see this file's own header) — the
  // architect's verbs are still invoked directly below, same as every
  // other role's scripted turn in this driver.
  if (handle.runner) {
    await ensureArchitectSpawned(handle.runner, discovery.reporterTicket);
  }

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
  attempt: number,
): Promise<void> {
  const { store, bus } = handle;
  if (!store || !bus || !ticket.worktree) return;
  const worktreePath = join(handle.config.repoRoot, ticket.worktree);
  const agent = agentIdFor('engineer', ticket.id);

  applyEngineerChange(worktreePath, ticket.id, attempt);
  // `git add src` only — never `-A`: the worktree also carries the
  // daemon's own `.claude/settings.json` (`runner/session.ts`'s
  // `writeClaudeSettings`, rewritten with a different `agentId` whenever
  // the reviewer's session later starts on this same shared worktree,
  // §12). Sweeping it into the ticket's own history with `-A` is what a
  // real engineer's commit never does either, and left it as a tracked,
  // uncommitted diff by the time `MergeOwner.onTicketDone` tried to rebase
  // — a real failure mode this driver hit and fixed here, not a defect in
  // `merge/owner.ts` (see `.pipeline-report.md`).
  const gitEnv = sandboxedSubprocessEnv(handle.config.repoRoot, 'git');
  Bun.spawnSync(['git', 'add', 'src'], { cwd: worktreePath, env: gitEnv });
  Bun.spawnSync(
    ['git', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `${ticket.id}: implement`],
    { cwd: worktreePath, env: gitEnv },
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

/** The demo epic's three tickets, hand-written per ticket id (small and fixed — a generic "apply this contract" engine is out of this driver's scope). `attempt` (1-based) distinguishes a ticket's first engineer pass from its post-`request_changes` fix pass — only `TKT-1001` (the seeded rule-violation ticket, T021 scope) reads it; every other ticket's change is attempt-independent. Each ticket's own proof test lives in its own new file (TKT-1001: `complete-task.test.ts`, TKT-1002: `list-tasks-order.test.ts`, TKT-1003: `overdue.test.ts`, already the existing pattern) rather than appended to the shared `tasks.test.ts` — two tickets both editing that file's tail is exactly the kind of same-line collision `MergeOwner.onTicketDone`'s rebase has no scripted conflict-resolution turn for (this driver hit that for real while wiring this in — see `.pipeline-report.md`). */
function applyEngineerChange(worktreePath: string, ticketId: TicketId, attempt: number): void {
  const tasksPath = join(worktreePath, 'src', 'tasks.ts');
  const current = readFileSync(tasksPath, 'utf8');

  if (ticketId === 'TKT-1001') {
    if (attempt === 1) {
      // First pass: implements the criterion correctly, but leaves a debug
      // `console.log` in place — the seeded RULE-001 violation ("no debug
      // console.log/console.debug calls ship in src/") a reviewer is
      // expected to catch and cite, not silently wave through.
      writeFileSync(
        tasksPath,
        current.replace(
          '  getTask(id: string): Task | undefined {\n    return this.tasks.get(id);\n  }\n}',
          [
            '  getTask(id: string): Task | undefined {',
            '    return this.tasks.get(id);',
            '  }',
            '',
            '  /** Marks a task done and returns it. Throws a descriptive Error for an unknown id (SPEC-quality-001 clause 1). */',
            '  completeTask(id: string): Task {',
            '    const task = this.tasks.get(id);',
            '    if (!task) throw new Error(`completeTask: no task with id "${id}"`);',
            '    console.log(`completeTask: marking ${id} done`);',
            '    task.done = true;',
            '    return task;',
            '  }',
            '}',
          ].join('\n'),
        ),
      );
      writeFileSync(
        join(worktreePath, 'src', 'complete-task.test.ts'),
        [
          "import { describe, expect, test } from 'bun:test';",
          "import { TaskStore } from './tasks';",
          '',
          "describe('TaskStore.completeTask', () => {",
          "  test('sets done to true and returns the updated task', () => {",
          '    const store = new TaskStore();',
          "    const task = store.createTask('ship it', '2026-09-10');",
          '    const completed = store.completeTask(task.id);',
          '    expect(completed.done).toBe(true);',
          '    expect(store.getTask(task.id)?.done).toBe(true);',
          '  });',
          '',
          "  test('throws on unknown id', () => {",
          '    const store = new TaskStore();',
          "    expect(() => store.completeTask('nope')).toThrow(/no task with id/);",
          '  });',
          '});',
          '',
        ].join('\n'),
      );
    } else {
      // Fix pass (round-2 re-review): strip the cited debug line only — the
      // completeTask logic and the proof test added on attempt 1 are untouched.
      writeFileSync(
        tasksPath,
        current
          .split('\n')
          .filter((line) => !line.includes('console.log('))
          .join('\n'),
      );
    }
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
    // Created out of due-date order on purpose: under the pre-DEC-0001
    // insertion-order behaviour this assertion fails (['later', 'earlier']),
    // so the QA command below is real signal, not a rubber stamp (opus
    // review round 1 blocker 3).
    writeFileSync(
      join(worktreePath, 'src', 'list-tasks-order.test.ts'),
      [
        "import { describe, expect, test } from 'bun:test';",
        "import { TaskStore } from './tasks';",
        '',
        "describe('TaskStore.listTasks order', () => {",
        "  test('sorts ascending by dueDate', () => {",
        '    const store = new TaskStore();',
        "    store.createTask('later', '2026-09-20');",
        "    store.createTask('earlier', '2026-09-05');",
        "    expect(store.listTasks().map((t) => t.title)).toEqual(['earlier', 'later']);",
        '  });',
        '});',
        '',
      ].join('\n'),
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

/** The 1-based line number of the first line in `relPath` containing `pattern` (a literal substring, not a regex), or `undefined` if the file/pattern isn't found — how the scripted reviewer locates the seeded violation in the ticket's own worktree instead of hard-coding a line number that would drift with the file's other content. */
function findLineContaining(
  worktreePath: string,
  relPath: string,
  pattern: string,
): number | undefined {
  const path = join(worktreePath, relPath);
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, 'utf8').split('\n');
  const idx = lines.findIndex((line) => line.includes(pattern));
  return idx === -1 ? undefined : idx + 1;
}

/**
 * The scripted reviewer's one turn for `round`. For `seed.violation`'s
 * ticket on round 1, this cites the seeded rule against the worktree's own
 * source (not a hard-coded finding) and requests changes; every other
 * round/ticket is a plain `approve` (T021 scope: one seeded violation, not
 * a generally adversarial reviewer).
 */
async function driveReviewerWork(
  handle: DaemonHandle,
  ticket: Ticket,
  round: number,
  seed: SeedFile,
): Promise<void> {
  if (!handle.reviewProtocol || !handle.store) return;
  const deps = {
    protocol: handle.reviewProtocol,
    store: handle.store,
    stateRoot: handle.config.stateRoot,
  };
  const ctx = { agent: agentIdFor('reviewer', ticket.id), ticket: ticket.id };

  const violation = seed.violation;
  if (violation && violation.ticket === ticket.id && round === 1 && ticket.worktree) {
    const worktreePath = join(handle.config.repoRoot, ticket.worktree);
    const line = findLineContaining(worktreePath, 'src/tasks.ts', violation.pattern);
    if (line !== undefined) {
      await reviewSubmit(deps, ctx, {
        round,
        pass: 'primary',
        verdict: 'request_changes',
        findings: [
          {
            severity: violation.severity,
            rule: violation.ruleId,
            location: { path: 'src/tasks.ts', line },
            message: violation.message,
          },
        ],
      });
      return;
    }
    // The violation's own pattern isn't in the worktree (a regression in
    // `applyEngineerChange`'s attempt-1 branch) — fall through to a plain
    // approve rather than submit a finding with no real location, so this
    // failure surfaces as "the QA/e2e assertion for a request_changes round
    // never happened" instead of a fabricated citation.
  }
  await reviewSubmit(deps, ctx, { round, pass: 'primary', verdict: 'approve', findings: [] });
}

/** Per-ticket criterion -> command map for the scripted QA turn — each command targets the specific test file the engineer's own commit added for that criterion (`applyEngineerChange`), so a QA verdict is evidence the criterion actually holds, not a blanket `bun test` pass (opus review round 1 blocker 3). Falls back to bare `bun test` for a ticket/criterion this driver has no specific test name for. */
function qaPlanFor(ticket: Ticket): Record<string, string> {
  // Substrings of the test's own name (bun's `-t` matches the full
  // "describe > test" path) — must track `applyEngineerChange`'s actual
  // `test(...)` literals exactly, not a paraphrase, or `-t` matches nothing
  // and `test_run` reports an empty-evidence failure (round 2 fix: this bit
  // once already, when the criterion text and the test name diverged after
  // `complete-task.test.ts`/`list-tasks-order.test.ts` were split out of
  // the shared `tasks.test.ts` — see `.pipeline-report.md`).
  const byTicket: Record<string, string[]> = {
    'TKT-1001': [
      'bun test -t "sets done to true and returns the updated task"',
      'bun test -t "throws on unknown id"',
    ],
    'TKT-1002': ['bun test -t "sorts ascending by dueDate"'],
    'TKT-1003': ['bun test -t "returns only tasks due before now"'],
  };
  const commands = byTicket[ticket.id];
  const plan: Record<string, string> = {};
  ticket.contract.acceptance.forEach((_c, i) => {
    plan[String(i)] = commands?.[i] ?? 'bun test';
  });
  return plan;
}

/** The scripted QA turn: run each criterion's own command (see `qaPlanFor`) for real in the fresh QA clone, then submit. */
async function driveQaWork(handle: DaemonHandle, ticket: Ticket): Promise<void> {
  if (!handle.qaProtocol) return;
  const tools = registerQaTools(handle.qaProtocol);
  const ctx = { agent: agentIdFor('qa', ticket.id), ticket: ticket.id };
  const plan = qaPlanFor(ticket);
  const planTool = tools.find((t) => t.name === 'qa_plan');
  const runTool = tools.find((t) => t.name === 'qa_run');
  const submitTool = tools.find((t) => t.name === 'qa_submit');
  if (!planTool || !runTool || !submitTool) return;
  await planTool.handler(ctx, { plan });
  const results = (await runTool.handler(ctx, {})) as Array<{
    criterion: string;
    command?: string;
    status: string;
    evidence: string;
  }>;
  // `bun test -t "<pattern>"` matching zero tests still exits 0, and
  // `tools/test-run.ts`'s own pass-count classifier (out of this ticket's
  // file allowance) reads that as a real pass — `"... -> 0 passed"`. This
  // driver's own `qaPlanFor` commands are exact test-name substrings, so a
  // `0 passed` here means one drifted out of sync with the actual test
  // (T021 round 3, opus review round 2 nit) — the fixture's own defect,
  // not the criterion actually holding. Fail loud rather than let the
  // offline e2e (or `agile run`) accept it as genuine evidence.
  for (const r of results) {
    if (/->\s*0 passed\b/.test(r.evidence)) {
      throw new Error(
        `agile run: QA criterion "${r.criterion}" (command: ${r.command ?? '(none)'}) matched zero tests (${r.evidence}) — the qaPlanFor command has drifted from the actual test name; this is a fixture defect, not a real pass. See .pipeline-report.md.`,
      );
    }
  }
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
  ticketOutcomes: Array<{
    ticket: TicketId;
    status: string;
    merged: boolean;
    /** Primary review rounds actually run for this ticket (1 unless the seeded violation forced a round-2 re-review; 0 if review never started). */
    reviewRounds: number;
    /** The primary verdict of each round, in order (`['request_changes', 'approve']`). The fifth live run's report labelled a lone `escalate` "(approve)"; the label now reads the records. */
    reviewVerdicts: string[];
  }>;
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
  // Live mode has no scripted turns to drive progress synchronously — real
  // ACP sessions answer on their own clock, so the loop must actually wait
  // between ticks instead of hot-looping `maxTicks` times in milliseconds
  // (opus review round 1 blocker 2: the old unconditional `for (; tick <
  // maxTicks; tick++)` with no sleep burned its whole budget in ~3s
  // regardless of vendor login). `tickIntervalMs` defaults to the heartbeat
  // tunable (CLAUDE.md: "heartbeat 30s") in live mode, 0 (no wait — fake
  // sessions resolve synchronously within the same tick) otherwise;
  // `liveTimeoutMs` defaults to the quorum-timeout tunable (10 min), long
  // enough for a real engineer/reviewer/qa chain to actually finish.
  const tickIntervalMs = opts.tickIntervalMs ?? (fake ? 0 : 30_000);
  const liveTimeoutMs = opts.liveTimeoutMs ?? 10 * 60 * 1000;
  // Floor at 30s (opus review round 4 nit): `StateStore.heartbeat`
  // coalesces `AgentRecord.last_seen` writes to at most once per 30s
  // (`HEARTBEAT_COALESCE_MS`) — a threshold below that would false-positive
  // on a perfectly healthy session that just hasn't crossed a coalescing
  // window yet. `opts.testNow` (below) is how a test gets a *real* sub-30s
  // threshold to actually fire without waiting on real wall-clock time:
  // it accelerates the clock both sides of this comparison read, rather
  // than shrinking the threshold underneath the coalescing window's own
  // real-time assumption.
  const stallTimeoutMs = Math.max(opts.stallTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS, 30_000);
  // `--live`-mode watchdog/loop-bound clock (test-only override via
  // `opts.testNow`, forwarded to the daemon itself below so
  // `AgentRecord.last_seen` timestamps and this loop's own readings stay
  // on the same clock — round 5's own "healthy long turn" test uses an
  // accelerated-but-real clock here to clear the 30s coalescing window and
  // a multi-minute `stallTimeoutMs` in well under a second of actual wall
  // time, without faking away the real proportional ordering between
  // events that a counter-based mock would lose).
  const clockNow = (): number => (opts.testNow ? opts.testNow().getTime() : Date.now());

  const handle = await startDaemon({
    cwd: opts.cwd,
    port: opts.port ?? 0,
    now: opts.testNow,
    // This loop drives every tick itself — the daemon's own 30 s timer
    // running the same glue concurrently double-prompted and double-acked
    // (fourth live run).
    ceremonyTickMs: 0,
    runnerSpawn: fake ? createFakeSpawn() : opts.liveSpawnForTest,
    gateDelegate: fake
      ? () => ({ decision: 'approve', by: 'em', rationale: 'automated (agile run --fake)' })
      : (opts.gateDelegate ??
        // A real live run (no fake transport injected) decides em-owned
        // gates with the EM session delegate; a test that injects
        // `liveSpawnForTest` keeps them pending so the watchdog can report
        // them.
        (opts.liveSpawnForTest
          ? undefined
          : createEmSessionDelegate({
              stateRoot: join(opts.cwd, '.agile'),
              cwd: opts.cwd,
              onNotice: opts.onNotice ?? ((line: string) => console.error(line)),
              stderrLogDir: join(opts.cwd, '.agile-daemon-cache', 'sessions'),
            }))),
  });
  if (!fake) {
    const base = `http://127.0.0.1:${handle.http.port}`;
    (opts.onNotice ?? ((line: string) => console.error(line)))(
      `control room: ${base}/control-room   feed: ${base}/`,
    );
  }

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
    try {
      return await runSprintBody();
    } finally {
      // Drains every still-live session (stop + await its own exit/crash
      // cleanup) whether the body above returned normally or threw (T021
      // round 3: the stall watchdog's thrown error used to skip straight
      // to `handle.stop()`, which stops sessions but doesn't wait on their
      // exit — a background write from the hung session's own crash
      // handling could still be in flight when a caller then removes
      // `cwd`, exactly the race this function's own header already
      // documents for the *normal* completion path). Never blocks past a
      // genuinely stuck exit forever: bounded, same as `runner.test.ts`'s
      // own teardown convention.
      await Promise.all(
        runner.list().map((session) => {
          session.stop();
          return Promise.race([session.exited, Bun.sleep(15_000)]);
        }),
      );
    }

    async function runSprintBody(): Promise<RunResult> {
      if (!fake) {
        const preflight = await preflightLiveVendor(
          opts.liveSpawnForTest,
          opts.preflightTimeoutMs ?? 20_000,
        );
        if (!preflight.reachable) {
          throw new LiveVendorUnavailableError(preflight.reason);
        }
      }

      let seed: SeedFile = {};
      if (opts.seed) {
        seed = loadSeed(opts.seed);
        if (store.listTickets().length === 0) await seedFixture(handle, seed);
      }
      const trackedIds = seedTicketIds(seed);

      if (store.listSprints().length === 0) {
        const goal = resolveSprintGoal(seed, handle.config.stateRoot);
        await planSprint(store, { ...(goal !== undefined ? { goal } : {}) });
      }

      const seenReview = new Set<string>();
      const qaSpawned = new Set<TicketId>();
      const mergedDone = new Set<TicketId>();
      const engineerHandled = new Set<TicketId>();
      const reviewerHandled = new Set<TicketId>();
      const qaHandled = new Set<TicketId>();
      // The seeded rule-violation ticket needs a *second* engineer/reviewer
      // turn (fix, then re-review) after its round-1 `request_changes` — the
      // sets above are "handled once, ever" gates for the common case, so
      // this ticket's second pass needs its own dedicated tracking rather
      // than overloading them (T021 round 2 / QA round 1, opus round 1
      // blocker 1).
      const violationTicket = seed.violation?.ticket;
      const violationFixDriven = new Set<TicketId>();
      const violationReviewedRound2 = new Set<TicketId>();
      let discoveryRaised = false;
      let discoveryResolved = !seed.discovery;
      let liveHaltSeen = false;
      let oversizedReadDecision = 'not checked (no --seed)';

      const start = clockNow();
      // Fail-fast stall watchdog state (`--live` only, see below): the most
      // recent `AgentRecord.last_seen` this loop has observed across every
      // registered agent — the exact liveness signal `Bus.checkLiveness`'s
      // own sweep keys on (`bus/bus.ts`), not ticket status (round 3's
      // mistake: a ticket can legitimately sit `in_progress` for many
      // minutes of real, observable vendor work — opus review round 3
      // reproduced round 3's status-based watchdog aborting a healthy run
      // with 45 `tool_call` events already logged). Starts at `start` so a
      // vendor that never spawns anything at all is still bounded by
      // `stallTimeoutMs`, same as one that spawns and then goes silent —
      // though "never spawns anything at all" is itself now treated as
      // "not stalled yet" tick-by-tick below (opus review round 4 nit),
      // this initial value is only ever compared against on the very first
      // check, before that branch has had a chance to run.
      let lastLivenessAt = start;
      const announcedHils = new Set<string>();
      const notice = opts.onNotice ?? ((line: string) => console.error(line));
      let tick = 0;
      /** `runs/<ts>.md` + the per-ticket outcomes — on the normal return and on every abort path alike. */
      const writeReport = (ticksUsed: number) => {
        const reportDir = opts.reportDir ?? join(opts.cwd, 'runs');
        mkdirSync(reportDir, { recursive: true });
        const ticketOutcomes = trackedIds.map((id) => {
          const ticket = store.getTicket(id);
          const verdicts = listReviewVerdicts(store, id);
          return {
            ticket: id,
            status: ticket.status,
            merged: (mergeOwner.status(id) as { status?: string } | undefined)?.status === 'merged',
            reviewRounds: verdicts.length,
            reviewVerdicts: verdicts,
          };
        });
        const reportPath = join(reportDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
        writeFileSync(
          reportPath,
          renderReport(handle, ticketOutcomes, oversizedReadDecision, ticksUsed),
        );
        return { reportPath, ticketOutcomes };
      };
      for (; fake ? tick < maxTicks : clockNow() - start < liveTimeoutMs; tick++) {
        // Same contract as daemon.ts's ceremony timer: a ceremony error is
        // logged, never fatal. Twenty-fifth live run (2026-09-11): one
        // unaddressable standup_call recipient threw out of emLoop.tick(),
        // the throw escaped this loop and tore down every session with the
        // epic three merges from done.
        try {
          await gateService.tick();
          await emLoop.tick();
        } catch (err) {
          console.warn(
            `agile run: ceremony tick ${tick} failed — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (fake) {
          // `--fake`'s scripted driver below plays the engineer/architect
          // turns itself (`driveEngineerWork(..., 2)` after
          // `request_changes`), so only the hand-offs that don't re-prompt
          // a session run here; the daemon's full pipeline would
          // double-drive the fake sessions.
          await advanceReviewRequests(store, bus, reviewProtocol, runner, seenReview);
          await advanceQaSpawns(store, runner, qaSpawned);
          await advanceDoneTickets(store, mergeOwner, mergedDone);
        } else {
          // Live: the daemon's own pipeline pass — one list, owned by
          // `daemon.ts`. The hand-rolled copy this replaced was missing
          // `advanceReviewerEscalations` and `releaseStaleTicketSessions`
          // (eleventh live run, 2026-09-10: readied tickets never
          // re-assigned because the pre-ripple sessions were never stopped).
          await handle.advancePipeline?.();
        }

        if (fake) {
          for (const ticket of store.listTickets()) {
            const attempts = ticket.routing?.attempts ?? 0;
            const isViolationFixTurn =
              ticket.id === violationTicket &&
              ticket.status === 'in_progress' &&
              attempts >= 1 &&
              !violationFixDriven.has(ticket.id);

            if (
              ticket.worktree &&
              (isViolationFixTurn ||
                (ticket.status === 'in_progress' && !engineerHandled.has(ticket.id)))
            ) {
              const attempt = isViolationFixTurn ? 2 : 1;
              if (isViolationFixTurn) violationFixDriven.add(ticket.id);
              else engineerHandled.add(ticket.id);
              if (oversizedReadDecision.startsWith('not checked')) {
                oversizedReadDecision = await checkOversizedReadDenied(
                  handle,
                  join(handle.config.repoRoot, ticket.worktree),
                );
              }
              await driveEngineerWork(handle, ticket, seed, attempt);
              if (attempt === 1 && seed.discovery?.reporterTicket === ticket.id)
                discoveryRaised = true;
            }

            const isViolationReviewRound2 =
              ticket.id === violationTicket &&
              ticket.status === 'in_review' &&
              attempts >= 1 &&
              !violationReviewedRound2.has(ticket.id);

            // `store.getAgent` throws `NotFoundError` rather than returning
            // `undefined` for a missing record (store.ts), so it must stay
            // short-circuited behind `ticket.status === 'in_review'` — never
            // hoisted into an eagerly-evaluated local, or every ticket not
            // yet in review throws here on every tick.
            if (
              ticket.status === 'in_review' &&
              (isViolationReviewRound2 || !reviewerHandled.has(ticket.id)) &&
              store.getAgent(agentIdFor('reviewer', ticket.id))
            ) {
              const round = isViolationReviewRound2 ? 2 : 1;
              if (isViolationReviewRound2) violationReviewedRound2.add(ticket.id);
              else reviewerHandled.add(ticket.id);
              await driveReviewerWork(handle, ticket, round, seed);
              // Deliberately not stopping the reviewer session here: nothing
              // in this codebase tells a session to exit between rounds (an
              // engineer's session between a `request_changes` and its own
              // next `board_post` is left alone the same way), and a session
              // exit while the ticket is still `in_progress`/`in_review` (a
              // `LIVE_STATUS`) makes `session.ts`'s `finish()` treat it as a
              // crash and re-ready the ticket, wiping this round's outcome.
              // `advanceReviewRequests` (`pipeline-glue.ts`) reuses this same
              // still-live session for round 2 instead of re-spawning it.
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
                await driveEngineerWork(handle, resumed, seed, 1);
              }
            }
          }
        }

        // Live: the architect raises and resolves the seeded discovery
        // itself, so "resolved" is read off the board — a halt was seen,
        // and none is active now. Twenty-fourth live run (2026-09-11): all
        // three tickets merged at 15:03:42 and the sprint was reviewed ten
        // seconds later, yet the loop ran on until the no-liveness rule
        // aborted it — this flag was only ever set by the scripted driver.
        if (!fake) {
          if (store.listHalts().length > 0) liveHaltSeen = true;
          else if (liveHaltSeen) discoveryResolved = true;
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
        // Fail-fast stall watchdog, `--live` only (opus review round 3
        // blocker: round 2's version keyed on ticket-status stasis with a
        // 2-minute default, which aborted a *healthy* live run mid-turn —
        // see the field's own doc comment on `stallTimeoutMs`). Keys on the
        // same signal `Bus.checkLiveness`'s own sweep uses
        // (`AgentRecord.last_seen`, updated on every heartbeat/tool_call —
        // `session.ts`'s `recordHeartbeat`), so it never fires while any
        // session is actually producing events, and its default threshold
        // is this repo's own 5-minute liveness tunable, not an invented
        // shorter one.
        // `--live` only: surface every still-pending `hil_request` the
        // moment it appears. In live mode the daemon has no gate delegate
        // (nothing auto-approves as `em` the way `--fake` does), so a
        // `hil`-routed permission (`permissions/decide.ts` — force-push,
        // dependency install, a push to a non-ticket branch, ...) leaves
        // the vendor's `session/request_permission` unanswered and that
        // session silently blocked until a human resolves it. Without this
        // notice the only symptom is a `last_seen` that stops advancing
        // and, five minutes later, the stall watchdog below — which is
        // exactly how the first real `test:live` run on a laptop died.
        if (!fake) {
          for (const req of gateService.list()) {
            if (req.status !== 'pending' || announcedHils.has(req.id)) continue;
            announcedHils.add(req.id);
            notice(formatPendingHil(req, opts.cwd, store));
          }
        }
        if (!fake && trackedIds.length > 0) {
          const lastSeenTimes = store
            .listAgents()
            .map((a) => Date.parse(a.record.last_seen))
            .filter((ms) => Number.isFinite(ms));
          if (lastSeenTimes.length > 0) {
            lastLivenessAt = Math.max(lastLivenessAt, ...lastSeenTimes);
          } else {
            // No agent has ever registered yet (opus review round 4 nit):
            // that's normal spawn latency (worktree placement, the vendor
            // process actually starting), not a stall — keep pushing the
            // clock forward until the *first* agent shows up, rather than
            // counting the time since loop start against it. Once at least
            // one agent has registered, the branch above takes over and the
            // real countdown begins.
            lastLivenessAt = clockNow();
          }
          if (clockNow() - lastLivenessAt >= stallTimeoutMs) {
            // Write the report before aborting (runs 5–8, 2026-09-10: the
            // watchdog fired after all reachable work was done, and the one
            // artifact the post-mortem wanted — review rounds, per-ticket
            // status — was the one never written).
            const abortedReport = writeReport(tick);
            throw new Error(
              `agile run --live: no session liveness (AgentRecord.last_seen) observed for ${stallTimeoutMs}ms — ${describeStall(
                store,
                gateService,
                opts.cwd,
                clockNow(),
              )} Report: ${abortedReport.reportPath}`,
            );
          }
        }
        if (!fake && tickIntervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, tickIntervalMs));
        }
      }

      const { reportPath, ticketOutcomes } = writeReport(tick);

      // Draining every still-live session (stop + await its own exit/crash
      // cleanup) so a background `finish()` write can't race a caller that
      // removes `cwd` right after this resolves is now the outer `finally`'s
      // job (see above) — it runs on this normal-return path too, not just
      // on a thrown error, so there is nothing left to do here.
      return { reportPath, ticketOutcomes, oversizedReadDecision, ticksUsed: tick };
    }
  } finally {
    await handle.stop();
  }
}

/**
 * One `--live` notice per newly pending `hil_request`: what raised it (the
 * latest `hook_decision` event with `decision: hil` for the same agent, when
 * there is one — that's where the classifier's actual reason lives; the
 * gate record itself only knows "no delegate configured"), and the command
 * that answers it. `agile` discovers the daemon socket from the repo root
 * (`discoverConfig`), so the hint is anchored on `cwd`.
 */
function formatPendingHil(req: HilRequest, cwd: string, store: StateStore): string {
  const hookReason = latestHilHookReason(store, req);
  const why = req.summary ?? hookReason ?? req.reason ?? req.gate;
  const ticket = req.ticket ? ` ${req.ticket}` : '';
  return [
    `agile run --live: HIL needed: ${req.id} (${req.gate}${ticket}) — ${why}.`,
    '  The requesting session is blocked until this is answered:',
    `    (cd ${cwd} && agile approve ${req.id})   # or: agile resolve ${req.id} --decision deny`,
  ].join('\n');
}

function latestHilHookReason(store: StateStore, req: HilRequest): string | undefined {
  // `req.owner` is the resolver (human / delegate), not the requester — the
  // event log is the only place the requesting agent and the classifier's
  // reason are recorded together.
  const events = store.listEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined || ev.kind !== 'hook_decision' || ev.data.decision !== 'hil') continue;
    if (ev.ticket !== req.ticket) continue; // same ticket, or both ticket-less (an architect gate)
    const reason = ev.data.reason;
    const command = ev.data.command;
    const agent = ev.agent ?? 'unknown agent';
    const what =
      typeof command === 'string' ? `\`${command}\`` : String(ev.data.toolClass ?? 'a tool call');
    return `${agent} asked to run ${what}: ${typeof reason === 'string' ? reason : 'routed to a human'}`;
  }
  return undefined;
}

/** The stall watchdog's error, after its fixed "no session liveness ... observed for Nms — " head: every pending HIL (the run was waiting on a human, not on an unreachable vendor) and every registered agent with how long ago it was last seen — so the abort names the actual blocker instead of guessing "unreachable". */
function describeStall(
  store: StateStore,
  gateService: GateService,
  cwd: string,
  nowMs: number,
): string {
  const lines: string[] = [];
  const pending = gateService.list().filter((r) => r.status === 'pending');
  if (pending.length > 0) {
    lines.push(
      `${pending.length} pending hil_request(s) — the blocked session(s) were waiting on a human, not on the vendor. Aborting instead of waiting out the remaining liveTimeoutMs.`,
    );
    for (const req of pending) lines.push(formatPendingHil(req, cwd, store));
  } else {
    lines.push(
      'no vendor session appears reachable. Aborting instead of waiting out the remaining liveTimeoutMs.',
    );
  }
  const agents = store.listAgents();
  if (agents.length > 0) {
    lines.push('\nRegistered agents (last_seen age):');
    for (const { id, record } of agents) {
      const age = Math.max(0, nowMs - Date.parse(record.last_seen));
      lines.push(
        `  ${id}: ${record.role ?? '?'}${record.ticket ? ` ${record.ticket}` : ''} — ${Math.round(age / 1000)}s ago (${record.vendor}/${record.model})`,
      );
    }
  }
  lines.push(
    `\nVendor stderr, per session: ${join(cwd, '.agile-daemon-cache', 'sessions')}/<agent>-<ts>.stderr.log`,
  );
  return lines.join('\n');
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
  const reviewRoundLines = outcomes.map(
    (o) =>
      `- ${o.ticket}: ${o.reviewRounds} round${o.reviewRounds === 1 ? '' : 's'}${o.reviewVerdicts.length > 0 ? ` (${o.reviewVerdicts.join(' then ')})` : ''}`,
  );

  return [
    `# agile run report — ${new Date().toISOString()}`,
    '',
    `Ceremony ticks used: ${ticksUsed}`,
    '',
    '## Per-ticket outcome',
    ...ticketLines,
    '',
    '## Review rounds per ticket',
    ...reviewRoundLines,
    '',
    '## Token spend per role (ledger)',
    ...spendLines,
    '',
    '## Oversized-file hook check',
    `- ${oversizedReadDecision}`,
    '',
  ].join('\n');
}
