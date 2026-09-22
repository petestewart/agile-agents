/**
 * `startAgentSession` — spawns one ACP session for an already-placed
 * worktree and wires it into the daemon (design/cockpit-design.md §4.1:
 * the daemon "spawns the vendor ACP session with the worktree as cwd,
 * installs the hook config (§8.1); streams the session's output into the
 * thread, routes `ask` to the inbox, and updates `agent.*`").
 *
 * Scope: this module owns exactly one running session's wiring — hook
 * settings, MCP config, permission responder, the agent-registry entry the
 * hook resolves a `cwd` through, the vendor's stderr/stdout logs, the
 * output→thread stream, and exit/crash handling. `attach/service.ts` owns
 * *which* stream, which worktree and which brief; this module runs the
 * session once handed them.
 *
 * T130 replaced the ticket-shaped inputs (`role: TicketPermissionRole`,
 * `agentId`, `ticket`) with `{stream, session, role}`:
 *
 * - the registry entry is keyed by the **session id** and carries
 *   `stream`/`role`/`worktree`, which is exactly what `hook/service.ts`
 *   resolves a tool call's `cwd` into (§8.1 step 1). It is written before
 *   the first prompt and deleted on exit, so a `cwd` only ever resolves
 *   while a session is actually live;
 * - the session's own output is appended to the stream thread as `line`
 *   entries authored `agent:<session id>` (§2.1), coalesced per ACP
 *   message and capped at the thread body cap, with the untruncated stream
 *   written to `<home>/sessions/<id>/output.log` — "signal over volume at
 *   every boundary … raw output to files with pointers" (CLAUDE.md);
 * - `pid` stays optional and is never substituted with the daemon's own
 *   pid, so an operator's "kill the pid on record" can't point at `agiled`.
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
import type { AgentId, SessionRef, SessionRole, Stream } from '@agile-agents/shared';
import { THREAD_BODY_MAX_CHARS } from '@agile-agents/shared';
import { writeClaudeSettings } from '../hook';
import { permissionRoleFor } from '../hook/decide';
import {
  type AcpPermissionRequestParams,
  type PermissionResponderHandle,
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
import type { StreamService } from '../streams/service';
import { type CliInvocation, cliInvocationToShell, normalizeCliBin } from './cli-bin';

/** `<sessionDir>/<name>` appender that never throws — diagnostics must not take a session down. */
function openLog(dir: string, name: string): { path: string; append: (chunk: string) => void } {
  const path = join(dir, name);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Fall through: every append below is already best-effort.
  }
  return {
    path,
    append: (chunk) => {
      try {
        appendFileSync(path, chunk);
      } catch {
        // A full disk or a vanished dir must never take the session down.
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
  streams: StreamService;
  /** The stream this session is attached to — its id is what the thread and the registry entry carry. */
  stream: Stream;
  /** The session record `attach/service.ts` minted (id, vendor, model, effort, role). */
  session: SessionRef;
  role: SessionRole;
  /** Absolute path — the session's `cwd` and where `.claude/settings.json` is written. */
  worktreePath: string;
  /** Rendered role brief (`runner/brief.ts`) — sent as the first `prompt()`. */
  brief: string;
  /** `<home>/sessions/<session id>/` — the vendor's stderr log and the untruncated output log. */
  sessionDir: string;
  /** How to invoke the `agile` CLI, for both the hook command and the MCP server's stdio command (`runner/cli-bin.ts`). Defaults to `'agile'` (on `$PATH`). */
  cliBin?: string | CliInvocation;
  /** `AGILE_SOCKET_PATH` for the worktree's hook + MCP bridge — a `.worktrees/**` cwd resolves to the wrong repo root without it. */
  socketPath?: string;
  provider?: AcpProviderConfig;
  /** Test seam: inject a fake `spawnSession` (the fake-agent helper) instead of the real ACP client. */
  spawn?: typeof defaultSpawnSession;
  now?: () => Date;
  hookTimeoutSeconds?: number;
  /** T026 tier-0: `true` when this vendor's exec is ungated everywhere and must be refused rather than run unsandboxed. */
  requiresSandbox?: boolean;
  /** T026: explicit opt-in to run this session under tier 0 even when it doesn't `requiresSandbox`. */
  sandboxEnabled?: boolean;
  /** Test seam: override how the agent command is wrapped for tier-0 sandboxing before spawn. */
  wrapCommand?: WrapAgentCommandFn;
  /** T022: only consulted for `provider.id === 'pi'` — the Pi agent dir the extension is installed into. */
  piAgentDir?: string;
  /** Test seam: inject a fake `installPiExtension`. */
  installPiExtension?: typeof installPiExtension;
  /**
   * T137: called every time a prompt turn resolves normally. What the end
   * of a turn *means* — the worker is finished, or it is waiting on an
   * answer — is a stream question, so the rule lives in
   * `attach/service.ts` and this module stays vendor-only. A failed turn
   * never calls it: `runPromptTurn` has already stopped the session and
   * `exited` carries that outcome.
   */
  onTurnEnd?: (info: { session: string; stream: string; turn: number }) => void;
}

export interface AgentExitInfo {
  session: string;
  stream: string;
  /** Human-readable reason, written onto the thread by the attach service. */
  reason: string;
  /** False when the session ended on a transport error or a failed prompt — `agent.status: blocked` rather than `done`. */
  ok: boolean;
}

export interface AgentSessionHandle {
  sessionId: string;
  stream: string;
  role: SessionRole;
  worktree: string;
  session: SpawnedSession;
  responder: PermissionResponderHandle;
  /** Resolves once the process has exited/crashed *and* this module's own cleanup has finished. Never rejects. */
  exited: Promise<AgentExitInfo>;
  /** Sends a fresh `session/prompt` turn to this still-live session (an answered question, a human line from the composer). */
  prompt(text: string): Promise<unknown>;
  /** `session.cancel()` + `session.close()` — the exit path still runs off the session's own `exit` event. */
  stop(): void;
}

/**
 * `session.prompt()` resolves (never rejects) for a turn that dies
 * mid-flight — `status: 'failed'`. Callers here need the opposite: "the
 * turn reached a live agent" and "the request went to a corpse" are
 * different outcomes, so a failed reply becomes a rejection.
 */
function rejectOnFailedReply(reply: unknown): unknown {
  const r = reply as Partial<SessionReply> | undefined;
  if (r && r.status === 'failed') {
    throw new Error(r.error?.message ?? 'ACP prompt turn failed with no error message');
  }
  return reply;
}

/**
 * The first `prompt()` on a Cursor/Grok session fails with
 * `AuthRequiredError` until the ACP `authenticate` round trip runs
 * (spike-findings.md §C2/§D). Tries each `provider.authMethods` id in
 * order, retrying the prompt after each; empty for every vendor that
 * authenticates ambiently.
 */
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
 * The MCP stdio server entry every session is configured with: `agile mcp
 * --session <id>`, plus `--socket <path>` whenever the session has an
 * explicit one (the bridge runs with the *worktree* as cwd, which resolves
 * to the wrong repo root without it).
 *
 * `env: []` is load-bearing even though empty: measured on a live daemon,
 * `@agentclientprotocol/claude-agent-acp` silently drops a stdio MCP
 * server whose descriptor has no `env` at all — the session then lists no
 * `mcp__agile__*` tools at all.
 */
function mcpServerConfig(
  cli: CliInvocation,
  sessionId: string,
  socketPath: string | undefined,
): unknown {
  return {
    name: 'agile',
    command: cli.command,
    args: [
      ...cli.args,
      'mcp',
      '--session',
      sessionId,
      ...(socketPath !== undefined ? ['--socket', socketPath] : []),
    ],
    env: [],
  };
}

/** Best-effort model id from the `_agile/session_state` notification's `configOptions` — vendor-specific and not modeled anywhere. */
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

/**
 * `session/update` kinds that report on the session rather than the turn's
 * content: they arrive between two chunks of one streaming agent message
 * and must not close it (T137).
 */
const NON_BOUNDARY_UPDATES: readonly string[] = [
  'usage_update',
  'current_mode_update',
  'available_commands_update',
];

/** The text of one `agent_message_chunk`'s content, or null for anything else. */
function chunkText(content: unknown): string | null {
  const c = asRecord(content);
  if (c === null) return null;
  return typeof c.text === 'string' ? c.text : null;
}

export function startAgentSession(opts: AgentSessionOptions): AgentSessionHandle {
  const { store, streams, stream, session: sessionRef, role, worktreePath, brief } = opts;
  const sessionId = sessionRef.id;
  const now = opts.now ?? (() => new Date());
  const cliBin = normalizeCliBin(opts.cliBin);
  const provider = opts.provider ?? ACP_PROVIDERS.claude;
  const spawn = opts.spawn ?? defaultSpawnSession;
  const policyRole = permissionRoleFor(role);

  // Tier 1 (§8.1): hook wiring active before the agent's first tool call.
  // `agentId` is the session id — the `agile_agent` hint the CLI forwards,
  // which disambiguates two sessions sharing one worktree.
  writeClaudeSettings(worktreePath, {
    agileBin: cliInvocationToShell(cliBin),
    socketPath: opts.socketPath,
    agentId: sessionId,
    timeoutSeconds: opts.hookTimeoutSeconds,
  });

  // T026 tier-0 (§4.3): wraps the vendor command under whatever sandbox
  // backend this host supports. Throws `SandboxRequiredError` (fail-closed)
  // when `requiresSandbox` is set and no backend resolves. A backend merely
  // being available is never itself a reason to wrap.
  const wrapCommand = opts.wrapCommand ?? defaultWrapAgentCommand;
  const wrapped = wrapCommand({
    role: policyRole,
    worktreePath,
    vendor: provider.id,
    command: provider.command,
    args: provider.args,
    requiresSandbox: opts.requiresSandbox,
    enabled: opts.sandboxEnabled,
    socketPath: opts.socketPath,
  });

  // T022: Pi has no ACP-level hook equivalent — its enforcement lives in
  // the `agile` extension, which this install call makes sure is on disk.
  // A foreign, non-agile-owned `extensions/agile.ts` is re-thrown rather
  // than swallowed: without the extension there is no tier-1 gate at all,
  // and spawning ungated is worse than not spawning.
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
        `startAgentSession: installing the agile Pi extension for ${sessionId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // The mode id must come from the provider's own vocabulary — a flat
  // `'default'` is a Claude-only mode id and `session/set_mode` rejects it
  // for every other vendor, failing `ensureSession()` and the first prompt.
  const modeId =
    (provider.id === 'cursor' ? cursorModeIdFor(policyRole) : undefined) ?? provider.defaultModeId;

  const stderrLog = openLog(opts.sessionDir, 'stderr.log');
  const outputLog = openLog(opts.sessionDir, 'output.log');

  // D12: the vendor's own model/effort levers, from the provider registry —
  // config per vendor, never a code path. An unmapped vendor contributes
  // nothing here and the attach service writes the "effort ignored" line.
  const modelContribution = provider.model?.(sessionRef.model) ?? {};
  const effortContribution =
    sessionRef.effort !== undefined ? (provider.effort?.(sessionRef.effort) ?? {}) : {};

  const spawnOptions: SpawnSessionOptions = {
    cmd: wrapped.command,
    args: [...wrapped.args, ...(modelContribution.args ?? []), ...(effortContribution.args ?? [])],
    cwd: worktreePath,
    envOverrides: {
      ...provider.envOverrides,
      ...wrapped.envOverrides,
      ...modelContribution.env,
      ...effortContribution.env,
      AGILE_AGENT: sessionId,
      AGILE_STREAM: stream.id,
      // Every git the session runs is headless: a `commit` without -m would
      // otherwise open core.editor and hang the tool call.
      GIT_EDITOR: 'true',
      ...(opts.socketPath ? { AGILE_SOCKET_PATH: opts.socketPath } : {}),
      ...(provider.id === 'pi' ? { [PI_GATE_ENV_VAR]: '1' } : {}),
    },
    clientCapabilities: provider.clientCapabilities,
    mcpServers: [mcpServerConfig(cliBin, sessionId, opts.socketPath)],
    onStderr: stderrLog.append,
    // Omitted entirely (not even `modeId: undefined`) when the provider has
    // no mode, so the built object stays honest about what is requested.
    ...(modeId !== undefined ? { modeId } : {}),
    // Grok routes all file I/O through client fs and has no other gateable
    // surface (spike-findings.md §C2/§C3).
    ...(provider.id === 'grok' ? { fsImpl: buildGrokFsPolicy(policyRole) } : {}),
  };
  const spawned = spawn(spawnOptions);

  const responder = buildPermissionResponder(store, {
    role: policyRole,
    agent: sessionId as AgentId,
    worktreePath,
    session: spawned,
    // T151 rebuilds an ACP permission request as the classifier route band
    // on the stream; until then the responder falls back to its own
    // `hil_request` write.
  });

  let model = sessionRef.model;
  let settled = false;
  let resolveExited!: (info: AgentExitInfo) => void;
  const exited = new Promise<AgentExitInfo>((resolve) => {
    resolveExited = resolve;
  });

  /**
   * Every fire-and-forget write this module makes (registry, thread lines,
   * events). `finish()` awaits every entry still pending, so `exited` never
   * resolves while a write from this session is still in flight — a caller
   * that tears the worktree down right after would otherwise race it.
   */
  const pendingWrites = new Set<Promise<unknown>>();
  function track(promise: Promise<unknown>): void {
    const forget = () => void pendingWrites.delete(tracked);
    const tracked: Promise<void> = promise.then(forget, forget);
    pendingWrites.add(tracked);
  }

  // ---------------------------------------------------------------- output
  //
  // One thread `line` per ACP message, not per chunk: consecutive
  // `agent_message_chunk` frames are deltas of one streaming message, and a
  // line per delta would be unreadable and would blow the thread up. The
  // untruncated text always goes to `output.log`; the thread line is capped
  // and carries the log as its `ref`.
  let buffer = '';
  function flushOutput(): void {
    const text = buffer.trim();
    buffer = '';
    if (text.length === 0) return;
    outputLog.append(`${text}\n`);
    const body =
      text.length > THREAD_BODY_MAX_CHARS ? `${text.slice(0, THREAD_BODY_MAX_CHARS - 1)}…` : text;
    track(
      streams
        .appendThread('agent', stream.id, { kind: 'line', body, ref: outputLog.path }, sessionId)
        .catch(() => {
          // A thread that can't be written (deleted stream, full disk) must
          // not take the session down — the raw log still has the text.
        }),
    );
  }

  /** Registry write: the hook's cwd → session index (§8.1 step 1). */
  async function putRegistryEntry(patch: { model?: string; sessionId?: string } = {}) {
    if (patch.model !== undefined) model = patch.model;
    await store.putAgent(sessionId as AgentId, {
      vendor: provider.id,
      model,
      stream: stream.id,
      ...(spawned.pid !== null ? { pid: spawned.pid } : {}),
      last_seen: now().toISOString(),
      role,
      worktree: worktreePath,
      ...(spawned.sessionId !== null ? { session_id: spawned.sessionId } : {}),
    });
  }

  async function finish(reason: string, ok: boolean): Promise<void> {
    if (settled) return;
    settled = true;
    unsubscribe();
    flushOutput();
    await Promise.all([...pendingWrites]);

    try {
      store.getAgent(sessionId as AgentId);
      await store.deleteAgent(sessionId as AgentId);
    } catch {
      // Already gone — fine.
    }

    // Flushes deferred-commit event writes queued earlier in this session's
    // life: `exited` must not resolve while a background flush timer is
    // still due, or a caller tearing the worktree down races it.
    await store.flush();
    resolveExited({ session: sessionId, stream: stream.id, reason, ok });
  }

  const unsubscribe = spawned.on((event: AgentEvent) => {
    if (event.type === 'exit') {
      // §2.3: "session exit ──► agent.status: done". A non-zero code is
      // normal here — it is what a `agile detach` (SIGTERM) and an ended
      // turn both look like — so the code goes in the reason, not into a
      // `blocked` verdict. Only a transport error or a failed prompt, where
      // the session never got to do its work, blocks the stream.
      void finish(`process exited (code ${event.exitCode})`, true);
      return;
    }
    if (event.type === 'error') {
      void finish(`transport error: ${event.message}`, false);
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
      const vendorSessionId = p?.sessionId;
      if (resolvedModel !== undefined || typeof vendorSessionId === 'string') {
        track(
          putRegistryEntry({
            ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
          }).catch(() => {
            // Not registered yet — the registration below carries whatever
            // is known by the time it runs.
          }),
        );
      }
      return;
    }

    if (frame.acp === 'notification' && frame.message.method === '_agile/turn_ended') {
      flushOutput();
      return;
    }

    if (frame.acp === 'notification' && frame.message.method === 'session/update') {
      const params = asRecord(frame.message.params);
      const update = asRecord(params?.update);
      const kind = update?.sessionUpdate;

      if (kind === 'agent_message_chunk') {
        const text = chunkText(update?.content);
        if (text !== null) {
          buffer += text;
          // A single message longer than the cap is flushed as it goes —
          // the log keeps every byte, the thread keeps readable lines.
          if (buffer.length >= THREAD_BODY_MAX_CHARS) flushOutput();
        }
        return;
      }

      // Bookkeeping updates are not message boundaries (T137): the live
      // run saw one agent message split into two thread entries because a
      // `usage_update` arrived between two chunks of it. Only a real turn
      // item (a tool call, a plan, the user's own message) closes the
      // streaming message.
      if (typeof kind === 'string' && NON_BOUNDARY_UPDATES.includes(kind)) return;
      flushOutput();

      if (kind === 'tool_call' || kind === 'tool_call_update') {
        track(
          store.appendEvent(
            buildEvent('tool_call', {
              agent: sessionId as AgentId,
              data: {
                stream: stream.id,
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

  /**
   * One prompt turn, with fail-loud handling: a rejected prompt does not
   * imply the subprocess exits, and a silently failing turn would strand
   * the stream. Turns are serialized — the ACP client refuses a second
   * `session/prompt` while one is still in flight — so a later `prompt()`
   * queues onto whatever turn is already running but still resolves on its
   * own turn's outcome.
   */
  let turnQueue: Promise<void> = Promise.resolve();
  let turnCount = 0;
  async function runPromptTurn(text: string): Promise<unknown> {
    const runOnce = async (): Promise<unknown> => {
      try {
        // A session that has been idle for hours waiting on an answer makes
        // no tool calls, so nothing else refreshes `last_seen`; without this
        // the hook's stale check could drop the registry entry the answered
        // session's next tool call has to resolve through (§8.1 step 1).
        await putRegistryEntry().catch(() => {
          // Not registered yet — the initial registration below covers it.
        });
        const reply = await promptWithAuthRetry(spawned, provider, text);
        turnCount += 1;
        if (!settled) {
          try {
            opts.onTurnEnd?.({ session: sessionId, stream: stream.id, turn: turnCount });
          } catch {
            // A turn-end rule that throws must not fail the turn itself.
          }
        }
        return reply;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await store
          .appendEvent(
            buildEvent('agent_put', {
              agent: sessionId as AgentId,
              data: {
                stream: stream.id,
                warning: `prompt failed, stopping session: ${message}`,
              },
            }),
            { commit: 'deferred' },
          )
          .catch(() => {
            // Best-effort visibility only — `finish()` is what recovers the
            // session/stream state either way.
          });
        spawned.cancel();
        spawned.close();
        await finish(`prompt failed: ${message}`, false);
        throw err;
      }
    };
    const result = turnQueue.then(runOnce, runOnce);
    // One turn's rejection never poisons the queue for the next one.
    turnQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // Establish the ACP session at spawn, not at the first prompt: the model
  // id arrives on the `session/new` result, and a session that is spawned
  // but never prompted would otherwise sit at its requested model forever.
  // Skipped for vendors that gate `session/new` behind `authenticate` —
  // there the prompt path's auth retry owns the handshake.
  if (provider.authMethods.length === 0) {
    void spawned.open().catch(() => {
      // Reported through the prompt path if it matters.
    });
  }

  // Registration before the first prompt, so a crash during the very first
  // turn still has a record to clean up — and so the hook can resolve the
  // session's very first tool call.
  void putRegistryEntry()
    .then(() => {
      if (spawned.pid !== null) return undefined;
      return store.appendEvent(
        buildEvent('agent_put', {
          agent: sessionId as AgentId,
          data: {
            stream: stream.id,
            warning:
              'spawned session pid unknown at registration; AgentRecord.pid omitted (never falls back to the daemon pid)',
          },
        }),
        { commit: 'deferred' },
      );
    })
    .then(() => runPromptTurn(brief))
    .catch(() => {
      // `runPromptTurn` already ran the full stop/`finish()` recovery and
      // rethrew only so a caller of `prompt()` can see it; this initial
      // call has no such caller.
    });

  return {
    sessionId,
    stream: stream.id,
    role,
    worktree: worktreePath,
    session: spawned,
    responder,
    exited,
    prompt(text: string) {
      return runPromptTurn(text);
    },
    stop() {
      // Deliberately does NOT unsubscribe: `close()` only *starts* the
      // teardown, and `finish()` runs off the session's own later `exit`
      // event — silencing that event would leave `exited` unresolved.
      spawned.cancel();
      spawned.close();
    },
  };
}
