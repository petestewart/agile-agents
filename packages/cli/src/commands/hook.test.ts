import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  type RpcServerHandle,
  renderCodexGateScript,
  shellQuote,
  startRpcServer,
} from '@agile-agents/daemon';
import { parseArgs } from '../args';
import { runCli } from '../index';
import { codexCallInWorktrees, hookEventToMethod, parseHookArgs, runHook } from './hook';

const CLI_ENTRY = join(import.meta.dir, '..', 'index.ts');

function stdinWith(payload: unknown): NodeJS.ReadableStream {
  return Readable.from([JSON.stringify(payload)]);
}

describe('hookEventToMethod', () => {
  test('kebab-case event names map to snake_case hook.* methods', () => {
    expect(hookEventToMethod('pre-tool-use')).toBe('hook.pre_tool_use');
    expect(hookEventToMethod('post-tool-use')).toBe('hook.post_tool_use');
    expect(hookEventToMethod('stop')).toBe('hook.stop');
  });
});

describe('parseHookArgs', () => {
  test('fail-closed is the default (T009); --fail-open opts out', () => {
    expect(parseHookArgs(parseArgs(['pre-tool-use']))).toEqual({
      event: 'pre-tool-use',
      failClosed: true,
      timeoutMs: undefined,
    });
    expect(parseHookArgs(parseArgs(['pre-tool-use', '--fail-open']))).toEqual({
      event: 'pre-tool-use',
      failClosed: false,
      timeoutMs: undefined,
    });
  });

  // T136 (QA rough edge 2): the usage line stopped presenting
  // `--fail-closed` (the default since T009) as the flag you need, and
  // names the real opt-out instead.
  test('the usage line names --fail-open, not --fail-closed', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    try {
      expect(await runCli([])).toBe(0);
    } finally {
      console.error = original;
    }
    const hookLine = errors
      .join('\n')
      .split('\n')
      .find((line) => line.trim().startsWith('hook <event>'));
    expect(hookLine).toBeDefined();
    expect(hookLine).toContain('[--fail-open]');
    expect(hookLine).not.toContain('--fail-closed');
  });

  test('--fail-closed is still accepted (explicit, no-op vs the default)', () => {
    expect(parseHookArgs(parseArgs(['pre-tool-use', '--fail-closed']))).toEqual({
      event: 'pre-tool-use',
      failClosed: true,
      timeoutMs: undefined,
    });
  });

  test('reads --timeout as a number of milliseconds', () => {
    expect(parseHookArgs(parseArgs(['pre-tool-use', '--timeout', '500']))).toEqual({
      event: 'pre-tool-use',
      failClosed: true,
      timeoutMs: 500,
    });
  });

  test('a non-numeric --timeout throws', () => {
    expect(() => parseHookArgs(parseArgs(['pre-tool-use', '--timeout', 'soon']))).toThrow(
      /--timeout must be a number/,
    );
  });

  test('throws a usage error with no event', () => {
    expect(() => parseHookArgs(parseArgs([]))).toThrow(/usage: agile hook/);
  });
});

describe('runHook', () => {
  let dir: string;
  let socketPath: string;
  let rpc: RpcServerHandle | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agile-cli-hook-'));
    socketPath = join(dir, 'test.sock');
  });

  afterEach(async () => {
    await rpc?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('forwards stdin JSON to hook.<event> and prints the real decision verbatim', async () => {
    rpc = startRpcServer({
      socketPath,
      version: 'test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: {
        'hook.pre_tool_use': (params) => ({
          decision: 'allow',
          echoedTool: (params as { tool: string }).tool,
        }),
      },
    });

    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: true,
        stdin: stdinWith({ tool: 'Read' }),
      });
    } finally {
      console.log = original;
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed).toEqual({ decision: 'allow', echoedTool: 'Read' });
  });

  // T012 QA/review round: `AGILE_AGENT` (set by `writeClaudeSettings`'s
  // `agentId` option) is forwarded into the payload as `agile_agent`, so
  // `HookService.resolveAgentByCwd` can disambiguate a reviewer/engineer
  // sharing one worktree.
  test('forwards AGILE_AGENT as payload.agile_agent when set', async () => {
    rpc = startRpcServer({
      socketPath,
      version: 'test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: {
        'hook.pre_tool_use': (params) => ({
          receivedAgent: (params as { agile_agent?: unknown }).agile_agent,
        }),
      },
    });

    const lines: string[] = [];
    const original = console.log;
    const originalEnv = process.env.AGILE_AGENT;
    process.env.AGILE_AGENT = '01ARZ3NDEKTSV4RRFFQ69GR001';
    console.log = (msg: string) => lines.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: true,
        stdin: stdinWith({ tool: 'Edit' }),
      });
    } finally {
      console.log = original;
      if (originalEnv === undefined) Reflect.deleteProperty(process.env, 'AGILE_AGENT');
      else process.env.AGILE_AGENT = originalEnv;
    }
    expect(code).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toEqual({ receivedAgent: '01ARZ3NDEKTSV4RRFFQ69GR001' });
  });

  test('does not add agile_agent when AGILE_AGENT is unset', async () => {
    rpc = startRpcServer({
      socketPath,
      version: 'test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: {
        'hook.pre_tool_use': (params) => ({ hasAgileAgent: 'agile_agent' in (params as object) }),
      },
    });

    const lines: string[] = [];
    const original = console.log;
    const originalEnv = process.env.AGILE_AGENT;
    Reflect.deleteProperty(process.env, 'AGILE_AGENT');
    console.log = (msg: string) => lines.push(msg);
    try {
      await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: true,
        stdin: stdinWith({ tool: 'Read' }),
      });
    } finally {
      console.log = original;
      if (originalEnv !== undefined) process.env.AGILE_AGENT = originalEnv;
    }
    expect(JSON.parse(lines.join('\n'))).toEqual({ hasAgileAgent: false });
  });

  test('fail-open (--fail-open): a not-implemented stub yields a permissive {} decision, exit 0, warns on stderr', async () => {
    // No `hook.*` extraMethods wired — same shape as an RPC failure for any
    // other reason (unimplemented method, handler throw, etc).
    rpc = startRpcServer({ socketPath, version: 'test', stateRoot: dir, startedAt: Date.now() });

    const lines: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg: string) => lines.push(msg);
    console.error = (msg: string) => errors.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: false,
        stdin: stdinWith({}),
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(code).toBe(0);
    // stdout stays pure JSON — the warning must never land there.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines.join('\n'))).toEqual({});
    expect(errors.join('\n')).toMatch(
      /daemon unreachable or hook\.\* not implemented; failing open/,
    );
  });

  test('fail-open: an unreachable daemon also yields {} and exit 0, warns on stderr', async () => {
    expect(existsSync(socketPath)).toBe(false);
    const lines: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg: string) => lines.push(msg);
    console.error = (msg: string) => errors.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: false,
        stdin: stdinWith({}),
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines.join('\n'))).toEqual({});
    expect(errors.join('\n')).toMatch(
      /daemon unreachable or hook\.\* not implemented; failing open/,
    );
  });

  test('--timeout bounds how long a wedged daemon is waited on before failing (open here)', async () => {
    rpc = startRpcServer({
      socketPath,
      version: 'test',
      stateRoot: dir,
      startedAt: Date.now(),
      // Never resolves — simulates a daemon that accepted the connection
      // but is wedged and never replies.
      extraMethods: { 'hook.pre_tool_use': () => new Promise(() => {}) },
    });

    const start = performance.now();
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: false,
        timeoutMs: 100,
        stdin: stdinWith({}),
      });
    } finally {
      console.log = original;
    }
    const elapsed = performance.now() - start;
    expect(code).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toEqual({});
    // Well under the 2000ms default — proves the override actually took effect.
    expect(elapsed).toBeLessThan(1000);
  });

  test('fail-closed (default, T009): a not-implemented stub denies the pre-tool-use call with a reason, exit 0', async () => {
    rpc = startRpcServer({ socketPath, version: 'test', stateRoot: dir, startedAt: Date.now() });
    const lines: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (msg: string) => lines.push(msg);
    console.error = (msg: string) => errors.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: true,
        stdin: stdinWith({}),
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(code).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'agile daemon unreachable',
      },
    });
    expect(errors.join('\n')).toMatch(/not implemented yet/);
  });

  test('fail-closed: an unreachable daemon also denies pre-tool-use with a reason, exit 0', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: true,
        stdin: stdinWith({}),
      });
    } finally {
      console.log = original;
    }
    expect(code).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'agile daemon unreachable',
      },
    });
  });

  test('fail-closed: post-tool-use/stop have no deny concept, so they still print {} on failure', async () => {
    for (const event of ['post-tool-use', 'stop']) {
      const lines: string[] = [];
      const original = console.log;
      console.log = (msg: string) => lines.push(msg);
      let code: number;
      try {
        code = await runHook({ socketPath, event, failClosed: true, stdin: stdinWith({}) });
      } finally {
        console.log = original;
      }
      expect(code).toBe(0);
      expect(JSON.parse(lines.join('\n'))).toEqual({});
    }
  });

  test('invalid JSON on stdin exits 1 without reaching the daemon', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(msg);
    let code: number;
    try {
      code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: false,
        stdin: Readable.from(['{not json']),
      });
    } finally {
      console.error = original;
    }
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/invalid JSON/);
  });
});

describe("T506: --vendor codex speaks Codex's hook contract", () => {
  let dir: string;
  let socketPath: string;
  let rpc: RpcServerHandle | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'agile-cli-hook-codex-')));
    socketPath = join(dir, 'test.sock');
  });

  afterEach(async () => {
    await rpc?.close();
    rpc = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the hook capturing stdout and stderr (both `console.*` and `process.stderr.write`). */
  async function run(
    stdin: NodeJS.ReadableStream,
    opts: { failClosed?: boolean; repo?: string } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    const write = process.stderr.write.bind(process.stderr);
    console.log = (msg: string) => out.push(String(msg));
    console.error = (msg: string) => err.push(String(msg));
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runHook({
        socketPath,
        event: 'pre-tool-use',
        failClosed: opts.failClosed ?? true,
        vendor: 'codex',
        ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
        stdin,
      });
      return { code, stdout: out.join('\n'), stderr: err.join('\n') };
    } finally {
      console.log = log;
      console.error = error;
      process.stderr.write = write;
    }
  }

  function serve(reply: (params: Record<string, unknown>) => unknown): {
    seen: Record<string, unknown>[];
  } {
    const seen: Record<string, unknown>[] = [];
    rpc = startRpcServer({
      socketPath,
      version: 'test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: {
        'hook.pre_tool_use': (params) => {
          seen.push(params as Record<string, unknown>);
          return reply(params as Record<string, unknown>);
        },
      },
    });
    return { seen };
  }

  const CODEX_INPUT = {
    session_id: 'thread-1',
    turn_id: 'turn-1',
    cwd: '/w',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'curl https://example.com' },
    tool_use_id: 'call-1',
  };

  test('parses --vendor codex, and refuses an unknown vendor', () => {
    expect(parseHookArgs(parseArgs(['pre-tool-use', '--vendor', 'codex']))).toEqual({
      event: 'pre-tool-use',
      failClosed: true,
      timeoutMs: undefined,
      vendor: 'codex',
    });
    expect(() => parseHookArgs(parseArgs(['pre-tool-use', '--vendor', 'gemini']))).toThrow(
      /--vendor must be one of claude, codex/,
    );
  });

  test('a deny is exit 2 with the reason on stderr and nothing on stdout; the input is marked codex', async () => {
    const { seen } = serve(() => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'curl needs the operator: held in Needs me',
      },
    }));
    const result = await run(stdinWith(CODEX_INPUT));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('curl needs the operator: held in Needs me');
    expect(seen[0]).toMatchObject({ ...CODEX_INPUT, agile_vendor: 'codex' });
  });

  test('an allow is exit 0 with nothing on stdout or stderr', async () => {
    serve(() => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    }));
    const result = await run(stdinWith(CODEX_INPUT));
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  test('a reply that is not an allow blocks', async () => {
    serve(() => ({ something: 'else' }));
    const result = await run(stdinWith(CODEX_INPUT));
    expect(result.code).toBe(2);
    expect(result.stderr).toBe('AGILE-GATE: blocked');
  });

  test('an unreachable daemon blocks with exit 2 (fail closed); --fail-open lets it run', async () => {
    const closed = await run(stdinWith(CODEX_INPUT));
    expect(closed.code).toBe(2);
    expect(closed.stdout).toBe('');
    expect(closed.stderr).toContain('AGILE-GATE: agile daemon unreachable');
    const open = await run(stdinWith(CODEX_INPUT), { failClosed: false });
    expect(open.code).toBe(0);
    expect(open.stdout).toBe('');
  });

  test('bad input blocks with exit 2 (Codex runs a call whose hook exited 1)', async () => {
    expect((await run(Readable.from(['{not json']))).code).toBe(2);
    expect((await run(stdinWith([1, 2]))).code).toBe(2);
  });

  // T511: the hook sits at the repo root, where the operator's own Codex reads it too.
  describe('--repo <root>: only calls from <root>/.worktrees/ are gated', () => {
    function layout(): { repo: string; wt: string } {
      const repo = join(dir, 'repo');
      const wt = join(repo, '.worktrees', '01ABC-csv');
      mkdirSync(join(wt, 'src'), { recursive: true });
      return { repo, wt };
    }

    const DENY = () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'curl needs the operator',
      },
    });

    test('a cwd outside .worktrees/ is allowed: exit 0, nothing printed, no daemon call', async () => {
      const { repo } = layout();
      const { seen } = serve(DENY);
      for (const cwd of [
        repo,
        join(repo, 'src'),
        join(dir, 'elsewhere'),
        `${repo}/.worktreesX/a`,
      ]) {
        const result = await run(stdinWith({ ...CODEX_INPUT, cwd }), { repo });
        expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
      }
      expect(seen).toHaveLength(0);
      // Not even a daemon to call: still allowed.
      await rpc?.close();
      rpc = undefined;
      expect((await run(stdinWith({ ...CODEX_INPUT, cwd: repo }), { repo })).code).toBe(0);
    });

    test('a cwd inside a worktree is gated as without --repo', async () => {
      const { repo, wt } = layout();
      const { seen } = serve(DENY);
      const result = await run(stdinWith({ ...CODEX_INPUT, cwd: join(wt, 'src') }), { repo });
      expect(result.code).toBe(2);
      expect(result.stderr).toBe('curl needs the operator');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ cwd: join(wt, 'src'), agile_vendor: 'codex' });
    });

    test('inside, an unreachable daemon blocks (fail closed)', async () => {
      const { repo, wt } = layout();
      const result = await run(stdinWith({ ...CODEX_INPUT, cwd: wt }), { repo });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('AGILE-GATE: agile daemon unreachable');
    });

    test('a missing, non-string or relative cwd counts as inside: gated', async () => {
      const { repo } = layout();
      const { seen } = serve(DENY);
      const { cwd: _cwd, ...noCwd } = CODEX_INPUT;
      for (const input of [noCwd, { ...CODEX_INPUT, cwd: 42 }, { ...CODEX_INPUT, cwd: 'repo' }]) {
        expect((await run(stdinWith(input), { repo })).code).toBe(2);
      }
      expect(seen).toHaveLength(3);
      // Bad input is still exit 2.
      expect((await run(Readable.from(['{not json']), { repo })).code).toBe(2);
    });

    test('the cwd is compared through its real path: a link into .worktrees/ is gated, a link out is not', async () => {
      const { repo, wt } = layout();
      const { seen } = serve(DENY);
      const into = join(dir, 'into-wt');
      symlinkSync(wt, into);
      expect((await run(stdinWith({ ...CODEX_INPUT, cwd: into }), { repo })).code).toBe(2);
      // The repo reached through a symlinked path: its worktrees are still gated.
      const repoLink = join(dir, 'repo-link');
      symlinkSync(repo, repoLink);
      expect((await run(stdinWith({ ...CODEX_INPUT, cwd: wt }), { repo: repoLink })).code).toBe(2);
      expect(seen).toHaveLength(2);
      expect(codexCallInWorktrees(join(repo, 'src'), repoLink)).toBe(false);
      expect(codexCallInWorktrees(join(repoLink, '.worktrees', 'x'), repo)).toBe(true);
    });

    test("end to end: the daemon's gate script runs the real CLI with --repo", async () => {
      const { repo, wt } = layout();
      const script = join(dir, 'agile-pre-tool-use.sh');
      writeFileSync(
        script,
        renderCodexGateScript({
          agileBin: `${shellQuote(process.execPath)} ${shellQuote(CLI_ENTRY)}`,
          socketPath: join(dir, 'no-daemon.sock'),
          repoRoot: repo,
        }),
      );
      chmodSync(script, 0o755);
      const runScript = async (cwd: string) => {
        const proc = Bun.spawn([script], {
          stdin: Buffer.from(JSON.stringify({ ...CODEX_INPUT, cwd })),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { code: await proc.exited, stdout, stderr };
      };
      // The operator's own Codex at the repo root: allowed with no daemon running.
      expect(await runScript(repo)).toEqual({ code: 0, stdout: '', stderr: '' });
      // A node's worktree: gated, and with no daemon, blocked.
      const inside = await runScript(join(wt, 'src'));
      expect(inside.code).toBe(2);
      expect(inside.stdout).toBe('');
      expect(inside.stderr).toContain('AGILE-GATE: agile daemon unreachable');
    }, 20_000);

    test('parses --repo with --vendor codex only', () => {
      expect(
        parseHookArgs(parseArgs(['pre-tool-use', '--vendor', 'codex', '--repo', '/r'])),
      ).toEqual({
        event: 'pre-tool-use',
        failClosed: true,
        timeoutMs: undefined,
        vendor: 'codex',
        repo: '/r',
      });
      expect(() => parseHookArgs(parseArgs(['pre-tool-use', '--repo', '/r']))).toThrow(
        /--repo <root> goes with pre-tool-use --vendor codex/,
      );
      expect(() => parseHookArgs(parseArgs(['stop', '--vendor', 'codex', '--repo', '/r']))).toThrow(
        /--repo <root> goes with/,
      );
    });
  });
});
