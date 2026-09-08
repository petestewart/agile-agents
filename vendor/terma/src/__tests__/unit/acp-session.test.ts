import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter, Readable, Writable } from "stream";

// Mock child_process.spawn to return a controllable mock subprocess
let mockSubprocess: any;
let stdinLines: string[] = [];
/** Simulate a full stdin buffer: write() returns false but still delivers. */
let stdinBackpressure = false;

vi.mock("child_process", () => ({
  spawn: vi.fn(() => {
    stdinLines = [];
    const stdin: any = new Writable({
      write(chunk: any, _enc: any, cb: any) {
        stdinLines.push(chunk.toString());
        cb();
        return !stdinBackpressure;
      },
    });
    const realWrite = stdin.write.bind(stdin);
    stdin.write = (...args: any[]) => {
      realWrite(...args);
      return !stdinBackpressure;
    };
    mockSubprocess = Object.assign(new EventEmitter(), {
      stdin,
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      pid: 99999,
      kill: vi.fn(),
    });
    return mockSubprocess;
  }),
}));

const readFileMock = vi.fn();
const writeFileMock = vi.fn();
// realpath is identity here; the real symlink behaviour (/tmp vs /private/tmp)
// is covered against the filesystem in the integration test.
vi.mock("fs/promises", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  realpath: (path: string) => Promise.resolve(path),
}));

import { spawn } from "child_process";
import {
  AcpSession,
  CLIENT_CAPABILITIES,
  acpTerminalOutput,
} from "../../main/terminal-host/acp-session";

/** Feed a JSON-RPC message to the session as if the agent had written it. */
function agentSends(obj: unknown): void {
  mockSubprocess.stdout.push(JSON.stringify(obj) + "\n");
}

function sentMessages(): any[] {
  return stdinLines
    .join("")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const flush = () => new Promise((r) => setImmediate(r));

describe("AcpSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFileMock.mockReset();
    writeFileMock.mockReset();
    stdinBackpressure = false;
  });

  function createSession(): AcpSession {
    return new AcpSession({ id: "acp-1", cwd: "/tmp" });
  }

  it("inherits the daemon environment when none is given", () => {
    createSession();
    const opts = (spawn as any).mock.calls[0][2];
    expect(opts.env.PATH).toBe(process.env.PATH);
  });

  it("refuses an explicit environment with no PATH with a structured error", () => {
    let thrown: any;
    try {
      new AcpSession({ id: "acp-nopath", cwd: "/tmp", env: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.message).toMatch(/must contain PATH/);
    // Clients match on `code`, not the message text.
    expect(thrown.code).toBe("INVALID_PARAMS");
  });

  it("spawns the pinned ACP bridge in its own process group", () => {
    createSession();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, opts] = (spawn as any).mock.calls[0];
    expect(command).toBe("npx");
    expect(args).toEqual(["-y", "@agentclientprotocol/claude-agent-acp@0.62.0"]);
    expect(opts.cwd).toBe("/tmp");
    expect(opts.detached).toBe(true);
  });

  it("uses an overridden command and args when provided", () => {
    new AcpSession({ id: "acp-2", cwd: "/tmp", command: "gemini", args: ["--acp"] });
    const [command, args] = (spawn as any).mock.calls[0];
    expect(command).toBe("gemini");
    expect(args).toEqual(["--acp"]);
  });

  it("sends an initialize handshake advertising the required client capabilities", async () => {
    createSession();
    await flush();

    const init = sentMessages().find((m) => m.method === "initialize");
    expect(init).toBeDefined();
    expect(init.jsonrpc).toBe("2.0");
    expect(init.params.protocolVersion).toBe(1);
    expect(init.params.clientCapabilities).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      _meta: { terminal_output: true },
    });
    // We must not advertise terminal support we do not implement.
    expect(init.params.clientCapabilities.terminal).toBeUndefined();
  });

  it("exposes the advertised capabilities as a frozen-shape constant", () => {
    expect(CLIENT_CAPABILITIES.fs.readTextFile).toBe(true);
    expect(CLIENT_CAPABILITIES.fs.writeTextFile).toBe(true);
    expect(CLIENT_CAPABILITIES._meta?.terminal_output).toBe(true);
  });

  it("advertises per-provider capabilities when supplied", async () => {
    // A provider with no vendor extensions (the Gemini registry entry's shape):
    // the initialize handshake must carry exactly what was passed, no Claude
    // `_meta` leaking in from the default.
    new AcpSession({
      id: "acp-caps",
      cwd: "/tmp",
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    await flush();

    const init = sentMessages().find((m) => m.method === "initialize");
    expect(init.params.clientCapabilities).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
    });
    expect(init.params.clientCapabilities._meta).toBeUndefined();
  });

  it("applies env overrides on top of the full inherited environment", () => {
    new AcpSession({
      id: "acp-env",
      cwd: "/tmp",
      envOverrides: { HOME: "/tmp/provider-home", EXTRA: "1" },
    });
    const opts = (spawn as any).mock.calls[0][2];
    // Override wins, the rest of the env is inherited untouched.
    expect(opts.env.HOME).toBe("/tmp/provider-home");
    expect(opts.env.EXTRA).toBe("1");
    expect(opts.env.PATH).toBe(process.env.PATH);
  });

  it("rejects overrides that leave the merged env without PATH", () => {
    let thrown: any;
    try {
      // The base env is valid on its own — only the override empties PATH —
      // so this fails only if validation runs on the *merged* env.
      new AcpSession({
        id: "acp-env-nopath",
        cwd: "/tmp",
        env: { PATH: "/usr/bin", HOME: "/tmp/h" },
        envOverrides: { PATH: "" },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe("INVALID_PARAMS");
  });

  it("resolves the handshake and emits an initialized event", async () => {
    const session = createSession();
    const events: string[] = [];
    session.on("data", (d: string) => events.push(d));
    await flush();

    const init = sentMessages().find((m) => m.method === "initialize");
    agentSends({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1 } });
    await expect(session.initialized).resolves.toEqual({ protocolVersion: 1 });
    // Every emitted envelope carries the event ring's sequence number, shared
    // with the replay so a reattaching client can de-duplicate, and the
    // generation of the timeline it belongs to.
    expect(JSON.parse(events[0])).toEqual({
      acp: "initialized",
      result: { protocolVersion: 1 },
      seq: 1,
      gen: 1,
    });
  });

  it("forwards session/update notifications verbatim", async () => {
    const session = createSession();
    const events: any[] = [];
    session.on("data", (d: string) => events.push(JSON.parse(d)));
    await flush();

    const update = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionUpdate: "agent_message_chunk" },
    };
    agentSends(update);
    await flush();

    expect(events).toContainEqual({
      acp: "notification",
      message: update,
      seq: expect.any(Number),
      gen: expect.any(Number),
    });
  });

  it("reassembles JSON-RPC messages split across stdout chunks", async () => {
    const session = createSession();
    const events: any[] = [];
    session.on("data", (d: string) => events.push(JSON.parse(d)));
    await flush();

    const line = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { a: 1 } });
    mockSubprocess.stdout.push(line.slice(0, 12));
    await flush();
    expect(events).toHaveLength(0);
    mockSubprocess.stdout.push(line.slice(12) + "\n");
    await flush();
    expect(events).toHaveLength(1);
  });

  it("answers fs/read_text_file itself, asynchronously", async () => {
    const session = createSession();
    readFileMock.mockResolvedValue("file contents");
    await flush();

    agentSends({ jsonrpc: "2.0", id: 7, method: "fs/read_text_file", params: { path: "/tmp/a.ts" } });
    await flush();
    await flush();

    expect(readFileMock).toHaveBeenCalledWith("/tmp/a.ts", "utf8");
    expect(sentMessages()).toContainEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: "file contents" },
    });
    expect(session.isExited).toBe(false);
  });

  it("answers fs/write_text_file itself", async () => {
    createSession();
    writeFileMock.mockResolvedValue(undefined);
    await flush();

    agentSends({
      jsonrpc: "2.0",
      id: 8,
      method: "fs/write_text_file",
      params: { path: "/tmp/b.ts", content: "x" },
    });
    await flush();
    await flush();

    expect(writeFileMock).toHaveBeenCalledWith("/tmp/b.ts", "x", "utf8");
    expect(sentMessages()).toContainEqual({ jsonrpc: "2.0", id: 8, result: {} });
  });

  it("reports fs errors back to the agent as a JSON-RPC error", async () => {
    createSession();
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    await flush();

    agentSends({
      jsonrpc: "2.0",
      id: 9,
      method: "fs/read_text_file",
      params: { path: "/tmp/missing.ts" },
    });
    await flush();
    await flush();

    expect(sentMessages()).toContainEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32603, message: "ENOENT" },
    });
  });

  it("forwards agent requests it cannot answer to the client", async () => {
    const session = createSession();
    session.attach();
    const events: any[] = [];
    session.on("data", (d: string) => events.push(JSON.parse(d)));
    await flush();

    agentSends({
      jsonrpc: "2.0",
      id: "req-1",
      method: "session/request_permission",
      params: { options: [] },
    });
    await flush();

    expect(events).toContainEqual({
      acp: "request",
      id: "req-1",
      method: "session/request_permission",
      params: { options: [] },
      seq: expect.any(Number),
      gen: expect.any(Number),
    });

    session.respond("req-1", { outcome: "selected" });
    expect(sentMessages()).toContainEqual({
      jsonrpc: "2.0",
      id: "req-1",
      result: { outcome: "selected" },
    });
  });

  it("records a _terma/request_settled marker when a forwarded request is answered (GH-129)", async () => {
    const session = createSession();
    session.attach();
    const events: any[] = [];
    session.on("data", (d: string) => events.push(JSON.parse(d)));
    await flush();

    agentSends({
      jsonrpc: "2.0",
      id: 0, // the real bridge used id 0 for its first permission request
      method: "session/request_permission",
      params: { options: [] },
    });
    await flush();

    session.respond(0, { outcome: "selected" });
    expect(events).toContainEqual({
      acp: "notification",
      message: {
        jsonrpc: "2.0",
        method: "_terma/request_settled",
        params: { id: 0 },
      },
      seq: expect.any(Number),
      gen: expect.any(Number),
    });
    // Answering the same id again settles nothing new — the marker pairs
    // one-to-one with forwarded requests.
    const before = events.length;
    session.respond(0, { outcome: "selected" });
    expect(events).toHaveLength(before);
  });

  it("records the settle marker for respondError too", async () => {
    const session = createSession();
    session.attach();
    const events: any[] = [];
    session.on("data", (d: string) => events.push(JSON.parse(d)));
    await flush();

    agentSends({
      jsonrpc: "2.0",
      id: "req-2",
      method: "session/request_permission",
      params: { options: [] },
    });
    await flush();

    session.respondError("req-2", -32603, "denied");
    expect(events).toContainEqual(
      expect.objectContaining({
        acp: "notification",
        message: expect.objectContaining({
          method: "_terma/request_settled",
          params: { id: "req-2" },
        }),
      }),
    );
  });

  it("emits no settle marker for requests it answered internally (fs handlers)", async () => {
    const session = createSession();
    session.attach();
    const events: any[] = [];
    session.on("data", (d: string) => events.push(JSON.parse(d)));
    readFileMock.mockResolvedValue("file contents");
    await flush();

    agentSends({ jsonrpc: "2.0", id: 7, method: "fs/read_text_file", params: { path: "/tmp/a.ts" } });
    await flush();
    await flush();

    expect(
      events.filter((e) => e?.message?.method === "_terma/request_settled"),
    ).toHaveLength(0);
  });

  it("marks the session exited when the process could not be spawned", async () => {
    // Node emits error + close (never exit) for a failed spawn.
    const session = createSession();
    const errors: string[] = [];
    session.on("error", (e: string) => errors.push(e));
    await flush();

    mockSubprocess.emit("error", new Error("spawn ENOENT"));
    mockSubprocess.emit("close", null);

    expect(errors).toContain("spawn ENOENT");
    expect(session.isExited).toBe(true);
    // The handshake rejection is the one most likely to be read, so it must
    // carry the spawn error too, not a generic "agent exited".
    await expect(session.initialized).rejects.toThrow(/failed to start: spawn ENOENT/);
    await expect(session.request("session/new")).rejects.toThrow(
      /failed to start: spawn ENOENT/,
    );
  });

  it("emits exit once when both exit and close fire", async () => {
    const session = createSession();
    const codes: number[] = [];
    session.on("exit", (c: number) => codes.push(c));
    await flush();
    mockSubprocess.emit("exit", 0);
    mockSubprocess.emit("close", 0);
    expect(codes).toEqual([0]);
  });

  it("does not treat stdin backpressure as a failed write", async () => {
    const session = createSession();
    await flush();
    stdinBackpressure = true;

    const pending = session.request("session/prompt", { big: "x".repeat(1000) });
    await flush();

    const sent = sentMessages().find((m) => m.method === "session/prompt");
    expect(sent).toBeDefined();
    // The request must still be pending — the data was delivered.
    agentSends({ jsonrpc: "2.0", id: sent.id, result: { stopReason: "end_turn" } });
    await expect(pending).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("confines agent filesystem access to the session workspace", async () => {
    const session = new AcpSession({ id: "acp-fs", cwd: "/tmp/ws" });
    await flush();

    agentSends({
      jsonrpc: "2.0",
      id: 20,
      method: "fs/read_text_file",
      params: { path: "/etc/passwd" },
    });
    await flush();
    await flush();

    expect(readFileMock).not.toHaveBeenCalled();
    expect(sentMessages()).toContainEqual({
      jsonrpc: "2.0",
      id: 20,
      error: { code: -32603, message: "Path outside session workspace: /etc/passwd" },
    });
    expect(session.isExited).toBe(false);
  });

  it("refuses forwarded requests when no client is attached", async () => {
    const session = createSession();
    await flush();

    agentSends({
      jsonrpc: "2.0",
      id: 21,
      method: "session/request_permission",
      params: {},
    });
    await flush();

    expect(sentMessages()).toContainEqual({
      jsonrpc: "2.0",
      id: 21,
      error: { code: -32603, message: "No client attached to answer request" },
    });
  });

  it("does not throw when an error is emitted with no client listening", async () => {
    // EventEmitter throws on an unlistened 'error'. The wire layer's listener
    // is removed on detach, so a detached session has none — and at the stdout
    // overflow site that throw would skip the kill() right after it, leaking
    // the agent process. The session keeps a permanent no-op listener.
    const session = createSession();
    await flush();

    expect(() => session.emit("error", "boom")).not.toThrow();

    // Still true after destroy(), which calls removeAllListeners().
    session.destroy();
    expect(() => session.emit("error", "boom again")).not.toThrow();
  });

  it("still kills the session on stdout overflow with nobody listening", async () => {
    // Deliberately NO error listener — the detached case. The emit that
    // announces the overflow is immediately followed by kill(); if that emit
    // throws, kill() is skipped and the agent process leaks while the log
    // claims the session was killed.
    createSession();
    await flush();

    mockSubprocess.stdout.push("x".repeat(51 * 1024 * 1024));
    await flush();

    expect(mockSubprocess.kill).toHaveBeenCalled();
  });

  it("rejects pending requests when the agent exits", async () => {
    const session = createSession();
    await flush();
    const pending = session.request("session/prompt", {});
    mockSubprocess.emit("exit", 1);
    await expect(pending).rejects.toThrow("ACP agent exited");
    expect(session.isExited).toBe(true);
  });

  it("rejects requests made after exit", async () => {
    const session = createSession();
    await flush();
    mockSubprocess.emit("exit", 0);
    await expect(session.request("session/prompt", {})).rejects.toThrow(
      "ACP session has exited",
    );
  });

  it("emits exit exactly once", async () => {
    const session = createSession();
    const codes: number[] = [];
    session.on("exit", (c: number) => codes.push(c));
    await flush();
    mockSubprocess.emit("exit", 3);
    mockSubprocess.emit("exit", 3);
    expect(codes).toEqual([3]);
  });

  it("ignores unparseable stdout lines without dying", async () => {
    const session = createSession();
    await flush();
    mockSubprocess.stdout.push("not json\n");
    await flush();
    expect(session.isExited).toBe(false);
  });

  describe("refcounting parity with the PTY path", () => {
    it("starts with detachedSince null", () => {
      expect(createSession().detachedSince).toBeNull();
    });

    it("stays attached until every attach is matched by a detach", () => {
      const session = createSession();
      session.attach();
      session.attach();
      session.detach();
      expect(session.isAttached).toBe(true);
      expect(session.detachedSince).toBeNull();
      session.detach();
      expect(session.isAttached).toBe(false);
      expect(session.detachedSince).not.toBeNull();
    });

    it("does not underflow on extra detaches", () => {
      const session = createSession();
      session.attach();
      session.detach();
      session.detach();
      session.attach();
      session.detach();
      expect(session.isAttached).toBe(false);
    });

    it("keeps detachedSince null while retained", () => {
      const session = createSession();
      session.attach();
      session.retain();
      session.detach();
      expect(session.isRetained).toBe(true);
      session.release();
      expect(session.isRetained).toBe(false);
      expect(session.detachedSince).not.toBeNull();
    });

    it("clears detachedSince on re-attach", () => {
      const session = createSession();
      session.attach();
      session.detach();
      expect(session.detachedSince).not.toBeNull();
      session.attach();
      expect(session.detachedSince).toBeNull();
    });
  });

  describe("acpTerminalOutput accessor", () => {
    it("reads the vendor _meta extension", () => {
      expect(
        acpTerminalOutput({ terminal_output: { terminal_id: "t1", data: "gone" } }),
      ).toEqual({ terminalId: "t1", data: "gone" });
    });

    it("returns null when the extension is absent or malformed", () => {
      expect(acpTerminalOutput(undefined)).toBeNull();
      expect(acpTerminalOutput({})).toBeNull();
      expect(acpTerminalOutput({ terminal_output: { terminal_id: 1 } })).toBeNull();
    });
  });
});

describe("AcpSession — prompt recording (GH-76)", () => {
  it("records the user's prompt into the ring before forwarding, and a turn-end frame when the round trip settles", async () => {
    const session = new AcpSession({ id: "acp-prompt", cwd: "/tmp" });
    await flush();

    const pending = session.request("session/prompt", {
      sessionId: "sess-1",
      prompt: [
        { type: "text", text: "look at " },
        { type: "resource_link", uri: "file:///a.ts", name: "@a.ts" },
      ],
    });
    await flush();

    // The prompt text is in the ring already — recorded before the agent
    // answered — in the nested SessionNotification envelope, so a re-attach
    // replays the user's message like any other frame.
    const before = session.replayEvents().events;
    const userFrames = before.filter(
      (e: any) =>
        e.acp === "notification" &&
        e.message.method === "session/update" &&
        e.message.params?.update?.sessionUpdate === "user_message_chunk",
    );
    expect(userFrames).toHaveLength(1);
    expect((userFrames[0] as any).message.params).toMatchObject({
      sessionId: "sess-1",
      update: { content: { type: "text", text: "look at @a.ts" } },
    });
    // No turn-end yet: the round trip has not settled.
    expect(
      before.some((e: any) => e.acp === "notification" && e.message.method === "_terma/turn_ended"),
    ).toBe(false);

    const sent = sentMessages().find((m) => m.method === "session/prompt");
    expect(sent).toBeDefined();
    // The forwarded request is untouched — recording is ring-only.
    expect(sent.params.prompt).toHaveLength(2);
    agentSends({ jsonrpc: "2.0", id: sent.id, result: { stopReason: "end_turn" } });
    await expect(pending).resolves.toEqual({ stopReason: "end_turn" });

    const after = session.replayEvents().events;
    const turnEnd = after.filter(
      (e: any) => e.acp === "notification" && e.message.method === "_terma/turn_ended",
    );
    expect(turnEnd).toHaveLength(1);
    expect((turnEnd[0] as any).message.params).toEqual({ sessionId: "sess-1", stopReason: "end_turn" });
    // And the turn-end was never written to the agent's stdin.
    expect(sentMessages().some((m) => m.method === "_terma/turn_ended")).toBe(false);
  });

  it("records a session/new response's mode state into the ring as _terma/session_state", async () => {
    const session = new AcpSession({ id: "acp-modes", cwd: "/tmp" });
    await flush();
    const pending = session.request("session/new", { cwd: "/tmp", mcpServers: [] });
    await flush();
    const sent = sentMessages().find((m) => m.method === "session/new");
    const modes = {
      currentModeId: "default",
      availableModes: [{ id: "default", name: "Manual" }],
    };
    const configOptions = [
      { id: "model", category: "model", type: "select", currentValue: "opus" },
    ];
    agentSends({
      jsonrpc: "2.0",
      id: sent.id,
      result: { sessionId: "sess-1", modes, configOptions },
    });
    // The response reaches the caller untouched.
    await expect(pending).resolves.toEqual({ sessionId: "sess-1", modes, configOptions });

    const markers = session
      .replayEvents()
      .events.filter(
        (e: any) => e.acp === "notification" && e.message.method === "_terma/session_state",
      );
    expect(markers).toHaveLength(1);
    expect((markers[0] as any).message.params).toEqual({
      sessionId: "sess-1",
      modes,
      configOptions,
    });
    // Terma-private: never written to the agent's stdin.
    expect(sentMessages().some((m) => m.method === "_terma/session_state")).toBe(false);
  });

  it("records nothing for a session/new response with neither modes nor configOptions", async () => {
    const session = new AcpSession({ id: "acp-no-modes", cwd: "/tmp" });
    await flush();
    const pending = session.request("session/new", { cwd: "/tmp", mcpServers: [] });
    await flush();
    const sent = sentMessages().find((m) => m.method === "session/new");
    agentSends({ jsonrpc: "2.0", id: sent.id, result: { sessionId: "sess-2" } });
    await expect(pending).resolves.toEqual({ sessionId: "sess-2" });
    expect(
      session
        .replayEvents()
        .events.some(
          (e: any) => e.acp === "notification" && e.message.method === "_terma/session_state",
        ),
    ).toBe(false);
  });

  it("records a turn-end frame even when the prompt round trip rejects", async () => {
    const session = new AcpSession({ id: "acp-prompt-err", cwd: "/tmp" });
    await flush();
    const pending = session.request("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "x" }] });
    await flush();
    const sent = sentMessages().find((m) => m.method === "session/prompt");
    agentSends({ jsonrpc: "2.0", id: sent.id, error: { code: -32000, message: "boom" } });
    await expect(pending).rejects.toThrow("boom");
    const turnEnd = session
      .replayEvents()
      .events.filter((e: any) => e.acp === "notification" && e.message.method === "_terma/turn_ended");
    expect(turnEnd).toHaveLength(1);
    expect((turnEnd[0] as any).message.params.stopReason).toBeNull();
  });
});
