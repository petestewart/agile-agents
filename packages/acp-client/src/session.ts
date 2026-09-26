/**
 * `spawnSession` — the one public entry point of this package: an ACP agent
 * subprocess driven over stdio with newline-delimited JSON-RPC (design
 * §8 "Adapter contract (ACP)").
 *
 * Provenance: lifted from Terma's `AcpSession`
 * (vendor/terma/src/main/terminal-host/acp-session.ts) and adapted —
 * `DaemonSession` lifecycle (attach/detach/retain, refcounting shared with a
 * PTY session type) is gone, because this package has no multi-client daemon
 * session registry to share it with; a daemon built on top of this later
 * (T004+) owns that. What's kept: spawn, JSON-RPC framing (now via
 * `framing.ts`, splitting on `"\n"` only), the two `fs/*` handlers with
 * workspace confinement, forwarding of everything else (permission requests,
 * `switch_mode` "Approve Plan", …) to the caller, turn-marker recording into
 * the event ring, and kill escalation. New: `authenticate` (Cursor/Grok need
 * it before `session/new` — design/spike-findings.md §C2, §D) and the
 * `session/new` → `session/prompt` → reply-fold flow that lets `prompt()`
 * return a normalized `SessionReply` instead of a raw ACP result.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath, sep } from 'node:path';
import {
  type FinalMessageState,
  INITIAL_FINAL_MESSAGE,
  applyFinalMessageEvent,
  replyFromFinalMessage,
  turnEndFromError,
  turnEndFromEvent,
  turnEndFromExit,
} from './contract';
import { DEFAULT_MAX_EVENT_LOG_CHARS, DEFAULT_MAX_EVENT_LOG_ENTRIES, EventLog } from './events';
import { DEFAULT_MAX_BUFFER_BYTES, FramingOverflowError, LineFramer } from './framing';
import {
  ACP_REQUEST_SETTLED_METHOD,
  ACP_SESSION_STATE_METHOD,
  ACP_TURN_ENDED_METHOD,
  type AcpClientCapabilities,
  AcpClientError,
  type AcpEvent,
  type AcpJsonRpcMessage,
  type AcpReplay,
  type AcpRequestId,
  type AgentEvent,
  AuthRequiredError,
  type Sequenced,
  type SessionReply,
  type SpawnSessionOptions,
} from './types';

const DEFAULT_CLIENT_CAPABILITIES: AcpClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
};

/** How long an agent gets to honour SIGTERM before the group is SIGKILLed. */
const FORCE_KILL_TIMEOUT_MS = 2000;
/** Handshake bound only. Ordinary requests (`session/prompt`) legitimately run for minutes. */
const INITIALIZE_TIMEOUT_MS = 120_000;
const ACP_PROTOCOL_VERSION = 1;

/**
 * Bun 1.3.11 loses a child's stdio pipe when its `epoll_ctl` fails with
 * `EBADF` (the T161 family; measured by injecting the error with strace).
 * On the stdin pipe at spawn, `spawn()` throws a bogus `RangeError: Out of
 * memory` and leaves no child behind. On the stdout pipe, `stdout` emits
 * `close` with no `end` and every byte the agent writes is dropped while
 * the agent lives on, so the handshake never answers and the session hangs.
 * On the stdin pipe's re-arm, the agent's stdin is closed with no signal
 * here (writes still report success): the agent reads EOF and exits 0.
 * A session makes at most this many spawns in all, over first spawns,
 * retries of a spawn that throws, and replacements of an agent whose stdout
 * died, or that exited cleanly, before it said anything (nothing is lost by
 * replacing it: only the handshake was sent, and it is replayed). Past that
 * point the session fails, with an `error` event, instead of hanging or
 * ending as if clean. A pidfd
 * EBADF in `node:child_process` Bun retries itself (unlike `Bun.spawn`'s
 * `exited`, T161).
 */
const MAX_SPAWN_ATTEMPTS = 3;
/** How long a stdout `close` without `end` waits for the process's own exit before it counts as a lost pipe. */
const STDOUT_LOSS_GRACE_MS = 50;

/** A JSON-RPC error response, surfaced with its code/data intact (not flattened into a string). */
export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpRpcError';
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** The handle `spawnSession` returns. */
export interface SpawnedSession {
  /**
   * Start (or reuse) an ACP session and run one prompt turn, resolving with
   * the normalized reply once the turn settles. Rejects with
   * `AuthRequiredError` if the agent reports that `authenticate` must run
   * first (design/spike-findings.md §C2, §D) — call `authenticate()` and
   * retry.
   */
  prompt(text: string): Promise<SessionReply>;
  /** `session/cancel` for the current session (fire-and-forget notification, per ACP). */
  cancel(): boolean;
  /** `session/load` — recover a previous ACP session id into this process. */
  load(sessionId: string): Promise<unknown>;
  /** `session/set_mode` for the current session. */
  setMode(modeId: string): Promise<unknown>;
  /** ACP `authenticate` — required by Cursor/Grok before `session/new` succeeds. */
  authenticate(methodId: string): Promise<unknown>;
  /** Answer a request forwarded via `on(...)` — permission prompts, `switch_mode`, etc. */
  respondPermission(id: AcpRequestId, result: unknown): boolean;
  /** Answer a forwarded request with a JSON-RPC error instead of a result. */
  respondPermissionError(id: AcpRequestId, code: number, message: string): boolean;
  /** Subscribe to protocol events and lifecycle signals. Returns an unsubscribe function. */
  on(listener: (event: AgentEvent) => void): () => void;
  /**
   * The event ring's current timeline (with a synthetic `truncated` notice
   * prepended when the cap dropped events) — for a caller that wants the
   * replay without also subscribing, or wants to check `dropped` on its own.
   */
  replay(): AcpReplay<AcpEvent>;
  /**
   * Establish the ACP session now — `session/new` (and `session/set_mode`
   * when a `modeId` was given) right after `initialize`, without waiting for
   * the first `prompt()`. Idempotent and shared: a concurrent `prompt()`
   * awaits the same in-flight `session/new` rather than sending a second
   * one. Resolves with the session id. T044 (QA round 1): the vendor's model
   * id rides on the `session/new` result (`_agile/session_state`), so a
   * session that is spawned but never prompted — the architect, in the demo
   * driver — would otherwise never report one.
   */
  open(): Promise<string>;
  /** Resolves with the `initialize` result once the handshake completes. */
  readonly initialized: Promise<unknown>;
  /** The ACP `session/new` id once a session exists, else null. */
  readonly sessionId: string | null;
  /**
   * The spawned agent subprocess's own OS pid (design/agile-agents-design.md
   * §8, §5 "Storage" — `bus/agents/<agent>.yaml`'s `pid` field is meant to be
   * this, not the daemon's own pid). `null` only in the narrow window where
   * `spawn()` itself failed before a pid could be assigned (mirrors Node's
   * own `ChildProcess.pid`, which is `undefined` in exactly that case —
   * normalized to `null` here so every other field on this interface that
   * can be "not yet/not ever available" uses the same sentinel).
   */
  readonly pid: number | null;
  readonly exited: boolean;
  /** SIGTERM the agent, escalating to SIGKILL after a grace period. */
  close(): void;
}

/**
 * Resolve the environment the agent runs with. Defaults to this process's
 * own environment — the agent is commonly launched through a resolver
 * (`npx`) and needs `PATH`, and most bridges need `HOME` for their
 * credential/session stores.
 *
 * `overrides` are applied on top of the full resolved env — never as a
 * replacement, because a minimal env fails at spawn. `PATH` is validated
 * after the merge so an override cannot smuggle the same failure back in.
 */
export function resolveAgentEnv(
  env: Record<string, string> | undefined,
  overrides?: Record<string, string>,
): Record<string, string> {
  const resolved = { ...(env ?? (process.env as Record<string, string>)), ...overrides };
  if (!resolved.PATH) {
    throw new AcpClientError('INVALID_PARAMS', 'ACP session env must contain PATH');
  }
  return resolved;
}

/**
 * Canonicalise a path that may not exist yet (a file about to be written):
 * resolve the closest existing ancestor and re-append the remainder, so
 * symlinked parents are followed without requiring the leaf to exist.
 * `realpathFn` is injectable (test seam — see `SpawnSessionOptions.fsImpl`).
 */
async function canonicalize(
  path: string,
  realpathFn: (path: string) => Promise<string> = realpath,
): Promise<string> {
  let current = path;
  const trailing: string[] = [];
  for (;;) {
    try {
      const real = await realpathFn(current);
      return trailing.length ? [real, ...trailing].join(sep) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      trailing.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Spawn an ACP agent subprocess and return the handle described in design
 * §8. Spawning and the `initialize` handshake both start immediately;
 * `initialized` and the first call to `prompt()` are how a caller waits on
 * them.
 */
export function spawnSession(opts: SpawnSessionOptions): SpawnedSession {
  const env = resolveAgentEnv(opts.env, opts.envOverrides);
  const clientCapabilities = opts.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES;
  const cwd = opts.cwd;
  // Test seams (see `SpawnSessionOptions`'s doc comments) — default to the
  // real implementations so production callers see no behavior change.
  const doSpawn = opts.spawn ?? spawn;
  const doReadFile = opts.fsImpl?.readFile ?? readFile;
  const doWriteFile = opts.fsImpl?.writeFile ?? writeFile;
  const doRealpath = opts.fsImpl?.realpath ?? realpath;

  const framer = new LineFramer(opts.maxStdoutBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES);
  const log = new EventLog<AcpEvent>(
    opts.eventLogMaxEntries ?? DEFAULT_MAX_EVENT_LOG_ENTRIES,
    opts.eventLogMaxChars ?? DEFAULT_MAX_EVENT_LOG_CHARS,
  );

  const listeners = new Set<(event: AgentEvent) => void>();
  const pending = new Map<number, PendingRequest>();
  /** Agent→client requests forwarded but not yet answered (permission prompts, chiefly). */
  const outstanding = new Map<AcpRequestId, { method: string; params: unknown }>();

  let nextRequestId = 1;
  let exited = false;
  let spawnError: Error | null = null;
  let cachedRoot: string | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let acpSessionId: string | null = null;
  let inFlight: { fold: FinalMessageState; settle: (reply: SessionReply) => void } | null = null;
  /**
   * Count of listeners registered through the public `on()`, distinct from
   * `listeners.size` (which also holds the internal turn-folding listener
   * added below) — used to refuse a forwarded agent request outright when no
   * caller could ever answer it, instead of leaving the agent blocked forever.
   */
  let publicListenerCount = 0;
  /** Serializes `load()` so two in-flight loads cannot interleave (matches Terma's `loadChain`). */
  let loadChain: Promise<void> = Promise.resolve();

  /** Spawns left for this session, over first spawns, throw retries and replacements alike. */
  let spawnsLeft = MAX_SPAWN_ATTEMPTS;
  /** Spawns the agent, retrying a synchronous throw while `spawnsLeft` allows. */
  function spawnChild(): ChildProcess {
    for (;;) {
      spawnsLeft -= 1;
      try {
        return doSpawn(opts.cmd, opts.args ?? [], {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          // Own process group: a resolver (`npx`) execs a child of its own, so
          // killing only the direct pid leaves the real agent orphaned.
          detached: true,
        });
      } catch (err) {
        if (spawnsLeft <= 0) throw err;
      }
    }
  }

  /** The current agent process. Replaced only while its stdout has never spoken. */
  let child: ChildProcess = spawnChild();
  /** Whether the current child's stdout has delivered anything. */
  let stdoutSpoke = false;
  /** Every line written while `stdoutSpoke` is false: what a replacement agent is sent again. */
  let handshake: string[] = [];
  /** Set by `close()`: an exit from here on is the one asked for, never a lost pipe. */
  let closeRequested = false;
  /** Set while `cancel()` writes: a stdin failure then fails the session, never replaces the agent. */
  let cancelling = false;
  /** The last of the agent's stderr, for the error when an agent is given up on. */
  let stderrTail = '';
  /** Pending `STDOUT_LOSS_GRACE_MS` checks, cleared by `close()`. */
  const graceTimers = new Set<ReturnType<typeof setTimeout>>();

  function emit(event: AgentEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  function emitFrame(frame: AcpEvent): Sequenced<AcpEvent> {
    const stamped = log.append(frame);
    emit({ type: 'event', event: stamped });
    return stamped;
  }

  /**
   * The ring's current timeline, with a synthetic `truncated` notice
   * prepended when the cap dropped events — ported from Terma's
   * `replayEvents()` (acp-session.ts): "the gap is visible in the timeline
   * itself rather than only in a field a caller might ignore".
   */
  function replayWithTruncationNotice(): AcpReplay<AcpEvent> {
    const { events, dropped, generation } = log.replay();
    if (dropped > 0) {
      return {
        events: [{ acp: 'truncated', dropped, seq: 0, gen: generation }, ...events],
        dropped,
        generation,
      };
    }
    return { events, dropped, generation };
  }

  function exitReason(): string {
    return spawnError ? `ACP agent failed to start: ${spawnError.message}` : 'ACP agent exited';
  }

  function rejectPending(err: Error): void {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  function writeLine(obj: unknown): boolean {
    if (exited || !child.stdin || child.stdin.destroyed) return false;
    const line = `${JSON.stringify(obj)}\n`;
    if (!stdoutSpoke) handshake.push(line);
    return writeTo(child, line);
  }

  /**
   * Every write to an agent's stdin goes through here. Bun's stdin writer
   * throws EPIPE synchronously when the agent is already gone but its exit
   * is not reported yet: a transport failure of the session, never a throw
   * into whoever sent the line (often an event-emitter callback, where a
   * throw is an uncaught exception). False when the write failed.
   */
  function writeTo(target: ChildProcess, line: string): boolean {
    try {
      target.stdin?.write(line);
    } catch (err) {
      onStdinFailed(target, err);
      return false;
    }
    return true;
  }

  function sendRequest(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (exited)
      return Promise.reject(new Error(spawnError ? exitReason() : 'ACP session has exited'));
    const id = nextRequestId++;
    return new Promise((resolvePromise, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle =
        <V>(fn: (v: V) => void) =>
        (v: V) => {
          if (timer) clearTimeout(timer);
          fn(v);
        };
      pending.set(id, { resolve: settle(resolvePromise), reject: settle(reject) });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      if (!writeLine({ jsonrpc: '2.0', id, method, params: params ?? {} })) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error('ACP agent stdin unavailable'));
      }
    });
  }

  function notify(method: string, params?: unknown): boolean {
    return writeLine({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  function respond(id: AcpRequestId, result: unknown): boolean {
    const wasForwarded = outstanding.delete(id);
    const ok = writeLine({ jsonrpc: '2.0', id, result });
    if (wasForwarded) recordRequestSettled(id);
    return ok;
  }

  function respondError(id: AcpRequestId, code: number, message: string): boolean {
    const wasForwarded = outstanding.delete(id);
    const ok = writeLine({ jsonrpc: '2.0', id, error: { code, message } });
    if (wasForwarded) recordRequestSettled(id);
    return ok;
  }

  function recordRequestSettled(id: AcpRequestId): void {
    emitFrame({
      acp: 'notification',
      message: { jsonrpc: '2.0', method: ACP_REQUEST_SETTLED_METHOD, params: { id } },
    });
  }

  function recordSessionState(result: unknown): void {
    const r = asRecord(result);
    if (r === null) return;
    if (r.modes === undefined && r.configOptions === undefined) return;
    emitFrame({
      acp: 'notification',
      message: {
        jsonrpc: '2.0',
        method: ACP_SESSION_STATE_METHOD,
        params: {
          sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined,
          modes: r.modes ?? null,
          configOptions: r.configOptions ?? null,
        },
      },
    });
  }

  async function workspaceRoot(): Promise<string> {
    if (cachedRoot === null) cachedRoot = await canonicalize(resolvePath(cwd), doRealpath);
    return cachedRoot;
  }

  /**
   * Confine agent-driven filesystem access to the session's working
   * directory. A scoping control on the two `fs/*` methods advertised, not a
   * sandbox: an agent that reads files in its own process never goes
   * through here at all.
   */
  async function confinePath(path: string): Promise<string> {
    const root = await workspaceRoot();
    const resolved = await canonicalize(resolvePath(cwd, path), doRealpath);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error(`Path outside session workspace: ${path}`);
    }
    return resolved;
  }

  async function handleAgentRequest(
    id: AcpRequestId,
    method: string,
    params: unknown,
  ): Promise<void> {
    const p = asRecord(params) ?? {};
    try {
      switch (method) {
        case 'fs/read_text_file': {
          const path = await confinePath(String(p.path ?? ''));
          const content = await doReadFile(path, 'utf8');
          respond(id, { content });
          return;
        }
        case 'fs/write_text_file': {
          const path = await confinePath(String(p.path ?? ''));
          await doWriteFile(path, String(p.content ?? ''), 'utf8');
          respond(id, {});
          return;
        }
        default:
          // Anything else (session/request_permission, switch_mode "Approve
          // Plan", …) needs the caller. With nobody listening, nothing can
          // ever answer it — refuse explicitly rather than leave the agent
          // blocked forever on a request that went into the void.
          if (publicListenerCount === 0) {
            respondError(id, -32603, 'No listener attached to answer request');
            return;
          }
          // Recorded before it is emitted: the agent blocks until this is
          // answered.
          outstanding.set(id, { method, params });
          emitFrame({ acp: 'request', id, method, params });
          return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respondError(id, -32603, message);
    }
  }

  function handleMessage(message: AcpJsonRpcMessage): void {
    // Response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const responseId = message.id;
      if (typeof responseId !== 'number') return;
      const p = pending.get(responseId);
      if (!p) return;
      pending.delete(responseId);
      if (message.error) {
        p.reject(new AcpRpcError(message.error.code, message.error.message, message.error.data));
      } else {
        p.resolve(message.result);
      }
      return;
    }
    // Request from the agent.
    if (message.id !== undefined && message.method !== undefined) {
      void handleAgentRequest(message.id, message.method, message.params);
      return;
    }
    // Notification — forward verbatim.
    if (message.method !== undefined) {
      emitFrame({ acp: 'notification', message });
    }
  }

  function onStdout(chunk: string): void {
    stdoutSpoke = true;
    handshake = [];
    let lines: string[];
    try {
      lines = framer.push(chunk);
    } catch (err) {
      if (err instanceof FramingOverflowError) {
        emit({ type: 'error', message: err.message });
        close();
        return;
      }
      throw err;
    }
    for (const line of lines) {
      let message: AcpJsonRpcMessage;
      try {
        message = JSON.parse(line) as AcpJsonRpcMessage;
      } catch {
        continue; // unparseable line — dropped, not fatal
      }
      handleMessage(message);
    }
  }

  function onStderr(chunk: string): void {
    // Agent stderr is diagnostics, not protocol — never parsed here. Handed
    // to the caller's sink when one is given (`onStderr`), dropped otherwise.
    if (opts.onStderr === undefined) return;
    try {
      opts.onStderr(String(chunk));
    } catch {
      // A failing sink must never take the session down.
    }
  }

  const onDead = (code: number | null) => {
    if (exited) return;
    exited = true;
    clearForceKillTimer();
    rejectPending(new Error(exitReason()));
    emit({ type: 'exit', exitCode: code ?? -1 });
  };

  /**
   * Replaces an agent that lost a pipe before it ever spoke (see
   * `MAX_SPAWN_ATTEMPTS`): nothing is lost, since only the handshake was
   * sent, and the replacement is sent it again. False when the session is
   * past that point (it spoke, is closing, or has no respawns left).
   */
  function replaceChild(lost: ChildProcess, why: string): boolean {
    if (stdoutSpoke || closeRequested || spawnsLeft <= 0) return false;
    signalTree('SIGKILL', lost);
    let next: ChildProcess;
    try {
      next = spawnChild();
    } catch (err) {
      emit({
        type: 'error',
        message: `ACP agent ${why} and the agent could not be restarted: ${err instanceof Error ? err.message : String(err)}`,
      });
      onDead(null);
      return true;
    }
    child = next;
    wire(next);
    onStderr(`[acp-client] agent ${why} before it spoke (lost pipe); restarted the agent\n`);
    // Guarded like every other write: this runs inside an `exit`/`error`/
    // `close` listener. A failed replay is `next`'s own lost pipe, handled
    // (replaced again, within the spawn budget, or failed) by `writeTo`.
    for (const line of handshake) {
      if (!writeTo(next, line)) break;
    }
    return true;
  }

  /**
   * The current child's stdout closed without `end`: the pipe is gone but
   * the agent may not be. An agent that never spoke is replaced; one that
   * did has session state a replacement would not, so the session fails
   * now, as a transport error, instead of hanging on a reply that can
   * never arrive.
   */
  function onStdoutLost(lost: ChildProcess): void {
    if (lost !== child || exited || closeRequested || spawnError !== null) return;
    if (typeof lost.exitCode === 'number' || typeof lost.signalCode === 'string') return;
    if (replaceChild(lost, 'stdout closed')) return;
    emit({ type: 'error', message: 'ACP agent stdout closed unexpectedly (lost pipe)' });
    close();
  }

  /**
   * A write to the agent's stdin failed: thrown by `write()` (Bun's fast
   * path, EPIPE) or emitted later as the stream's `error` (a write that
   * completed asynchronously). With nobody listening, that `error` would be
   * an uncaught exception in the daemon (CI job 108169280649: a
   * `session/cancel` sent after a failed prompt, to an agent already gone).
   * An agent that never spoke is replaced, like any pipe lost before the
   * handshake; past that the session fails as a transport error. Nothing to
   * report once the session is closing or has exited.
   */
  function onStdinFailed(failed: ChildProcess, err: unknown): void {
    if (failed !== child || exited || closeRequested) return;
    const why = err instanceof Error ? err.message : String(err);
    // Never a replacement for a failed `session/cancel`: whoever cancels is
    // stopping the turn (the runner closes right after), so a fresh agent
    // would only be spawned to be killed.
    if (!cancelling && replaceChild(failed, 'stdin failed')) return;
    emit({ type: 'error', message: `ACP agent stdin failed (lost pipe): ${why}` });
    close();
  }

  /**
   * The current child exited. A lost stdin pipe gives no signal of its own
   * (writes still report success): the agent reads EOF and exits cleanly.
   * So a clean exit before the agent ever answered the handshake, that
   * nobody asked for, is treated as that lost pipe and the agent replaced;
   * any other exit is the session's.
   */
  function onChildExit(c: ChildProcess, code: number | null): void {
    if (c !== child) return;
    if (
      code === 0 &&
      !exited &&
      spawnError === null &&
      handshake.length > 0 &&
      replaceChild(c, 'exited')
    ) {
      return;
    }
    if (code === 0 && !exited && !stdoutSpoke && !closeRequested && handshake.length > 0) {
      // Out of replacements: an agent that never answered is a failure,
      // never a clean end (a vendor CLI that exits 0 before speaking ACP).
      const last = stderrTail
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      emit({
        type: 'error',
        message: `ACP agent exited before it answered the handshake (${MAX_SPAWN_ATTEMPTS} attempts)${last ? `: ${last.slice(0, 300)}` : ''}`,
      });
    } else if (
      code === 0 &&
      !exited &&
      stdoutSpoke &&
      !closeRequested &&
      spawnError === null &&
      pending.size > 0
    ) {
      // Past the handshake a replacement would lack the agent's session
      // state, so this fails the session, but as what it is: an agent does
      // not end cleanly with a request of ours unanswered, and a stdin pipe
      // Bun lost on re-arm reads as exactly that (measured under strace).
      emit({
        type: 'error',
        message: 'ACP agent exited cleanly with a request unanswered (lost stdin pipe?)',
      });
    }
    onDead(code);
  }

  /** Listens to one child; a replaced child's late events are ignored. */
  function wire(c: ChildProcess): void {
    let stdoutEnded = false;
    // Always listened to: an unheard stream `error` is an uncaught exception.
    c.stdin?.on('error', (err: Error) => onStdinFailed(c, err));
    c.stdout?.setEncoding('utf8');
    c.stdout?.on('data', (chunk: string) => {
      if (c === child) onStdout(chunk);
    });
    c.stdout?.on('end', () => {
      stdoutEnded = true;
    });
    c.stdout?.on('close', () => {
      if (stdoutEnded || c !== child) return;
      // A dying process can close its pipe a moment before its exit is reported.
      const timer = setTimeout(() => {
        graceTimers.delete(timer);
        onStdoutLost(c);
      }, STDOUT_LOSS_GRACE_MS);
      graceTimers.add(timer);
    });
    c.stderr?.setEncoding('utf8');
    c.stderr?.on('data', (chunk: string) => {
      if (c !== child) return;
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
      onStderr(chunk);
    });
    // `exit` and `close` are both handled: Node emits `error` + `close`
    // (never `exit`) when the process could not be spawned at all.
    const dead = (code: number | null) => onChildExit(c, code);
    c.on('exit', dead);
    c.on('close', dead);
    c.on('error', (err) => {
      if (c !== child) return;
      emit({ type: 'error', message: err.message });
      spawnError = err;
    });
  }
  wire(child);

  function clearForceKillTimer(): void {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  }

  function signalTree(signal: NodeJS.Signals, target: ChildProcess = child): void {
    const pid = target.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        target.kill(signal);
      } catch {
        // Process already reaped.
      }
    }
  }

  function close(): void {
    if (exited) return;
    closeRequested = true;
    for (const timer of graceTimers) clearTimeout(timer);
    graceTimers.clear();
    clearForceKillTimer();
    signalTree('SIGTERM');
    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      if (!exited) signalTree('SIGKILL');
    }, FORCE_KILL_TIMEOUT_MS);
    // Settle any reserved-or-running prompt turn immediately rather than
    // waiting on the real process to exit — which, especially in a test
    // harness or a stuck bridge, may never happen (or happen long after the
    // grace period above), leaving `prompt()`'s caller hanging forever.
    if (inFlight) {
      settleInFlight(
        replyFromFinalMessage(inFlight.fold, turnEndFromError('ACP session is closing')),
      );
    }
  }

  const initialized = sendRequest(
    'initialize',
    { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities },
    INITIALIZE_TIMEOUT_MS,
  ).then(
    (result) => {
      emitFrame({ acp: 'initialized', result });
      return result;
    },
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'error', message: `ACP initialize failed: ${message}` });
      throw err;
    },
  );
  // Keep a handler attached so a failed handshake never surfaces as an
  // unhandled rejection; callers awaiting `initialized` still see the error.
  initialized.catch(() => {});

  /**
   * The in-flight `session/new`, shared between `open()` and `prompt()`.
   * Without this, an eager `open()` and the first `prompt()` racing each
   * other would both send `session/new`. Cleared on failure so a later call
   * (e.g. after `authenticate`) retries instead of replaying the rejection.
   */
  let sessionOpening: Promise<string> | null = null;

  function ensureSession(): Promise<string> {
    if (acpSessionId !== null) return Promise.resolve(acpSessionId);
    if (sessionOpening === null) {
      sessionOpening = openSession().catch((err) => {
        sessionOpening = null;
        throw err;
      });
    }
    return sessionOpening;
  }

  async function openSession(): Promise<string> {
    await initialized;
    try {
      const result = await sendRequest('session/new', { cwd, mcpServers: opts.mcpServers ?? [] });
      recordSessionState(result);
      const r = asRecord(result);
      const sessionId = r?.sessionId;
      if (typeof sessionId !== 'string') {
        throw new Error('session/new did not return a sessionId');
      }
      acpSessionId = sessionId;
      if (opts.modeId !== undefined) {
        await sendRequest('session/set_mode', { sessionId, modeId: opts.modeId });
      }
      return sessionId;
    } catch (err) {
      // Match the spike harness (spike/permission-matrix.ts): the JSON-RPC
      // code is the authoritative signal (-32000, per
      // design/spike-findings.md §C2, §D on Cursor/Grok); the message regex
      // is only a fallback for a vendor that uses a different code.
      if (err instanceof AcpRpcError && (err.code === -32000 || /auth/i.test(err.message))) {
        throw new AuthRequiredError(err.message, err.data);
      }
      throw err;
    }
  }

  /**
   * Send the `session/prompt` request for a turn whose slot is already
   * reserved in `inFlight` (by `prompt()`, synchronously, before this point)
   * — settling happens entirely through the fold listener below, matching
   * whatever the slot's `settle` closure resolves.
   */
  function sendPromptTurn(sessionId: string, text: string): void {
    const echo: AcpJsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
      },
    };
    emitFrame({ acp: 'notification', message: echo });

    const recordTurnEnd = (stopReason: string | null) => {
      emitFrame({
        acp: 'notification',
        message: {
          jsonrpc: '2.0',
          method: ACP_TURN_ENDED_METHOD,
          params: { sessionId, stopReason },
        },
      });
    };
    sendRequest('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }).then(
      (result) => {
        const stopReason = asRecord(result)?.stopReason;
        recordTurnEnd(typeof stopReason === 'string' ? stopReason : null);
      },
      () => {
        // The turn-end marker above already carries "failed"; the settled
        // reply is what the caller sees, so the rejection itself is
        // intentionally swallowed here.
        recordTurnEnd(null);
      },
    );
  }

  function settleInFlight(reply: SessionReply): void {
    const turn = inFlight;
    inFlight = null;
    turn?.settle(reply);
  }

  // Fold every emitted frame into the in-flight turn (if any) and settle it
  // when a turn-end marker arrives.
  listeners.add((agentEvent) => {
    if (agentEvent.type === 'exit') {
      if (inFlight)
        settleInFlight(replyFromFinalMessage(inFlight.fold, turnEndFromExit(agentEvent.exitCode)));
      return;
    }
    if (agentEvent.type === 'error') {
      if (inFlight)
        settleInFlight(replyFromFinalMessage(inFlight.fold, turnEndFromError(agentEvent.message)));
      return;
    }
    const event = agentEvent.event;
    if (inFlight) inFlight.fold = applyFinalMessageEvent(inFlight.fold, event);
    const end = turnEndFromEvent(event);
    if (end !== null && inFlight) settleInFlight(replyFromFinalMessage(inFlight.fold, end));
  });

  return {
    initialized,
    open(): Promise<string> {
      return ensureSession();
    },
    get sessionId() {
      return acpSessionId;
    },
    get pid() {
      return child.pid ?? null;
    },
    get exited() {
      return exited;
    },
    async prompt(text: string): Promise<SessionReply> {
      if (inFlight) {
        throw new AcpClientError(
          'PROMPT_IN_FLIGHT',
          'A prompt turn is already running on this session; await it (or session.cancel()) before starting another.',
        );
      }
      // Reserve the slot *synchronously*, before the first `await` below —
      // not inside `sendPromptTurn`/after `ensureSession()` resolves. A
      // second `prompt()` call issued back-to-back with no intervening
      // `await` (e.g. before `session/new` has even been sent) runs its own
      // synchronous prelude before this function yields, so the guard above
      // must see this reservation already in place or both calls slip past
      // it — exactly the bug this reservation closes.
      let settle!: (reply: SessionReply) => void;
      const reply = new Promise<SessionReply>((resolve) => {
        settle = resolve;
      });
      const slot: { fold: FinalMessageState; settle: (reply: SessionReply) => void } = {
        fold: INITIAL_FINAL_MESSAGE,
        settle,
      };
      inFlight = slot;
      let sessionId: string;
      try {
        sessionId = await ensureSession();
      } catch (err) {
        // The turn never started — release the reservation so the next
        // `prompt()` call is not permanently blocked by this failure. Nobody
        // else holds a reference to `reply` (it was never returned), so
        // leaving it unsettled here is not a leak.
        if (inFlight === slot) inFlight = null;
        throw err;
      }
      sendPromptTurn(sessionId, text);
      return reply;
    },
    cancel(): boolean {
      if (acpSessionId === null) return false;
      cancelling = true;
      try {
        return notify('session/cancel', { sessionId: acpSessionId });
      } finally {
        cancelling = false;
      }
    },
    async load(sessionId: string): Promise<unknown> {
      const run = async (): Promise<unknown> => {
        await initialized;
        log.beginReplace();
        try {
          const result = await sendRequest('session/load', {
            sessionId,
            cwd,
            mcpServers: opts.mcpServers ?? [],
          });
          log.commitReplace();
          acpSessionId = sessionId;
          recordSessionState(result);
          return result;
        } catch (err) {
          log.abortReplace();
          throw err;
        }
      };
      // `then(run, run)` so one failed load does not wedge the queue behind
      // it; overlapping loads are serialized rather than interleaved (Terma's
      // `loadChain` — see acp-session.ts's `load()` doc comment for why
      // resetting the ring per call is not enough on its own).
      const result = loadChain.then(run, run);
      loadChain = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    async setMode(modeId: string): Promise<unknown> {
      const sessionId = await ensureSession();
      return sendRequest('session/set_mode', { sessionId, modeId });
    },
    async authenticate(methodId: string): Promise<unknown> {
      await initialized;
      return sendRequest('authenticate', { methodId });
    },
    respondPermission(id: AcpRequestId, result: unknown): boolean {
      return respond(id, result);
    },
    respondPermissionError(id: AcpRequestId, code: number, message: string): boolean {
      return respondError(id, code, message);
    },
    replay(): AcpReplay<AcpEvent> {
      return replayWithTruncationNotice();
    },
    on(listener: (event: AgentEvent) => void): () => void {
      // Replay whatever is already in the ring — including a synthetic
      // `truncated` notice when the ring's cap dropped events — so a
      // listener attached after the handshake still sees `initialized`,
      // anything since, and any gap in between rather than a silent hole.
      for (const event of replayWithTruncationNotice().events) listener({ type: 'event', event });
      listeners.add(listener);
      publicListenerCount += 1;
      return () => {
        if (listeners.delete(listener)) publicListenerCount -= 1;
      };
    },
    close,
  };
}
