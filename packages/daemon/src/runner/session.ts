/**
 * `startAgentSession` — spawns one ACP session for an already-placed
 * worktree and wires it into the daemon (T012 — design/
 * agile-agents-design.md §8 "Adapter contract": "(ticket, oracle_refs,
 * kb_refs, worktree) -> (diff, report, status, ledger events)"; §4 "Ledger";
 * §5 "Liveness"; §6 tier 1/2 enforcement).
 *
 * Scope: this module owns exactly one running session's wiring — hook
 * settings, MCP config, permission responder, ledger, event log, heartbeat,
 * registration, and exit/crash handling. `runner.ts` owns *which* worktree
 * and ticket state transition a call to `spawn()` implies; this module just
 * runs the session once handed a worktree path and a rendered brief.
 *
 * `AgentRecord.pid` (T012 QA round fix, corrected in review round 3):
 * registration uses `session.pid` — `@agile-agents/acp-client`'s
 * `SpawnedSession` exposes the spawned child's real OS pid (granted for
 * this round: `packages/acp-client/src/{session,types}.ts`). Round 2 fell
 * back to the daemon's own pid (`session.pid ?? process.pid`) in the
 * narrow window a spawn failed to assign one — opus round 2 correctly
 * called this out as recreating the exact "kill the record, kill the
 * daemon" footgun the fix was supposed to remove. `AgentRecord.pid` is now
 * optional (`packages/shared/src/agents.ts`, granted): when
 * `session.pid` is `null`, `pid` is omitted entirely (never substituted)
 * and an `agent_put` event logs a warning naming the gap, so it's visible
 * in `log/events.jsonl` rather than silently wrong. This is what lets an
 * external operator's "kill -9 the pid on record" acceptance step work as
 * written, not just the daemon's own automatic liveness sweep (which never
 * reads `pid` for anything — the crash test in `runner.test.ts` asserts
 * `store.getAgent(...).pid` equals the fake agent's own pid *before*
 * killing it).
 *
 * `role`/`worktree`/`session_id` survival — RESOLVED at the root in review
 * round 4 (QA round 3 REJECT: a live reviewer/QA session silently decayed to
 * the engineer's permissive policy once `hook/service.ts`'s own
 * `store.heartbeat` call crossed the 30s coalescing window, because that
 * method used to rebuild `AgentRecord` from only its patch fields, dropping
 * anything else already on disk). `StateStore.heartbeat` (`store/store.ts`)
 * now only ever touches `last_seen`/`ticket`, carrying every other field
 * over from the existing record verbatim, and `Bus.heartbeat` delegates to
 * it for every heartbeat past an agent's first. `recordHeartbeat` below
 * still (a) registers the full record once via `store.putAgent` at start,
 * then (b) re-applies `role`/`worktree`/`session_id` via `store.putAgent`
 * after every `bus.heartbeat()` call if they ever come back different from
 * what this session expects — now a pure backstop against some *other*
 * future `putAgent`/`heartbeat` caller re-introducing this bug, not the
 * load-bearing fix it was before round 4 (the fix now lives where round 4's
 * QA finding said it belonged: the store itself, so it can't recur from any
 * caller).
 *
 * `tool_call` observation (T012 QA round fix): `@agile-agents/shared`'s
 * `EVENT_KINDS` (granted for this round: `packages/shared/src/event.ts`)
 * gained a dedicated `tool_call` kind, so every `tool_call`/`tool_call_update`
 * ACP notification is now logged as `kind: 'tool_call'` with
 * `{toolCallId, kind, title, status}` in `data` (`agent`/`ticket` are the
 * `Event` schema's own top-level fields, not duplicated into `data`) —
 * replacing the earlier round's `entity_put`-as-stand-in workaround.
 *
 * `usage_update` before any sprint exists (T012 QA round finding): a
 * `usage_update` that arrives with no sprint on record used to be silently
 * dropped (`currentSprintId()` resolves to `undefined`, and the ledger write
 * was skipped outright). It's now filed under the `nosprint` ledger file
 * (`store.appendLedgerLine`'s own sprint-id convention — `SprintIdSchema`
 * requires the literal shape, so a real placeholder id would fail
 * validation; `nosprint` is a plain string, not a `SprintId`, matching how
 * `ledger/nosprint.jsonl` is already named elsewhere as the pre-sprint
 * fallback), and a `ledger_no_sprint` event is logged so the gap is visible
 * in `log/events.jsonl` rather than only in a missing ledger line nobody
 * went looking for.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACP_PROVIDERS,
  type AcpProviderConfig,
  type AgentEvent,
  AuthRequiredError,
  type SessionReply,
  type SpawnSessionOptions,
  type SpawnedSession,
  spawnSession as defaultSpawnSession,
} from '@agile-agents/acp-client';
import type { AgentId, LedgerKind, LedgerLine, Policy, TicketId } from '@agile-agents/shared';
import { ulid, validateLedgerLine } from '@agile-agents/shared';
import type { Bus } from '../bus';
import { pickCurrentSprint } from '../feed';
import type { GateService } from '../gates';
import { writeClaudeSettings } from '../hook';
import {
  type AcpPermissionRequestParams,
  type PermissionResponderHandle,
  type PermissionRole,
  buildGrokFsPolicy,
  buildPermissionResponder,
  cursorModeIdFor,
} from '../permissions';
import {
  ForeignPiExtensionError,
  GATE_ENV_VAR as PI_GATE_ENV_VAR,
  installPiExtension,
  readAgileExtensionSource,
  resolvePiAgentDir,
} from '../pi';
import { type WrapAgentCommandFn, wrapAgentCommand as defaultWrapAgentCommand } from '../sandbox';
import { buildEvent } from '../store';
import type { StateStore } from '../store';
import { type CliInvocation, cliInvocationToShell, normalizeCliBin } from './cli-bin';

/**
 * T031: `architect` maps to `'ceremony'` — the ledger kind this codebase
 * already uses for a role that isn't tied to one ticket's own spend budget
 * (`LEDGER_KINDS` in `packages/shared/src/ledger.ts`; `'reader'` is the
 * other ledger-only kind, for tool-runner turns, not a spawned session).
 */
const ROLE_LEDGER_KIND: Record<PermissionRole, LedgerKind> = {
  engineer: 'engineer',
  reviewer: 'review',
  qa: 'qa',
  architect: 'ceremony',
};

/** A per-session stderr log under `stderrLogDir` — see `AgentSessionOptions.stderrLogDir`. Returns `undefined` when no dir is configured or it can't be created. */
export function openStderrLog(
  dir: string | undefined,
  agentId: string,
  at: Date,
): { path: string; append: (chunk: string) => void } | undefined {
  if (dir === undefined) return undefined;
  const path = join(dir, `${agentId}-${at.toISOString().replace(/[:.]/g, '-')}.stderr.log`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return undefined;
  }
  return {
    path,
    append: (chunk) => {
      try {
        appendFileSync(path, chunk);
      } catch {
        // Diagnostics only — never let a full disk or a vanished dir take the session down.
      }
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export interface AgentSessionOptions {
  store: StateStore;
  bus: Bus;
  role: PermissionRole;
  agentId: AgentId;
  ticket: TicketId;
  /** Absolute path — the session's `cwd` and where `.claude/settings.json` is written. */
  worktreePath: string;
  /** Rendered role brief (`brief.ts`) — sent as the first `prompt()`. */
  brief: string;
  /** How to invoke the `agile` CLI, for both the hook command and the MCP server's stdio command: a bare name/path, or a structured `{command, args}` (`runner/cli-bin.ts`'s `resolveCliBin` — e.g. `bun <path to packages/cli/src/index.ts>`). Defaults to `'agile'` (on `$PATH`). */
  cliBin?: string | CliInvocation;
  /** `AGILE_SOCKET_PATH` for the worktree's hook + MCP bridge, when the worktree's own `git rev-parse --show-toplevel` wouldn't already resolve to the main repo (every `.worktrees/**` ticket worktree). */
  socketPath?: string;
  provider?: AcpProviderConfig;
  /** Resolves the current sprint id for ledger filing — same convention as `ToolService.currentSprintId`. */
  currentSprintId?: () => string | undefined;
  /** Optional — hands `hil` permission verdicts to T018's `GateService` instead of the responder's default store-backed writer. */
  gateService?: GateService;
  /** Test seam: inject a fake `spawnSession` (the fake-agent helper) instead of the real ACP client. */
  spawn?: typeof defaultSpawnSession;
  now?: () => Date;
  hookTimeoutSeconds?: number;
  /**
   * T023 quota tracking: every `usage_update` ledger line is also fed to
   * the quota service for this session's vendor/account (countdown,
   * `quota_low`/`quota_exhausted`). Optional — tests and pre-`.agile/`
   * daemons run without it.
   */
  quota?: { recordUsage(vendor: string, account: string, line: LedgerLine): Promise<unknown> };
  /** Vendor account this session is billed to. Defaults to `'default'` until routing threads the chosen account through. */
  account?: string;
  /**
   * T026 tier-0 sandbox: `true` when this session's vendor has ungated exec
   * (`VendorConfig.requires_sandbox` in `@agile-agents/shared` — Codex,
   * Grok per design §6) and must be refused rather than run unsandboxed
   * when no tier-0 backend is available. Defaults `false` — callers that
   * haven't wired `vendors.yaml` through yet (see the pipeline report's
   * "wiring the manager needs to do") get today's unsandboxed behaviour,
   * same as before this ticket.
   */
  requiresSandbox?: boolean;
  /**
   * T026 round 2 (review round 1 B2): explicit opt-in to run *this*
   * session's vendor under tier 0 even when it doesn't `requiresSandbox` —
   * a future config/policy surface's seam. Defaults `false`, which is what
   * keeps today's behaviour unchanged for Claude/Pi sessions on a host
   * that happens to have a tier-0 backend available (a backend existing is
   * never itself a reason to wrap — see `sandbox/wrap.ts`'s header).
   */
  sandboxEnabled?: boolean;
  /** Test seam: override how the agent process command is wrapped for tier-0 sandboxing before spawn. Defaults to the real `sandbox.wrapAgentCommand`. */
  wrapCommand?: WrapAgentCommandFn;
  /**
   * T022: only consulted when `provider.id === 'pi'` — the Pi agent config
   * directory `installPiExtension` writes `extensions/agile.ts` and
   * `settings.json` into (`resolvePiAgentDir()`'s default when unset). Test
   * seam so a session test never touches the real `~/.pi/agent`.
   */
  piAgentDir?: string;
  /** Test seam: inject a fake `installPiExtension` instead of the real filesystem writer, so a non-Pi-provider test never pays for the (harmless but pointless) real check. Defaults to the real `installPiExtension`. */
  installPiExtension?: typeof installPiExtension;
  /**
   * Architect-only (T031 — CLAUDE.md v0 default: "Architect planning turn:
   * try Claude `plan` mode first ... If plan mode blocks the architect's
   * MCP writes, run `default` mode with a daemon-side `approve_plan`
   * gate."). `'plan'` (the default) sends `modeId: 'plan'` on a Claude
   * spawn, so `ExitPlanMode` arrives as the "Approve Plan"
   * `session/request_permission` (`kind: 'switch_mode'`,
   * design/spike-findings.md §C3) this module routes to the `approve_plan`
   * gate below. `'default'` is the documented fallback — DESIGN-GAP
   * (`architect/session.ts`'s own header, carried over unresolved: whether
   * plan mode's read-only restriction also blocks the architect's own MCP
   * verb calls is unmeasured in this container, no live vendor login
   * available — see CLAUDE.md "Cloud sessions"), so this stays a
   * caller-chosen seam rather than something this module auto-detects.
   * Ignored for every non-architect role and for a non-Claude provider (no
   * `switch_mode`/plan-mode concept measured on any other vendor —
   * `provider.defaultModeId` applies unchanged there).
   */
  architectMode?: 'plan' | 'default';
  /**
   * Directory for this session's vendor-process stderr log
   * (`<dir>/<agentId>-<spawn timestamp>.stderr.log`, appended as chunks
   * arrive). The runner passes `<repoRoot>/.agile-daemon-cache/sessions`
   * (gitignored, a sibling of the other daemon-cache subdirs). Without it
   * the vendor's stderr is dropped, and a session that dies or blocks at
   * startup (bad login, rejected flag, missing binary) leaves no trace
   * beyond a `last_seen` that never advances. Never fatal: a failed
   * mkdir/append is swallowed so logging can't take a spawn down.
   */
  stderrLogDir?: string;
  /** Test seam: how often to re-poll a pending `approve_plan` gate (see `architectMode`). Defaults to 200ms. */
  architectGatePollMs?: number;
  /** Test seam: how long to wait on a pending `approve_plan` gate before denying the plan. Defaults to 5 minutes. */
  architectGateTimeoutMs?: number;
}

export interface AgentExitInfo {
  agentId: AgentId;
  ticket: TicketId;
  /** Human-readable reason recorded on the ticket's history and the escalate message. */
  reason: string;
  /** Whether the ticket was actually transitioned back to `ready` (false if it wasn't in a live status any more — already reviewed/QA'd/done out from under the exit). */
  ticketReadied: boolean;
}

export interface AgentSessionHandle {
  agentId: AgentId;
  ticket: TicketId;
  role: PermissionRole;
  worktree: string;
  session: SpawnedSession;
  responder: PermissionResponderHandle;
  /** Resolves once the process has exited/crashed *and* the exit/crash handling (ticket -> ready, escalate, deleteAgent) has finished. Never rejects. */
  exited: Promise<AgentExitInfo>;
  /**
   * Sends a fresh `session/prompt` turn to this still-live session (T021
   * round 3) — the seam a re-review (or any other need to talk to an
   * already-spawned agent a second time) uses instead of respawning under
   * the same agent id, which `Runner.spawn` refuses while a session is
   * still live. Rejects if the turn itself fails (same fail-loud handling
   * as the initial spawn prompt: the process is stopped and the exit/crash
   * path runs before this rejects) — a caller should treat a rejection the
   * same way a failed spawn would be treated.
   */
  prompt(text: string): Promise<unknown>;
  /** `session.cancel()` + `session.close()`, for a graceful stop (`runner.stop`) — does not itself run the exit/crash handling (that's `exited`, driven by the session's own `exit` event either way). */
  stop(): void;
}

/**
 * T027: the first `prompt()` on a Cursor/Grok session fails with
 * `AuthRequiredError` until the ACP `authenticate` round trip runs
 * (design/spike-findings.md §C2/§D: "Cursor … ACP `authenticate
 * (cursor_login)` required"; "Grok … needs ACP `authenticate` (OAuth)").
 * Tries each `provider.authMethods` id **in order, one at a time**, retrying
 * the prompt after each: the first retry that succeeds (or fails with
 * anything other than `AuthRequiredError`) short-circuits the loop, so a
 * two-method vendor doesn't waste — or worse, get blocked by — an
 * `authenticate` call for a method it turns out not to need (round 2 fix,
 * review round 1 nit: the original ran *every* method id unconditionally,
 * so a rejection on the first id would throw out of the loop before the
 * second was ever tried). Empty for every vendor that authenticates
 * ambiently (Claude/Codex/Gemini, §C/§D) — a one-branch no-op re-throw for
 * them. A provider that lists no auth methods but still throws
 * `AuthRequiredError` re-throws unchanged — there is nothing this function
 * can do about a vendor `resolveAcpProvider` didn't say needed a handshake.
 */
/**
 * `session.prompt()` never rejects for a turn that dies mid-flight — a
 * `close()`/`exit`/transport `error` settles the in-flight turn with a
 * *resolved* `SessionReply` (`status: 'failed'`, `acp-client/src/
 * session.ts`'s `turnEndFromError`/`replyFromFinalMessage` — correct on
 * that package's own terms: a turn ending in error is still a turn that
 * ended). This module's callers (`runPromptTurn`'s fail-loud handling,
 * `Runner.promptAgent`'s callers) need the opposite: "the turn reached a
 * live agent" vs. "the request went to a corpse" are different outcomes,
 * and a re-review that quietly "succeeds" against a dead session (T021
 * round 4, opus review round 3 nit) is worse than one that visibly fails.
 * So a resolved `status: 'failed'` reply is turned into a rejection here,
 * before `runPromptTurn`'s own catch ever sees it.
 */
function rejectOnFailedReply(reply: unknown): unknown {
  const r = reply as Partial<SessionReply> | undefined;
  if (r && r.status === 'failed') {
    throw new Error(r.error?.message ?? 'ACP prompt turn failed with no error message');
  }
  return reply;
}

async function promptWithAuthRetry(
  session: SpawnedSession,
  provider: AcpProviderConfig,
  brief: string,
): Promise<unknown> {
  try {
    return rejectOnFailedReply(await session.prompt(brief));
  } catch (err) {
    if (!(err instanceof AuthRequiredError) || provider.authMethods.length === 0) throw err;
    let lastErr: unknown = err;
    for (const methodId of provider.authMethods) {
      try {
        await session.authenticate(methodId);
        return rejectOnFailedReply(await session.prompt(brief));
      } catch (retryErr) {
        lastErr = retryErr;
        if (!(retryErr instanceof AuthRequiredError)) throw retryErr;
        // Still needs auth — try the next method id, if any.
      }
    }
    throw lastErr;
  }
}

/**
 * Builds the MCP stdio server entry T011's report specifies: `agile mcp
 * --agent <id> --ticket <id>`, plus `--socket <path>` whenever the session
 * has an explicit `socketPath`. The MCP server runs with the *worktree* as
 * its cwd, and `discoverConfig` resolves the daemon socket relative to the
 * cwd's repo root — which for a `.worktrees/**` checkout is the worktree
 * itself, not the main repo, so without this the bridge dies on startup
 * (`connect ENOENT .worktrees/<ticket>/.agile-daemon.sock`) and the session
 * has no daemon verbs at all: it does the work, ends its turn, and nothing
 * ever re-prompts it (the first real `test:live` run — every engineer
 * committed, then sat idle until the liveness watchdog). The hook command
 * already carries the socket as an `AGILE_SOCKET_PATH=` prefix
 * (`hook/settings.ts`); this is the MCP descriptor's equivalent, as an
 * argument rather than an env entry because the ACP `env` field's shape
 * differs between vendors and an argument works everywhere.
 *
 * `env: []` is load-bearing even though empty: measured on a live daemon
 * (two real Claude sessions, descriptors identical except for this field),
 * `@agentclientprotocol/claude-agent-acp` 0.75.1 silently drops a stdio
 * MCP server whose descriptor has no `env` at all — the session lists no
 * `mcp__agile__*` tools and the bridge's `session/create` trace shows no
 * MCP phase. With `env: []` (the ACP schema's `EnvVariable[]` shape) the
 * tools appear. Without it, `--socket` alone still left every live session
 * with zero daemon verbs.
 */
function mcpServerConfig(
  cli: CliInvocation,
  agentId: AgentId,
  ticket: TicketId,
  socketPath: string | undefined,
): unknown {
  return {
    name: 'agile',
    command: cli.command,
    args: [
      ...cli.args,
      'mcp',
      '--agent',
      agentId,
      '--ticket',
      ticket,
      ...(socketPath !== undefined ? ['--socket', socketPath] : []),
    ],
    env: [],
  };
}

/**
 * T031: `ExitPlanMode` arrives titled "Approve Plan" with `kind:
 * 'switch_mode'` (design/spike-findings.md §C3). Title match is a fallback
 * for a vendor/version that doesn't set `kind` — mirrors `architect/
 * session.ts`'s own `isExitPlanModeRequest` (not imported from there: this
 * ticket's file ownership is `runner/session.ts`, not `architect/**`, and
 * the check is three lines).
 */
function isArchitectPlanRequest(toolCall: { kind?: string; title?: string } | undefined): boolean {
  if (!toolCall) return false;
  if (toolCall.kind === 'switch_mode') return true;
  return typeof toolCall.title === 'string' && /approve plan/i.test(toolCall.title);
}

function findPermissionOption(
  options: Array<{ optionId: string; kind: string }>,
  wantKinds: readonly string[],
): { optionId: string; kind: string } | undefined {
  for (const kind of wantKinds) {
    const found = options.find((o) => o.kind === kind);
    if (found) return found;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits on the `approve_plan` gate `GateService.request` opened, polling
 * `GateService.get` until it resolves (a human's `respond`, an EM/architect
 * delegate firing synchronously inside `request` itself, or this
 * function's own timeout) — same polling shape as `architect/session.ts`'s
 * `awaitPlanApproval` (that module has no push/subscribe surface to wait on
 * either; `GateService` doesn't gain one from this ticket).
 */
/** The plan text a Claude `ExitPlanMode` permission request carries (`toolCall.rawInput.plan`), else the tool title, else nothing — capped to the message-body budget. */
function planSummaryFrom(params: unknown): string | undefined {
  const toolCall = asRecord(asRecord(params)?.toolCall);
  const rawInput = asRecord(toolCall?.rawInput);
  const plan = rawInput?.plan;
  if (typeof plan === 'string' && plan.trim().length > 0) {
    return `architect plan: ${plan.trim()}`.slice(0, 800);
  }
  const title = toolCall?.title;
  return typeof title === 'string' && title.length > 0 ? `architect: ${title}` : undefined;
}

async function awaitArchitectPlanApproval(
  gateService: GateService,
  policy: Policy,
  pollMs: number,
  timeoutMs: number,
  now: () => Date,
  summary?: string,
): Promise<boolean> {
  const request = await gateService.request('approve_plan', {
    policy,
    hilKind: 'approve_decision',
    from: 'architect',
    // What the architect is asking to have approved — the plan text when
    // the vendor put it in the request, else the tool title. The EM
    // delegate decided the first live approve_plan with "no summary text
    // was recorded" (fifth run).
    ...(summary !== undefined ? { summary } : {}),
  });
  if (request.status === 'resolved') return request.decision === 'approve';

  const start = now().getTime();
  while (true) {
    const current = gateService.get(request.id);
    if (current.status === 'resolved') return current.decision === 'approve';
    if (now().getTime() - start >= timeoutMs) return false;
    await sleep(pollMs);
  }
}

/** Best-effort model id from the `_agile/session_state` notification's `configOptions` — shape is vendor-specific and not modeled anywhere; falls back to `'unknown'` rather than guessing at a field name that isn't there. */
function modelFromSessionState(params: unknown): string | undefined {
  const p = asRecord(params);
  const configOptions = p?.configOptions;
  if (Array.isArray(configOptions)) {
    for (const opt of configOptions) {
      const o = asRecord(opt);
      if (typeof o?.model === 'string') return o.model;
      if (typeof o?.currentValue === 'string' && o?.id === 'model') return o.currentValue;
    }
  }
  const record = asRecord(configOptions);
  if (typeof record?.model === 'string') return record.model;
  return undefined;
}

export function startAgentSession(opts: AgentSessionOptions): AgentSessionHandle {
  const {
    store,
    bus,
    role,
    agentId,
    ticket,
    worktreePath,
    brief,
    gateService,
    now = () => new Date(),
  } = opts;
  const cliBin = normalizeCliBin(opts.cliBin);
  const provider = opts.provider ?? ACP_PROVIDERS.claude;
  const spawn = opts.spawn ?? defaultSpawnSession;
  const currentSprintId =
    opts.currentSprintId ?? (() => pickCurrentSprint(store.listSprints())?.id);

  // Tier 1 (§6): hook wiring active before the agent's first tool call.
  writeClaudeSettings(worktreePath, {
    agileBin: cliInvocationToShell(cliBin),
    socketPath: opts.socketPath,
    // T012 QA/review round: disambiguates hook calls when a reviewer and an
    // engineer share one physical worktree (§12) — see `hook/service.ts`'s
    // `resolveAgentByCwd`. Each session's own `.claude/settings.json` write
    // is read by Claude once at its own startup, so a later session sharing
    // the same worktree overwriting this file with its own `agentId` does
    // not retroactively change an already-running session's hook command.
    agentId,
    timeoutSeconds: opts.hookTimeoutSeconds,
  });

  // T026 tier-0 (§6): wraps the vendor command under whatever sandbox
  // backend this host supports before it ever spawns. Throws
  // `SandboxRequiredError` (fail-closed) when `requiresSandbox` is set and
  // `detectBackend()` resolves `none` — the caller (`runner.spawn`) must not
  // catch that into an unsandboxed spawn. Round 2 (review round 1 B2): a
  // backend merely being *available* is never itself a reason to wrap —
  // `wrapAgentCommand` only wraps when `requiresSandbox` or `sandboxEnabled`
  // is explicitly set, so this call is a no-op passthrough for today's
  // Claude/Pi sessions exactly as before this ticket. Round 2 B3: threads
  // `socketPath` through so the rendered profile can grant the daemon
  // socket — without it, turning tier 0 on silently breaks tier 1.
  const wrapCommand = opts.wrapCommand ?? defaultWrapAgentCommand;
  const wrapped = wrapCommand({
    role,
    worktreePath,
    vendor: provider.id,
    command: provider.command,
    args: provider.args,
    requiresSandbox: opts.requiresSandbox,
    enabled: opts.sandboxEnabled,
    socketPath: opts.socketPath,
  });
  // T022: Pi has no ACP-level hook equivalent — its own enforcement lives in
  // the `agile` extension (`pi/agile-extension.ts`), which this install call
  // makes sure is on disk (idempotent) and self-guards on `AGILE_PI_GATE`,
  // set below only for a Pi-provider session so every other vendor's
  // envOverrides are unaffected.
  //
  // Round 2 review fix (B3): `installPiExtension` itself already never
  // throws for a `settings.json` (`quietStartup`) failure — this try/catch
  // is the outer safety net the review asked for regardless, so a bug
  // anywhere in that call can never silently take the whole spawn down
  // *except* for the one failure mode that's genuinely load-bearing: a
  // foreign, non-agile-owned `extensions/agile.ts` at the target path
  // (`ForeignPiExtensionError`, B2) — without the extension file actually
  // on disk there is no tier-1 gate for this session at all, so that one
  // is re-thrown rather than swallowed (CLAUDE.md: "hooks are the
  // enforcement layer" — spawning ungated is worse than not spawning).
  if (provider.id === 'pi') {
    const install = opts.installPiExtension ?? installPiExtension;
    try {
      install({
        agentDir: opts.piAgentDir ?? resolvePiAgentDir(),
        extensionSource: readAgileExtensionSource(),
      });
    } catch (err) {
      if (err instanceof ForeignPiExtensionError) throw err;
      throw new Error(
        `startAgentSession: installing the agile Pi extension for ${agentId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // T027 review round 1 B1: `modeId` must come from the *provider's own*
  // mode vocabulary (`defaultModeId` — undefined for a vendor with no mode
  // concept, e.g. Grok, spike-findings.md §C2 "no modes"), never a flat
  // `'default'` — that's a Claude-only mode id, and `session/set_mode`
  // rejects it for every other vendor, failing the whole `ensureSession()`
  // and therefore the first prompt. Cursor's reviewer gets `ask` as a
  // courtesy nudge on top of that (§C3 — prompt-level only, never a
  // substitute for the reviewer table's own execute/edit deny verdicts,
  // which run unchanged regardless of mode); every other vendor/role keeps
  // its provider's own default. T031: the architect on Claude gets `'plan'`
  // (CLAUDE.md v0 default, `opts.architectMode` seam — see its doc comment)
  // — the request_permission handler below is what turns `ExitPlanMode`
  // into the `approve_plan` gate once this mode actually raises one.
  const architectPlanMode =
    role === 'architect' && provider.id === 'claude' && (opts.architectMode ?? 'plan') === 'plan';
  const modeId =
    (provider.id === 'cursor' ? cursorModeIdFor(role) : undefined) ??
    (architectPlanMode ? 'plan' : undefined) ??
    provider.defaultModeId;

  const stderrLog = openStderrLog(opts.stderrLogDir, agentId, now());
  const spawnOptions: SpawnSessionOptions = {
    cmd: wrapped.command,
    args: wrapped.args,
    cwd: worktreePath,
    envOverrides: {
      ...provider.envOverrides,
      ...wrapped.envOverrides,
      AGILE_AGENT: agentId,
      AGILE_TICKET: ticket,
      ...(opts.socketPath ? { AGILE_SOCKET_PATH: opts.socketPath } : {}),
      ...(provider.id === 'pi' ? { [PI_GATE_ENV_VAR]: '1' } : {}),
    },
    clientCapabilities: provider.clientCapabilities,
    mcpServers: [mcpServerConfig(cliBin, agentId, ticket, opts.socketPath)],
    ...(stderrLog ? { onStderr: stderrLog.append } : {}),
    // Omitted entirely (not even `modeId: undefined`) when the provider has
    // no mode — `SpawnSessionOptions.modeId` being present-but-undefined
    // vs. absent doesn't matter to `ensureSession()`'s `!== undefined`
    // check, but this keeps the built object honest about what's actually
    // being requested.
    ...(modeId !== undefined ? { modeId } : {}),
    // T027: Grok routes all file I/O through client fs and has no other
    // gateable surface (design/spike-findings.md §C2/§C3) — this is the
    // one seam where a reviewer's write can be refused with a reason the
    // model actually sees (`permissions/vendor-fs.ts`). No other provider
    // is measured using client fs for real I/O, so this stays Grok-only.
    ...(provider.id === 'grok' ? { fsImpl: buildGrokFsPolicy(role) } : {}),
  };
  const session = spawn(spawnOptions);

  const responder = buildPermissionResponder(store, {
    role,
    ticket,
    agent: agentId,
    worktreePath,
    session,
    ...(gateService
      ? {
          requestHil: (input) =>
            gateService
              .request(`permission:${role}`, {
                policy: store.getPolicy(),
                ticket: input.ticket,
                hilKind: input.hilKind,
                from: input.agent,
                summary: input.summary,
              })
              .then((req) => ({ id: req.id })),
        }
      : {}),
  });

  let model = 'unknown';
  let lastUsedTokens = 0;
  let settled = false;
  let resolveExited!: (info: AgentExitInfo) => void;
  const exited = new Promise<AgentExitInfo>((resolve) => {
    resolveExited = resolve;
  });

  /**
   * Every fire-and-forget store write this module makes (heartbeat, ledger,
   * tool_call observation) is added here and removed on settle. `finish()`
   * awaits every entry still pending — review round fix: an earlier version
   * of this tracker kept only the *latest* write (on the theory that
   * `StateStore`'s mutex is strictly FIFO, so awaiting the last one enqueued
   * would imply every earlier one had landed too); that reasoning has a gap
   * whenever two writes are enqueued through paths that don't themselves
   * serialize before reaching the mutex (e.g. two `track()` calls from two
   * different listener invocations racing each other's own pre-mutex async
   * work), so a real accumulating set is what's actually needed to be sure
   * `finish()` never resolves `exited` while a write from this session is
   * still in flight. Without this, a caller that deletes the worktree/repo
   * right after `exited` resolves can race a still-in-flight deferred commit
   * into a "not a git repository" error — the failure this tracker exists to
   * close off.
   */
  const pendingWrites = new Set<Promise<unknown>>();
  function track(promise: Promise<unknown>): void {
    let settled: Promise<void>;
    settled = promise.then(
      () => void pendingWrites.delete(settled),
      () => void pendingWrites.delete(settled),
    );
    pendingWrites.add(settled);
  }

  /** Re-applies role/worktree/session_id if the heartbeat write just dropped them (see file header). */
  async function recordHeartbeat(patch: { vendor?: string; model?: string } = {}): Promise<void> {
    await bus.heartbeat(agentId, { vendor: provider.id, model, ticket, ...patch });
    let current: ReturnType<StateStore['getAgent']> | undefined;
    try {
      current = store.getAgent(agentId);
    } catch {
      return;
    }
    if (
      current.role === role &&
      current.worktree === worktreePath &&
      (session.sessionId === null || current.session_id === session.sessionId)
    ) {
      return;
    }
    await store.putAgent(agentId, {
      ...current,
      role,
      worktree: worktreePath,
      ...(session.sessionId !== null ? { session_id: session.sessionId } : {}),
    });
  }

  async function finish(reason: string): Promise<void> {
    if (settled) return;
    settled = true;
    unsubscribe();
    // See `pendingWrites`'s doc comment — waits for every fire-and-forget
    // write still in flight, not just the most recently started one.
    await Promise.all([...pendingWrites]);

    let ticketReadied = false;
    try {
      const current = store.getTicket(ticket);
      const LIVE_STATUSES = new Set(['assigned', 'in_progress', 'in_review', 'in_qa', 'blocked']);
      if (LIVE_STATUSES.has(current.status)) {
        await store.transitionTicket(ticket, 'ready', { by: agentId, reason });
        ticketReadied = true;
      }
    } catch {
      // Ticket vanished or transition illegal from under us — nothing to ripple back.
    }

    await bus.send({
      id: ulid(),
      ts: now().toISOString(),
      from: agentId,
      to: ['em'],
      kind: 'escalate',
      priority: 'urgent',
      ticket,
      body: `${agentId} (${role}) session ended: ${reason}`.slice(0, 800),
      requires_ack: true,
    });

    try {
      store.getAgent(agentId);
      await store.deleteAgent(agentId);
    } catch {
      // Already gone (e.g. `checkLiveness` beat us to it) — fine.
    }

    // Flushes any deferred-commit ledger/tool_call writes queued earlier in
    // this session's life (store.ts's "Deferred-commit batching") — without
    // this, `exited` can resolve while a background flush timer is still
    // due, and a caller that tears down the worktree/repo right after
    // `exited` races that timer into a "not a git repository" failure.
    await store.flush();
    resolveExited({ agentId, ticket, reason, ticketReadied });
  }

  const unsubscribe = session.on((event: AgentEvent) => {
    track(recordHeartbeat());

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
      const params = frame.params as AcpPermissionRequestParams;
      // T031: an architect's `ExitPlanMode` ("Approve Plan") request is the
      // `approve_plan` gate itself (design/spike-findings.md §C3), routed
      // to `GateService` rather than through `architectVerdict` (which has
      // no notion of `switch_mode` at all — it isn't a read/edit/execute/
      // fetch tool class, so it would otherwise hit the safe-default deny).
      // Every other permission request from an architect session (an edit,
      // an exec) still goes through the normal responder below, same as
      // any other role.
      if (role === 'architect' && isArchitectPlanRequest(params.toolCall)) {
        void (async () => {
          const options = params.options ?? [];
          let approved = false;
          // Review round 2 (opus blocker 1): `store.getPolicy()` and every
          // `GateService` call below are fallible (a missing
          // `.agile/policy.yaml`, a store write failure, a corrupt/removed
          // HIL record) — and, unlike `permissions/responder.ts`'s own
          // "respond before the fallible event-log write" rule (quoted in
          // its file header: "a store hiccup must not leave the agent's
          // turn hung on an already-decided answer"), this branch used to
          // run every fallible call *before* ever responding to `frame.id`.
          // A thrown error here used to propagate straight out of this
          // `session.on` listener and into `acp-client`'s frame dispatch —
          // reproduced in review: the fake agent's permission request was
          // never answered at all, hanging the turn forever. Fail closed
          // instead: any error opening/polling the gate denies the plan
          // (never silently allows one nobody actually approved), and the
          // request is always answered before anything else in this branch
          // can fail again.
          let gateFailure: string | undefined;
          try {
            if (gateService) {
              approved = await awaitArchitectPlanApproval(
                gateService,
                store.getPolicy(),
                opts.architectGatePollMs ?? 200,
                opts.architectGateTimeoutMs ?? 5 * 60 * 1000,
                now,
                planSummaryFrom(params),
              );
            }
          } catch (err) {
            approved = false;
            gateFailure = err instanceof Error ? err.message : String(err);
          }

          const chosen = approved
            ? findPermissionOption(options, ['allow_once', 'allow_always'])
            : findPermissionOption(options, ['reject_once', 'reject_always']);
          if (chosen) {
            session.respondPermission(frame.id, {
              outcome: { outcome: 'selected', optionId: chosen.optionId },
            });
          } else {
            session.respondPermission(frame.id, { outcome: { outcome: 'cancelled' } });
          }

          const reason =
            gateFailure !== undefined
              ? `approve_plan gate unavailable (${gateFailure}) — denied`
              : gateService
                ? 'approve_plan gate'
                : 'approve_plan gate unavailable (no GateService wired) — denied';
          // Best-effort logging only, after the request is already
          // answered above — a failure here must never re-throw into this
          // listener (that's exactly the bug this fix closes).
          track(
            store
              .appendEvent(
                buildEvent('hook_decision', {
                  ticket,
                  agent: agentId,
                  data: { role, toolClass: 'other', decision: approved ? 'allow' : 'deny', reason },
                }),
                { commit: 'deferred' },
              )
              .catch(() => {}),
          );

          if (gateFailure !== undefined) {
            // Surface the failure through the same escalate shape `finish()`
            // uses for a session ending — em needs to see a broken gate,
            // but the architect session itself stays live (it can still
            // answer non-plan tool calls normally; only this one plan
            // request was denied).
            track(
              bus
                .send({
                  id: ulid(),
                  ts: now().toISOString(),
                  from: agentId,
                  to: ['em'],
                  kind: 'escalate',
                  priority: 'urgent',
                  ticket,
                  body: `${agentId} (${role}) approve_plan gate failed, plan denied: ${gateFailure}`.slice(
                    0,
                    800,
                  ),
                  requires_ack: true,
                })
                .catch(() => {}),
            );
          }
        })();
        return;
      }
      void responder.handleRequest(frame.id, params);
      return;
    }

    if (frame.acp === 'notification' && frame.message.method === '_agile/session_state') {
      const p = asRecord(frame.message.params);
      const resolvedModel = modelFromSessionState(p);
      if (resolvedModel !== undefined) {
        model = resolvedModel;
        track(recordHeartbeat({ model: resolvedModel }));
      }
      const sessionId = p?.sessionId;
      if (typeof sessionId === 'string') {
        try {
          const current = store.getAgent(agentId);
          track(store.putAgent(agentId, { ...current, session_id: sessionId }));
        } catch {
          // Not registered yet — the initial `putAgent` below will carry session_id once known.
        }
      }
      return;
    }

    if (frame.acp === 'notification' && frame.message.method === 'session/update') {
      const params = asRecord(frame.message.params);
      const update = asRecord(params?.update);
      const kind = update?.sessionUpdate;

      if (kind === 'usage_update') {
        const used = typeof update?.used === 'number' ? update.used : undefined;
        if (used !== undefined) {
          // DESIGN-GAP (file header): `usage_update` carries only
          // `{used, size}` — a running context-window total, not an
          // in/out split or a cost. `in_tokens` is the delta since the
          // last update (0 on the very first one, or if the counter went
          // backwards, e.g. a fresh turn); `out_tokens`/`cost_usd` stay 0.
          const delta = Math.max(0, used - lastUsedTokens);
          lastUsedTokens = used;
          // T012 QA round fix: a usage_update before any sprint exists used
          // to be silently dropped. `nosprint` is this codebase's existing
          // pre-sprint fallback file convention (`tools/service.ts`,
          // `tools/cache.ts`) — the ledger line still lands, plus a
          // `ledger_no_sprint` event so the gap is visible in the log, not
          // just in a ledger file nobody thought to check.
          const resolvedSprintId = currentSprintId();
          const noSprint = resolvedSprintId === undefined;
          const sprint = resolvedSprintId ?? 'nosprint';
          const ledgerLine = validateLedgerLine({
            ts: now().toISOString(),
            sprint,
            ticket,
            agent: agentId,
            model,
            in_tokens: delta,
            out_tokens: 0,
            cost_usd: 0,
            kind: ROLE_LEDGER_KIND[role],
          });
          track(store.appendLedgerLine(sprint, ledgerLine, { commit: 'deferred' }));
          // T023: the same line drives the per-account quota countdown.
          if (opts.quota) {
            track(opts.quota.recordUsage(provider.id, opts.account ?? 'default', ledgerLine));
          }
          if (noSprint) {
            track(
              store.appendEvent(
                buildEvent('ledger_no_sprint', {
                  ticket,
                  agent: agentId,
                  data: { in_tokens: delta },
                }),
                { commit: 'deferred' },
              ),
            );
          }
        }
        return;
      }

      if (kind === 'tool_call' || kind === 'tool_call_update') {
        track(
          store.appendEvent(
            buildEvent('tool_call', {
              ticket,
              agent: agentId,
              data: {
                toolCallId: update?.toolCallId,
                kind: update?.kind,
                title: update?.title,
                status: update?.status,
              },
            }),
            { commit: 'deferred' },
          ),
        );
      }
    }
  });

  // Registration (§5 "Storage": agents/<agent>.yaml) — before the first
  // prompt, so a crash during the very first turn still has a record to
  // clean up.
  //
  // `pid` (review round 3, opus item 3): `AgentRecord.pid` is optional
  // precisely so this never falls back to `process.pid` (the daemon's own
  // pid) — see this file's header. `session.pid` is `null` only in the
  // narrow window the spawned child's pid wasn't assigned (mirrors Node's
  // `ChildProcess.pid` being `undefined` in that case); when that happens
  // the record is still written (an idle-but-registered agent beats no
  // record at all), just without `pid`, and a warning event is logged so
  // the gap shows up in `log/events.jsonl` instead of silently resolving
  // to the wrong process.
  const spawnedPid = session.pid;

  /**
   * One prompt turn on this session, with the "a rejected prompt does not
   * imply the subprocess exits" fail-loud handling (T027 review round 1
   * B1's own reasoning, generalised in T021 round 3 to any turn, not just
   * the first): a session/update stream failing silently would strand
   * whatever ticket status this turn was supposed to advance. Shared by
   * the initial post-registration prompt below and the exported `prompt()`
   * handle method (T021 round 3 — a re-review/second turn on an already-
   * live session, since nothing else in this codebase re-prompts one; see
   * `runner/runner.ts`'s `promptAgent` and `pipeline-glue.ts`'s re-review
   * reuse branch, the callers this exists for). Rejects to the caller
   * (unlike the registration call site below, which swallows it — that one
   * has no caller to report back to) so `Runner.promptAgent` can surface a
   * failed re-prompt instead of silently doing nothing.
   */
  // Serializes turns on this session (T021 round 3): the ACP client
  // refuses a second `session/prompt` while one is still in flight
  // (`PROMPT_IN_FLIGHT` — a real single-turn-at-a-time protocol
  // constraint, not a bug to work around by racing it). The initial
  // post-registration prompt below is fire-and-forget from `spawn`'s own
  // point of view — a caller of the new `prompt()` handle method (a
  // re-review) has no way to know whether that first turn has actually
  // settled yet, so `runPromptTurn` queues onto whatever turn is already
  // running instead of calling `session.prompt` directly: each call waits
  // for the previous one to settle (success or failure) before sending its
  // own, but still resolves/rejects on its *own* turn's real outcome, not
  // the previous one's.
  let turnQueue: Promise<void> = Promise.resolve();
  async function runPromptTurn(text: string): Promise<unknown> {
    const runOnce = async (): Promise<unknown> => {
      try {
        return await promptWithAuthRetry(session, provider, text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await store
          .appendEvent(
            buildEvent('agent_put', {
              agent: agentId,
              ticket,
              data: { warning: `prompt failed, stopping session: ${message}` },
            }),
            { commit: 'deferred' },
          )
          .catch(() => {
            // Best-effort visibility only — `finish()` below is what
            // actually recovers the ticket/agent state regardless of
            // whether this event write lands.
          });
        session.cancel();
        session.close();
        await finish(`prompt failed: ${message}`);
        throw err;
      }
    };
    const result = turnQueue.then(runOnce, runOnce);
    // Never let one turn's rejection poison the queue for the *next* one —
    // only this call's own returned promise carries its outcome to its
    // caller.
    turnQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  void store
    .putAgent(agentId, {
      vendor: provider.id,
      model,
      ticket,
      ...(spawnedPid !== null ? { pid: spawnedPid } : {}),
      last_seen: now().toISOString(),
      role,
      worktree: worktreePath,
    })
    .then(() => {
      if (spawnedPid !== null) return undefined;
      return store.appendEvent(
        buildEvent('agent_put', {
          agent: agentId,
          ticket,
          data: {
            warning:
              'spawned agent pid unknown at registration; AgentRecord.pid omitted (never falls back to the daemon pid)',
          },
        }),
        { commit: 'deferred' },
      );
    })
    .then(() => runPromptTurn(brief))
    .catch(() => {
      // `runPromptTurn` already ran the full stop/escalate/`finish()`
      // recovery and rethrew only so a caller of `prompt()` can see the
      // failure — this initial call has no such caller, so it's swallowed
      // here (matches the pre-round-3 behavior exactly).
    });

  return {
    agentId,
    ticket,
    role,
    worktree: worktreePath,
    session,
    responder,
    exited,
    /**
     * Sends a fresh turn to this already-live session (T021 round 3):
     * `session/prompt` is otherwise only ever called once, at spawn — a
     * second review round (or any other multi-turn need) has no way to
     * reach a session that's still connected but idle without this. Real
     * ACP sessions support multiple prompt turns on one `session/new`
     * (that's the wire-level shape a multi-turn conversation already is);
     * `fake-agent.ts`'s `session/prompt` handler already re-runs its
     * (default one-`usage_update`-plus-`end_turn`) script on every call,
     * with no special-casing needed for a second call.
     */
    prompt(text: string) {
      return runPromptTurn(text);
    },
    stop() {
      // Deliberately does NOT call `unsubscribe()` here — `close()` only
      // *starts* tearing the process down (SIGTERM, escalating to SIGKILL
      // after a grace period); the exit/crash handling in `finish()` runs
      // off the session's own later `exit` event, through the same listener
      // a real crash drives. Unsubscribing here would silence that event
      // and `exited` would never resolve.
      session.cancel();
      session.close();
    },
  };
}
