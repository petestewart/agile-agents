/**
 * `startAgentSession` — spawns one ACP session for an already-placed
 * worktree and wires it into the daemon (T012 — design/
 * agile-agents-design.md §8 "Adapter contract": "(ticket, oracle_refs,
 * kb_refs, worktree) -> (diff, report, status, events)";
 * §5 "Liveness"; §6 tier 1/2 enforcement).
 *
 * Scope: this module owns exactly one running session's wiring — hook
 * settings, MCP config, permission responder, event log, heartbeat,
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
import type { AgentId, TicketId } from '@agile-agents/shared';
import { ulid } from '@agile-agents/shared';
import type { Bus } from '../bus';
import type { GateService } from '../gates';
import { writeClaudeSettings } from '../hook';
import {
  type AcpPermissionRequestParams,
  type PermissionResponderHandle,
  type PermissionRole,
  type TicketPermissionRole,
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
  role: TicketPermissionRole;
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
  /** Optional — hands `hil` permission verdicts to T018's `GateService` instead of the responder's default store-backed writer. */
  gateService?: GateService;
  /** Test seam: inject a fake `spawnSession` (the fake-agent helper) instead of the real ACP client. */
  spawn?: typeof defaultSpawnSession;
  now?: () => Date;
  hookTimeoutSeconds?: number;
  /** Vendor account this session is billed to. Defaults to `'default'`. */
  account?: string;
  /**
   * T026 tier-0 sandbox: `true` when this session's vendor has ungated exec
   * (`VendorConfig.requires_sandbox` in `@agile-agents/shared` — Codex,
   * Grok per design §6) and must be refused rather than run unsandboxed
   * when no tier-0 backend is available. Defaults `false`.
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
  role: TicketPermissionRole;
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
  // its provider's own default.
  const modeId =
    (provider.id === 'cursor' ? cursorModeIdFor(role) : undefined) ?? provider.defaultModeId;

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
      // Every git the session runs is headless: a `rebase --continue` or a
      // `commit` without -m would otherwise open core.editor and hang the
      // tool call (merge-conflict fix cycle, fifteenth live run).
      GIT_EDITOR: 'true',
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
    // T121: an ACP permission request used to open a `permission:<role>`
    // gate. Gate names are now the closed set `land | rule_accept |
    // classifier_review` (cockpit design §3.1) and a gate is raised on a
    // stream, which this ticket-keyed runner cannot name; T151 rebuilds
    // this as the classifier route band. Until then the responder falls
    // back to its own `bus/inbox/human` `hil_request` write.
  });

  let model = 'unknown';
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

    // T044 (QA round 1, finding 4): this notice is the DAEMON's, not the
    // agent's — the agent is gone, and the daemon is reporting that. It used
    // to go out `from: agentId`, which made `pipeline-glue.ts`'s
    // `advanceEngineerEscalations` (T040) read every engineer's normal exit
    // as the engineer escalating, open a `Question` for it, and leave every
    // merged ticket "Done · blocked / Waiting on you" on the Sprint tab.
    // `from: 'daemon'` is what `bus.ts`'s own liveness/redelivery notices
    // already use, and `routing.ts` always allows daemon -> em.
    await bus.send({
      id: ulid(),
      ts: now().toISOString(),
      from: 'daemon',
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
      void responder.handleRequest(frame.id, params);
      return;
    }

    if (frame.acp === 'notification' && frame.message.method === '_agile/session_state') {
      const p = asRecord(frame.message.params);
      const resolvedModel = modelFromSessionState(p);
      if (resolvedModel !== undefined) model = resolvedModel;
      const sessionId = p?.sessionId;
      /**
       * T044: the model id is written with `putAgent`, NOT through
       * `recordHeartbeat`. `StateStore.heartbeat` coalesces — a `last_seen`
       * less than `HEARTBEAT_COALESCE_MS` old with no ticket reassignment
       * pending is a pure no-op (see its own doc comment) — and this
       * notification arrives within milliseconds of the registration
       * `putAgent` below, so every model update was being swallowed and
       * every agent record kept the `'unknown'` fallback. That is what made
       * the control room's Team table read `claude/unknown` for every row.
       * One write carries both fields, since they arrive in one frame.
       */
      if (resolvedModel !== undefined || typeof sessionId === 'string') {
        try {
          const current = store.getAgent(agentId);
          track(
            store.putAgent(agentId, {
              ...current,
              ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
              ...(typeof sessionId === 'string' ? { session_id: sessionId } : {}),
            }),
          );
        } catch {
          // Not registered yet — the initial `putAgent` below carries
          // whatever `model`/`session_id` are known by the time it runs.
        }
      }
      return;
    }

    if (frame.acp === 'notification' && frame.message.method === 'session/update') {
      const params = asRecord(frame.message.params);
      const update = asRecord(params?.update);
      const kind = update?.sessionUpdate;

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

  // T044 (QA round 1, finding 1): establish the ACP session at spawn, not at
  // the first prompt. The model id arrives on the `session/new` result (the
  // `_agile/session_state` notification handled above), and a session that
  // is spawned but never prompted — the architect under the demo driver —
  // used to sit at `model: 'unknown'` forever. `open()` shares its
  // `session/new` with the first `prompt()` below, so nothing is sent twice.
  // Skipped for vendors that gate `session/new` behind `authenticate`
  // (Cursor/Grok): there the prompt path's auth retry owns the handshake.
  if (provider.authMethods.length === 0) {
    void session.open().catch(() => {
      // Reported through the prompt path (`runPromptTurn`) if it matters.
    });
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
