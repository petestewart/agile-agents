/**
 * The first goal starts the architect (T042 — §17 "Control room v2": "The
 * repo opens here with an empty plan and a chat. Your goal is the first
 * message ... The architect reads the repo, the plan fills in on the left").
 *
 * `POST /api/chat/em` is still the one chat endpoint; this module decides
 * whether a given line is *the goal* rather than a message to the EM, and
 * runs one architect planning turn when it is. "The repo has no plan yet"
 * is deliberately narrow and checkable: no ticket files at all, and
 * `oracle/product.md` still the placeholder `agile init` wrote. One ticket
 * or one edited brief and every later line goes to the EM as before.
 *
 * The live planner is T014's `runArchitectTurn` (plan mode, MCP verbs over
 * `agile mcp --agent architect`, the `approve_plan` gate wired to the
 * `GateService`). Offline — `bun test`, `test:integration`, and any daemon
 * with no vendor login — the planner is a *double* that calls the same
 * daemon verbs the architect would (`ARCHITECT_TOOLS` + `product_brief_write`),
 * so the code under test is the daemon side of the planning turn rather
 * than a mock of it.
 */

import type { Policy } from '@agile-agents/shared';
import { ulid } from '@agile-agents/shared';
import { type ArchitectSessionMode, runArchitectTurn } from '../architect/session';
import type { Bus } from '../bus';
import type { GateService } from '../gates';
import type { CliInvocation } from '../runner/cli-bin';
import type { StateStore } from '../store';
import { PRODUCT_BRIEF_PATH } from './service';

export interface PlanningTurnInput {
  goal: string;
  /** Rendered prompt (see `renderPlanningPrompt`) — the live path's one `prompt()` call. */
  prompt: string;
}

/** How a planning turn is actually run. One implementation spawns the architect; a test double calls the same daemon verbs. */
export type ArchitectPlanner = (input: PlanningTurnInput) => Promise<void>;

export interface PlanningTurnDeps {
  store: StateStore;
  bus?: Bus;
  planner?: ArchitectPlanner;
  now?: () => Date;
  /** Reports a failed turn; defaults to `console.error` (a planning turn that dies must not take the HTTP request with it). */
  onError?(message: string): void;
}

/** True when this repo has no plan yet, so the next chat line is the goal. */
export function isFirstGoal(store: StateStore, briefIsStub: boolean): boolean {
  return store.listTickets().length === 0 && briefIsStub;
}

/** The architect's planning prompt. Names the verbs it must call, because the panes are exactly what those verbs write. */
export function renderPlanningPrompt(goal: string, repoRoot: string): string {
  return [
    'You are the architect for this repo. The operator has just given you the first goal from the control room.',
    '',
    `Repo: ${repoRoot}`,
    `Goal: ${goal}`,
    '',
    'Read the repo (README, package manifests, existing tests) and then, using your `agile` MCP verbs only:',
    `  1. \`product_brief_write\` — write ${PRODUCT_BRIEF_PATH}: product, non-goals, glossary, and a "Current goal" section quoting the goal above.`,
    '  2. `decision_publish` — record any rule the whole team must follow as a SPEC entry, and any fork you have already settled as a DEC entry.',
    '  3. `ticket_create` + `ticket_refine` + `ticket_point` — one ticket per deliverable, in dependency order. Fully refine only the tickets that can start immediately (nothing left to wait on); leave later-layer tickets as stubs: title, a one-line `description`, and `depends`.',
    '',
    'Do not write code, run commands, or touch a worktree. When the plan is written, end your turn.',
  ].join('\n');
}

export interface PlanningTurnStart {
  started: boolean;
  reason?: string;
}

/**
 * Files the goal on the bus (so it is in `events.jsonl` and the architect's
 * inbox like any other instruction) and starts one planning turn in the
 * background. Returns as soon as the turn is queued — the browser's POST
 * never blocks on a model turn, same contract as `EmChatService.send`.
 */
export async function startPlanningTurn(
  deps: PlanningTurnDeps,
  goal: string,
  repoRoot: string,
): Promise<PlanningTurnStart> {
  const now = deps.now ?? (() => new Date());
  if (deps.bus) {
    const sent = await deps.bus.send({
      id: ulid(),
      ts: now().toISOString(),
      from: 'human',
      to: ['architect'],
      kind: 'fyi',
      priority: 'urgent',
      body: `Goal: ${goal}`.slice(0, 800),
    });
    if (!sent.ok) return { started: false, reason: sent.reason };
  }
  if (!deps.planner) {
    return { started: false, reason: 'no architect planner is wired to this daemon' };
  }
  const input: PlanningTurnInput = { goal, prompt: renderPlanningPrompt(goal, repoRoot) };
  const onError = deps.onError ?? ((message: string) => console.error(message));
  void deps.planner(input).catch((err) => {
    onError(`architect planning turn failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { started: true };
}

export interface LivePlannerOptions {
  gateService: GateService;
  policy: Policy;
  cwd: string;
  cliBin?: string | CliInvocation;
  socketPath?: string;
  mode?: ArchitectSessionMode;
}

/**
 * The live planner: one architect ACP session (T014). `plan` mode first, per
 * CLAUDE.md's v0 default — the `ExitPlanMode` request it ends on is routed
 * to the `approve_plan` gate by `runArchitectTurn` itself.
 */
export function liveArchitectPlanner(options: LivePlannerOptions): ArchitectPlanner {
  return async ({ prompt }) => {
    const handle = runArchitectTurn({
      gateService: options.gateService,
      policy: options.policy,
      cwd: options.cwd,
      prompt,
      mode: options.mode ?? 'plan',
      ...(options.cliBin !== undefined ? { cliBin: options.cliBin } : {}),
      ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
    });
    await handle.exited;
  };
}
