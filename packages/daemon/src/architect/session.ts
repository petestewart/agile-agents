/**
 * Architect ACP session (T014 — CLAUDE.md "v0 defaults": "Architect planning
 * turn: try Claude `plan` mode first (T014). If plan mode blocks the
 * architect's MCP writes, run `default` mode with a daemon-side
 * `approve_plan` gate."; design/spike-findings.md §C3: "Claude `plan` mode:
 * writes/exec are refused by the model at prompt level, then `ExitPlanMode`
 * arrives as an ACP permission request titled 'Approve Plan' (`kind:
 * switch_mode`) ... the daemon's answer to 'Approve Plan' *is* the gate.").
 *
 * This module does not reuse `runner/session.ts`'s `startAgentSession` —
 * that module's `role` parameter is `PermissionRole` (`engineer | reviewer |
 * qa` only, `permissions/types.ts`), its permission responder applies the
 * engineer/reviewer/qa policy tables (§14, T010), and it always spawns
 * `modeId: 'default'`. None of that fits an architect turn, and this
 * ticket's file ownership doesn't include `runner/**`/`permissions/**` to
 * extend them — see `.pipeline-report.md` for the one line a future ticket
 * would add to `runner.ts` to spawn an architect through the real `Runner`
 * instead of this module's own minimal spawn wrapper.
 *
 * DESIGN-GAP (mode fallback): "if plan mode blocks the architect's MCP
 * writes, run default mode" is left as a parameter (`mode`) the caller
 * chooses, not something this module auto-detects. ACP's `session/update`/
 * `request_permission` frames carry no signal that would distinguish
 * "the architect never called an MCP verb because plan mode silently
 * swallowed every tool call" from "the architect's turn genuinely had
 * nothing to write yet" — MCP tool calls happen over the separate stdio
 * channel `agile mcp --agent architect` opens, invisible to the ACP frame
 * stream this module listens on. The daemon-level signal that plan mode
 * isn't working is observable elsewhere (a ticket a refinement sprint named
 * never advances out of `draft`/`stale` across a turn) and belongs to
 * whichever ceremony driver (EM/sprint loop) decides to retry with
 * `mode: 'default'`, not to this one call.
 */

import {
  ACP_PROVIDERS,
  type AcpProviderConfig,
  type AgentEvent,
  type SpawnSessionOptions,
  type SpawnedSession,
  spawnSession as defaultSpawnSession,
} from '@agile-agents/acp-client';
import type { Policy } from '@agile-agents/shared';
import type { GateService } from '../gates';

export type ArchitectSessionMode = 'plan' | 'default';

export interface RunArchitectTurnOptions {
  gateService: GateService;
  /** `store.getPolicy()` — forwarded to `GateService.request`'s gate-owner resolution (most-specific-wins, §16). */
  policy: Policy;
  /** Working directory for the session — the repo root, never a ticket worktree (the architect brief: "Never run code or touch a worktree"). */
  cwd: string;
  /** The rendered brief/refinement/standup prompt — this turn's first (and only) `prompt()` call. */
  prompt: string;
  mode: ArchitectSessionMode;
  /** `agile mcp --agent architect` — no `--ticket` (the architect isn't scoped to one). Defaults to `'agile'`. */
  cliBin?: string;
  socketPath?: string;
  provider?: AcpProviderConfig;
  spawn?: typeof defaultSpawnSession;
  now?: () => Date;
  /** How often to re-check the `approve_plan` gate while it's still pending. Defaults to 200ms; test seam. */
  gatePollMs?: number;
  /** How long to wait on a pending `approve_plan` gate before giving up and denying the plan. Defaults to 5 minutes. */
  gateTimeoutMs?: number;
}

export interface ArchitectTurnExitInfo {
  reason: string;
  /** Whether an `ExitPlanMode`/"Approve Plan" request was seen and, if so, what the gate decided. `undefined` in `default` mode, or if the turn never reached that request. */
  planApproved?: boolean;
}

export interface ArchitectSessionHandle {
  session: SpawnedSession;
  exited: Promise<ArchitectTurnExitInfo>;
  stop(): void;
}

/** "ExitPlanMode arrives ... titled 'Approve Plan' (`kind: switch_mode`)" (spike-findings §C3). Title match is a fallback for a vendor/version that doesn't set `kind`. */
function isExitPlanModeRequest(toolCall: { kind?: string; title?: string } | undefined): boolean {
  if (!toolCall) return false;
  if (toolCall.kind === 'switch_mode') return true;
  return typeof toolCall.title === 'string' && /approve plan/i.test(toolCall.title);
}

function findOption(
  options: Array<{ optionId: string; kind: string }>,
  wantKinds: readonly string[],
): { optionId: string; kind: string } | undefined {
  for (const kind of wantKinds) {
    const found = options.find((o) => o.kind === kind);
    if (found) return found;
  }
  return options[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs one architect turn. Resolves `exited` once the process ends (normally or on error) — never rejects, matching `runner/session.ts`'s `AgentSessionHandle` convention. */
export function runArchitectTurn(opts: RunArchitectTurnOptions): ArchitectSessionHandle {
  const { gateService, policy, cwd, prompt, mode } = opts;
  const cliBin = opts.cliBin ?? 'agile';
  const provider = opts.provider ?? ACP_PROVIDERS.claude;
  const spawn = opts.spawn ?? defaultSpawnSession;
  const now = opts.now ?? (() => new Date());
  const gatePollMs = opts.gatePollMs ?? 200;
  const gateTimeoutMs = opts.gateTimeoutMs ?? 5 * 60 * 1000;

  const spawnOptions: SpawnSessionOptions = {
    cmd: provider.command,
    args: [...provider.args],
    cwd,
    envOverrides: {
      ...provider.envOverrides,
      AGILE_AGENT: 'architect',
      ...(opts.socketPath ? { AGILE_SOCKET_PATH: opts.socketPath } : {}),
    },
    clientCapabilities: provider.clientCapabilities,
    mcpServers: [{ name: 'agile', command: cliBin, args: ['mcp', '--agent', 'architect'] }],
    modeId: mode,
  };
  const session = spawn(spawnOptions);

  let settled = false;
  let resolveExited!: (info: ArchitectTurnExitInfo) => void;
  const exited = new Promise<ArchitectTurnExitInfo>((resolve) => {
    resolveExited = resolve;
  });
  let planApproved: boolean | undefined;

  async function finish(reason: string): Promise<void> {
    if (settled) return;
    settled = true;
    unsubscribe();
    resolveExited({ reason, ...(planApproved !== undefined ? { planApproved } : {}) });
  }

  /**
   * Waits on the `approve_plan` gate `GateService.request` opened, polling
   * `GateService.get` until it resolves (a human's `respond`, an EM/architect
   * delegate firing synchronously inside `request` itself, or this
   * function's own timeout). `GateService` has no push/subscribe surface
   * (T018's scope) — polling is this module's own, kept short so a test's
   * fake clock/timers aren't needed: `gatePollMs`/`gateTimeoutMs` are both
   * plain `setTimeout`-based and small enough for `bun test` defaults.
   */
  async function awaitPlanApproval(): Promise<boolean> {
    const request = await gateService.request('approve_plan', {
      policy,
      hilKind: 'approve_decision',
      from: 'architect',
    });
    if (request.status === 'resolved') return request.decision === 'approve';

    const start = now().getTime();
    while (true) {
      const current = gateService.get(request.id);
      if (current.status === 'resolved') return current.decision === 'approve';
      if (now().getTime() - start >= gateTimeoutMs) return false;
      await sleep(gatePollMs);
    }
  }

  const unsubscribe = session.on((event: AgentEvent) => {
    if (event.type === 'exit') {
      void finish(`process exited (code ${event.exitCode})`);
      return;
    }
    if (event.type === 'error') {
      void finish(`transport error: ${event.message}`);
      return;
    }

    const frame = event.event;
    if (frame.acp === 'request' && frame.method === 'session/request_permission') {
      const params = frame.params as {
        toolCall?: { kind?: string; title?: string };
        options: Array<{ optionId: string; kind: string }>;
      };
      if (isExitPlanModeRequest(params.toolCall)) {
        void awaitPlanApproval().then((approved) => {
          planApproved = approved;
          const chosen = approved
            ? findOption(params.options, ['allow_once', 'allow_always'])
            : findOption(params.options, ['reject_once', 'reject_always']);
          if (chosen) {
            session.respondPermission(frame.id, {
              outcome: { outcome: 'selected', optionId: chosen.optionId },
            });
          } else {
            session.respondPermission(frame.id, { outcome: { outcome: 'cancelled' } });
          }
        });
        return;
      }

      // Any other permission request during an architect turn (edit/execute)
      // is refused outright — "Never run code or touch a worktree" (the
      // architect brief). No HIL detour: this isn't a role the policy
      // tables in `permissions/**` cover, and an architect asking to edit a
      // file is a bug in the turn, not a judgment call.
      const deny = findOption(params.options, ['reject_once', 'reject_always']);
      if (deny) {
        session.respondPermission(frame.id, {
          outcome: { outcome: 'selected', optionId: deny.optionId },
        });
      } else {
        session.respondPermission(frame.id, { outcome: { outcome: 'cancelled' } });
      }
      return;
    }

    if (frame.acp === 'notification' && frame.message.method === '_agile/session_state') {
      // Model id bookkeeping is the daemon's `Runner`/ledger concern for a
      // real spawned architect (out of this ticket's ownership) — this
      // module only needs the frame stream for permission routing.
      return;
    }
  });

  void session.prompt(prompt).catch(() => {
    // Surfaces through the session's own `exit`/`error` events, same as
    // `runner/session.ts`'s equivalent catch.
  });

  return {
    session,
    exited,
    stop() {
      session.cancel();
      session.close();
    },
  };
}
