/**
 * Adapted from Terma's messageable-acp-session.test.ts
 * (vendor/terma/src/__tests__/unit/messageable-acp-session.test.ts): the
 * `AcpSessionHub` tests are dropped (no daemon-side multi-session registry
 * exists in this package — see messageable.ts's header), but the
 * `AcpMessageableSession` behaviour it pinned — busy derivation, turn
 * folding, exit handling, and blocked-on-permission tracking (GH-129) — is
 * ported against a fake `SpawnedSession` instead of a fake daemon.
 */
import { describe, expect, it } from 'bun:test';
import { createMessageableSession } from './messageable';
import type { SpawnedSession } from './session';
import type { AgentEvent, SessionReply, SessionTurnEnd } from './types';

/** A minimal fake `SpawnedSession`: enough surface for `createMessageableSession`. */
class FakeSpawnedSession implements Pick<SpawnedSession, 'prompt' | 'on'> {
  private listeners = new Set<(event: AgentEvent) => void>();
  prompts: string[] = [];
  private nextReply: SessionReply | ((text: string) => Promise<SessionReply>) = {
    status: 'completed',
    text: '',
  };

  setNextReply(reply: SessionReply | ((text: string) => Promise<SessionReply>)): void {
    this.nextReply = reply;
  }

  async prompt(text: string): Promise<SessionReply> {
    this.prompts.push(text);
    return typeof this.nextReply === 'function' ? this.nextReply(text) : this.nextReply;
  }

  on(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    for (const l of [...this.listeners]) l(event);
  }
}

function frame(update: Record<string, unknown>, sessionId = 'acp-1'): AgentEvent {
  return {
    type: 'event',
    event: {
      acp: 'notification',
      message: { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } },
      seq: 1,
      gen: 1,
    },
  };
}

function turnEnded(stopReason: string | null, sessionId = 'acp-1'): AgentEvent {
  return {
    type: 'event',
    event: {
      acp: 'notification',
      message: { jsonrpc: '2.0', method: '_agile/turn_ended', params: { sessionId, stopReason } },
      seq: 2,
      gen: 1,
    },
  };
}

function permissionRequest(id: number | string, sessionId = 'acp-1'): AgentEvent {
  return {
    type: 'event',
    event: {
      acp: 'request',
      id,
      method: 'session/request_permission',
      params: { sessionId, options: [] },
      seq: 3,
      gen: 1,
    },
  };
}

function requestSettled(id: number | string): AgentEvent {
  return {
    type: 'event',
    event: {
      acp: 'notification',
      message: { jsonrpc: '2.0', method: '_agile/request_settled', params: { id } },
      seq: 4,
      gen: 1,
    },
  };
}

describe('createMessageableSession', () => {
  it('starts idle', () => {
    const fake = new FakeSpawnedSession();
    const session = createMessageableSession('sess-1', fake as unknown as SpawnedSession);
    expect(session.busy).toBe(false);
    expect(session.blockedOnPermission).toBe(false);
  });

  it('derives busy from a turn started by another driver, and clears on turn-end', () => {
    const fake = new FakeSpawnedSession();
    const session = createMessageableSession('sess-1', fake as unknown as SpawnedSession);
    fake.emit(
      frame({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } }),
    );
    expect(session.busy).toBe(true);
    fake.emit(turnEnded('end_turn'));
    expect(session.busy).toBe(false);
  });

  it("send() marks busy immediately and resolves with the underlying prompt's reply", async () => {
    const fake = new FakeSpawnedSession();
    fake.setNextReply({ status: 'completed', text: 'done: all green' });
    const session = createMessageableSession('sess-1', fake as unknown as SpawnedSession);

    const replyPromise = session.send('do the thing');
    expect(session.busy).toBe(true);
    expect(fake.prompts).toEqual(['do the thing']);

    const reply = await replyPromise;
    expect(reply).toEqual({ status: 'completed', text: 'done: all green' });
  });

  it('notifies turn-end listeners for turns other drivers started', () => {
    const fake = new FakeSpawnedSession();
    const session = createMessageableSession('sess-1', fake as unknown as SpawnedSession);
    const ends: SessionTurnEnd[] = [];
    session.onTurnEnded((end) => ends.push(end));

    fake.emit(
      frame({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'pane prompt' },
      }),
    );
    expect(session.busy).toBe(true);
    fake.emit(turnEnded('end_turn'));
    expect(session.busy).toBe(false);
    expect(ends).toEqual([{ status: 'completed', error: null }]);
  });

  it('maps a vendor early-stop (max_tokens) to completed', () => {
    const fake = new FakeSpawnedSession();
    const session = createMessageableSession('sess-1', fake as unknown as SpawnedSession);
    const ends: SessionTurnEnd[] = [];
    session.onTurnEnded((end) => ends.push(end));
    fake.emit(frame({ sessionUpdate: 'user_message_chunk' }));
    fake.emit(turnEnded('max_tokens'));
    expect(ends).toEqual([{ status: 'completed', error: null }]);
  });

  it('dispose() stops watching the underlying session', () => {
    const fake = new FakeSpawnedSession();
    const session = createMessageableSession('sess-1', fake as unknown as SpawnedSession);
    session.dispose();
    fake.emit(frame({ sessionUpdate: 'user_message_chunk' }));
    // No longer listening — busy never flips.
    expect(session.busy).toBe(false);
  });

  describe('blocked-on-permission (GH-129)', () => {
    function inFlight() {
      const fake = new FakeSpawnedSession();
      const session = createMessageableSession('sess-1', fake as unknown as SpawnedSession);
      fake.emit(frame({ sessionUpdate: 'user_message_chunk' }));
      return { fake, session };
    }

    it('reports blocked while a permission request is unresolved, clear once settled', () => {
      const { fake, session } = inFlight();
      expect(session.busy).toBe(true);
      expect(session.blockedOnPermission).toBe(false);

      fake.emit(permissionRequest('req-1'));
      expect(session.blockedOnPermission).toBe(true);

      fake.emit(requestSettled('req-1'));
      expect(session.blockedOnPermission).toBe(false);
      expect(session.busy).toBe(true); // the turn is still running
    });

    it('treats request id 0 as a real pending permission (no truthiness tests)', () => {
      const { fake, session } = inFlight();
      fake.emit(permissionRequest(0));
      expect(session.blockedOnPermission).toBe(true);
      fake.emit(requestSettled(0));
      expect(session.blockedOnPermission).toBe(false);
    });

    it('tracks multiple outstanding prompts and stays blocked until the last settles', () => {
      const { fake, session } = inFlight();
      fake.emit(permissionRequest('req-1'));
      fake.emit(permissionRequest('req-2'));
      fake.emit(requestSettled('req-1'));
      expect(session.blockedOnPermission).toBe(true);
      fake.emit(requestSettled('req-2'));
      expect(session.blockedOnPermission).toBe(false);
    });

    it('clears stale pending permissions at the turn boundary', () => {
      const { fake, session } = inFlight();
      fake.emit(permissionRequest('req-1'));
      expect(session.blockedOnPermission).toBe(true);
      fake.emit(turnEnded('end_turn'));
      expect(session.busy).toBe(false);
      expect(session.blockedOnPermission).toBe(false);
    });
  });
});
