/**
 * Adapted from Terma's acp-session.test.ts
 * (vendor/terma/src/__tests__/unit/acp-session.test.ts): same subprocess
 * mocking approach (a fake `child_process.spawn` and `fs/promises`), rewired
 * for `bun:test` and for `spawnSession`'s narrower public surface — no
 * attach/detach/retain (there is no multi-client daemon registry here; a
 * daemon built on top of this package owns that, T004+), events observed
 * only through `on(listener)`, and permission-style forwarded requests
 * answered through `respondPermission`.
 *
 * T012 QA/review round: this file used to install its fakes via
 * `mock.module('node:child_process', ...)` / `mock.module('node:fs/promises',
 * ...)`. Bun's `mock.module` replaces the module in the *process-wide*
 * module registry for the whole `bun test` invocation, not just this file —
 * so it silently stubbed out real process spawning (and real `fs/promises`)
 * for every other test file that happened to run afterward in the same
 * invocation, including `packages/daemon`'s own real-subprocess tests. That
 * was a correctness bug in the test suite (not merely a style nit): a
 * daemon test expecting to spawn a real `bun fake-agent.ts` child could
 * silently get this file's fake 99999-pid object instead, which never
 * actually spawns anything or emits a real `exit`, hanging the daemon test
 * indefinitely. Fixed by threading the fakes through `SpawnSessionOptions`'s
 * new `spawn`/`fsImpl` injection points instead (`session.ts`/`types.ts`) —
 * no process-wide state, so this file's own behavior is unchanged but
 * nothing leaks.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { spawnSession } from './session';
import { AcpClientError } from './types';

const state: {
  child:
    | (EventEmitter & {
        stdin: Writable;
        stdout: Readable;
        stderr: Readable;
        pid: number;
        kill: ReturnType<typeof mock>;
      })
    | null;
  stdinLines: string[];
  backpressure: boolean;
} = { child: null, stdinLines: [], backpressure: false };

const spawnMock = mock((_cmd: string, _args: string[], _opts: unknown) => {
  state.stdinLines = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      state.stdinLines.push(chunk.toString());
      cb();
    },
  });
  const realWrite = stdin.write.bind(stdin);
  (stdin as unknown as { write: unknown }).write = (...args: Parameters<typeof realWrite>) => {
    realWrite(...args);
    return !state.backpressure;
  };
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout: new Readable({ read() {} }),
    stderr: new Readable({ read() {} }),
    pid: 99999,
    kill: mock(() => {}),
  });
  state.child = child;
  return child;
});

const readFileMock = mock(async (_path: string, _enc: string): Promise<string> => '');
const writeFileMock = mock(
  async (_path: string, _content: string, _enc: string): Promise<void> => {},
);
// realpath is identity here; symlink behaviour is out of scope for a
// subprocess-mocked unit test.
const realpathMock = (path: string) => Promise.resolve(path);

type AgentEvent = import('./types').AgentEvent;

function agentSends(obj: unknown): void {
  state.child?.stdout.push(`${JSON.stringify(obj)}\n`);
}

function sentMessages(): Array<Record<string, unknown>> {
  return state.stdinLines
    .join('')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Answer the handshake so `initialized` (and anything gated on it) resolves. */
async function answerInitialize(): Promise<void> {
  await flush();
  const init = sentMessages().find((m) => m.method === 'initialize');
  if (!init) throw new Error('initialize was never sent');
  agentSends({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1 } });
  await flush();
}

/** Answer a pending `session/new`, so `prompt`/`setMode` can proceed. */
async function answerSessionNew(sessionId = 'acp-1'): Promise<void> {
  await flush();
  const req = sentMessages().find(
    (m) => m.method === 'session/new' && !answeredIds.has(m.id as number),
  );
  if (!req) throw new Error('session/new was never sent');
  answeredIds.add(req.id as number);
  agentSends({ jsonrpc: '2.0', id: req.id, result: { sessionId } });
  await flush();
}
const answeredIds = new Set<number>();

describe('spawnSession', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    readFileMock.mockClear();
    writeFileMock.mockClear();
    state.backpressure = false;
    answeredIds.clear();
  });

  function create(overrides: Partial<Parameters<typeof spawnSession>[0]> = {}) {
    return spawnSession({
      cmd: 'npx',
      args: ['-y', 'acp-bridge@1'],
      cwd: '/tmp',
      spawn: spawnMock as unknown as typeof import('node:child_process').spawn,
      fsImpl: { readFile: readFileMock, writeFile: writeFileMock, realpath: realpathMock },
      ...overrides,
    });
  }

  it("inherits the caller's environment when none is given", () => {
    create();
    const opts = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(opts.env.PATH).toBe(process.env.PATH);
  });

  // T012 QA round: `AgentRecord.pid` in the daemon is meant to be the
  // spawned agent's own OS pid, not the caller's — `SpawnedSession` didn't
  // expose it at all before this.
  it('exposes the spawned child process pid (not the caller/daemon pid)', () => {
    const session = create();
    expect(session.pid).toBe(99999); // the fake child's `pid` set up above
    expect(session.pid).not.toBe(process.pid);
  });

  it('refuses an explicit environment with no PATH with a structured error', () => {
    let thrown: unknown;
    try {
      create({ env: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AcpClientError);
    expect((thrown as InstanceType<typeof AcpClientError>).code).toBe('INVALID_PARAMS');
    expect((thrown as Error).message).toMatch(/must contain PATH/);
  });

  it('spawns the given command and args in its own process group', () => {
    create({ cmd: 'gemini', args: ['--acp'] });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string; detached: boolean },
    ];
    expect(command).toBe('gemini');
    expect(args).toEqual(['--acp']);
    expect(opts.cwd).toBe('/tmp');
    expect(opts.detached).toBe(true);
  });

  it('applies env overrides on top of the full inherited environment', () => {
    create({ envOverrides: { HOME: '/tmp/provider-home', EXTRA: '1' } });
    const opts = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> };
    expect(opts.env.HOME).toBe('/tmp/provider-home');
    expect(opts.env.EXTRA).toBe('1');
    expect(opts.env.PATH).toBe(process.env.PATH);
  });

  it('rejects overrides that leave the merged env without PATH', () => {
    let thrown: unknown;
    try {
      create({ env: { PATH: '/usr/bin', HOME: '/tmp/h' }, envOverrides: { PATH: '' } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AcpClientError);
    expect((thrown as InstanceType<typeof AcpClientError>).code).toBe('INVALID_PARAMS');
  });

  it('sends an initialize handshake advertising the default client capabilities', async () => {
    create();
    await flush();
    const init = sentMessages().find((m) => m.method === 'initialize');
    expect(init).toBeDefined();
    expect(init?.jsonrpc).toBe('2.0');
    const params = init?.params as { protocolVersion: number; clientCapabilities: unknown };
    expect(params.protocolVersion).toBe(1);
    expect(params.clientCapabilities).toEqual({ fs: { readTextFile: true, writeTextFile: true } });
  });

  it('advertises per-provider capabilities when supplied', async () => {
    create({
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        _meta: { terminal_output: true },
      },
    });
    await flush();
    const init = sentMessages().find((m) => m.method === 'initialize');
    const params = init?.params as { clientCapabilities: { _meta?: unknown } };
    expect(params.clientCapabilities._meta).toEqual({ terminal_output: true });
  });

  it('resolves `initialized` and emits an initialized event', async () => {
    const session = create();
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));
    await answerInitialize();

    await expect(session.initialized).resolves.toEqual({ protocolVersion: 1 });
    const initEvent = events.find((e) => e.type === 'event' && e.event.acp === 'initialized');
    expect(initEvent).toBeDefined();
  });

  it('forwards session/update notifications verbatim, with seq/gen stamped', async () => {
    const session = create();
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));
    await answerInitialize();

    const update = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionUpdate: 'agent_message_chunk' },
    };
    agentSends(update);
    await flush();

    const forwarded = events.find((e) => e.type === 'event' && e.event.acp === 'notification');
    expect(forwarded).toMatchObject({
      type: 'event',
      event: { acp: 'notification', message: update },
    });
  });

  it('reassembles JSON-RPC messages split across stdout chunks', async () => {
    const session = create();
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));
    await answerInitialize();

    const line = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { a: 1 } });
    const before = events.length;
    state.child?.stdout.push(line.slice(0, 12));
    await flush();
    expect(events.length).toBe(before);
    state.child?.stdout.push(`${line.slice(12)}\n`);
    await flush();
    expect(events.length).toBe(before + 1);
  });

  it('answers fs/read_text_file itself, confined to the workspace', async () => {
    const session = create({ cwd: '/tmp/ws' });
    readFileMock.mockResolvedValueOnce('file contents');
    await answerInitialize();

    agentSends({
      jsonrpc: '2.0',
      id: 7,
      method: 'fs/read_text_file',
      params: { path: '/tmp/ws/a.ts' },
    });
    await flush();
    await flush();

    expect(readFileMock).toHaveBeenCalledWith('/tmp/ws/a.ts', 'utf8');
    expect(sentMessages()).toContainEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { content: 'file contents' },
    });
    expect(session.exited).toBe(false);
  });

  it('answers fs/write_text_file itself', async () => {
    create();
    writeFileMock.mockResolvedValueOnce(undefined);
    await answerInitialize();

    agentSends({
      jsonrpc: '2.0',
      id: 8,
      method: 'fs/write_text_file',
      params: { path: '/tmp/b.ts', content: 'x' },
    });
    await flush();
    await flush();

    expect(writeFileMock).toHaveBeenCalledWith('/tmp/b.ts', 'x', 'utf8');
    expect(sentMessages()).toContainEqual({ jsonrpc: '2.0', id: 8, result: {} });
  });

  it('reports fs errors back to the agent as a JSON-RPC error', async () => {
    create();
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'));
    await answerInitialize();

    agentSends({
      jsonrpc: '2.0',
      id: 9,
      method: 'fs/read_text_file',
      params: { path: '/tmp/missing.ts' },
    });
    await flush();
    await flush();

    expect(sentMessages()).toContainEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32603, message: 'ENOENT' },
    });
  });

  it('confines agent filesystem access to the session workspace', async () => {
    const session = create({ cwd: '/tmp/ws' });
    await answerInitialize();

    agentSends({
      jsonrpc: '2.0',
      id: 20,
      method: 'fs/read_text_file',
      params: { path: '/etc/passwd' },
    });
    await flush();
    await flush();

    expect(readFileMock).not.toHaveBeenCalled();
    expect(sentMessages()).toContainEqual({
      jsonrpc: '2.0',
      id: 20,
      error: { code: -32603, message: 'Path outside session workspace: /etc/passwd' },
    });
    expect(session.exited).toBe(false);
  });

  it('forwards a permission request to the caller and answers it via respondPermission', async () => {
    const session = create();
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));
    await answerInitialize();

    agentSends({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'session/request_permission',
      params: { options: [] },
    });
    await flush();

    expect(events).toContainEqual({
      type: 'event',
      event: expect.objectContaining({
        acp: 'request',
        id: 'req-1',
        method: 'session/request_permission',
      }),
    });

    session.respondPermission('req-1', { outcome: 'selected' });
    expect(sentMessages()).toContainEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      result: { outcome: 'selected' },
    });
  });

  it('records a settle marker (once) when a forwarded request is answered', async () => {
    const session = create();
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));
    await answerInitialize();

    // The real Claude bridge used id 0 for its first permission request —
    // must not be treated as falsy anywhere on this path.
    agentSends({
      jsonrpc: '2.0',
      id: 0,
      method: 'session/request_permission',
      params: { options: [] },
    });
    await flush();

    session.respondPermission(0, { outcome: 'selected' });
    const settleFrames = events.filter(
      (e) =>
        e.type === 'event' &&
        e.event.acp === 'notification' &&
        e.event.message.method === '_agile/request_settled',
    );
    expect(settleFrames).toHaveLength(1);
    expect(settleFrames[0]).toMatchObject({ event: { message: { params: { id: 0 } } } });

    // Answering the same id again settles nothing new.
    const before = events.length;
    session.respondPermission(0, { outcome: 'selected' });
    expect(events).toHaveLength(before);
  });

  it('records the settle marker for respondPermissionError too', async () => {
    const session = create();
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));
    await answerInitialize();

    agentSends({ jsonrpc: '2.0', id: 'req-2', method: 'session/request_permission', params: {} });
    await flush();

    session.respondPermissionError('req-2', -32603, 'denied');
    expect(
      events.some(
        (e) =>
          e.type === 'event' &&
          e.event.acp === 'notification' &&
          e.event.message.method === '_agile/request_settled' &&
          (e.event.message.params as { id: unknown }).id === 'req-2',
      ),
    ).toBe(true);
  });

  it('emits no settle marker for requests it answered internally (fs handlers)', async () => {
    const session = create();
    const events: AgentEvent[] = [];
    session.on((e) => events.push(e));
    readFileMock.mockResolvedValueOnce('file contents');
    await answerInitialize();

    agentSends({
      jsonrpc: '2.0',
      id: 7,
      method: 'fs/read_text_file',
      params: { path: '/tmp/a.ts' },
    });
    await flush();
    await flush();

    expect(
      events.filter(
        (e) =>
          e.type === 'event' &&
          e.event.acp === 'notification' &&
          e.event.message.method === '_agile/request_settled',
      ),
    ).toHaveLength(0);
  });

  it('marks the session exited when the process could not be spawned', async () => {
    const session = create();
    const errors: string[] = [];
    session.on((e) => {
      if (e.type === 'error') errors.push(e.message);
    });
    await flush();

    state.child?.emit('error', new Error('spawn ENOENT'));
    state.child?.emit('close', null);

    expect(errors).toContain('spawn ENOENT');
    expect(session.exited).toBe(true);
    await expect(session.initialized).rejects.toThrow(/failed to start: spawn ENOENT/);
    await expect(session.authenticate('m')).rejects.toThrow(/failed to start: spawn ENOENT/);
  });

  it('emits exit exactly once when both exit and close fire', async () => {
    const session = create();
    const codes: number[] = [];
    session.on((e) => {
      if (e.type === 'exit') codes.push(e.exitCode);
    });
    await flush();
    state.child?.emit('exit', 3);
    state.child?.emit('close', 3);
    expect(codes).toEqual([3]);
    expect(session.exited).toBe(true);
  });

  it('does not treat stdin backpressure as a failed write', async () => {
    const session = create();
    await answerInitialize();
    state.backpressure = true;

    const pending = session.authenticate('cursor_login');
    await flush();
    const sent = sentMessages().find((m) => m.method === 'authenticate');
    expect(sent).toBeDefined();
    agentSends({ jsonrpc: '2.0', id: sent?.id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('rejects pending requests when the agent exits mid-request', async () => {
    const session = create();
    await answerInitialize();
    const pending = session.authenticate('cursor_login');
    await flush(); // let the request actually reach the wire before the agent dies
    state.child?.emit('exit', 1);
    await expect(pending).rejects.toThrow('ACP agent exited');
    expect(session.exited).toBe(true);
  });

  it('rejects requests made after exit', async () => {
    const session = create();
    await answerInitialize();
    state.child?.emit('exit', 0);
    await expect(session.authenticate('cursor_login')).rejects.toThrow('ACP session has exited');
  });

  it('ignores unparseable stdout lines without dying', async () => {
    const session = create();
    await answerInitialize();
    state.child?.stdout.push('not json\n');
    await flush();
    expect(session.exited).toBe(false);
  });

  it('still kills the session on stdout overflow with nobody listening', async () => {
    create({ maxStdoutBufferBytes: 1024 });
    await flush();
    state.child?.stdout.push('x'.repeat(2000));
    await flush();
    expect(state.child?.kill).toHaveBeenCalled();
  });

  describe('prompt()', () => {
    it('creates a session lazily, sends the prompt, and resolves the folded reply', async () => {
      const session = create();
      await answerInitialize();

      const replyPromise = session.prompt('hello');
      await answerSessionNew('acp-1');
      await flush();

      const promptMsg = sentMessages().find((m) => m.method === 'session/prompt');
      expect(promptMsg).toBeDefined();
      expect(promptMsg?.params).toEqual({
        sessionId: 'acp-1',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      agentSends({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hi there' },
          },
        },
      });
      await flush();
      agentSends({ jsonrpc: '2.0', id: promptMsg?.id, result: { stopReason: 'end_turn' } });

      const reply = await replyPromise;
      expect(reply).toEqual({ status: 'completed', text: 'hi there' });
      expect(session.sessionId).toBe('acp-1');
    });

    it('reuses the ACP session id across prompts', async () => {
      const session = create();
      await answerInitialize();
      const first = session.prompt('one');
      await answerSessionNew('acp-1');
      await flush();
      const firstPrompt = sentMessages().find((m) => m.method === 'session/prompt');
      agentSends({ jsonrpc: '2.0', id: firstPrompt?.id, result: { stopReason: 'end_turn' } });
      await first;

      const second = session.prompt('two');
      await flush();
      const newCalls = sentMessages().filter((m) => m.method === 'session/new');
      expect(newCalls).toHaveLength(1); // no second session/new
      const secondPrompt = sentMessages().filter((m) => m.method === 'session/prompt')[1];
      agentSends({ jsonrpc: '2.0', id: secondPrompt?.id, result: { stopReason: 'end_turn' } });
      await expect(second).resolves.toMatchObject({ status: 'completed' });
    });

    it('settles a failed reply, with the streamed text kept, when the prompt round trip rejects', async () => {
      const session = create();
      await answerInitialize();
      const replyPromise = session.prompt('go');
      await answerSessionNew('acp-1');
      await flush();
      agentSends({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'partial' },
          },
        },
      });
      await flush();
      const promptMsg = sentMessages().find((m) => m.method === 'session/prompt');
      agentSends({ jsonrpc: '2.0', id: promptMsg?.id, error: { code: -32000, message: 'boom' } });

      const reply = await replyPromise;
      expect(reply.status).toBe('failed');
      expect(reply.text).toBe('partial');
      expect(reply.error?.code).toBe('turn_failed');
    });

    it('rejects a second concurrent prompt instead of stranding the first', async () => {
      const session = create();
      await answerInitialize();
      const first = session.prompt('one');
      await answerSessionNew('acp-1');
      await flush();

      await expect(session.prompt('two')).rejects.toMatchObject({
        name: 'AcpClientError',
        code: 'PROMPT_IN_FLIGHT',
      });

      // The first prompt is still alive and settles normally — it was never
      // stranded by the rejected second call.
      const promptMsg = sentMessages().find((m) => m.method === 'session/prompt');
      agentSends({ jsonrpc: '2.0', id: promptMsg?.id, result: { stopReason: 'end_turn' } });
      await expect(first).resolves.toMatchObject({ status: 'completed' });

      // Once the first turn has settled, prompting again works.
      const third = session.prompt('three');
      await flush();
      const thirdPrompt = sentMessages().filter((m) => m.method === 'session/prompt')[1];
      agentSends({ jsonrpc: '2.0', id: thirdPrompt?.id, result: { stopReason: 'end_turn' } });
      await expect(third).resolves.toMatchObject({ status: 'completed' });
    });

    it('rejects a second prompt fired synchronously before the first reaches session/new', async () => {
      // The QA-found race: both calls issued with no `await` between them,
      // before the first has even sent `session/new` — the guard must
      // reserve the slot synchronously at the top of `prompt()`, not only
      // once `promptRequest`/`ensureSession` has resolved, or both calls
      // slip past it and the first is orphaned forever.
      const session = create();
      await answerInitialize();

      const first = session.prompt('one');
      const second = session.prompt('two'); // no await in between — this is the repro

      await expect(second).rejects.toMatchObject({
        name: 'AcpClientError',
        code: 'PROMPT_IN_FLIGHT',
      });

      await answerSessionNew('acp-1');
      await flush();
      const promptMsg = sentMessages().find((m) => m.method === 'session/prompt');
      agentSends({ jsonrpc: '2.0', id: promptMsg?.id, result: { stopReason: 'end_turn' } });
      await expect(first).resolves.toMatchObject({ status: 'completed' });

      // The second call never got far enough to send anything of its own.
      expect(sentMessages().filter((m) => m.method === 'session/new')).toHaveLength(1);
      expect(sentMessages().filter((m) => m.method === 'session/prompt')).toHaveLength(1);
    });

    it('close() settles a pending prompt instead of leaving it hanging', async () => {
      const session = create();
      await answerInitialize();
      const pending = session.prompt('go');
      await answerSessionNew('acp-1'); // now genuinely mid-turn: session/prompt has been sent
      await flush();

      session.close();

      const reply = await pending;
      expect(reply.status).toBe('failed');
      expect(reply.error?.code).toBe('session_error');
    });

    it('close() unblocks a prompt reserved but not yet past session/new, once the process actually exits', async () => {
      // Closing settles the reserved slot's internal reply promise
      // immediately (asserted above), but `prompt()`'s own returned promise
      // is still awaiting `ensureSession()` at this point — it settles (by
      // rejecting, an acceptable outcome alongside resolving) once the real
      // process exit rejects the pending `session/new` round trip. Either
      // way, the caller is never left hanging.
      const session = create();
      await answerInitialize();
      const pending = session.prompt('go'); // session/new sent, not yet answered
      await flush();

      session.close();
      state.child?.emit('exit', 0);

      await expect(pending).rejects.toThrow('ACP agent exited');
    });
  });

  describe('mcpServers / modeId passthrough (T011)', () => {
    it('passes mcpServers through on session/new and session/load', async () => {
      const mcpServers = [{ name: 'agile-tools', command: 'agile', args: ['mcp'] }];
      const session = create({ mcpServers });
      await answerInitialize();

      const promptPromise = session.prompt('go');
      await flush();
      const newMsg = sentMessages().find((m) => m.method === 'session/new');
      expect(newMsg?.params).toMatchObject({ mcpServers });
      answeredIds.add(newMsg?.id as number);
      agentSends({ jsonrpc: '2.0', id: newMsg?.id, result: { sessionId: 'acp-1' } });
      await flush();
      const promptMsg = sentMessages().find((m) => m.method === 'session/prompt');
      agentSends({ jsonrpc: '2.0', id: promptMsg?.id, result: { stopReason: 'end_turn' } });
      await promptPromise;

      const loadPromise = session.load('old-session');
      await flush();
      const loadMsg = sentMessages().find((m) => m.method === 'session/load');
      expect(loadMsg?.params).toMatchObject({ mcpServers });
      agentSends({ jsonrpc: '2.0', id: loadMsg?.id, result: {} });
      await loadPromise;
    });

    it('sets the initial mode right after session/new when modeId is given', async () => {
      const session = create({ modeId: 'acceptEdits' });
      await answerInitialize();
      const promptPromise = session.prompt('go');
      await flush();
      const newMsg = sentMessages().find((m) => m.method === 'session/new');
      agentSends({ jsonrpc: '2.0', id: newMsg?.id, result: { sessionId: 'acp-1' } });
      await flush();

      const setModeMsg = sentMessages().find((m) => m.method === 'session/set_mode');
      expect(setModeMsg?.params).toEqual({ sessionId: 'acp-1', modeId: 'acceptEdits' });
      agentSends({ jsonrpc: '2.0', id: setModeMsg?.id, result: {} });
      await flush();
      const promptMsg = sentMessages().find((m) => m.method === 'session/prompt');
      agentSends({ jsonrpc: '2.0', id: promptMsg?.id, result: { stopReason: 'end_turn' } });
      await promptPromise;
    });
  });

  describe('cancel / setMode / load', () => {
    it('cancel() sends session/cancel as a notification (no id) once a session exists', async () => {
      const session = create();
      await answerInitialize();
      expect(session.cancel()).toBe(false); // no session yet
      const replyPromise = session.prompt('go');
      await answerSessionNew('acp-1');
      await flush();
      expect(session.cancel()).toBe(true);
      const cancelMsg = sentMessages().find((m) => m.method === 'session/cancel');
      expect(cancelMsg).toEqual({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: 'acp-1' },
      });
      // Clean up the still-pending prompt so it does not leak into other tests.
      const promptMsg = sentMessages().find((m) => m.method === 'session/prompt');
      agentSends({ jsonrpc: '2.0', id: promptMsg?.id, result: { stopReason: 'cancelled' } });
      await replyPromise;
    });

    it('setMode() sends session/set_mode for the current session', async () => {
      const session = create();
      await answerInitialize();
      const setModePromise = session.setMode('acceptEdits');
      await answerSessionNew('acp-1');
      await flush();
      const msg = sentMessages().find((m) => m.method === 'session/set_mode');
      expect(msg?.params).toEqual({ sessionId: 'acp-1', modeId: 'acceptEdits' });
      agentSends({ jsonrpc: '2.0', id: msg?.id, result: {} });
      await expect(setModePromise).resolves.toEqual({});
    });

    it('load() recovers a session id and records session state', async () => {
      const session = create();
      await answerInitialize();
      const loadPromise = session.load('old-session');
      await flush();
      const msg = sentMessages().find((m) => m.method === 'session/load');
      expect(msg?.params).toMatchObject({ sessionId: 'old-session' });
      agentSends({
        jsonrpc: '2.0',
        id: msg?.id,
        result: { modes: { currentModeId: 'default' } },
      });
      await loadPromise;
      expect(session.sessionId).toBe('old-session');
    });
  });

  describe('authenticate()', () => {
    it('sends the ACP authenticate request with the given methodId', async () => {
      const session = create();
      await answerInitialize();
      const authPromise = session.authenticate('grok.com');
      await flush();
      const msg = sentMessages().find((m) => m.method === 'authenticate');
      expect(msg?.params).toEqual({ methodId: 'grok.com' });
      agentSends({ jsonrpc: '2.0', id: msg?.id, result: {} });
      await expect(authPromise).resolves.toEqual({});
    });

    it('raises AuthRequiredError for a -32000 session/new failure, even without "auth" in the message', async () => {
      const session = create();
      await answerInitialize();
      const promptPromise = session.prompt('go');
      await flush();
      const newMsg = sentMessages().find((m) => m.method === 'session/new');
      // Deliberately no "auth" substring — the code alone must trigger it,
      // matching spike/permission-matrix.ts's `e?.code === -32000 || ...`.
      agentSends({
        jsonrpc: '2.0',
        id: newMsg?.id,
        error: { code: -32000, message: 'Please sign in first' },
      });
      await expect(promptPromise).rejects.toMatchObject({ name: 'AuthRequiredError' });
    });

    it('surfaces authMethods from a matching error message even without code -32000 (fallback)', async () => {
      const session = create();
      await answerInitialize();
      const promptPromise = session.prompt('go');
      await flush();
      const newMsg = sentMessages().find((m) => m.method === 'session/new');
      agentSends({
        jsonrpc: '2.0',
        id: newMsg?.id,
        error: {
          code: -32001,
          message: 'Authentication required',
          data: { authMethods: ['cursor_login'] },
        },
      });
      await expect(promptPromise).rejects.toMatchObject({
        name: 'AuthRequiredError',
        authMethods: { authMethods: ['cursor_login'] },
      });
    });

    it('passes authMethods through from the initialize result for the caller to inspect', async () => {
      const session = create();
      await flush();
      const init = sentMessages().find((m) => m.method === 'initialize');
      agentSends({
        jsonrpc: '2.0',
        id: init?.id,
        result: { protocolVersion: 1, authMethods: [{ id: 'cursor_login' }] },
      });
      await expect(session.initialized).resolves.toMatchObject({
        authMethods: [{ id: 'cursor_login' }],
      });
    });

    it('retries session/new successfully after authenticate() resolves', async () => {
      const session = create();
      await answerInitialize();
      const first = session.prompt('go');
      await flush();
      const firstNew = sentMessages().find((m) => m.method === 'session/new');
      agentSends({
        jsonrpc: '2.0',
        id: firstNew?.id,
        error: { code: -32000, message: 'auth required' },
      });
      await expect(first).rejects.toMatchObject({ name: 'AuthRequiredError' });

      const authPromise = session.authenticate('cursor_login');
      await flush();
      const authMsg = sentMessages().find((m) => m.method === 'authenticate');
      agentSends({ jsonrpc: '2.0', id: authMsg?.id, result: {} });
      await authPromise;

      const second = session.prompt('go again');
      await flush();
      const secondNew = sentMessages().filter((m) => m.method === 'session/new')[1];
      agentSends({ jsonrpc: '2.0', id: secondNew?.id, result: { sessionId: 'acp-1' } });
      await flush();
      const promptMsg = sentMessages().find((m) => m.method === 'session/prompt');
      agentSends({ jsonrpc: '2.0', id: promptMsg?.id, result: { stopReason: 'end_turn' } });
      await expect(second).resolves.toMatchObject({ status: 'completed' });
    });
  });

  describe('truncation is never silent (dropped events surface as a `truncated` notice)', () => {
    it('replay() reports dropped and prepends a synthetic truncated event once the ring cap is exceeded', async () => {
      const session = create({ eventLogMaxEntries: 2 });
      await answerInitialize(); // 1 event so far: initialized
      for (let i = 0; i < 3; i++) {
        agentSends({ jsonrpc: '2.0', method: 'session/update', params: { n: i } });
        await flush();
      }

      const replay = session.replay();
      expect(replay.dropped).toBeGreaterThan(0);
      expect(replay.events[0]).toMatchObject({ acp: 'truncated', dropped: replay.dropped });
    });

    it('on() replays the truncated notice to a listener attached after the drop', async () => {
      const session = create({ eventLogMaxEntries: 2 });
      await answerInitialize();
      for (let i = 0; i < 3; i++) {
        agentSends({ jsonrpc: '2.0', method: 'session/update', params: { n: i } });
        await flush();
      }

      const events: AgentEvent[] = [];
      session.on((e) => events.push(e));
      expect(events[0]).toMatchObject({ type: 'event', event: { acp: 'truncated' } });
    });
  });

  describe('forwarded requests with no listener attached', () => {
    it('refuses a permission request outright rather than leaving the agent blocked forever', async () => {
      const session = create();
      await answerInitialize();

      agentSends({ jsonrpc: '2.0', id: 'req-1', method: 'session/request_permission', params: {} });
      await flush();

      expect(sentMessages()).toContainEqual({
        jsonrpc: '2.0',
        id: 'req-1',
        error: { code: -32603, message: 'No listener attached to answer request' },
      });
    });
  });
});
