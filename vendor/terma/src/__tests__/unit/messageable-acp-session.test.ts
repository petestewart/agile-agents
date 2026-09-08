import { describe, it, expect } from "vitest";
import type { AcpEvent, AcpReplay, SessionInfo } from "../../main/lib/terminal-host/types";
import {
  AcpMessageableSession,
  AcpSessionHub,
  SessionAddressError,
  type MessageableDaemon,
} from "../../main/lib/control/messageable-acp-session";
import type { SessionTurnEnd } from "@shared/agent-session-contract";

type Subscriber = {
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
  onError: (error: string) => void;
  onDisconnect: () => void;
};

function frame(update: Record<string, unknown>, sessionId = "acp-1"): string {
  return JSON.stringify({
    acp: "notification",
    message: {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    },
  });
}

function turnEnded(stopReason: string | null, sessionId = "acp-1"): string {
  return JSON.stringify({
    acp: "notification",
    message: {
      jsonrpc: "2.0",
      method: "_terma/turn_ended",
      params: { sessionId, stopReason },
    },
  });
}

class FakeDaemon implements MessageableDaemon {
  subscribers = new Map<string, Subscriber>();
  requests: Array<{ sessionId: string; method: string; params: unknown }> = [];
  replayEvents: AcpEvent[] = [];
  sessions: SessionInfo[] = [];
  attachRefs = 0;
  retains = 0;
  rejectPrompts = false;

  subscribe(sessionId: string, subscriber: Subscriber): () => void {
    this.subscribers.set(sessionId, subscriber);
    return () => this.subscribers.delete(sessionId);
  }

  async acpRequest(sessionId: string, method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ sessionId, method, params });
    if (method === "session/prompt" && this.rejectPrompts) {
      throw new Error("daemon connection lost");
    }
    return {};
  }

  async acpReplay(): Promise<AcpReplay<AcpEvent>> {
    return {
      events: this.replayEvents.map((e, i) => ({ ...e, seq: i + 1, gen: 1 })),
      dropped: 0,
      generation: 1,
    } as AcpReplay<AcpEvent>;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.sessions;
  }

  async attachRef(): Promise<boolean> {
    this.attachRefs += 1;
    return true;
  }
  async detachRef(): Promise<void> {
    this.attachRefs -= 1;
  }
  async retain(): Promise<void> {
    this.retains += 1;
  }
  async release(): Promise<void> {
    this.retains -= 1;
  }

  emit(sessionId: string, data: string): void {
    this.subscribers.get(sessionId)?.onData(data);
  }
}

function replayEvent(json: string): AcpEvent {
  return JSON.parse(json) as AcpEvent;
}

describe("AcpMessageableSession", () => {
  it("derives the ACP session id and idle state from the replay", async () => {
    const daemon = new FakeDaemon();
    daemon.replayEvents = [
      replayEvent(frame({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } })),
      replayEvent(turnEnded("end_turn")),
    ];
    const session = new AcpMessageableSession("sess-1", daemon);
    await session.init();
    expect(session.busy).toBe(false);
  });

  it("derives busy when the replay ends inside an open turn", async () => {
    const daemon = new FakeDaemon();
    daemon.replayEvents = [
      replayEvent(frame({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } })),
    ];
    const session = new AcpMessageableSession("sess-1", daemon);
    await session.init();
    expect(session.busy).toBe(true);
  });

  it("sends a prompt and resolves with the final assistant message of the turn", async () => {
    const daemon = new FakeDaemon();
    daemon.replayEvents = [replayEvent(turnEnded("end_turn"))]; // carries acp id
    const session = new AcpMessageableSession("sess-1", daemon);
    await session.init();

    const replyPromise = session.send("do the thing");
    expect(session.busy).toBe(true);
    // Wait for the prompt request to be issued.
    await new Promise((r) => setImmediate(r));
    expect(daemon.requests).toContainEqual({
      sessionId: "sess-1",
      method: "session/prompt",
      params: { sessionId: "acp-1", prompt: [{ type: "text", text: "do the thing" }] },
    });

    daemon.emit("sess-1", frame({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "do the thing" } }));
    daemon.emit("sess-1", frame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working…" } }));
    daemon.emit("sess-1", frame({ sessionUpdate: "tool_call", toolCallId: "t1" }));
    daemon.emit("sess-1", frame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done: " } }));
    daemon.emit("sess-1", frame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all green" } }));
    daemon.emit("sess-1", turnEnded("end_turn"));

    const reply = await replyPromise;
    expect(reply).toEqual({ status: "completed", text: "done: all green" });
    expect(session.busy).toBe(false);
  });

  it("maps a vendor early-stop (max_tokens) to completed, per the #123 fold", async () => {
    const daemon = new FakeDaemon();
    daemon.replayEvents = [replayEvent(turnEnded("end_turn"))];
    const session = new AcpMessageableSession("sess-1", daemon);
    await session.init();
    const replyPromise = session.send("go");
    await new Promise((r) => setImmediate(r));
    daemon.emit("sess-1", frame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } }));
    daemon.emit("sess-1", turnEnded("max_tokens"));
    expect(await replyPromise).toEqual({ status: "completed", text: "partial" });
  });

  it("settles a failed reply when the agent process exits mid-turn", async () => {
    const daemon = new FakeDaemon();
    daemon.replayEvents = [replayEvent(turnEnded("end_turn"))];
    const session = new AcpMessageableSession("sess-1", daemon);
    await session.init();
    const replyPromise = session.send("go");
    await new Promise((r) => setImmediate(r));
    daemon.emit("sess-1", frame({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "so far" } }));
    daemon.subscribers.get("sess-1")!.onExit(1);
    const reply = await replyPromise;
    expect(reply.status).toBe("failed");
    expect(reply.error?.code).toBe("session_exited");
    expect(reply.text).toBe("so far"); // streamed text kept as diagnostic
    // A dead handle fails fast on the next send.
    const next = await session.send("again");
    expect(next.status).toBe("failed");
  });

  it("settles a failed reply when the prompt round trip rejects on the wire", async () => {
    const daemon = new FakeDaemon();
    daemon.replayEvents = [replayEvent(turnEnded("end_turn"))];
    daemon.rejectPrompts = true;
    const session = new AcpMessageableSession("sess-1", daemon);
    await session.init();
    const reply = await session.send("go");
    expect(reply.status).toBe("failed");
    expect(reply.error?.code).toBe("session_error");
  });

  it("notifies turn-end listeners for turns other drivers started", async () => {
    const daemon = new FakeDaemon();
    const session = new AcpMessageableSession("sess-1", daemon);
    await session.init();
    const ends: SessionTurnEnd[] = [];
    session.onTurnEnded((end) => ends.push(end));

    daemon.emit("sess-1", frame({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "pane prompt" } }));
    expect(session.busy).toBe(true);
    daemon.emit("sess-1", turnEnded("end_turn"));
    expect(session.busy).toBe(false);
    expect(ends).toEqual([{ status: "completed", error: null }]);
  });
});

describe("AcpSessionHub", () => {
  it("refuses unknown sessions and PTY sessions with typed address errors (§6.2)", async () => {
    const daemon = new FakeDaemon();
    daemon.sessions = [
      { id: "pty-1", kind: "pty", cwd: "/w", createdAt: 0 },
      { id: "gone", kind: "acp", cwd: "/w", createdAt: 0, exited: true },
    ];
    const hub = new AcpSessionHub(daemon);
    await expect(hub.acquire("nope")).rejects.toSatisfy(
      (e: unknown) => e instanceof SessionAddressError && e.code === "session_not_found",
    );
    await expect(hub.acquire("pty-1")).rejects.toSatisfy(
      (e: unknown) => e instanceof SessionAddressError && e.code === "wrong_session_kind",
    );
    await expect(hub.acquire("gone")).rejects.toSatisfy(
      (e: unknown) => e instanceof SessionAddressError && e.code === "session_exited",
    );
  });

  it("pins the session per hold and unpins on the last release (§6.3)", async () => {
    const daemon = new FakeDaemon();
    daemon.sessions = [{ id: "sess-1", kind: "acp", cwd: "/w", createdAt: 0 }];
    const hub = new AcpSessionHub(daemon);

    const first = await hub.acquire("sess-1");
    const second = await hub.acquire("sess-1");
    expect(second).toBe(first); // cached handle
    expect(daemon.retains).toBe(1);
    expect(daemon.attachRefs).toBe(1);

    await hub.release("sess-1");
    expect(daemon.retains).toBe(1); // still held
    await hub.release("sess-1");
    expect(daemon.retains).toBe(0);
    expect(daemon.attachRefs).toBe(0);
  });

  it("single-flights concurrent acquires for the same session (one retain, one handle)", async () => {
    const daemon = new FakeDaemon();
    daemon.sessions = [{ id: "sess-1", kind: "acp", cwd: "/w", createdAt: 0 }];
    const hub = new AcpSessionHub(daemon);

    const [a, b] = await Promise.all([hub.acquire("sess-1"), hub.acquire("sess-1")]);
    expect(b).toBe(a);
    expect(daemon.retains).toBe(1);
    expect(daemon.attachRefs).toBe(1);

    await hub.release("sess-1");
    expect(daemon.retains).toBe(1); // second hold still pins
    await hub.release("sess-1");
    expect(daemon.retains).toBe(0);
    expect(daemon.attachRefs).toBe(0);
  });
});

// ---- GH-129: blocked-on-permission tracking --------------------------------

function permissionRequest(id: number | string, sessionId = "acp-1"): string {
  return JSON.stringify({
    acp: "request",
    id,
    method: "session/request_permission",
    params: { sessionId, options: [] },
  });
}

function requestSettled(id: number | string): string {
  return JSON.stringify({
    acp: "notification",
    message: { jsonrpc: "2.0", method: "_terma/request_settled", params: { id } },
  });
}

describe("AcpMessageableSession blocked-on-permission (GH-129)", () => {
  async function inFlightSession() {
    const daemon = new FakeDaemon();
    const session = new AcpMessageableSession("sess-1", daemon);
    await session.init();
    daemon.emit("sess-1", frame({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } }));
    return { daemon, session };
  }

  it("reports blocked while a permission request is unresolved, clear once settled", async () => {
    const { daemon, session } = await inFlightSession();
    expect(session.busy).toBe(true);
    expect(session.blockedOnPermission).toBe(false);

    daemon.emit("sess-1", permissionRequest("req-1"));
    expect(session.blockedOnPermission).toBe(true);

    daemon.emit("sess-1", requestSettled("req-1"));
    expect(session.blockedOnPermission).toBe(false);
    expect(session.busy).toBe(true); // the turn is still running
  });

  it("treats request id 0 as a real pending permission (no truthiness tests)", async () => {
    const { daemon, session } = await inFlightSession();
    daemon.emit("sess-1", permissionRequest(0));
    expect(session.blockedOnPermission).toBe(true);
    daemon.emit("sess-1", requestSettled(0));
    expect(session.blockedOnPermission).toBe(false);
  });

  it("tracks multiple outstanding prompts and stays blocked until the last settles", async () => {
    const { daemon, session } = await inFlightSession();
    daemon.emit("sess-1", permissionRequest("req-1"));
    daemon.emit("sess-1", permissionRequest("req-2"));
    daemon.emit("sess-1", requestSettled("req-1"));
    expect(session.blockedOnPermission).toBe(true);
    daemon.emit("sess-1", requestSettled("req-2"));
    expect(session.blockedOnPermission).toBe(false);
  });

  it("clears stale pending permissions at the turn boundary (old-daemon degradation)", async () => {
    const { daemon, session } = await inFlightSession();
    daemon.emit("sess-1", permissionRequest("req-1"));
    expect(session.blockedOnPermission).toBe(true);
    // No settle marker ever arrives (a daemon predating the marker): the
    // turn end still clears the state.
    daemon.emit("sess-1", turnEnded("end_turn"));
    expect(session.busy).toBe(false);
    expect(session.blockedOnPermission).toBe(false);
  });

  it("derives blocked state from the replay (handle opened mid-prompt)", async () => {
    const daemon = new FakeDaemon();
    daemon.replayEvents = [
      replayEvent(frame({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "do it" } })),
      replayEvent(permissionRequest("req-9")),
    ];
    const session = new AcpMessageableSession("sess-1", daemon);
    await session.init();
    expect(session.busy).toBe(true);
    expect(session.blockedOnPermission).toBe(true);
  });

  it("pairs replayed requests with replayed settle markers", async () => {
    const daemon = new FakeDaemon();
    daemon.replayEvents = [
      replayEvent(frame({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "do it" } })),
      replayEvent(permissionRequest("req-9")),
      replayEvent(requestSettled("req-9")),
    ];
    const session = new AcpMessageableSession("sess-1", daemon);
    await session.init();
    expect(session.busy).toBe(true);
    expect(session.blockedOnPermission).toBe(false);
  });

  it("does not report blocked for a permission request replayed from a finished turn", async () => {
    const daemon = new FakeDaemon();
    daemon.replayEvents = [
      replayEvent(frame({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "do it" } })),
      replayEvent(permissionRequest("req-9")),
      replayEvent(turnEnded("end_turn")),
    ];
    const session = new AcpMessageableSession("sess-1", daemon);
    await session.init();
    expect(session.busy).toBe(false);
    expect(session.blockedOnPermission).toBe(false);
  });
});

describe("AcpSessionHub.peek (GH-129)", () => {
  it("returns the open handle without taking a hold, and forgets it on last release", async () => {
    const daemon = new FakeDaemon();
    daemon.sessions = [{ id: "sess-1", kind: "acp", cwd: "/w", createdAt: 0 }];
    const hub = new AcpSessionHub(daemon);

    expect(hub.peek("sess-1")).toBeUndefined();
    const handle = await hub.acquire("sess-1");
    expect(hub.peek("sess-1")).toBe(handle);
    expect(daemon.retains).toBe(1); // peek took nothing

    await hub.release("sess-1");
    expect(hub.peek("sess-1")).toBeUndefined();
    expect(daemon.retains).toBe(0);
  });
});
