/**
 * `startAgentSession`: spawns one ACP session in an already-placed
 * worktree and wires it into the daemon (§4.1): hook settings, MCP config,
 * permission responder, the registry entry the hook resolves a `cwd`
 * through, the vendor's logs, the output→thread stream, and exit handling.
 * `attach/service.ts` decides which stream, worktree and brief.
 *
 * - The registry entry is keyed by session id and carries
 *   `stream`/`role`/`worktree` (§8.1 step 1). It exists only while the
 *   session is live.
 * - Output goes on the thread as `line` entries by `agent:<session>`,
 *   coalesced per ACP message and capped; the untruncated text goes to
 *   `<home>/sessions/<id>/output.log`.
 * - `pid` is never substituted with the daemon's, so "kill the pid on
 *   record" can't point at `agiled`.
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
import type { PatternRuleRules } from '../permissions/rule-checks';
import { patternRuleGate } from '../permissions/rule-checks';
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

/** `<sessionDir>/<name>` appender that never throws: diagnostics must not take a session down. */
function openLog(dir: string, name: string): { path: string; append: (chunk: string) => void } {
  const path = join(dir, name);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Every append below is best-effort anyway.
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
  /** Its id is what the thread and the registry entry carry. */
  stream: Stream;
  /** The session record `attach/service.ts` minted. */
  session: SessionRef;
  role: SessionRole;
  /** Absolute: the session's `cwd`, where `.claude/settings.json` is written. */
  worktreePath: string;
  /** The rendered brief, sent as the first `prompt()`. */
  brief: string;
  /** `<home>/sessions/<session id>/`: stderr and output logs. */
  sessionDir: string;
  /** How to invoke the `agile` CLI for the hook and MCP commands. Defaults to `'agile'`. */
  cliBin?: string | CliInvocation;
  /** `AGILE_SOCKET_PATH` for the hook and MCP bridge (a worktree cwd would resolve the wrong root). */
  socketPath?: string;
  provider?: AcpProviderConfig;
  /** Test seam: a fake `spawnSession`. */
  spawn?: typeof defaultSpawnSession;
  now?: () => Date;
  hookTimeoutSeconds?: number;
  /** Tier 0: this vendor's exec is ungated everywhere; refuse rather than run unsandboxed. */
  requiresSandbox?: boolean;
  /** Tier 0 opt-in even when not `requiresSandbox`. */
  sandboxEnabled?: boolean;
  /** Test seam: how the agent command is wrapped for tier 0. */
  wrapCommand?: WrapAgentCommandFn;
  /** Pi only: the agent dir the extension is installed into. */
  piAgentDir?: string;
  /** Test seam: a fake `installPiExtension`. */
  installPiExtension?: typeof installPiExtension;
  /**
   * Called when a prompt turn resolves normally. What that means (finished,
   * or waiting on an answer) is a stream question for `attach/service.ts`.
   * A failed turn never calls it: the session is already stopped.
   */
  onTurnEnd?: (info: { session: string; stream: string; turn: number; queued: number }) => void;
  /**
   * The rules read side: the ACP permission responder runs the pattern
   * rules in scope, the only enforcement a vendor with no pre-tool-use hook
   * (Cursor, Codex, Grok, §4.3) gets.
   */
  rules?: PatternRuleRules;
}

export interface AgentExitInfo {
  session: string;
  stream: string;
  /** Human-readable reason, written onto the thread by the attach service. */
  reason: string;
  /** False on a transport error or failed prompt: `blocked` rather than `done`. */
  ok: boolean;
  /** The vendor's last non-empty stderr line, when the session ended on a failure or non-zero exit. */
  vendorError?: string;
}

/** The last non-empty line of a stderr tail, trimmed. */
export function lastStderrLine(tail: string): string | undefined {
  const lines = tail.split(/\r?\n/).map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]) return lines[i];
  }
  return undefined;
}

export interface AgentSessionHandle {
  sessionId: string;
  stream: string;
  role: SessionRole;
  worktree: string;
  session: SpawnedSession;
  responder: PermissionResponderHandle;
  /** Resolves after exit/crash and this module's cleanup. Never rejects. */
  exited: Promise<AgentExitInfo>;
  /**
   * A new `session/prompt` turn (an answer, a composer line). Queued behind
   * any running turn; `onDelivered` fires when this turn actually starts.
   * After `stop()` a queued turn is skipped (it rejects) rather than sent.
   */
  prompt(text: string, opts?: { onDelivered?: () => void }): Promise<unknown>;
  /** Turns started or queued and not yet finished (0 = idle). */
  turnsInFlight(): number;
  /** Whether `stop()` has been called. */
  stopped(): boolean;
  /** `cancel()` + `close()`; the exit path still runs off the session's own `exit` event. */
  stop(): void;
}

/** `session.prompt()` resolves `failed` for a turn that died mid-flight; turn that into a rejection. */
function rejectOnFailedReply(reply: unknown): unknown {
  const r = reply as Partial<SessionReply> | undefined;
  if (r && r.status === 'failed') {
    throw new Error(r.error?.message ?? 'ACP prompt turn failed with no error message');
  }
  return reply;
}

/**
 * Cursor/Grok fail the first prompt with `AuthRequiredError` until ACP
 * `authenticate` runs (spike-findings.md §C2/§D): try each
 * `provider.authMethods` id, retrying the prompt after each.
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
        // Still needs auth: try the next method id.
      }
    }
    throw lastErr;
  }
}

/**
 * `agile mcp --session <id> [--socket <path>]`, the MCP stdio server every
 * session gets. `env: []` is load-bearing: claude-agent-acp silently drops
 * a stdio MCP server with no `env`, leaving no `mcp__agile__*` tools.
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

/** Best-effort model id from `_agile/session_state`'s vendor-specific `configOptions`. */
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

/** `session/update` kinds that report on the session, not the turn: they must not split a streaming message. */
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

  // Tier 1 (§8.1): hooks active before the first tool call. The session id
  // reaches the hook via `AGILE_AGENT` in the session env, not the file.
  writeClaudeSettings(worktreePath, {
    agileBin: cliInvocationToShell(cliBin),
    socketPath: opts.socketPath,
    timeoutSeconds: opts.hookTimeoutSeconds,
  });

  // Tier 0 (§4.3): wrap the vendor command in the host's sandbox backend.
  // `SandboxRequiredError` when `requiresSandbox` and no backend resolves;
  // an available backend alone is never a reason to wrap.
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

  // Pi has no ACP-level hook: enforcement is the `agile` extension. A
  // foreign `extensions/agile.ts` is re-thrown: spawning ungated is worse
  // than not spawning.
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

  // The mode id comes from the provider's vocabulary: `'default'` is
  // Claude-only and `session/set_mode` rejects it elsewhere.
  const modeId =
    (provider.id === 'cursor' ? cursorModeIdFor(policyRole) : undefined) ?? provider.defaultModeId;

  const stderrLog = openLog(opts.sessionDir, 'stderr.log');
  const outputLog = openLog(opts.sessionDir, 'output.log');
  // The tail of the vendor's stderr, so a vendor failure can be named.
  let stderrTail = '';
  const onStderr = (chunk: string) => {
    stderrLog.append(chunk);
    stderrTail = (stderrTail + chunk).slice(-4000);
  };

  // D12: the vendor's model/effort levers come from the provider registry.
  // An unmapped vendor contributes nothing (attach writes "effort ignored").
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
      // Headless git: a `commit` without -m would open core.editor and hang.
      GIT_EDITOR: 'true',
      ...(opts.socketPath ? { AGILE_SOCKET_PATH: opts.socketPath } : {}),
      ...(provider.id === 'pi' ? { [PI_GATE_ENV_VAR]: '1' } : {}),
    },
    clientCapabilities: provider.clientCapabilities,
    mcpServers: [mcpServerConfig(cliBin, sessionId, opts.socketPath)],
    onStderr,
    // Omitted entirely when the provider has no mode.
    ...(modeId !== undefined ? { modeId } : {}),
    // Grok routes all file I/O through client fs, its only gateable surface (spike-findings.md §C2/§C3).
    ...(provider.id === 'grok' ? { fsImpl: buildGrokFsPolicy(policyRole) } : {}),
  };
  const spawned = spawn(spawnOptions);

  const responder = buildPermissionResponder(store, {
    role: policyRole,
    agent: sessionId as AgentId,
    worktreePath,
    session: spawned,
    // The same rules the hook tier enforces, bound to this stream: the
    // only tier a vendor without a pre-tool-use hook has.
    ...(opts.rules !== undefined
      ? { patternRules: patternRuleGate({ store, rules: opts.rules, stream: stream.id }) }
      : {}),
  });

  let model = sessionRef.model;
  let settled = false;
  let resolveExited!: (info: AgentExitInfo) => void;
  const exited = new Promise<AgentExitInfo>((resolve) => {
    resolveExited = resolve;
  });

  /** Every fire-and-forget write; `finish()` awaits them so `exited` never races a pending write. */
  const pendingWrites = new Set<Promise<unknown>>();
  function track(promise: Promise<unknown>): void {
    const forget = () => void pendingWrites.delete(tracked);
    const tracked: Promise<void> = promise.then(forget, forget);
    pendingWrites.add(tracked);
  }

  // ---------------------------------------------------------------- output
  // One thread `line` per ACP message, not per chunk (chunks are deltas of
  // one message). `output.log` gets everything; the line is capped and
  // points at the log.
  let buffer = '';
  function flushOutput(): void {
    const text = buffer.trim();
    buffer = '';
    if (text.length === 0) return;
    outputLog.append(`${text}\n`);
    const body =
      text.length > THREAD_BODY_MAX_CHARS ? `${text.slice(0, THREAD_BODY_MAX_CHARS - 1)}…` : text;
    const append = () =>
      streams.appendThread(
        'agent',
        stream.id,
        { kind: 'line', body, ref: outputLog.path },
        sessionId,
      );
    const logFailure = (attempt: string, err: unknown) =>
      // Into stderr.log, not the stderr tail: it is the daemon's failure, not the vendor's.
      stderrLog.append(
        `[agiled] thread append failed (${attempt}): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    track(
      append()
        .catch((err: unknown) => {
          logFailure('retrying once', err);
          return append();
        })
        .catch((err: unknown) => {
          // An unwritable thread must not take the session down; output.log has the text.
          logFailure('gave up', err);
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

  async function finish(reason: string, ok: boolean, failed = !ok): Promise<void> {
    if (settled) return;
    settled = true;
    unsubscribe();
    flushOutput();
    await Promise.all([...pendingWrites]);

    try {
      store.getAgent(sessionId as AgentId);
      await store.deleteAgent(sessionId as AgentId);
    } catch {
      // Already gone.
    }

    // `exited` must not resolve before queued event writes have landed.
    await store.flush();
    const vendorError = failed ? lastStderrLine(stderrTail) : undefined;
    resolveExited({
      session: sessionId,
      stream: stream.id,
      reason,
      ok,
      ...(vendorError !== undefined ? { vendorError } : {}),
    });
  }

  const unsubscribe = spawned.on((event: AgentEvent) => {
    if (event.type === 'exit') {
      // §2.3: exit ⇒ `done`. A non-zero code is normal (a detach's SIGTERM
      // looks like that), so it goes in the reason. Only a transport error
      // or failed prompt blocks the stream.
      void finish(`process exited (code ${event.exitCode})`, true, event.exitCode !== 0);
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
            // Not registered yet: the registration carries whatever is known then.
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
          // A message longer than the cap is flushed as it goes.
          if (buffer.length >= THREAD_BODY_MAX_CHARS) flushOutput();
        }
        return;
      }

      // Bookkeeping updates are not message boundaries (a `usage_update`
      // between two chunks once split one message in two). Only a real turn
      // item closes the streaming message.
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
          ),
        );
      }
    }
  });

  /**
   * One prompt turn, failing loud: a rejected prompt doesn't imply the
   * process exits, and a silent failure would strand the stream. Turns are
   * serialized (the ACP client refuses a second in-flight prompt); each
   * `prompt()` still resolves on its own turn's outcome.
   */
  let turnQueue: Promise<void> = Promise.resolve();
  let turnCount = 0;
  /** Turns enqueued and not yet finished, the running one included. */
  let inFlight = 0;
  let stopRequested = false;
  async function runPromptTurn(text: string, onDelivered?: () => void): Promise<unknown> {
    inFlight += 1;
    const runOnce = async (): Promise<unknown> => {
      // A turn queued behind a session that has since been stopped is not
      // sent to a closed session (which would record a spurious failure).
      if (stopRequested || settled)
        throw new Error('session stopped before this turn was delivered');
      try {
        onDelivered?.();
      } catch {
        // A throwing delivery callback must not fail the turn.
      }
      try {
        // Refresh `last_seen`: a session idle for hours on a question makes
        // no tool calls, and the hook's stale check would drop its entry.
        await putRegistryEntry().catch(() => {
          // Not registered yet: the initial registration covers it.
        });
        const reply = await promptWithAuthRetry(spawned, provider, text);
        turnCount += 1;
        if (!settled) {
          try {
            // `queued`: turns waiting behind this one. The turn-end rule must
            // not let the session go while a queued line is still to run.
            opts.onTurnEnd?.({
              session: sessionId,
              stream: stream.id,
              turn: turnCount,
              queued: inFlight - 1,
            });
          } catch {
            // A throwing turn-end rule must not fail the turn.
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
          )
          .catch(() => {
            // Best effort: `finish()` recovers the state either way.
          });
        spawned.cancel();
        spawned.close();
        await finish(`prompt failed: ${message}`, false);
        throw err;
      }
    };
    const counted = async (): Promise<unknown> => {
      try {
        return await runOnce();
      } finally {
        inFlight -= 1;
      }
    };
    const result = turnQueue.then(counted, counted);
    // One turn's rejection never poisons the next.
    turnQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // Open the ACP session at spawn: the model id arrives on `session/new`,
  // and an unprompted session would otherwise never learn it. Vendors that
  // gate `session/new` behind `authenticate` leave it to the prompt path.
  if (provider.authMethods.length === 0) {
    void spawned.open().catch(() => {
      // Reported through the prompt path if it matters.
    });
  }

  // Register before the first prompt: a crash in the first turn has a
  // record to clean up, and the hook can resolve the first tool call.
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
      );
    })
    .then(() => runPromptTurn(brief))
    .catch(() => {
      // `runPromptTurn` already stopped and recorded the failure.
    });

  return {
    sessionId,
    stream: stream.id,
    role,
    worktree: worktreePath,
    session: spawned,
    responder,
    exited,
    prompt(text: string, promptOpts?: { onDelivered?: () => void }) {
      return runPromptTurn(text, promptOpts?.onDelivered);
    },
    turnsInFlight() {
      return inFlight;
    },
    stopped() {
      return stopRequested || settled;
    },
    stop() {
      stopRequested = true;
      // No unsubscribe: `finish()` runs off the session's later `exit`
      // event, and silencing it would leave `exited` unresolved.
      spawned.cancel();
      spawned.close();
    },
  };
}
