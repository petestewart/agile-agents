import { spawn, type ChildProcess } from "child_process";
import { readFile, writeFile, realpath } from "fs/promises";
import { dirname, resolve, sep } from "path";
import { DaemonSession } from "./session-base";
import { DaemonError } from "./daemon-error";
import { AcpEventLog, type AcpReplay } from "./acp-event-log";
import {
  ACP_PROVIDERS,
  type AcpClientCapabilities,
} from "../../shared/acp-providers";
import {
  ACP_REQUEST_SETTLED_METHOD,
  ACP_SESSION_STATE_METHOD,
  ACP_TURN_ENDED_METHOD,
} from "../../shared/acp-types";
import type {
  AcpEvent,
  AcpJsonRpcMessage as JsonRpcMessage,
  AcpRequestId,
  SessionInfo,
} from "../lib/terminal-host/types";


/**
 * ACP (Agent Client Protocol) session: an agent subprocess driven over stdio
 * with newline-delimited JSON-RPC.
 *
 * Lifecycle and refcounting are inherited from `DaemonSession`, so an ACP
 * session attaches, detaches, retains, releases and reaps identically to a PTY
 * session — that equivalence is deliberate (see `session-base.ts`).
 *
 * The daemon is protocol-generic: it frames JSON-RPC, answers the client
 * methods we advertise, and forwards everything else verbatim. No knowledge of
 * any particular agent vendor lives here.
 */

/**
 * Default launch: the Claude entry of the provider registry
 * (`src/shared/acp-providers.ts`), pinned and verified by the Phase 0 spike.
 * The daemon itself stays provider-agnostic — these are only the fallback for
 * callers that pass no command, kept for the existing wire contract.
 */
export const DEFAULT_ACP_COMMAND = ACP_PROVIDERS.claude.command;
export const DEFAULT_ACP_ARGS = [...ACP_PROVIDERS.claude.args];

/**
 * How long an agent gets to honour SIGTERM before the group is SIGKILLed.
 *
 * The daemon's shutdown path (`index.ts`) explicitly waits for this escalation
 * before exiting — `server.close()` can call back on the next tick when no
 * client is connected, which would otherwise let the daemon exit while a
 * SIGTERM-ignoring agent was still alive and reparent it to init forever.
 */
const FORCE_KILL_TIMEOUT_MS = 2000;
const MAX_STDOUT_BUFFER_BYTES = 50 * 1024 * 1024;
/**
 * Handshake bound only. Ordinary requests (`session/prompt`) legitimately run
 * for minutes and are bounded by process exit instead.
 */
const INITIALIZE_TIMEOUT_MS = 120_000;
const ACP_PROTOCOL_VERSION = 1;

/**
 * Default capabilities advertised at `initialize` when the caller supplies
 * none — the registry's Claude entry, matching the default command above.
 * Callers pass per-provider capabilities via `opts.clientCapabilities`.
 *
 * `fs.readTextFile` / `fs.writeTextFile` are standard ACP and are implemented
 * below. `terminal` is deliberately NOT advertised: the spike (Q5) showed the
 * bridge never calls `terminal/create`, and advertising a method we do not
 * implement is a hang waiting to happen.
 */
export const CLIENT_CAPABILITIES = ACP_PROVIDERS.claude.clientCapabilities;

export interface AcpSessionOptions {
  id: string;
  cwd: string;
  env?: Record<string, string>;
  /** Override the agent binary. Defaults to the pinned Claude ACP bridge. */
  command?: string;
  args?: string[];
  /** Env vars overridden on top of the resolved env (per-provider isolation). */
  envOverrides?: Record<string, string>;
  /** Capabilities to advertise at `initialize`. Defaults to the Claude set. */
  clientCapabilities?: AcpClientCapabilities;
  /** Test seam: override the event-ring count cap. */
  eventLogMaxEntries?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Narrow accessor for the vendor `_meta.terminal_output` extension.
 *
 * Now defined in `src/shared/acp-types.ts` alongside the other `_meta` readers,
 * so the renderer uses the same one rather than a second copy. Re-exported here
 * because this module is where it used to live.
 */
export { acpTerminalOutput } from "../../shared/acp-types";

/**
 * Resolve the environment the agent runs with.
 *
 * Defaults to the daemon's own environment: the agent is launched through a
 * resolver (`npx`) and needs `PATH`, and the Claude bridge needs `HOME` for
 * its credential and session stores (SPIKE Q4). An explicit env that cannot
 * possibly work is rejected loudly rather than failing as a silent spawn
 * error later.
 *
 * `overrides` (per-provider isolation, e.g. a provider-private HOME) are
 * applied on top of the full resolved env — never as a replacement, because a
 * minimal env fails at spawn. PATH is validated after the merge so an
 * override cannot smuggle the same failure back in.
 */
export function resolveAgentEnv(
  env: Record<string, string> | undefined,
  overrides?: Record<string, string>,
): Record<string, string> {
  const resolved = { ...(env ?? (process.env as Record<string, string>)), ...overrides };
  if (!resolved.PATH) {
    // DaemonError so the wire layer emits a structured {code, message},
    // like every other client-visible daemon rejection.
    throw new DaemonError("INVALID_PARAMS", "ACP session env must contain PATH");
  }
  return resolved;
}

/**
 * Canonicalise a path that may not exist yet (a file about to be written):
 * resolve the closest existing ancestor and re-append the remainder, so
 * symlinked parents are followed without requiring the leaf to exist.
 */
async function canonicalize(path: string): Promise<string> {
  let current = path;
  const trailing: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return trailing.length ? [real, ...trailing].join(sep) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      trailing.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

/**
 * The user-visible text of a prompt's content blocks: `text` blocks verbatim,
 * `resource_link` blocks by name. MUST build the same string the renderer's
 * optimistic bubble uses (`agent-sessions/store.ts`), because the client
 * retires that bubble by matching this text exactly.
 */
function promptText(prompt: unknown): string | null {
  if (!Array.isArray(prompt)) return null;
  const parts: string[] = [];
  for (const raw of prompt) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (typeof block.text === "string") parts.push(block.text);
    else if (typeof block.name === "string") parts.push(block.name);
  }
  return parts.length > 0 ? parts.join("") : null;
}

export class AcpSession extends DaemonSession {
  readonly kind = "acp" as const;

  private subprocess: ChildProcess | null = null;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Agent→client requests we have forwarded but nobody has answered yet.
   *
   * The agent blocks on each of these, and `emitEvent` has no replay, so
   * without this a client that disappears mid-request (app restart) would
   * leave the agent wedged forever. Recovered on attach via `pendingRequests`.
   */
  private outstanding = new Map<AcpRequestId, { method: string; params: unknown }>();
  private _initialized: Promise<unknown>;
  private spawnError: Error | null = null;
  private cachedRoot: string | null = null;
  private deadResolve: (() => void) | null = null;
  private readonly dead = new Promise<void>((r) => {
    this.deadResolve = r;
  });
  private readonly log: AcpEventLog<AcpEvent>;
  private readonly clientCapabilities: AcpClientCapabilities;
  /** Serialises `session/load` so two in flight cannot interleave. */
  private loadChain: Promise<void> = Promise.resolve();

  constructor(opts: AcpSessionOptions) {
    super(opts.id, opts.cwd);
    // Mirrors PtySession: 3 listeners per client, with headroom for a brief
    // two-client overlap during reconnection.
    this.setMaxListeners(20);
    // EventEmitter THROWS on an 'error' event with no listener, and the only
    // real listener is the wire layer's, which is removed on detach. Without
    // this, emitting an error on a detached session throws — and at the stdout
    // overflow site that throw would skip the kill() immediately after it,
    // announcing "killing session" and then leaking the process. Client-facing
    // delivery is unaffected: when a client is attached, its listener still
    // runs alongside this no-op.
    this.on("error", () => {});
    this.log = new AcpEventLog<AcpEvent>(opts.eventLogMaxEntries);
    this.clientCapabilities = opts.clientCapabilities ?? CLIENT_CAPABILITIES;
    this.spawn(opts);
    this._initialized = this.initialize();
    // Keep a handler attached so a failed handshake can never surface as an
    // unhandled rejection; callers awaiting `initialized` still see the error.
    this._initialized.catch(() => {});
  }

  private spawn(opts: AcpSessionOptions): void {
    const command = opts.command || DEFAULT_ACP_COMMAND;
    const args = opts.args ?? DEFAULT_ACP_ARGS;
    const env = resolveAgentEnv(opts.env, opts.envOverrides);

    this.subprocess = spawn(command, args, {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group. `npx` execs a child of its own, so killing only the
      // direct pid leaves the real agent orphaned — the 2026-07 failure mode.
      // With a group we signal the whole tree in kill().
      detached: true,
    });

    this.subprocess.stdout?.setEncoding("utf8");
    this.subprocess.stdout?.on("data", (chunk: string) => {
      this.pushStdout(chunk);
    });

    this.subprocess.stderr?.setEncoding("utf8");
    this.subprocess.stderr?.on("data", (chunk: string) => {
      // Log but never forward — agent stderr is diagnostics, not protocol.
      process.stderr.write(`[acp-session ${this.id}] stderr: ${chunk}\n`);
    });

    // `exit` and `close` are both handled: Node emits `error` + `close`
    // (never `exit`) when the process could not be spawned at all, and a
    // spawn failure that left the session neither exited nor settled would
    // wedge every pending request forever.
    const onDead = (code: number | null) => {
      if (this.markExited(code ?? -1)) {
        this.clearForceKillTimer();
        this.rejectPending(new Error(this.exitReason()));
        this.deadResolve?.();
        this.emit("exit", code ?? -1);
      }
    };
    this.subprocess.on("exit", onDead);
    this.subprocess.on("close", onDead);

    this.subprocess.on("error", (err) => {
      this.emit("error", err.message);
      // `close` follows and marks the session exited; this only guards the
      // case where it somehow does not.
      this.spawnError = err;
    });
  }

  /** ACP handshake. Resolves with the agent's `initialize` result. */
  private async initialize(): Promise<unknown> {
    try {
      const result = await this.request(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: this.clientCapabilities,
        },
        INITIALIZE_TIMEOUT_MS,
      );
      this.emitEvent({ acp: "initialized", result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("error", `ACP initialize failed: ${message}`);
      throw err;
    }
  }

  /** Resolves once the handshake has completed (or rejects if it failed). */
  get initialized(): Promise<unknown> {
    return this._initialized;
  }

  private pushStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    if (Buffer.byteLength(this.stdoutBuffer) > MAX_STDOUT_BUFFER_BYTES) {
      this.stdoutBuffer = "";
      this.emit(
        "error",
        `ACP stdout buffer exceeded ${MAX_STDOUT_BUFFER_BYTES} bytes; killing session`,
      );
      this.kill();
      return;
    }

    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        console.error(`[acp-session ${this.id}] unparseable line: ${trimmed}`);
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    // Response to one of our requests
    if (message.id !== undefined && message.method === undefined) {
      const responseId = message.id;
      if (typeof responseId !== "number") {
        console.error(
          `[acp-session ${this.id}] dropped response with non-numeric id ${String(responseId)}`,
        );
        return;
      }
      const pending = this.pending.get(responseId);
      if (!pending) {
        console.error(
          `[acp-session ${this.id}] dropped response for unknown request id ${responseId}`,
        );
        return;
      }
      this.pending.delete(responseId);
      if (message.error) {
        pending.reject(
          new Error(`${message.error.message} (code ${message.error.code})`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Request from the agent
    if (message.id !== undefined && message.method !== undefined) {
      void this.handleAgentRequest(message.id, message.method, message.params);
      return;
    }

    // Notification (session/update and friends) — forward verbatim
    if (message.method !== undefined) {
      this.emitEvent({ acp: "notification", message });
    }
  }

  private async handleAgentRequest(
    id: AcpRequestId,
    method: string,
    params: unknown,
  ): Promise<void> {
    const p = (params ?? {}) as Record<string, unknown>;
    // The agent blocks until it gets an answer, so an answer that never
    // reached stdin is worth saying out loud rather than discarding.
    const answer = (ok: boolean) => {
      if (!ok) {
        this.emit(
          "error",
          `Failed to answer agent request '${method}' (id ${String(id)}): agent stdin unavailable`,
        );
      }
    };
    try {
      switch (method) {
        case "fs/read_text_file": {
          const path = await this.confinePath(String(p.path ?? ""));
          const content = await readFile(path, "utf8");
          answer(this.respond(id, { content }));
          return;
        }
        case "fs/write_text_file": {
          const path = await this.confinePath(String(p.path ?? ""));
          await writeFile(path, String(p.content ?? ""), "utf8");
          answer(this.respond(id, {}));
          return;
        }
        default:
          // Anything else (notably session/request_permission) needs a human.
          // Forward it and let the attached client answer via respond().
          // With no client attached nobody can answer, and a silently dropped
          // request blocks the agent until the reaper kills it — so refuse
          // explicitly instead.
          if (!this.isAttached) {
            answer(
              this.respondError(id, -32603, "No client attached to answer request"),
            );
            return;
          }
          // Recorded before it is emitted: the agent blocks until this is
          // answered, and the emit is fire-and-forget with no replay, so a
          // client that goes away mid-request (an app restart) must be able to
          // recover it on re-attach or the agent waits forever.
          this.outstanding.set(id, { method, params });
          this.emitEvent({ acp: "request", id, method, params });
          return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      answer(this.respondError(id, -32603, message));
    }
  }

  /**
   * Confine agent-driven filesystem access to the session's working directory.
   *
   * This is a scoping control on the two fs methods we advertise, not a
   * sandbox: an agent that reads files in its own process (as the Claude
   * bridge does for many tools) never goes through here at all.
   *
   * Both sides are canonicalised before comparison. Agents routinely send
   * canonical paths — the Claude bridge reports `/private/tmp/...` for a
   * session whose cwd is `/tmp/...` — and a textual comparison would refuse
   * files that are genuinely inside the workspace. Canonicalising the target
   * also blocks a symlink *inside* the workspace that points out of it.
   */
  private async confinePath(path: string): Promise<string> {
    const root = await this.workspaceRoot();
    const resolved = await canonicalize(resolve(this.cwd, path));
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error(`Path outside session workspace: ${path}`);
    }
    return resolved;
  }

  private async workspaceRoot(): Promise<string> {
    if (this.cachedRoot === null) {
      this.cachedRoot = await canonicalize(resolve(this.cwd));
    }
    return this.cachedRoot;
  }

  /**
   * Record one protocol event and forward it to attached clients.
   *
   * Emission is unconditional — there is no emulator holding scrollback, so
   * gating on attach would silently drop protocol frames. With no listeners
   * the emit is a no-op, which is precisely the notification-side loss AG-02
   * left open: the *request* side refuses agent requests when nothing is
   * attached, but notifications had nowhere to go. Appending to the log before
   * emitting closes that hole — a detached window now costs nothing, because
   * the events are replayed on reattach.
   *
   * Recording is synchronous — only the disk write is queued — so an event
   * parsed off stdout moments before teardown is still both delivered and
   * cached, and sequence numbers always match stdout arrival order.
   */
  private emitEvent(event: AcpEvent): void {
    this.emit("data", JSON.stringify(this.log.append(event)));
  }

  /**
   * The cached timeline for instant paint on attach, plus the count of events
   * the cap dropped from its head.
   *
   * When anything was dropped a synthetic `truncated` event leads the replay,
   * so the gap is visible in the timeline itself rather than only in a field a
   * renderer might ignore. Callers should also de-duplicate live events whose
   * `seq` is at or below the last replayed one.
   *
   * The timeline is in-memory and covers the current agent process only. After
   * a daemon restart it starts empty and is repopulated by the bridge's own
   * `session/load` replay — see `AcpEventLog` for why persisting it across
   * would double it.
   *
   * Note a long-running session can truncate away its `initialized` event
   * (always `seq: 1`), so clients must not gate rendering on having seen it.
   *
   * `generation` identifies the timeline itself. It changes when the ring is
   * replaced by a `session/load`, which is the only way a client can tell that
   * the events it is receiving *replace* what it painted rather than continue
   * it — `seq` keeps climbing across a replacement and so cannot say this.
   */
  replayEvents(): AcpReplay<AcpEvent> {
    const { events, dropped, generation } = this.log.replay();
    if (dropped > 0) {
      // The synthetic notice carries the timeline's own generation: it belongs
      // to this timeline, and a client filtering on generation must not drop
      // the one event announcing the loss.
      return {
        events: [{ acp: "truncated", dropped, seq: 0, gen: generation }, ...events],
        dropped,
        generation,
      };
    }
    return { events, dropped, generation };
  }

  /**
   * Write one JSON-RPC line. Returns whether the write was *accepted*, not
   * whether the stream drained: `stream.write()` returning false only signals
   * backpressure — the data is still queued and delivered. Treating that as a
   * failure would report large prompts as failed while the agent ran them.
   */
  private writeLine(obj: unknown): boolean {
    if (this.exited || !this.subprocess?.stdin || this.subprocess.stdin.destroyed) {
      return false;
    }
    this.subprocess.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  }

  /**
   * Send a JSON-RPC request to the agent and await its response.
   * `timeoutMs` is optional because ACP requests such as `session/prompt`
   * legitimately run for minutes; untimed requests are still rejected when
   * the agent process dies.
   */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(
        new Error(this.spawnError ? this.exitReason() : "ACP session has exited"),
      );
    }
    if (method === "session/load") {
      return this.load(params, timeoutMs);
    }
    if (method === "session/prompt") {
      return this.promptRequest(params, timeoutMs);
    }
    if (method === "session/new") {
      return this.sendRequest(method, params, timeoutMs).then((result) => {
        this.recordSessionState(result);
        return result;
      });
    }
    return this.sendRequest(method, params, timeoutMs);
  }

  /**
   * Record the session-state half of a `session/new` / `session/load`
   * *response* into the ring (`_terma/session_state`): the response goes only
   * to the requesting client, so without this a re-attaching window or an
   * adopting pane can never learn the agent's advertised modes or model.
   * Fields are echoed verbatim — the daemon stays protocol-generic — and
   * nothing is recorded for a provider that reports neither.
   */
  private recordSessionState(result: unknown): void {
    if (typeof result !== "object" || result === null) return;
    const r = result as Record<string, unknown>;
    if (r.modes === undefined && r.configOptions === undefined) return;
    this.emitEvent({
      acp: "notification",
      message: {
        jsonrpc: "2.0",
        method: ACP_SESSION_STATE_METHOD,
        params: {
          sessionId: typeof r.sessionId === "string" ? r.sessionId : undefined,
          modes: r.modes ?? null,
          configOptions: r.configOptions ?? null,
        },
      },
    });
  }

  /**
   * Forward a `session/prompt`, recording into the ring the two things the
   * frame stream itself never carries:
   *
   * - **The user's prompt.** The bridge echoes user messages as
   *   `user_message_chunk` only on a `session/load` replay, never live — so
   *   without this, a re-attaching client replays a conversation with every
   *   user message missing. Recorded in the same nested SessionNotification
   *   envelope the bridge uses, so clients need no second parse path.
   * - **The end of the turn.** `stopReason` lives in the prompt *response*,
   *   which the ring never records; without a marker, consecutive agent turns
   *   fuse into one message on replay. Recorded whether the round trip
   *   resolved or rejected — the turn is over either way. The marker is
   *   Terma-private (`_terma/turn_ended`) and is never written to the agent.
   */
  private promptRequest(params: unknown, timeoutMs?: number): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : undefined;
    const text = promptText(p.prompt);
    if (text !== null) {
      this.emitEvent({
        acp: "notification",
        message: {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
          },
        },
      });
    }
    const recordTurnEnd = (stopReason: unknown) => {
      this.emitEvent({
        acp: "notification",
        message: {
          jsonrpc: "2.0",
          method: ACP_TURN_ENDED_METHOD,
          params: {
            sessionId,
            stopReason: typeof stopReason === "string" ? stopReason : null,
          },
        },
      });
    };
    return this.sendRequest("session/prompt", params, timeoutMs).then(
      (result) => {
        recordTurnEnd((result as Record<string, unknown> | null | undefined)?.stopReason);
        return result;
      },
      (err: unknown) => {
        recordTurnEnd(null);
        throw err;
      },
    );
  }

  /**
   * Run a `session/load`, which makes the agent re-emit the entire conversation
   * as ordinary notifications before it responds (SPIKE Q4). Those notifications
   * must *become* the timeline rather than stack on top of it — otherwise the
   * ring holds two copies in disjoint `seq` ranges that `seq <= lastReplayed`
   * de-duplication cannot collapse.
   *
   * Two things are needed for that, and only both together are sufficient:
   *
   * - **Single-flight.** Loads are serialised on `loadChain`, because this layer
   *   is a generic passthrough and multiple clients can be attached at once, so
   *   two of them loading on attach is reachable. Clearing the ring per call is
   *   *not* enough: the clear is synchronous but the replay is not, so
   *   overlapping loads each clear an already-empty ring and then both append
   *   into it — reproduced, and exactly the doubling this guards against.
   * - **Staged replacement.** The new timeline is built off to the side and
   *   swapped in only on success, so a failed load restores the previous
   *   timeline instead of destroying it, and a concurrent reader never observes
   *   a half-built or empty one.
   *
   * What this guarantees: no duplication and no loss from loads issued through
   * this method, however they interleave. It does not police an agent that
   * re-emits history unprompted.
   */
  private load(params?: unknown, timeoutMs?: number): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      this.log.beginReplace();
      try {
        const result = await this.sendRequest("session/load", params, timeoutMs);
        this.log.commitReplace();
        // After the commit, so the marker lands in the replacement timeline
        // rather than being discarded with the staged one.
        this.recordSessionState(result);
        return result;
      } catch (err) {
        this.log.abortReplace();
        throw err;
      }
    };
    // `then(run, run)` so one failed load does not wedge the queue behind it.
    const result = this.loadChain.then(run, run);
    // The chain itself must never stay rejected; the caller owns `result`.
    this.loadChain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private sendRequest(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(
        new Error(this.spawnError ? this.exitReason() : "ACP session has exited"),
      );
    }
    const id = this.nextRequestId++;
    return new Promise((resolvePromise, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = <T>(fn: (value: T) => void) => (value: T) => {
        if (timer) clearTimeout(timer);
        fn(value);
      };
      this.pending.set(id, {
        resolve: settle(resolvePromise),
        reject: settle(reject),
      });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      if (!this.writeLine({ jsonrpc: "2.0", id, method, params: params ?? {} })) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error("ACP agent stdin unavailable"));
      }
    });
  }

  /** Send a JSON-RPC notification to the agent (no response expected). */
  notify(method: string, params?: unknown): boolean {
    return this.writeLine({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  /** Answer a request the agent made of us. */
  respond(id: AcpRequestId, result: unknown): boolean {
    const wasForwarded = this.outstanding.delete(id);
    const ok = this.writeLine({ jsonrpc: "2.0", id, result });
    if (wasForwarded) this.recordRequestSettled(id);
    return ok;
  }

  respondError(id: AcpRequestId, code: number, message: string): boolean {
    const wasForwarded = this.outstanding.delete(id);
    const ok = this.writeLine({ jsonrpc: "2.0", id, error: { code, message } });
    if (wasForwarded) this.recordRequestSettled(id);
    return ok;
  }

  /**
   * Record that a *forwarded* agent→client request (one that went out as an
   * `acp: "request"` envelope — permission prompts, chiefly) has been
   * answered. The answer itself travels only on the agent's stdin, so this
   * marker is the one signal other subscribers (the mailbox's messageable
   * handle) get that the agent stopped waiting on a human. Requests answered
   * internally (the fs handlers) were never emitted, so they never settle
   * here — `outstanding` gates both sides.
   */
  private recordRequestSettled(id: AcpRequestId): void {
    this.emitEvent({
      acp: "notification",
      message: {
        jsonrpc: "2.0",
        method: ACP_REQUEST_SETTLED_METHOD,
        params: { id },
      },
    });
  }

  /**
   * Requests the agent is still blocked on, as the same `acp: "request"`
   * envelopes they were originally delivered as — so a re-attaching client
   * replays them through its normal handler rather than a special path.
   */
  pendingRequests(): AcpEvent[] {
    return Array.from(this.outstanding, ([id, { method, params }]) => ({
      acp: "request" as const,
      id,
      method,
      params,
    }));
  }

  /** Why the agent is gone — the spawn error if there was one. */
  private exitReason(): string {
    return this.spawnError
      ? `ACP agent failed to start: ${this.spawnError.message}`
      : "ACP agent exited";
  }

  private rejectPending(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  /**
   * Resolves once the agent process is gone, or after `timeoutMs`. The daemon
   * shutdown path awaits this so the SIGKILL escalation in `kill()` actually
   * gets to run before the process exits.
   */
  async whenDead(timeoutMs: number): Promise<void> {
    if (this.exited) return;
    await Promise.race([
      this.dead,
      new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.()),
    ]);
  }

  kill(): void {
    if (this.exited) return;

    this.clearForceKillTimer();
    this.signalTree("SIGTERM");

    this.forceKillTimer = setTimeout(() => {
      this.forceKillTimer = null;
      if (this.subprocess && !this.exited) {
        this.signalTree("SIGKILL");
      }
    }, FORCE_KILL_TIMEOUT_MS);
  }

  /**
   * Signal the agent's whole process group. `npx` is a launcher: signalling
   * only its pid leaves the agent it exec'd running as an orphan.
   */
  private signalTree(signal: NodeJS.Signals): void {
    const pid = this.subprocess?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // Group already gone (or never created) — fall back to the direct pid.
      try {
        this.subprocess?.kill(signal);
      } catch {
        // Process already reaped.
      }
    }
  }

  private clearForceKillTimer(): void {
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer);
      this.forceKillTimer = null;
    }
  }

  destroy(): void {
    this.clearForceKillTimer();
    this.log.reset();
    if (!this.exited) {
      this.kill();
    }
    this.rejectPending(new Error("ACP session destroyed"));
    // The agent is gone, so nothing can answer these any more.
    this.outstanding.clear();
    this.removeAllListeners();
    // Re-arm the no-op: the subprocess handlers outlive destroy(), so a late
    // stdout overflow could still emit and throw on a listener-less emitter.
    this.on("error", () => {});
  }

  getInfo(): SessionInfo {
    return {
      kind: this.kind,
      id: this.id,
      cwd: this.cwd,
      pid: this.subprocess?.pid,
      createdAt: this.createdAt,
      attached: this.isAttached,
      retained: this.isRetained,
      exited: this.isExited,
    };
  }
}
