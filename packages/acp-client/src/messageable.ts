/**
 * `MessageableSession` — the narrow, protocol-neutral mailbox contract over
 * a live `spawnSession(...)` handle: `send`, the turn-ended signal, and
 * whether a permission request is currently blocking the turn.
 *
 * Provenance: lifted from Terma
 * (vendor/terma/src/main/lib/control/messageable-acp-session.ts,
 * `AcpMessageableSession`) and adapted — the daemon-side `AcpSessionHub`
 * (refcounted acquire/release over a multi-session daemon registry) is
 * dropped: this package spawns one process per `spawnSession` call, so there
 * is no registry to hub over. A daemon that manages many sessions (T004+)
 * builds that layer on top of `spawnSession`, not inside this package. What
 * is kept: deriving `busy` from the live event stream, the
 * blocked-on-permission tracking (GH-129 in Terma), and settling turns
 * driven by *any* caller of `prompt()`, not just this wrapper's own `send`.
 */
import type { SpawnedSession } from './session';
import { ACP_REQUEST_SETTLED_METHOD, ACP_TURN_ENDED_METHOD } from './types';
import type { AcpRequestId, SessionReply, SessionTurnEnd, WireAcpEvent } from './types';

/**
 * A session the mailbox can address (design §5). One turn at a time;
 * settlement never rejects — `send` resolves through `spawnSession`'s own
 * `prompt()`, which already turns a dead session or wire failure into a
 * `failed` reply.
 */
export interface MessageableSession {
  readonly sessionId: string;
  /** Whether a turn is currently in flight. */
  readonly busy: boolean;
  /**
   * Whether the in-flight turn is blocked on an unresolved
   * `session/request_permission` — i.e. the agent is waiting on a human, not
   * thinking. Purely observational; only meaningful while `busy`.
   */
  readonly blockedOnPermission: boolean;
  /** Start one turn carrying `text`; resolves with the normalized reply when it settles. */
  send(text: string): Promise<SessionReply>;
  /** Subscribe to the turn-ended signal for every settled turn on this session. Returns an unsubscribe function. */
  onTurnEnded(listener: (end: SessionTurnEnd) => void): () => void;
  /** Stop watching the underlying session. */
  dispose(): void;
}

function turnEndedParams(event: WireAcpEvent): { stopReason?: unknown } | undefined {
  if (event.acp !== 'notification' || event.message.method !== ACP_TURN_ENDED_METHOD)
    return undefined;
  return event.message.params as { stopReason?: unknown } | undefined;
}

/** Whether this frame marks the start of a turn (the recorded prompt echo). */
function isTurnStart(event: WireAcpEvent): boolean {
  if (event.acp !== 'notification' || event.message.method !== 'session/update') return false;
  const params = event.message.params as { update?: { sessionUpdate?: unknown } } | undefined;
  return params?.update?.sessionUpdate === 'user_message_chunk';
}

function permissionRequestIdOf(event: WireAcpEvent): AcpRequestId | null {
  if (event.acp !== 'request' || event.method !== 'session/request_permission') return null;
  return event.id;
}

function settledRequestIdOf(event: WireAcpEvent): AcpRequestId | null {
  if (event.acp !== 'notification' || event.message.method !== ACP_REQUEST_SETTLED_METHOD)
    return null;
  const params = event.message.params;
  if (typeof params !== 'object' || params === null) return null;
  const id = (params as Record<string, unknown>).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function isTurnEndMarker(event: WireAcpEvent): boolean {
  return event.acp === 'notification' && event.message.method === ACP_TURN_ENDED_METHOD;
}

/**
 * Wrap a live `spawnSession` handle as a `MessageableSession`. `sessionId`
 * addresses the wrapper itself (the caller's own id for it), independent of
 * the underlying ACP session id `spawnSession` mints lazily.
 */
export function createMessageableSession(
  sessionId: string,
  session: SpawnedSession,
): MessageableSession {
  let busy = false;
  const pendingPermissions = new Set<AcpRequestId>();
  const turnListeners = new Set<(end: SessionTurnEnd) => void>();

  const unsubscribe = session.on((agentEvent) => {
    if (agentEvent.type !== 'event') return;
    const event = agentEvent.event;
    if (isTurnStart(event)) busy = true;

    const requested = permissionRequestIdOf(event);
    if (requested !== null) pendingPermissions.add(requested);
    const settled = settledRequestIdOf(event);
    if (settled !== null) pendingPermissions.delete(settled);

    if (isTurnEndMarker(event)) {
      busy = false;
      pendingPermissions.clear();
      const params = turnEndedParams(event);
      const stopReason = typeof params?.stopReason === 'string' ? params.stopReason : null;
      const end: SessionTurnEnd =
        stopReason === null
          ? {
              status: 'failed',
              error: {
                code: 'turn_failed',
                message: 'The turn did not finish cleanly (prompt rejected)',
              },
            }
          : stopReason === 'cancelled'
            ? { status: 'cancelled', error: null }
            : { status: 'completed', error: null };
      for (const listener of [...turnListeners]) listener(end);
    }
  });

  return {
    sessionId,
    get busy() {
      return busy;
    },
    get blockedOnPermission() {
      return busy && pendingPermissions.size > 0;
    },
    send(text: string): Promise<SessionReply> {
      if (busy) {
        // Contract violation guard — the mailbox is meant to serialize
        // deliveries (design §5), so a second `send` while one is in flight
        // is a bug upstream. Settling as a failed reply (never rejecting,
        // per the contract above) is what stops it from hanging the caller
        // forever, since `session.prompt()` itself now rejects a concurrent
        // call rather than stranding it.
        return Promise.resolve({
          status: 'failed',
          text: '',
          error: { code: 'turn_in_flight', message: 'A delivery turn is already running.' },
        });
      }
      busy = true;
      return session.prompt(text);
    },
    onTurnEnded(listener: (end: SessionTurnEnd) => void): () => void {
      turnListeners.add(listener);
      return () => turnListeners.delete(listener);
    },
    dispose(): void {
      unsubscribe();
      turnListeners.clear();
    },
  };
}
