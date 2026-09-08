/**
 * ACP (Agent Client Protocol) wire types and the vendor-neutral turn/reply
 * contract, extracted from Terma's `src/shared/acp-types.ts` and
 * `src/shared/agent-session-contract.ts` (see design/agile-agents-design.md
 * §8 "Adapter contract (ACP)"). Provenance: this file is lifted from Terma
 * (vendor/terma/src/shared/acp-types.ts, acp-providers.ts,
 * agent-session-contract.ts) and adapted — Terma/Electron/Drizzle naming
 * removed, `_terma/*` wire markers renamed to `_agile/*`.
 */

/**
 * JSON-RPC id an ACP agent used for a request it made of the client. Echoed
 * back verbatim on `respondPermission` / `respondPermissionError` — never
 * reinterpreted. The real Claude bridge sent `id = 0` for its first
 * permission request, so no code on this path may test an id for truthiness.
 */
export type AcpRequestId = number | string;

/**
 * Package-private notification method the session records into its event
 * stream when a `session/prompt` round trip settles (params:
 * `{ sessionId, stopReason }`). End-of-turn is otherwise invisible in the
 * frame stream — it lives in the prompt *response*, which a listener
 * attaching mid-turn never sees — so without this marker a caller cannot
 * tell turns apart from the notification stream alone. Never written to the
 * agent's stdin.
 */
export const ACP_TURN_ENDED_METHOD = '_agile/turn_ended';

/**
 * Package-private notification recorded when a `session/new` or
 * `session/load` round trip resolves, carrying the parts of the *response*
 * the frame stream never sees: the session's mode state (`modes`) and config
 * options (`configOptions`, where the Claude bridge reports the live model).
 * Never written to the agent's stdin. Fields are echoed verbatim from the
 * agent's result and may be null when a provider does not report them.
 */
export const ACP_SESSION_STATE_METHOD = '_agile/session_state';

/**
 * Package-private notification recorded when a forwarded agent→client
 * request (notably `session/request_permission`) is finally answered via
 * `respondPermission` / `respondPermissionError`. The answer itself travels
 * only on the agent's stdin, so without this marker nothing else observing
 * the event stream can tell that the agent stopped waiting on a human.
 * Never written to the agent's stdin.
 */
export const ACP_REQUEST_SETTLED_METHOD = '_agile/request_settled';

/** Minimal JSON-RPC envelope exchanged with the agent over stdio. */
export interface AcpJsonRpcMessage {
  jsonrpc?: string;
  id?: AcpRequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * One ACP protocol event, as decoded off the agent's stdout (or synthesized
 * by this package — `truncated`).
 *
 * `truncated` is synthetic: it is never emitted live, only prepended to a
 * replay whose head the event ring's cap dropped. It carries a `dropped`
 * count that may itself be read only with an explicit numeric check — a
 * falsy test (`if (e.seq)`) would discard exactly the event announcing the
 * loss.
 */
export type AcpEvent =
  | { acp: 'initialized'; result: unknown }
  | { acp: 'notification'; message: AcpJsonRpcMessage }
  | { acp: 'request'; id: AcpRequestId; method: string; params: unknown }
  | { acp: 'truncated'; dropped: number };

/**
 * An event plus the sequence number assigned when it was recorded, and the
 * generation of the timeline it belongs to.
 *
 * `seq` is monotonic per session and never reused. `gen` identifies which
 * timeline the event belongs to — it changes when the ring is replaced by a
 * `session/load`, the only way a caller can tell that events it is
 * receiving *replace* what it already saw rather than continue it.
 */
export type Sequenced<T> = T & { seq: number; gen: number };

/** An `AcpEvent` carrying its ring stamps, where one was assigned. */
export type WireAcpEvent = AcpEvent & { seq?: number; gen?: number };

export interface AcpReplay<T> {
  events: Sequenced<T>[];
  /**
   * How many events were dropped from the head of the timeline. Non-zero
   * means the replayed timeline is incomplete. Read it with an explicit
   * numeric comparison: `dropped: 0` is the normal case and is falsy.
   */
  dropped: number;
  /** Which timeline these events belong to — see `Sequenced`. */
  generation: number;
}

/**
 * What `spawnSession(...).on(...)` delivers: protocol frames plus the
 * process lifecycle signals a caller needs in order to stop waiting on an
 * agent that is gone.
 */
export type AgentEvent =
  | { type: 'event'; event: Sequenced<AcpEvent> }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string };

/** Vendor capability extensions and the two standard `fs/*` capabilities. */
export interface AcpClientCapabilities {
  fs: { readTextFile: boolean; writeTextFile: boolean };
  /**
   * Vendor capability extensions, advertised per provider. Advertising an
   * extension a provider does not know is harmless (it ignores `_meta`), but
   * keeping it per-provider is what stops one vendor's needs from becoming a
   * default every new provider inherits.
   */
  _meta?: Record<string, boolean>;
}

/** Options accepted by `spawnSession`. */
export interface SpawnSessionOptions {
  /** The agent binary to spawn. */
  cmd: string;
  /** Arguments to the binary. Defaults to none. */
  args?: string[];
  cwd: string;
  /** Full environment for the subprocess. Defaults to the caller's own `process.env`. */
  env?: Record<string, string>;
  /**
   * Env vars overridden on top of the resolved env (per-provider isolation,
   * e.g. a provider-private HOME). Applied on top of the full resolved env —
   * never as a replacement, because a minimal env fails at spawn.
   */
  envOverrides?: Record<string, string>;
  /** Capabilities to advertise at `initialize`. Defaults to `{ fs: { readTextFile: true, writeTextFile: true } }`. */
  clientCapabilities?: AcpClientCapabilities;
  /** Test seam: override the event-ring entry cap. */
  eventLogMaxEntries?: number;
  /** Test seam: override the event-ring byte cap. */
  eventLogMaxChars?: number;
  /** Test seam: override the stdout line-framer byte cap. */
  maxStdoutBufferBytes?: number;
}

/**
 * Structured error thrown for client-side misconfiguration (never for
 * anything the agent itself reports — those are plain `Error`s carrying the
 * agent's message). `code` is a stable, machine-matchable discriminant.
 */
export class AcpClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AcpClientError';
  }
}

/**
 * Thrown by `prompt()` when the agent's `session/new` reports that
 * authentication is required before a session can be created (Cursor/Grok —
 * design/spike-findings.md §C, §D). `authMethods` carries whatever the
 * agent's error `data` reported, verbatim, when it reported anything.
 */
export class AuthRequiredError extends Error {
  constructor(
    message: string,
    readonly authMethods?: unknown,
  ) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

// ---------------------------------------------------------------------------
// The vendor-neutral turn/reply contract (from Terma's
// `agent-session-contract.ts`). Kept separate from the ACP-shaped types
// above: nothing below this line may import `stopReason` vocabulary.
// ---------------------------------------------------------------------------

/**
 * How a turn settled:
 *
 * - `completed` — the agent finished the turn and its reply text is
 *   meaningful. Includes turns the harness ended early for its own reasons
 *   (token limits, refusals): the round trip settled cleanly and the agent
 *   said what it said.
 * - `cancelled` — the turn was interrupted (`session/cancel`). Not an
 *   error: `error` is null.
 * - `failed` — the turn did not finish: the round trip rejected, the agent
 *   process died, or the transport reported an error. `error` says which.
 */
export type SessionTurnStatus = 'completed' | 'cancelled' | 'failed';

/**
 * Structured error carried when a turn `failed`. `code` is a stable
 * machine-readable discriminant; `message` is for humans. Consumers must
 * treat unknown codes as opaque failures, never exhaustively match on them.
 */
export interface SessionTurnError {
  code: string;
  message: string;
}

/** The turn-ended signal: fires exactly once per settled turn. */
export interface SessionTurnEnd {
  status: SessionTurnStatus;
  error: SessionTurnError | null;
}

/** Cap on `SessionReply.text`. A reply longer than this is cut at the cap and flagged `truncated: true`. */
export const REPLY_TEXT_MAX_CHARS = 65_536;

/**
 * The normalized reply a settled turn produces. `text` is the **final
 * assistant message** of the turn — not the full item list: tool calls and
 * reasoning stay out. Empty when the turn produced no assistant message.
 */
export interface SessionReply {
  status: SessionTurnStatus;
  text: string;
  error?: SessionTurnError;
  truncated?: boolean;
}
