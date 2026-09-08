/**
 * ACP (Agent Client Protocol) types shared across processes, plus the narrow
 * accessors for the bridge's vendor `_meta` extensions.
 *
 * These types were main-process-only until this module existed
 * (`src/main/lib/terminal-host/types.ts`), so nothing ACP-shaped was importable
 * from the renderer. They live here for the same reason every other type in
 * `src/shared/` does: both ends of an IPC boundary need the same shape.
 *
 * Scope is deliberately narrow — types plus `_meta` readers, no behaviour.
 * `_meta.terminal_output`, `_meta.terminal_info` and `_meta.claudeCode.*` are
 * vendor extensions on a 0.x package (SPIKE Q5). Keeping every read of them
 * behind an accessor that returns `null` on an unrecognised shape means a
 * bridge upgrade degrades one card rather than breaking a pane.
 */

/**
 * JSON-RPC id an ACP agent used for a request it made of us. Echoed back
 * verbatim on `acpRespond` — never reinterpreted.
 *
 * The real bridge sent `id = 0` for its first permission request, so no code
 * on this path may test an id for truthiness.
 */
import type { AcpClientCapabilities } from "./acp-providers";

export type AcpRequestId = number | string;

/**
 * Terma-private notification method the daemon records into the event ring
 * when a `session/prompt` round trip settles (params:
 * `{ sessionId, stopReason }`). End-of-turn is otherwise invisible in the
 * frame stream — it lives in the prompt *response*, which the ring never
 * records — so without this marker a replay after re-attach fuses every
 * agent turn into one message. Never written to the agent's stdin.
 */
export const ACP_TURN_ENDED_METHOD = "_terma/turn_ended";

/**
 * Terma-private notification the daemon records when a `session/new` or
 * `session/load` round trip resolves, carrying the parts of the *response*
 * the frame stream never sees: the session's mode state (`modes`) and config
 * options (`configOptions`, where the Claude bridge reports the live model).
 * Without this marker, a client that did not issue the request itself — a
 * re-attaching window, a pane adopting an orchestration-driven session —
 * can never learn which modes the agent advertises. Never written to the
 * agent's stdin. Fields are echoed verbatim from the agent's result and may
 * be null when a provider does not report them.
 */
export const ACP_SESSION_STATE_METHOD = "_terma/session_state";

/**
 * Terma-private notification the daemon records when an agent→client request
 * it had forwarded (notably `session/request_permission`) is finally
 * answered via `acpRespond` (params: `{ id }` — the original request's
 * JSON-RPC id). The answer itself travels only on the agent's stdin, so
 * without this marker no *other* subscriber (the mailbox's messageable
 * handle, a second attached window) can ever tell that the agent stopped
 * waiting on a human. Emitted through the same log-then-emit path as every
 * frame, so a replay pairs each `acp: "request"` envelope with its settle.
 * Never written to the agent's stdin. Additive: consumers that do not know
 * the method ignore it like any other notification.
 */
export const ACP_REQUEST_SETTLED_METHOD = "_terma/request_settled";

/** Minimal JSON-RPC envelope forwarded verbatim from the agent. */
export interface AcpJsonRpcMessage {
  jsonrpc?: string;
  id?: AcpRequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * One ACP protocol event, carried as the JSON-encoded `data` payload of an
 * ordinary `sessionData` frame — ACP rides the existing session data channel
 * rather than introducing a second event type.
 *
 * `truncated` is synthetic: it is never emitted live, only prepended to a
 * replay whose head the ring's cap dropped. It carries `seq: 0` and a `dropped`
 * count that may itself be read only with an explicit numeric check — a falsy
 * test (`if (e.seq)`) would discard exactly the event announcing the loss.
 */
export type AcpEvent =
  | { acp: "initialized"; result: unknown }
  | { acp: "notification"; message: AcpJsonRpcMessage }
  | { acp: "request"; id: AcpRequestId; method: string; params: unknown }
  | { acp: "truncated"; dropped: number };

/**
 * An event plus the sequence number assigned when it was recorded, and the
 * generation of the timeline it belongs to.
 *
 * `seq` is monotonic per session and never reused. `gen` identifies which
 * timeline the event belongs to, and is what makes a replaced timeline
 * detectable — see `AcpReplay.generation`.
 */
export type Sequenced<T> = T & { seq: number; gen: number };

/**
 * An `AcpEvent` as it crosses the wire. `seq` and `gen` are present on
 * everything the daemon's event ring emitted, and absent on a pending request
 * recovered through `acpPendingRequests`, which never went through the ring on
 * that path.
 */
export type WireAcpEvent = AcpEvent & { seq?: number; gen?: number };

export interface AcpReplay<T> {
  events: Sequenced<T>[];
  /**
   * How many events were dropped from the head of the timeline. Non-zero means
   * the replayed timeline is incomplete and the UI must say so. Read it with an
   * explicit numeric comparison: `dropped: 0` is the normal case and is falsy.
   */
  dropped: number;
  /**
   * Which timeline these events belong to. Increments every time the ring is
   * replaced, which happens on a successful `session/load` — where the agent
   * re-emits the whole conversation, so the new events are the *same*
   * conversation, not a continuation of it.
   *
   * This exists because `seq` alone cannot express that. After a load the new
   * events carry higher seqs than everything a client already painted, so a
   * client merging on `seq` keeps both copies and doubles the conversation.
   * Comparing generations makes the replacement detectable in the data instead
   * of relying on the client to remember a rule:
   *
   *   if (replay.generation !== paintedGeneration) discard the local timeline
   *
   * Live events carry the same `gen`, so a client can also notice mid-stream
   * that its timeline is stale and re-fetch, rather than only at a load it
   * issued itself — a load issued by another attached client is otherwise
   * invisible.
   *
   * Compare with `!==`, never truthiness: generations are numbers and a client
   * that has painted nothing starts from a generation it has not seen.
   */
  generation: number;
}

/**
 * What the `agent.onEvent` subscription delivers, mirroring `TerminalEvent`
 * for the PTY path: protocol frames plus the session lifecycle signals a pane
 * needs in order to stop waiting on an agent that is gone.
 */
export type AgentEvent =
  | { type: "event"; event: WireAcpEvent }
  | { type: "exit"; exitCode: number }
  | { type: "error"; message: string }
  | { type: "disconnect" }
  /**
   * This subscription could not attach to the session, so it will receive no
   * frames until an attach succeeds. The session may well still be alive in the
   * daemon — that is exactly why this is announced rather than left silent. The
   * router retries on every reconnect; a consumer that wants to recover sooner
   * can re-issue `createOrAttach`.
   */
  | { type: "attachFailed"; sessionId: string };

/** Create ACP session options. */
export interface CreateAcpSessionOptions {
  id: string;
  cwd: string;
  env?: Record<string, string>;
  command?: string;
  args?: string[];
  /** Overrides applied on top of the resolved env (see `resolveAgentEnv`). */
  envOverrides?: Record<string, string>;
  /** Per-provider capabilities to advertise at `initialize`. */
  clientCapabilities?: AcpClientCapabilities;
}

/**
 * Narrow accessor for the vendor `_meta.terminal_output` extension.
 * Returns null when the bridge does not provide it.
 */
export function acpTerminalOutput(
  meta: unknown,
): { terminalId: string; data: string } | null {
  const output = metaField(meta, "terminal_output");
  if (output === null) return null;
  const { terminal_id: terminalId, data } = output;
  if (typeof terminalId !== "string" || typeof data !== "string") return null;
  return { terminalId, data };
}

/**
 * Narrow accessor for the vendor `_meta.terminal_info` extension, which marks a
 * `tool_call` as terminal-shaped and names the terminal its output will arrive
 * under (SPIKE Q5). Returns null when the bridge does not provide it.
 */
export function acpTerminalInfo(meta: unknown): { terminalId: string } | null {
  const info = metaField(meta, "terminal_info");
  if (info === null) return null;
  const terminalId = info.terminal_id;
  if (typeof terminalId !== "string") return null;
  return { terminalId };
}

/**
 * Narrow accessor for the vendor `_meta.terminal_exit` extension, which the
 * bridge attaches to the final `tool_call_update` (the one carrying
 * `status: "completed" | "failed"`) of a terminal-shaped call. Verified against
 * `@agentclientprotocol/claude-agent-acp@0.62.0` `dist/tools.js`: the shape is
 * `{ terminal_id: string, exit_code: number, signal: null }` — but `exit_code`
 * and `signal` are typed nullable here to match the codex-acp lifecycle this
 * extension imitates. Returns null when the bridge does not provide it.
 *
 * `exit_code: 0` is the normal success case — callers must never test the
 * exit code (or this accessor's fields) for truthiness, only against null.
 */
export function acpTerminalExit(
  meta: unknown,
): { terminalId: string; exitCode: number | null; signal: string | null } | null {
  const exit = metaField(meta, "terminal_exit");
  if (exit === null) return null;
  const terminalId = exit.terminal_id;
  if (typeof terminalId !== "string") return null;
  const exitCode = typeof exit.exit_code === "number" ? exit.exit_code : null;
  const signal = typeof exit.signal === "string" ? exit.signal : null;
  return { terminalId, exitCode, signal };
}

/**
 * Narrow accessor for the vendor `_meta.claudeCode.toolName`, which names the
 * concrete tool behind a `tool_call`'s generic `kind` discriminator.
 * Returns null when the bridge does not provide it.
 */
export function acpToolName(meta: unknown): string | null {
  const claudeCode = metaField(meta, "claudeCode");
  if (claudeCode === null) return null;
  return typeof claudeCode.toolName === "string" ? claudeCode.toolName : null;
}

/** One unified-diff hunk from the bridge's `structuredPatch`. */
export interface AcpPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * Narrow accessor for the vendor
 * `_meta.claudeCode.toolResponse.structuredPatch`, a ready-made unified diff
 * for an edit tool call (SPIKE Q2). Returns null when the bridge does not
 * provide it, or when any hunk is not the expected shape — a partial patch is
 * worse than no patch for a diff viewer.
 */
export function acpStructuredPatch(meta: unknown): AcpPatchHunk[] | null {
  const claudeCode = metaField(meta, "claudeCode");
  if (claudeCode === null) return null;
  const toolResponse = asRecord(claudeCode.toolResponse);
  if (toolResponse === null) return null;
  const patch = toolResponse.structuredPatch;
  if (!Array.isArray(patch)) return null;
  const hunks: AcpPatchHunk[] = [];
  for (const raw of patch) {
    const hunk = asRecord(raw);
    if (hunk === null) return null;
    const { oldStart, oldLines, newStart, newLines, lines } = hunk;
    if (
      typeof oldStart !== "number" ||
      typeof oldLines !== "number" ||
      typeof newStart !== "number" ||
      typeof newLines !== "number" ||
      !Array.isArray(lines) ||
      !lines.every((line) => typeof line === "string")
    ) {
      return null;
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, lines: lines as string[] });
  }
  return hunks;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function metaField(meta: unknown, key: string): Record<string, unknown> | null {
  const record = asRecord(meta);
  if (record === null) return null;
  return asRecord(record[key]);
}
