/**
 * ACP implementation of the `MessageableSession` contract (spec §6.4) — the
 * stateful wiring the contract extraction (#123) deliberately deferred to the
 * mailbox: who holds the reply fold, when it resets, and how a daemon session
 * becomes something the mailbox can `send()` to.
 *
 * The mailbox consumes ONLY `@shared/agent-session-contract`; this module is
 * the one place that binds the contract to the ACP event stream, and it does
 * so exclusively through the pure folds in
 * `terminal-host/acp-session-contract.ts` — no `stopReason` vocabulary or
 * frame-shape knowledge lives here beyond what those folds expose.
 *
 * Frames are consumed via `manager.subscribe()` (the multi-subscriber path),
 * never by owning the `createOrAttachAcp` callback slot — same rule as
 * `session-driver.ts`. Frames only flow while an attach ref is held; the hub
 * takes one per live handle and drops it on dispose (the mailbox holds
 * handles exactly while operations are outstanding — retain-while-pending
 * pairs with attach-while-pending).
 */
import type {
  MessageableSession,
  SessionReply,
  SessionTurnEnd,
} from "@shared/agent-session-contract";
import {
  applyFinalMessageEvent,
  INITIAL_FINAL_MESSAGE,
  replyFromFinalMessage,
  turnEndFromError,
  turnEndFromEvent,
  turnEndFromExit,
  type FinalMessageState,
} from "../terminal-host/acp-session-contract";
import { parseAcpEvent } from "../terminal-host/acp-events";
import { ACP_REQUEST_SETTLED_METHOD } from "@shared/acp-types";
import type { AcpRequestId } from "@shared/acp-types";
import type { AcpEvent, AcpReplay, SessionInfo, WireAcpEvent } from "../terminal-host/types";

/** The slice of DaemonTerminalManager the messageable wiring needs. */
export interface MessageableDaemon {
  subscribe(
    sessionId: string,
    subscriber: {
      onData: (data: string) => void;
      onExit: (exitCode: number) => void;
      onError: (error: string) => void;
      onDisconnect: () => void;
    },
  ): () => void;
  acpRequest(sessionId: string, method: string, params?: unknown): Promise<unknown>;
  acpReplay(sessionId: string): Promise<AcpReplay<AcpEvent>>;
  listSessions(): Promise<SessionInfo[]>;
  attachRef(sessionId: string): Promise<boolean>;
  detachRef(sessionId: string): Promise<void>;
  retain(sessionId: string): Promise<void>;
  release(sessionId: string): Promise<void>;
}

export { SessionAddressError } from "./session-address-error";
import { SessionAddressError } from "./session-address-error";

/** The ACP envelope's session id, off any frame that carries one. */
function acpSessionIdOf(event: AcpEvent | WireAcpEvent): string | null {
  const params =
    event.acp === "notification"
      ? event.message.params
      : event.acp === "request"
        ? event.params
        : null;
  if (typeof params !== "object" || params === null) return null;
  const sessionId = (params as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" ? sessionId : null;
}

/** Does this frame mark the start of a turn (the daemon's prompt echo)? */
function isTurnStart(event: WireAcpEvent): boolean {
  if (event.acp !== "notification") return false;
  if (event.message.method !== "session/update") return false;
  const params = event.message.params as { update?: { sessionUpdate?: unknown } } | undefined;
  return params?.update?.sessionUpdate === "user_message_chunk";
}

/** The request id of a `session/request_permission` the agent is blocked on. */
function permissionRequestIdOf(event: AcpEvent | WireAcpEvent): AcpRequestId | null {
  if (event.acp !== "request") return null;
  if (event.method !== "session/request_permission") return null;
  return event.id;
}

/**
 * The request id settled by a `_terma/request_settled` marker (see
 * `acp-types.ts`) — the daemon's signal that a forwarded agent→client
 * request was finally answered.
 */
function settledRequestIdOf(event: AcpEvent | WireAcpEvent): AcpRequestId | null {
  if (event.acp !== "notification") return null;
  if (event.message.method !== ACP_REQUEST_SETTLED_METHOD) return null;
  const params = event.message.params;
  if (typeof params !== "object" || params === null) return null;
  const id = (params as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

interface InFlightTurn {
  fold: FinalMessageState;
  settle: (reply: SessionReply) => void;
}

/**
 * One live messageable handle over a daemon ACP session. Created and cached
 * by `AcpSessionHub`; disposed when the hub drops its last hold.
 */
export class AcpMessageableSession implements MessageableSession {
  private acpSessionId: string | null = null;
  private busyState = false;
  /**
   * `session/request_permission` requests the agent is currently blocked on,
   * by JSON-RPC id (GH-129). Populated from `acp: "request"` frames, drained
   * by the daemon's `_terma/request_settled` markers, and cleared wholesale
   * at every turn boundary — a finished turn cannot still be waiting on a
   * human, and a daemon old enough not to emit settle markers degrades to
   * exactly that turn-boundary clearing.
   */
  private pendingPermissions = new Set<AcpRequestId>();
  private inFlight: InFlightTurn | null = null;
  private turnListeners = new Set<(end: SessionTurnEnd) => void>();
  private unsubscribe: (() => void) | null = null;
  private dead = false;

  constructor(
    readonly sessionId: string,
    private readonly daemon: MessageableDaemon,
  ) {}

  get busy(): boolean {
    return this.busyState;
  }

  /**
   * Whether the in-flight turn is blocked on an unresolved
   * `session/request_permission` — i.e. the agent is waiting on a human, not
   * thinking (GH-129). Purely observational; only meaningful while `busy`.
   */
  get blockedOnPermission(): boolean {
    return this.busyState && this.pendingPermissions.size > 0;
  }

  get exited(): boolean {
    return this.dead;
  }

  /**
   * Bind to the live frame stream and derive initial state from the replay:
   * the ACP session id from any enveloped frame, and busy-ness from whether
   * the replay ends inside an open turn.
   */
  async init(): Promise<void> {
    this.unsubscribe = this.daemon.subscribe(this.sessionId, {
      onData: (data) => {
        const event = parseAcpEvent(data);
        if (event) this.handleEvent(event);
      },
      onExit: (exitCode) => this.handleEnd(turnEndFromExit(exitCode), true),
      onError: (error) => this.handleEnd(turnEndFromError(error), true),
      onDisconnect: () => {},
    });
    const replay = await this.daemon.acpReplay(this.sessionId);
    for (const event of replay.events) {
      const id = acpSessionIdOf(event);
      if (id !== null) this.acpSessionId = id;
      const wire = event as WireAcpEvent;
      if (isTurnStart(wire)) this.busyState = true;
      this.foldPermissionState(wire);
      if (turnEndFromEvent(wire) !== null) {
        this.busyState = false;
        this.pendingPermissions.clear();
      }
    }
  }

  /**
   * Track the unresolved-permission set off one frame: a
   * `session/request_permission` request opens an entry, the daemon's
   * `_terma/request_settled` marker closes it. Applied identically to the
   * replay (init) and the live stream, so a handle opened mid-prompt reports
   * blocked just like one that watched the request arrive.
   */
  private foldPermissionState(event: WireAcpEvent): void {
    const requested = permissionRequestIdOf(event);
    if (requested !== null) this.pendingPermissions.add(requested);
    const settled = settledRequestIdOf(event);
    if (settled !== null) this.pendingPermissions.delete(settled);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.turnListeners.clear();
  }

  onTurnEnded(listener: (end: SessionTurnEnd) => void): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
  }

  /**
   * Start one turn carrying `text`; resolves with the normalized reply when
   * the turn settles. Never rejects (§6.4): a dead session or wire failure
   * settles as a failed reply.
   */
  send(text: string): Promise<SessionReply> {
    if (this.dead) {
      return Promise.resolve({
        status: "failed",
        text: "",
        error: { code: "session_exited", message: "The agent session has exited." },
      });
    }
    if (this.inFlight) {
      // Contract violation guard — the mailbox serializes deliveries, so this
      // is a bug upstream, reported as a failed reply rather than a throw.
      return Promise.resolve({
        status: "failed",
        text: "",
        error: { code: "turn_in_flight", message: "A delivery turn is already running." },
      });
    }
    this.busyState = true;
    return new Promise<SessionReply>((resolve) => {
      this.inFlight = { fold: INITIAL_FINAL_MESSAGE, settle: resolve };
      void this.resolveAcpSessionId()
        .then((acpSessionId) =>
          this.daemon.acpRequest(this.sessionId, "session/prompt", {
            sessionId: acpSessionId,
            prompt: [{ type: "text", text }],
          }),
        )
        .catch((err) => {
          // Wire-level rejection (daemon drop, agent spawn failure): the turn
          // is over even though no `_terma/turn_ended` will arrive.
          this.handleEnd(
            turnEndFromError(err instanceof Error ? err.message : String(err)),
            false,
          );
        });
    });
  }

  private async resolveAcpSessionId(): Promise<string> {
    if (this.acpSessionId !== null) return this.acpSessionId;
    const replay = await this.daemon.acpReplay(this.sessionId);
    for (const event of replay.events) {
      const id = acpSessionIdOf(event);
      if (id !== null) this.acpSessionId = id;
    }
    if (this.acpSessionId === null) {
      throw new Error(
        "The agent session has no ACP session yet (no session/new has completed).",
      );
    }
    return this.acpSessionId;
  }

  private handleEvent(event: WireAcpEvent): void {
    const id = acpSessionIdOf(event);
    if (id !== null) this.acpSessionId = id;

    if (isTurnStart(event)) this.busyState = true;
    this.foldPermissionState(event);
    if (this.inFlight) {
      this.inFlight.fold = applyFinalMessageEvent(this.inFlight.fold, event);
    }
    const end = turnEndFromEvent(event);
    if (end !== null) this.handleEnd(end, false);
  }

  private handleEnd(end: SessionTurnEnd, died: boolean): void {
    if (died) {
      this.dead = true;
      // An exit with no turn open is lifecycle news, not a turn boundary —
      // only surface it when something was actually in flight or busy.
      if (!this.inFlight && !this.busyState) return;
    }
    this.busyState = false;
    // A finished turn cannot still be waiting on the user — whatever prompt
    // was pending is stale (mirrors frame-router's clearStaleAttention).
    this.pendingPermissions.clear();
    const inFlight = this.inFlight;
    this.inFlight = null;
    if (inFlight) {
      inFlight.settle(replyFromFinalMessage(inFlight.fold, end));
    }
    for (const listener of [...this.turnListeners]) {
      listener(end);
    }
  }
}

/**
 * Cache of live messageable handles, keyed by daemon session id, refcounted
 * by `acquire`/`release` holds. A hold also pins the underlying session:
 * daemon retain (§6.3 retain-while-pending — closing B's pane while A awaits
 * B must not strand A) plus a frame attach ref (a retained-but-detached
 * session is frame-silent).
 */
export class AcpSessionHub {
  /**
   * Keyed by session id; `promise` is the single-flight init. Concurrent
   * acquires for the same session join the same entry (each bumping `holds`)
   * instead of racing retain/attach/init — two `/control` requests can hit
   * `acquire` for the same recipient in the same tick.
   */
  private handles = new Map<
    string,
    { promise: Promise<AcpMessageableSession>; holds: number }
  >();

  /**
   * Handles whose init has completed, for the synchronous non-owning `peek`.
   * Entries appear when `open()` resolves and vanish when the last hold
   * disposes the handle — a peek never extends a lifetime.
   */
  private live = new Map<string, AcpMessageableSession>();

  constructor(private readonly daemon: MessageableDaemon) {}

  /**
   * Synchronous, non-owning look at an already-open handle (GH-129: the
   * mailbox reads `busy` / `blockedOnPermission` off it to annotate
   * unsettled operations). Returns undefined while init is still in flight
   * or when no holds keep the handle alive — callers must treat absence as
   * "no diagnosis", never as "not busy".
   */
  peek(sessionId: string): AcpMessageableSession | undefined {
    return this.live.get(sessionId);
  }

  /**
   * Resolve a daemon session id to a messageable handle, taking one hold.
   * Throws `SessionAddressError` for unknown ids and PTY sessions (§6.2 —
   * terminal panes have no turn signals; the fix is a GUI-mode profile).
   */
  async acquire(sessionId: string): Promise<AcpMessageableSession> {
    const existing = this.handles.get(sessionId);
    if (existing) {
      existing.holds += 1;
      try {
        return await existing.promise;
      } catch (err) {
        // Joined a failed init: give the hold back (the opener removed the
        // entry already, so a later acquire starts fresh).
        existing.holds -= 1;
        throw err;
      }
    }

    const entry = { promise: this.open(sessionId), holds: 1 };
    this.handles.set(sessionId, entry);
    try {
      return await entry.promise;
    } catch (err) {
      if (this.handles.get(sessionId) === entry) this.handles.delete(sessionId);
      throw err;
    }
  }

  private async open(sessionId: string): Promise<AcpMessageableSession> {
    const sessions = await this.daemon.listSessions();
    const info = sessions.find((s) => s.id === sessionId);
    if (!info) {
      throw new SessionAddressError(
        "session_not_found",
        `No session "${sessionId}" exists.`,
      );
    }
    if (info.kind !== "acp") {
      throw new SessionAddressError(
        "wrong_session_kind",
        `Session "${sessionId}" is a terminal (PTY) session with no turn signals.`,
      );
    }
    if (info.exited === true) {
      throw new SessionAddressError(
        "session_exited",
        `Session "${sessionId}" has exited.`,
      );
    }

    await this.daemon.retain(sessionId);
    await this.daemon.attachRef(sessionId);
    const session = new AcpMessageableSession(sessionId, this.daemon);
    try {
      await session.init();
    } catch (err) {
      session.dispose();
      await this.daemon.detachRef(sessionId).catch(() => {});
      await this.daemon.release(sessionId).catch(() => {});
      throw err;
    }
    this.live.set(sessionId, session);
    return session;
  }

  /** Drop one hold; the last hold disposes the handle and unpins the session. */
  async release(sessionId: string): Promise<void> {
    const entry = this.handles.get(sessionId);
    if (!entry) return;
    entry.holds -= 1;
    if (entry.holds > 0) return;
    this.handles.delete(sessionId);
    try {
      const session = await entry.promise;
      session.dispose();
      // Drop the peek entry only after init has settled, and only if it is
      // still ours: deleting before the await would race a still-initializing
      // open() (whose `live.set` runs when the promise resolves, i.e. after a
      // synchronous delete here), and an unconditional delete would race a
      // NEW entry opened for the same id while we awaited.
      if (this.live.get(sessionId) === session) this.live.delete(sessionId);
    } catch {
      // Init never succeeded; open() already unpinned (and never set `live`).
      return;
    }
    await this.daemon.detachRef(sessionId).catch(() => {});
    await this.daemon.release(sessionId).catch(() => {});
  }
}
