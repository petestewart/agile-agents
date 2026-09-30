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

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
import type {
  AgentId,
  PermissionPosture,
  SessionRef,
  SessionRole,
  Stream,
} from '@agile-agents/shared';
import {
  AGENT_LINE_MAX_CHARS,
  type AgentCommand,
  AgentCommandSchema,
  vendorHasHooks,
} from '@agile-agents/shared';
import { writeClaudeSettings } from '../hook';
import { permissionRoleFor } from '../hook/decide';
import {
  type AcpPermissionRequestParams,
  type PermissionResponderContext,
  type PermissionResponderHandle,
  buildGrokFsPolicy,
  buildPermissionResponder,
  cursorModeIdFor,
} from '../permissions';
import { readOnlyGitEnv } from '../permissions/git-env';
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
import { withoutDaemonSecrets } from '../secret-env';
import { buildEvent } from '../store';
import type { StateStore } from '../store';
import type { StreamService } from '../streams/service';
import { type CliInvocation, cliInvocationToShell, normalizeCliBin } from './cli-bin';
import { type InstalledCli, installedCliForSpawn } from './installed-cli';
import {
  currentValueOf,
  modelNameIn,
  vendorEffortOption,
  vendorModelOption,
} from './vendor-models';

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
  /** The stream the session works on; absent for a stream-less owner (below). */
  stream?: Stream;
  /**
   * T300 (P16): a session with no stream (the Director). `id` names it in
   * handles and exit info; its output lines go to `appendOutput`.
   */
  owner?: { id: string; appendOutput(body: string, ref: string): Promise<unknown> };
  /** The session record `attach/service.ts` minted. */
  session: SessionRef;
  role: SessionRole;
  /** Absolute: the session's `cwd`, where `.claude/settings.json` is written. */
  worktreePath: string;
  /** The rendered brief, sent as the first `prompt()`. */
  brief: string;
  /** T336: the brief's turn started (the session accepted it). */
  onBriefDelivered?: () => void;
  /**
   * T465 (D48): resume an earlier session of the vendor's with ACP
   * `session/load` and send `prompt` (the new message) instead of the brief.
   * A load that fails starts a fresh session with the brief, and says so
   * through `onResume`.
   */
  resume?: { acpSessionId: string; prompt: string };
  /** T465: how the resume went (`ok: false` carries why; the brief went instead). */
  onResume?: (result: { ok: true } | { ok: false; error: string }) => void;
  /** T465: the vendor's ACP session id, once it is known (recorded for a later resume). */
  onAcpSession?: (acpSessionId: string) => void;
  /**
   * T467: every reply the vendor sent about its session (`session/new`,
   * `session/load`, `session/set_config_option`), as saved to
   * `session-state.json`: the model catalog keeps the vendor's list from it.
   */
  onSessionState?: (state: Record<string, unknown>) => void;
  /**
   * T467 (D46): the picked model was set through the vendor's ACP model
   * option before the first turn, or was not taken (and why). Not called
   * when there was nothing to set.
   */
  onModel?: (result: ModelPickResult) => void;
  /**
   * T488: the picked effort was set through the vendor's ACP effort option
   * (Codex) before the first turn, or was not taken (and why). Not called
   * when there was nothing to set, or for a vendor with a spawn mapping.
   */
  onEffort?: (result: EffortPickResult) => void;
  /**
   * T480 (D49): the operator's installed CLI for this vendor (`installedCliFor`),
   * which the bridge runs instead of its bundled copy. Applied only to an
   * unsandboxed session: a sandbox may not see or read the host's binary.
   */
  installedCli?: InstalledCli;
  /** `<home>/sessions/<session id>/`: stderr and output logs. */
  sessionDir: string;
  /** How to invoke the `agile` CLI for the hook and MCP commands. Defaults to `'agile'`. */
  cliBin?: string | CliInvocation;
  /** `AGILE_SOCKET_PATH` for the hook and MCP bridge (a worktree cwd would resolve the wrong root). */
  socketPath?: string;
  provider?: AcpProviderConfig;
  /** T305, T330 (P20): the ACP read scope (`readRoots`/`hiddenRoots`), as the hook tier's (the Director's too); T457: and the posture. */
  readScope?: {
    readRoots: readonly string[];
    hiddenRoots: readonly string[];
    posture?: PermissionPosture;
  };
  /** T457: how the ACP tier routes a read the Ask posture held (`acpReadRouter`); absent parks it. */
  routeRead?: PermissionResponderContext['routeRead'];
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
  /** T432: the process's exit code, when it exited (absent on a transport error). */
  exitCode?: number;
  /**
   * T460: what the agent said in a turn that failed ("Failed to authenticate:
   * OAuth session expired…"). Claude Code reports a login refusal this way,
   * as reply text, while its stderr holds only a debug line.
   */
  agentSaid?: string;
}

/**
 * T432: why the vendor can't start here, when its command is not on the
 * daemon's PATH (an absolute or relative path is left to the spawn).
 * `undefined` when it is there.
 */
export function missingVendorCommand(
  provider: Pick<AcpProviderConfig, 'label' | 'command'>,
  which: (command: string) => string | null = (command) => Bun.which(command),
): string | undefined {
  if (provider.command.includes('/') || which(provider.command) !== null) return undefined;
  const via =
    provider.command === 'npx'
      ? ' It runs through npx: install Node.js, then restart the daemon.'
      : '';
  return `${provider.label} can't start: \`${provider.command}\` is not on the daemon's PATH.${via}`;
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
  /**
   * T411: how full the session's context window is, as its last
   * `usage_update` said (tokens used of the window's size); `undefined`
   * until the vendor reports one (not every vendor does).
   */
  contextUsage(): ContextUsage | undefined;
  /**
   * T461: the slash commands the vendor advertises for this session, as its
   * last `available_commands_update` listed them (empty until one arrives).
   */
  commands(): readonly AgentCommand[];
  /** Whether `stop()` has been called. */
  stopped(): boolean;
  /** `cancel()` + `close()`; the exit path still runs off the session's own `exit` event. */
  stop(): void;
}

/** T411: a session's context window: tokens used of its size. */
export interface ContextUsage {
  used: number;
  size: number;
}

/** T411: a `usage_update`'s numbers, when they make sense. */
export function contextUsageOf(update: Record<string, unknown> | null): ContextUsage | undefined {
  const used = update?.used;
  const size = update?.size;
  if (typeof used !== 'number' || typeof size !== 'number') return undefined;
  if (!Number.isFinite(used) || !Number.isFinite(size) || used < 0 || size <= 0) return undefined;
  return { used: Math.round(used), size: Math.round(size) };
}

/** T460: a turn that failed, with what the agent said in it. */
export class TurnFailedError extends Error {
  constructor(
    message: string,
    readonly said: string | undefined,
  ) {
    super(message);
    this.name = 'TurnFailedError';
  }
}

/** `session.prompt()` resolves `failed` for a turn that died mid-flight; turn that into a rejection. */
function rejectOnFailedReply(reply: unknown): unknown {
  const r = reply as Partial<SessionReply> | undefined;
  if (r && r.status === 'failed') {
    const said = typeof r.text === 'string' ? r.text.trim() : '';
    throw new TurnFailedError(
      r.error?.message ?? 'ACP prompt turn failed with no error message',
      said === '' ? undefined : said.slice(0, 500),
    );
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
export function modelFromSessionState(params: unknown): string | undefined {
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
  // T467a: ACP's `models` field (`{currentModelId, availableModels}`), when the vendor sends it.
  const models = asRecord(p?.models);
  if (typeof models?.currentModelId === 'string') return models.currentModelId;
  return undefined;
}

/** T467a (D46, LIVE-CHECKLIST §12): the vendor's `session/new` (or `session/load`) reply, as sent. */
export const SESSION_STATE_FILE = 'session-state.json';

/**
 * T467a: keeps what the vendor said about its modes, config options and
 * models in `<sessionDir>/session-state.json`, so §12 can be measured
 * from the file rather than guessed. Best-effort, like the other logs;
 * never holds a credential (the reply carries none). T467: the file names
 * its vendor, so the model catalog (`model-catalog.ts`) can read it back
 * without the session's record. Returns what it wrote.
 */
export function saveSessionState(
  dir: string,
  params: Record<string, unknown> | null,
  vendor?: string,
): Record<string, unknown> {
  const saved = {
    at: new Date().toISOString(),
    ...(vendor !== undefined ? { vendor } : {}),
    ...(params ?? {}),
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SESSION_STATE_FILE), `${JSON.stringify(saved, null, 2)}\n`);
  } catch {
    // Diagnostics never take a session down.
  }
  return saved;
}

/**
 * T467 (D46): how a session's picked model went, once the session opened.
 * `ok: true`: the vendor runs it (set through its ACP model option, or it
 * already ran it). `ok: false`: it did not take; `line` says so in words
 * and `actual`, when the vendor named one, is what it runs instead.
 */
export type ModelPickResult =
  | { ok: true; model: string }
  | { ok: false; picked: string; actual?: string; line: string };

/**
 * T488: how a session's picked effort went, for a vendor that takes it as
 * an ACP config option. `ok: false`: `line` says in words what it runs.
 */
export type EffortPickResult =
  | { ok: true; effort: string }
  | { ok: false; picked: string; actual?: string; line: string };

/** T461: at most this many advertised commands are kept per session. */
const COMMANDS_MAX = 200;

/** T461: an `available_commands_update`'s commands that parse, capped; the rest are dropped. */
export function advertisedCommands(update: Record<string, unknown> | null): AgentCommand[] {
  const list = update?.availableCommands;
  if (!Array.isArray(list)) return [];
  const out: AgentCommand[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const c = asRecord(item);
    const input = asRecord(c?.input);
    const parsed = AgentCommandSchema.safeParse({
      name: typeof c?.name === 'string' ? c.name.replace(/^\//, '') : undefined,
      description: typeof c?.description === 'string' ? c.description.slice(0, 300) : '',
      ...(typeof input?.hint === 'string' ? { hint: input.hint.slice(0, 200) } : {}),
    });
    if (!parsed.success || seen.has(parsed.data.name)) continue;
    seen.add(parsed.data.name);
    out.push(parsed.data);
    if (out.length === COMMANDS_MAX) break;
  }
  return out;
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
  const streamId = stream?.id;
  if (streamId === undefined && opts.owner === undefined) {
    throw new Error('startAgentSession: a session needs a stream or an owner');
  }
  const ownerId = streamId ?? (opts.owner?.id as string);
  const sessionId = sessionRef.id;
  const now = opts.now ?? (() => new Date());
  const cliBin = normalizeCliBin(opts.cliBin);
  const provider = opts.provider ?? ACP_PROVIDERS.claude;
  const spawn = opts.spawn ?? defaultSpawnSession;
  const policyRole = permissionRoleFor(role);

  // T432: a vendor that isn't installed says so, where the spawn would only
  // have failed later as "ACP agent stdin unavailable".
  if (opts.spawn === undefined) {
    const missing = missingVendorCommand(provider);
    if (missing !== undefined) throw new Error(missing);
  }

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
  // T343: a read-only role's git can't run a repo-configured program.
  const gitEnv = readOnlyGitEnv(policyRole, { ...process.env, ...provider.envOverrides });
  const wrapped = wrapCommand({
    role: policyRole,
    worktreePath,
    vendor: provider.id,
    command: provider.command,
    args: provider.args,
    requiresSandbox: opts.requiresSandbox,
    enabled: opts.sandboxEnabled,
    socketPath: opts.socketPath,
    ...(Object.keys(gitEnv).length > 0 ? { envPassthroughNames: Object.keys(gitEnv) } : {}),
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

  // T480 (D49): the bridge runs the operator's installed CLI, not its bundled copy.
  // A sandboxed session keeps the bundled one: the sandbox may not see the host's.
  const installed = installedCliForSpawn(opts.installedCli, wrapped.backend);
  if (installed !== undefined) {
    stderrLog.append(`[agiled] running your installed ${installed.label}: ${installed.path}\n`);
  } else if (opts.installedCli !== undefined) {
    stderrLog.append(
      `[agiled] sandboxed session: the bridge's bundled ${opts.installedCli.label} runs, not ${opts.installedCli.path}\n`,
    );
  }

  // D12: the vendor's model/effort levers come from the provider registry.
  // An unmapped vendor contributes nothing (attach writes "effort ignored").
  const modelContribution = provider.model?.(sessionRef.model) ?? {};
  const effortContribution =
    sessionRef.effort !== undefined ? (provider.effort?.(sessionRef.effort) ?? {}) : {};

  const spawnOptions: SpawnSessionOptions = {
    cmd: wrapped.command,
    args: [...wrapped.args, ...(modelContribution.args ?? []), ...(effortContribution.args ?? [])],
    cwd: worktreePath,
    // T486: the daemon's own env, less its secrets (the classifier key).
    env: withoutDaemonSecrets(),
    envOverrides: {
      ...provider.envOverrides,
      ...(installed?.env ?? {}),
      ...wrapped.envOverrides,
      ...modelContribution.env,
      ...effortContribution.env,
      AGILE_AGENT: sessionId,
      ...(streamId !== undefined ? { AGILE_STREAM: streamId } : {}),
      // Headless git: a `commit` without -m would open core.editor and hang.
      GIT_EDITOR: 'true',
      // T345: the hook checks `cd <dir>` from the cwd; an inherited CDPATH
      // would send it elsewhere. Empty searches only the cwd (bash, dash, zsh).
      CDPATH: '',
      ...gitEnv,
      ...(opts.socketPath ? { AGILE_SOCKET_PATH: opts.socketPath } : {}),
      ...(provider.id === 'pi' ? { [PI_GATE_ENV_VAR]: '1' } : {}),
    },
    clientCapabilities: provider.clientCapabilities,
    mcpServers: [mcpServerConfig(cliBin, sessionId, opts.socketPath)],
    onStderr,
    // Omitted entirely when the provider has no mode.
    ...(modeId !== undefined ? { modeId } : {}),
    // Grok routes all file I/O through client fs, its only gateable surface (spike-findings.md §C2/§C3).
    ...(provider.id === 'grok' ? { fsImpl: buildGrokFsPolicy(policyRole, worktreePath) } : {}),
  };
  const spawned = spawn(spawnOptions);

  const responder = buildPermissionResponder(store, {
    role: policyRole,
    agent: sessionId as AgentId,
    worktreePath,
    session: spawned,
    // T476: a vendor with no pre-tool hook gets a card, not a refusal, for a command it can't show.
    hooked: vendorHasHooks(provider.id),
    ...(opts.readScope ?? {}),
    ...(opts.routeRead !== undefined ? { routeRead: opts.routeRead } : {}),
    // The same rules the hook tier enforces, bound to this stream: the
    // only tier a vendor without a pre-tool-use hook has.
    ...(opts.rules !== undefined && streamId !== undefined
      ? { patternRules: patternRuleGate({ store, rules: opts.rules, stream: streamId }) }
      : {}),
  });

  let model = sessionRef.model;
  /** T467: the vendor's last reply about its session, as saved (its model option is read from it). */
  let lastState: Record<string, unknown> | null = null;
  let settled = false;
  /** T465: a `session/load` is replaying the old conversation: none of it is new output. */
  let replaying = false;
  let reportedAcpSession: string | undefined;
  /** T465: tells the caller the vendor's session id once it exists (or changes). */
  function reportAcpSession(): void {
    const id = spawned.sessionId;
    if (id === null || id === reportedAcpSession) return;
    reportedAcpSession = id;
    try {
      opts.onAcpSession?.(id);
    } catch {
      // Bookkeeping only.
    }
  }
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
  // points at the log. T330: a message is one line with its whole text up
  // to `AGENT_LINE_MAX_CHARS` (it once split mid-sentence at 800 chars);
  // past that it is cut at the end and the overflow streams to the log.
  let buffer = '';
  let overflowed = false;
  let context: ContextUsage | undefined;
  let commands: AgentCommand[] = [];
  function flushOutput(): void {
    const text = overflowed ? buffer.trimStart() : buffer.trim();
    const wasOverflowed = overflowed;
    buffer = '';
    overflowed = false;
    if (wasOverflowed) outputLog.append('\n');
    if (text.length === 0) return;
    if (!wasOverflowed) outputLog.append(`${text}\n`);
    const body =
      wasOverflowed || text.length > AGENT_LINE_MAX_CHARS
        ? `${text.slice(0, AGENT_LINE_MAX_CHARS - 1).trimEnd()}…`
        : text;
    const append = () =>
      opts.owner !== undefined
        ? opts.owner.appendOutput(body, outputLog.path)
        : streams.appendThread(
            'agent',
            ownerId,
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
      ...(streamId !== undefined ? { stream: streamId } : {}),
      ...(spawned.pid !== null ? { pid: spawned.pid } : {}),
      last_seen: now().toISOString(),
      role,
      worktree: worktreePath,
      ...(spawned.sessionId !== null ? { session_id: spawned.sessionId } : {}),
    });
  }

  async function finish(
    reason: string,
    ok: boolean,
    failed = !ok,
    exitCode?: number,
    agentSaid?: string,
  ): Promise<void> {
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
      stream: ownerId,
      reason,
      ok,
      ...(vendorError !== undefined ? { vendorError } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(agentSaid !== undefined ? { agentSaid } : {}),
    });
  }

  const unsubscribe = spawned.on((event: AgentEvent) => {
    if (event.type === 'exit') {
      // §2.3: exit ⇒ `done`. A non-zero code is normal (a detach's SIGTERM
      // looks like that), so it goes in the reason. Only a transport error
      // or failed prompt blocks the stream.
      void finish(
        `process exited (code ${event.exitCode})`,
        true,
        event.exitCode !== 0,
        event.exitCode,
      );
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
      let p = asRecord(frame.message.params);
      // T467: a `session/set_config_option` reply carries only `configOptions`:
      // the rest of what the vendor said stays as its last reply had it.
      if (p?.source === 'session/set_config_option' && lastState !== null) {
        const { at: _at, vendor: _vendor, ...before } = lastState;
        p = {
          ...before,
          ...(p.configOptions !== null && p.configOptions !== undefined
            ? { configOptions: p.configOptions }
            : {}),
          source: p.source,
        };
      }
      lastState = saveSessionState(opts.sessionDir, p, provider.id);
      try {
        opts.onSessionState?.(lastState);
      } catch {
        // The catalog is bookkeeping: never the session's problem.
      }
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
      // T465: `session/load` re-sends the whole conversation; the thread already has it.
      if (replaying) {
        if (kind === 'usage_update') context = contextUsageOf(update) ?? context;
        if (kind === 'available_commands_update') commands = advertisedCommands(update);
        return;
      }

      if (kind === 'agent_message_chunk') {
        const text = chunkText(update?.content);
        if (text !== null) {
          if (overflowed) {
            outputLog.append(text);
          } else if (buffer.length + text.length > AGENT_LINE_MAX_CHARS) {
            // Past the cap: the head stays for the line, the rest goes to the log as it comes.
            outputLog.append((buffer + text).trimStart());
            buffer = (buffer + text).slice(0, AGENT_LINE_MAX_CHARS);
            overflowed = true;
          } else {
            buffer += text;
          }
        }
        return;
      }

      // Bookkeeping updates are not message boundaries (a `usage_update`
      // between two chunks once split one message in two). Only a real turn
      // item closes the streaming message.
      if (kind === 'usage_update') context = contextUsageOf(update) ?? context;
      if (kind === 'available_commands_update') commands = advertisedCommands(update);
      if (typeof kind === 'string' && NON_BOUNDARY_UPDATES.includes(kind)) return;
      flushOutput();

      if (kind === 'tool_call' || kind === 'tool_call_update') {
        track(
          store.appendEvent(
            buildEvent('tool_call', {
              agent: sessionId as AgentId,
              data: {
                stream: ownerId,
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
  /**
   * `session/cancel` ahead of a close. acp-client's `cancel()` does not
   * throw on a failed send (it reports it as the session's transport error),
   * so the catch is defence in depth: a provider or a future `cancel()` that
   * throws for any reason must still never skip the close and `finish()`
   * after it, or the session is left half-stopped.
   */
  function cancelBeforeClose(): void {
    try {
      spawned.cancel();
    } catch {
      // Already reported through the session's error path, or moot: closing.
    }
  }
  let turnCount = 0;
  /** Turns enqueued and not yet finished, the running one included. */
  let inFlight = 0;
  let stopRequested = false;
  async function runPromptTurn(
    text: string | Promise<string>,
    onDelivered?: () => void,
  ): Promise<unknown> {
    inFlight += 1;
    // T467: a first turn's text may reject (its session never opened) while an earlier
    // turn still runs; `runOnce` handles it, and this keeps it from reading as unhandled.
    if (typeof text !== 'string') text.catch(() => {});
    /** A failed turn stops the session, loudly (the vendor's reply, or a session that never opened). */
    const failTurn = async (err: unknown): Promise<never> => {
      const message = err instanceof Error ? err.message : String(err);
      await store
        .appendEvent(
          buildEvent('agent_put', {
            agent: sessionId as AgentId,
            data: {
              stream: ownerId,
              warning: `prompt failed, stopping session: ${message}`,
            },
          }),
        )
        .catch(() => {
          // Best effort: `finish()` recovers the state either way.
        });
      cancelBeforeClose();
      spawned.close();
      const said = err instanceof TurnFailedError ? err.said : undefined;
      await finish(`prompt failed: ${message}`, false, true, undefined, said);
      throw err;
    };
    const delivered = (): void => {
      try {
        onDelivered?.();
      } catch {
        // A throwing delivery callback must not fail the turn.
      }
    };
    const runOnce = async (): Promise<unknown> => {
      // T465: a resume's first turn knows its text once the old session has loaded (or not).
      // T467: a fresh one once its session opened and its model was set. A session
      // that could not open fails this turn, as its prompt did before.
      let body: string;
      try {
        body = await text;
      } catch (err) {
        if (stopRequested || settled) throw err;
        delivered();
        return failTurn(err);
      }
      // A turn queued behind a session that has since been stopped is not
      // sent to a closed session (which would record a spurious failure).
      if (stopRequested || settled)
        throw new Error('session stopped before this turn was delivered');
      delivered();
      try {
        // Refresh `last_seen`: a session idle for hours on a question makes
        // no tool calls, and the hook's stale check would drop its entry.
        await putRegistryEntry().catch(() => {
          // Not registered yet: the initial registration covers it.
        });
        const reply = await promptWithAuthRetry(spawned, provider, body);
        reportAcpSession();
        turnCount += 1;
        if (!settled) {
          try {
            // `queued`: turns waiting behind this one. The turn-end rule must
            // not let the session go while a queued line is still to run.
            opts.onTurnEnd?.({
              session: sessionId,
              stream: ownerId,
              turn: turnCount,
              queued: inFlight - 1,
            });
          } catch {
            // A throwing turn-end rule must not fail the turn.
          }
        }
        return reply;
      } catch (err) {
        return failTurn(err);
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
  // T465: a resume loads the old session instead (`firstPrompt`).
  if (provider.authMethods.length === 0 && opts.resume === undefined) {
    void spawned
      .open()
      .then(reportAcpSession)
      .catch(() => {
        // Reported through the prompt path if it matters.
      });
  }

  /** T467: tells the caller how the pick went; the reason also goes to stderr.log. */
  function reportModel(result: ModelPickResult): void {
    if (!result.ok) stderrLog.append(`[agiled] model: ${result.line}\n`);
    try {
      opts.onModel?.(result);
    } catch {
      // Bookkeeping only.
    }
  }

  /**
   * T467 (D46): sets the session's picked model through the vendor's ACP
   * model option (`session/set_config_option`), once the session is open
   * and before its first turn, and reads the reply back: the vendor's own
   * `currentValue` says whether it took. Only a pick the vendor lists and
   * doesn't already run is sent; Claude's full ids ride `ANTHROPIC_MODEL`
   * (the provider's `model` switch) as before. Never fails the session.
   */
  /** T488: the newest `configOptions` a `session/set_config_option` reply carried (a model change can change the effort list). */
  let latestConfigOptions: unknown;

  async function applyPickedModel(): Promise<void> {
    const pick = sessionRef.model;
    const option = vendorModelOption(lastState);
    // Nothing reported (Gemini, Pi), the vendor's own default, or already running it.
    if (option === undefined || pick === provider.defaultModel || pick === option.current) return;
    const current = option.current;
    const runs = (value: string | undefined): string =>
      value === undefined ? 'its own default' : modelNameIn(option, value);
    const vendor = provider.label;
    const listed = option.options.some((o) => o.value === pick);
    if (!listed) {
      // A vendor switch carries it (Claude's ANTHROPIC_MODEL): not this option's to set.
      if (provider.model !== undefined) return;
      reportModel({
        ok: false,
        picked: pick,
        ...(current !== undefined ? { actual: current } : {}),
        line: `${vendor} doesn't list ${pick} among its models; it runs ${runs(current)}`,
      });
      return;
    }
    const pickName = modelNameIn(option, pick);
    if (option.configId === undefined) {
      reportModel({
        ok: false,
        picked: pick,
        ...(current !== undefined ? { actual: current } : {}),
        line: `${vendor} lists ${pickName} but has no model option to set it through; it runs ${runs(current)}`,
      });
      return;
    }
    const configId = option.configId;
    let after: string | undefined;
    try {
      const reply = asRecord(await spawned.setConfigOption(configId, pick));
      if (Array.isArray(reply?.configOptions)) latestConfigOptions = reply.configOptions;
      after = currentValueOf(reply?.configOptions, configId);
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      reportModel({
        ok: false,
        picked: pick,
        ...(current !== undefined ? { actual: current } : {}),
        line: `${vendor} refused the model ${pickName} (${why}); it runs ${runs(current)}`,
      });
      return;
    }
    if (after === pick) {
      reportModel({ ok: true, model: pick });
      return;
    }
    if (after === undefined) {
      reportModel({
        ok: false,
        picked: pick,
        line: `${vendor} did not say whether it took ${pickName}: its reply named no model`,
      });
      return;
    }
    reportModel({
      ok: false,
      picked: pick,
      actual: after,
      line: `${vendor} kept its own model (${runs(after)}); it did not take ${pickName}`,
    });
  }

  function reportEffort(result: EffortPickResult): void {
    if (!result.ok) stderrLog.append(`[agiled] effort: ${result.line}\n`);
    try {
      opts.onEffort?.(result);
    } catch {
      // Bookkeeping only.
    }
  }

  /**
   * T488: sets the session's picked effort through the vendor's ACP effort
   * option (`category: "thought_level"`), after the model (whose reply may
   * list other levels) and before the first turn, and reads the reply back.
   * Only for a provider with `effortOption` (Codex): Claude's rides its spawn
   * env. A level the vendor doesn't list, or already runs, isn't sent. Never
   * fails the session.
   */
  async function applyPickedEffort(): Promise<void> {
    const pick = sessionRef.effort;
    if (provider.effortOption !== true || pick === undefined) return;
    const vendor = provider.label;
    const option = vendorEffortOption(
      latestConfigOptions ?? (lastState !== null ? lastState.configOptions : undefined),
    );
    if (option === undefined) {
      reportEffort({
        ok: false,
        picked: pick,
        line: `${vendor} reported no effort setting, so effort ${pick} was not set`,
      });
      return;
    }
    const current = option.current;
    const runs = current === undefined ? 'its own default' : current;
    if (pick === current) return;
    if (!option.values.includes(pick)) {
      reportEffort({
        ok: false,
        picked: pick,
        ...(current !== undefined ? { actual: current } : {}),
        line: `${vendor} doesn't offer effort ${pick}; it runs ${runs}`,
      });
      return;
    }
    let after: string | undefined;
    try {
      const reply = asRecord(await spawned.setConfigOption(option.configId, pick));
      after = currentValueOf(reply?.configOptions, option.configId);
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      reportEffort({
        ok: false,
        picked: pick,
        ...(current !== undefined ? { actual: current } : {}),
        line: `${vendor} refused effort ${pick} (${why}); it runs ${runs}`,
      });
      return;
    }
    if (after === pick) {
      reportEffort({ ok: true, effort: pick });
      return;
    }
    reportEffort({
      ok: false,
      picked: pick,
      ...(after !== undefined ? { actual: after } : {}),
      line:
        after === undefined
          ? `${vendor} did not say whether it took effort ${pick}`
          : `${vendor} kept effort ${after}; it did not take ${pick}`,
    });
  }

  /**
   * T467: a fresh session's first turn waits for this: the session opened
   * (authenticating first where the vendor asks for it, as the prompt path
   * does) and the picked model set, so the brief runs on it. A session that
   * can't open rejects, and the first turn fails with that, as its prompt did.
   */
  async function openAndPickModel(): Promise<void> {
    try {
      await openSession();
    } catch (err) {
      throw withInstalledHint(err);
    }
    if (stopRequested || settled) return;
    reportAcpSession();
    await applyPickedModel();
    if (stopRequested || settled) return;
    await applyPickedEffort();
  }

  /**
   * T480: a session that can't open while the bridge runs the operator's
   * installed CLI says so, and where the switch is: a CLI far newer or older
   * than the bridge is the likely cause, and the bundled copy the fix.
   */
  function withInstalledHint(err: unknown): unknown {
    if (installed === undefined || err instanceof AuthRequiredError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new Error(
      `${message} (it ran your installed ${installed.label} at ${installed.path}; Settings → Agents → Models can switch ${provider.label} back to the bridge's bundled copy)`,
    );
  }

  async function openSession(): Promise<void> {
    try {
      await spawned.open();
    } catch (err) {
      if (!(err instanceof AuthRequiredError) || provider.authMethods.length === 0) throw err;
      let lastErr: unknown = err;
      let opened = false;
      for (const methodId of provider.authMethods) {
        try {
          await spawned.authenticate(methodId);
          await spawned.open();
          opened = true;
          break;
        } catch (retryErr) {
          lastErr = retryErr;
          if (!(retryErr instanceof AuthRequiredError)) throw retryErr;
          // Still needs auth: try the next method id.
        }
      }
      if (!opened) throw lastErr;
    }
  }

  /**
   * T465 (D48): the first turn's text. A resume loads the vendor's earlier
   * session (authenticating first where the vendor asks for it) and sends
   * the new message; a load that fails falls back to a fresh session and
   * the brief, and the reason goes to stderr.log and to `onResume`.
   */
  async function firstPrompt(): Promise<string> {
    const resume = opts.resume;
    if (resume === undefined) return brief;
    replaying = true;
    try {
      try {
        await spawned.load(resume.acpSessionId);
      } catch (err) {
        if (provider.authMethods.length === 0) throw err;
        let loaded = false;
        let lastErr: unknown = err;
        for (const methodId of provider.authMethods) {
          try {
            await spawned.authenticate(methodId);
            await spawned.load(resume.acpSessionId);
            loaded = true;
            break;
          } catch (retryErr) {
            lastErr = retryErr;
          }
        }
        if (!loaded) throw lastErr;
      }
      replaying = false;
      if (modeId !== undefined) {
        await spawned.setMode(modeId).catch(() => {
          // The loaded session keeps the mode it had.
        });
      }
      reportAcpSession();
      try {
        opts.onResume?.({ ok: true });
      } catch {
        // Bookkeeping only.
      }
      // T467: the loaded session runs the pick too.
      await applyPickedModel();
      return resume.prompt;
    } catch (err) {
      replaying = false;
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      stderrLog.append(`[agiled] session/load failed, starting fresh with the brief: ${error}\n`);
      try {
        opts.onResume?.({ ok: false, error });
      } catch {
        // Bookkeeping only.
      }
      // T467: the fresh session the brief goes to gets the pick first.
      await openAndPickModel();
      return brief;
    }
  }

  // Register before the first prompt: a crash in the first turn has a
  // record to clean up, and the hook can resolve the first tool call.
  const registered = putRegistryEntry().then(() => {
    if (spawned.pid !== null) return undefined;
    return store.appendEvent(
      buildEvent('agent_put', {
        agent: sessionId as AgentId,
        data: {
          stream: ownerId,
          warning:
            'spawned session pid unknown at registration; AgentRecord.pid omitted (never falls back to the daemon pid)',
        },
      }),
    );
  });
  if (opts.resume === undefined) {
    // T467: the brief waits for the picked model to be set (`openAndPickModel`).
    void registered
      .then(() =>
        runPromptTurn(
          openAndPickModel().then(() => brief),
          opts.onBriefDelivered,
        ),
      )
      .catch(() => {
        // `runPromptTurn` already stopped and recorded the failure.
      });
  } else {
    // T465: the first turn is reserved at once, so no digest is prompted in while the old session loads.
    void runPromptTurn(
      registered.catch(() => undefined).then(firstPrompt),
      opts.onBriefDelivered,
    ).catch(() => {
      // `runPromptTurn` already stopped and recorded the failure.
    });
  }

  return {
    sessionId,
    stream: ownerId,
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
    contextUsage() {
      return context === undefined ? undefined : { ...context };
    },
    commands() {
      return commands;
    },
    stopped() {
      return stopRequested || settled;
    },
    stop() {
      stopRequested = true;
      // No unsubscribe: `finish()` runs off the session's later `exit`
      // event, and silencing it would leave `exited` unresolved.
      cancelBeforeClose();
      spawned.close();
    },
  };
}
