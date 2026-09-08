/**
 * The session interface — the narrow, protocol-neutral mailbox contract
 * (spec `specs/agent-control-channel.md` §6.4 "Option C", reply shape §5.2).
 *
 * This is the upper of the two abstraction layers, extracted while ACP is
 * still the only driving transport so its shape comes from the abstraction
 * rather than from any one harness's quirks:
 *
 * - **Layer 1 (internal, ACP-shaped)** — the daemon decodes wire frames into
 *   `AcpEvent` (`acp-types.ts`); `agent-sessions/store.ts` and orchestration2
 *   stay typed on ACP; vendor richness rides in `_meta`. Non-ACP transports
 *   translate into that format at the daemon boundary. Nothing here changes
 *   any of that.
 * - **Layer 2 (this module)** — three surfaces and nothing more: `send`, the
 *   `turn-ended {status, error}` signal, and the normalized `reply`. It is
 *   derived *from* the events and knows nothing of ACP: no import from
 *   `acp-types.ts`, no `stopReason` vocabulary, no `_meta`.
 *
 * The mailbox (ACC-06: `send` / `await` / `wake-on`, the operation table)
 * consumes **only** this contract. Anything the mailbox turns out to need
 * must be added here, per transport, rather than reaching under the boundary
 * to protocol frames — that reach is exactly what this extraction prevents.
 *
 * The ACP side of the boundary lives in
 * `src/main/lib/terminal-host/acp-session-contract.ts`; a future transport
 * (Codex `app-server`, spec §12.2) adds its own translation without touching
 * this file beyond what its typed errors genuinely require.
 */

/**
 * How a turn settled, from the mailbox's point of view:
 *
 * - `completed` — the agent finished the turn and its reply text is
 *   meaningful. Includes turns the harness ended early for its own reasons
 *   (token limits, refusals): the transport round trip settled cleanly, the
 *   agent said what it said, and the mailbox delivers it.
 * - `cancelled` — the turn was interrupted (operator stop, explicit cancel
 *   verb). Not an error: `error` is null.
 * - `failed` — the turn did not finish: the round trip rejected, the agent
 *   process died, or the transport reported an error. `error` says which.
 */
export type SessionTurnStatus = "completed" | "cancelled" | "failed";

/**
 * Structured error carried when a turn `failed` (§5.2). `code` is a stable
 * machine-readable discriminant; `message` is for humans.
 *
 * Codes are an open string set because transports report failures with
 * different granularity — ACP's turn-end signal only knows "the round trip
 * rejected", while Codex's `turn/completed` carries typed variants like
 * `contextWindowExceeded` (spec §12.1) that its translator will pass through
 * as codes. The ACP translator emits:
 *
 * - `"turn_failed"` — the prompt round trip rejected; the turn did not
 *   finish cleanly.
 * - `"session_exited"` — the agent process exited mid-turn.
 * - `"session_error"` — the transport reported an error mid-turn.
 *
 * Consumers must treat unknown codes as opaque failures, never exhaustively
 * match on them.
 */
export interface SessionTurnError {
  code: string;
  message: string;
}

/**
 * The `turn-ended` signal: fires exactly once per settled turn, however the
 * turn was driven (mailbox send, pane composer, orchestration). `error` is
 * populated exactly when `status` is `"failed"`.
 */
export interface SessionTurnEnd {
  status: SessionTurnStatus;
  error: SessionTurnError | null;
}

/**
 * Documented cap on `SessionReply.text` (§5.2 truncation policy). A reply
 * longer than this is cut at the cap and flagged `truncated: true` — callers
 * that need the rest use the full item list (a `--full` path, out of scope
 * here), not a bigger cap.
 */
export const REPLY_TEXT_MAX_CHARS = 65_536;

/**
 * The normalized reply a settled turn produces (§5.2). `text` is the **final
 * assistant message** of the turn — not the full item list: tool calls and
 * reasoning stay out. Empty when the turn produced no assistant message
 * (failed before streaming, or a turn that only ran tools).
 *
 * `error` is present exactly when `status` is `"failed"`; `text` still
 * carries whatever the agent streamed before failing, which is often the
 * most useful diagnostic. `truncated` is set only when `text` was cut at
 * `REPLY_TEXT_MAX_CHARS`.
 */
export interface SessionReply {
  status: SessionTurnStatus;
  text: string;
  error?: SessionTurnError;
  truncated?: boolean;
}

/**
 * A session the mailbox can address. This — not `AcpEvent`, not the daemon
 * client — is the only surface ACC-06 programs against.
 *
 * The shape follows the proven `DrivenSession.promptTurn` precedent
 * (`orchestration2/session-driver.ts`): one turn at a time, and settlement
 * **never rejects** — a dead session or wire failure settles as a `failed`
 * reply, so a mailbox operation can always resolve its durable record.
 */
export interface MessageableSession {
  /** Daemon session id (the minted id, not any protocol-internal id). */
  readonly sessionId: string;
  /**
   * Whether a turn is currently in flight. The mailbox's default delivery is
   * queue-for-next-turn (§5.3): it checks this and holds delivery until the
   * session settles rather than opening a concurrent turn.
   */
  readonly busy: boolean;
  /**
   * Start one turn carrying `text`; resolves with the normalized reply when
   * that turn settles. Never rejects. Callers serialize: await the previous
   * turn (or wait for `busy` to clear) before sending the next.
   */
  send(text: string): Promise<SessionReply>;
  /**
   * Subscribe to the turn-ended signal for every settled turn on this
   * session — including turns other drivers started, which is what lets the
   * mailbox flush its queue when a pane-driven turn settles. Returns an
   * unsubscribe function.
   */
  onTurnEnded(listener: (end: SessionTurnEnd) => void): () => void;
}
