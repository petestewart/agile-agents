/**
 * T506: Codex's own PreToolUse gate (`codex.ts`): the hooks.json writer,
 * the trust read of `$CODEX_HOME/config.toml`, the input translation, and
 * Codex's calls through the same `HookService` decision as Claude's. No
 * vendor, no network: Codex's measured input shape (spike-findings §C5) is
 * written out by hand.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentRecord,
  type KnowledgeItem,
  type RulePattern,
  ulid,
  validateKnowledgeItem,
} from '@agile-agents/shared';
import { Bus } from '../bus';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import {
  CODEX_HOOK_MATCHERS,
  CODEX_UNGATED_REASON,
  CodexGateWatch,
  HookSightings,
  codexHomeDir,
  codexToClaudePayload,
  codexTrustFor,
  codexTrustTarget,
  codexUntrustedMessage,
  patchPaths,
  renderCodexGateScript,
  writeCodexHooks,
} from './codex';
import { HookService } from './service';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'agile-codex-hook-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(['init', '-q', '-b', 'main'], path);
  git(['config', 'user.email', 'test@example.com'], path);
  git(['config', 'user.name', 'Test'], path);
  writeFileSync(join(path, 'README.md'), '# fixture\n');
  git(['add', '-A'], path);
  git(['commit', '-q', '-m', 'init'], path);
}

/** Codex's measured `PreToolUse` input (spike-findings §C5), with `tool_name`/`tool_input` varied. */
function codexInput(cwd: string, tool_name: string, tool_input: Record<string, unknown>) {
  return {
    session_id: 'codex-thread-1',
    turn_id: 'turn-1',
    transcript_path: join(cwd, 'transcript.jsonl'),
    cwd,
    hook_event_name: 'PreToolUse',
    model: 'gpt-5.5',
    permission_mode: 'default',
    tool_name,
    tool_input,
    tool_use_id: `call-${ulid()}`,
  };
}

describe('the hooks.json writer', () => {
  test('writes the gate script and PreToolUse matchers for shell, edits and MCP', () => {
    const wt = join(dir, 'wt');
    initRepo(wt);
    const written = writeCodexHooks(wt, { agileBin: 'agile', socketPath: '/tmp/agile s.sock' });

    const script = join(wt, '.codex', 'agile-pre-tool-use.sh');
    const file = JSON.parse(readFileSync(join(wt, '.codex', 'hooks.json'), 'utf8'));
    expect(file).toEqual(written);
    expect(file).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: script, statusMessage: 'agile gate' }],
          },
          {
            matcher: 'apply_patch|Edit|Write',
            hooks: [{ type: 'command', command: script, statusMessage: 'agile gate' }],
          },
          {
            matcher: 'mcp__.*',
            hooks: [{ type: 'command', command: script, statusMessage: 'agile gate' }],
          },
        ],
      },
    });
    expect(CODEX_HOOK_MATCHERS).toEqual(['Bash', 'apply_patch|Edit|Write', 'mcp__.*']);

    // The script: the socket in its env (quoted), the CLI in Codex's mode, exit 2 if it can't run.
    const body = readFileSync(script, 'utf8');
    expect(body.startsWith('#!/bin/sh\n')).toBe(true);
    expect(body).toContain(
      "AGILE_SOCKET_PATH='/tmp/agile s.sock' agile hook pre-tool-use --vendor codex || exit 2",
    );
    // No session id in the file: a worker and its reviewer share the worktree.
    expect(body).not.toContain('AGILE_AGENT');
    expect(statSync(script).mode & 0o111).not.toBe(0);
  });

  test('the script runs: stdin reaches the CLI, and a CLI that cannot run exits 2', () => {
    const fake = join(dir, 'fake-agile');
    writeFileSync(
      fake,
      `#!/bin/sh\ncat > ${join(dir, 'stdin.json')}\necho "$AGILE_SOCKET_PATH $*" > ${join(dir, 'argv.txt')}\nexit 0\n`,
    );
    chmodSync(fake, 0o755);
    const script = join(dir, 'gate.sh');
    writeFileSync(script, renderCodexGateScript({ agileBin: fake, socketPath: '/s.sock' }));
    chmodSync(script, 0o755);
    const ok = Bun.spawnSync([script], { stdin: Buffer.from('{"tool_name":"Bash"}') });
    expect(ok.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'stdin.json'), 'utf8')).toBe('{"tool_name":"Bash"}');
    expect(readFileSync(join(dir, 'argv.txt'), 'utf8').trim()).toBe(
      '/s.sock hook pre-tool-use --vendor codex',
    );

    // Codex runs a call whose hook exited with anything but 2: a missing CLI must block.
    writeFileSync(script, renderCodexGateScript({ agileBin: join(dir, 'missing-agile') }));
    const missing = Bun.spawnSync([script], { stdin: Buffer.from('{}'), stderr: 'pipe' });
    expect(missing.exitCode).toBe(2);
  });

  test('keeps other keys and events, replaces PreToolUse, is idempotent, and git-ignores .codex/', () => {
    const wt = join(dir, 'wt');
    initRepo(wt);
    mkdirSync(join(wt, '.codex'), { recursive: true });
    writeFileSync(
      join(wt, '.codex', 'hooks.json'),
      JSON.stringify({
        mine: true,
        hooks: { Stop: [{ hooks: [] }], PreToolUse: [{ matcher: 'x', hooks: [] }] },
      }),
    );
    writeCodexHooks(wt, { agileBin: 'agile' });
    const first = readFileSync(join(wt, '.codex', 'hooks.json'), 'utf8');
    const parsed = JSON.parse(first);
    expect(parsed.mine).toBe(true);
    expect(parsed.hooks.Stop).toEqual([{ hooks: [] }]);
    expect(parsed.hooks.PreToolUse.map((m: { matcher: string }) => m.matcher)).toEqual([
      ...CODEX_HOOK_MATCHERS,
    ]);
    writeCodexHooks(wt, { agileBin: 'agile' });
    expect(readFileSync(join(wt, '.codex', 'hooks.json'), 'utf8')).toBe(first);

    // Out of git status, as Claude's `.claude/` is.
    const status = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: wt, stdout: 'pipe' });
    expect(new TextDecoder().decode(status.stdout)).not.toContain('.codex');
    const exclude = readFileSync(join(wt, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line === '.codex/')).toHaveLength(1);
  });

  test('a repo that tracks .codex/hooks.json is refused, never changed', () => {
    const wt = join(dir, 'wt');
    initRepo(wt);
    mkdirSync(join(wt, '.codex'));
    writeFileSync(join(wt, '.codex', 'hooks.json'), '{"theirs":true}\n');
    git(['add', '-A'], wt);
    git(['commit', '-q', '-m', 'their hooks'], wt);
    expect(() => writeCodexHooks(wt, { agileBin: 'agile' })).toThrow(
      /tracks \.codex\/hooks\.json; Codex's gate would change a tracked file/,
    );
    expect(readFileSync(join(wt, '.codex', 'hooks.json'), 'utf8')).toBe('{"theirs":true}\n');
  });
});

describe('trust: read from Codex config.toml, never written', () => {
  function codexHome(toml: string | undefined): string {
    const home = join(dir, `codex-${ulid()}`);
    mkdirSync(home, { recursive: true });
    if (toml !== undefined) writeFileSync(join(home, 'config.toml'), toml);
    return home;
  }
  const project = (path: string, level: string) =>
    `[projects.${JSON.stringify(path)}]\ntrust_level = "${level}"\n`;

  test('the exact path, trusted', () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const home = codexHome(`model = "gpt-5.5"\n${project(repo, 'trusted')}`);
    const before = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(codexTrustFor(repo, home)).toEqual({ trusted: true, by: repo });
    // Read only.
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(before);
  });

  test('a trusted ancestor covers a worktree under it', () => {
    const wt = join(dir, 'repo', '.worktrees', '01ABC-x');
    mkdirSync(wt, { recursive: true });
    const home = codexHome(project(dir, 'trusted'));
    expect(codexTrustFor(wt, home)).toEqual({ trusted: true, by: dir });
  });

  test('an untrusted path, a sibling, or a nearer untrusted entry is not trusted', () => {
    const repo = join(dir, 'repo');
    const other = join(dir, 'other');
    mkdirSync(repo);
    mkdirSync(other);
    expect(codexTrustFor(repo, codexHome(project(repo, 'untrusted')))).toEqual({
      trusted: false,
      why: `Codex project ${repo} is not trusted`,
    });
    expect(codexTrustFor(repo, codexHome(project(other, 'trusted')))).toEqual({
      trusted: false,
      why: 'no trusted Codex project covers it',
    });
    // `/a/repo-x` is not under `/a/repo`.
    expect(codexTrustFor(`${repo}-x`, codexHome(project(repo, 'trusted'))).trusted).toBe(false);
    // The nearest entry decides: an untrusted repo under a trusted home is not trusted.
    expect(
      codexTrustFor(repo, codexHome(`${project(dir, 'trusted')}${project(repo, 'untrusted')}`))
        .trusted,
    ).toBe(false);
  });

  test('a symlinked path is compared through its real path too', () => {
    const real = join(dir, 'real');
    mkdirSync(real);
    const link = join(dir, 'link');
    symlinkSync(real, link);
    expect(codexTrustFor(link, codexHome(project(real, 'trusted'))).trusted).toBe(true);
    expect(codexTrustFor(real, codexHome(project(link, 'trusted'))).trusted).toBe(true);
  });

  test('a missing, unreadable or malformed config is not trusted, and its contents are never quoted', () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const missing = codexHome(undefined);
    expect(codexTrustFor(repo, missing)).toEqual({
      trusted: false,
      why: `no readable Codex config at ${join(missing, 'config.toml')}`,
    });
    const unreadable = codexHome(undefined);
    mkdirSync(join(unreadable, 'config.toml')); // a directory: read fails
    expect(codexTrustFor(repo, unreadable).trusted).toBe(false);
    const bad = codexHome('secret_token = "sk-abc"\n[projects.\n');
    const result = codexTrustFor(repo, bad);
    expect(result).toEqual({
      trusted: false,
      why: `${join(bad, 'config.toml')} isn't valid TOML`,
    });
    expect(JSON.stringify(result)).not.toContain('sk-abc');
    // No [projects] at all.
    expect(codexTrustFor(repo, codexHome('model = "x"\n')).trusted).toBe(false);
  });

  test('CODEX_HOME names the home when set, else ~/.codex', () => {
    expect(codexHomeDir({ CODEX_HOME: '/opt/codex' })).toBe('/opt/codex');
    expect(codexHomeDir({ CODEX_HOME: '  ' })).toBe(join(homedir(), '.codex'));
    expect(codexHomeDir({})).toBe(join(homedir(), '.codex'));
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const home = codexHome(project(repo, 'trusted'));
    expect(codexTrustFor(repo, codexHomeDir({ CODEX_HOME: home })).trusted).toBe(true);
  });

  test('the refusal names the repo a worktree belongs to', () => {
    expect(codexTrustTarget('/Users/p/code/app/.worktrees/01ABC-fix')).toBe('/Users/p/code/app');
    expect(codexTrustTarget('/Users/p/.agile/sessions/01ABC')).toBe(
      '/Users/p/.agile/sessions/01ABC',
    );
    expect(codexUntrustedMessage('/Users/p/code/app/.worktrees/01ABC-fix')).toBe(
      "Codex's gate isn't trusted here: trust /Users/p/code/app in Codex",
    );
    expect(codexUntrustedMessage('/r', 'why')).toBe(
      "Codex's gate isn't trusted here: trust /r in Codex (why)",
    );
  });
});

describe("Codex's hook input, as the payload the decision reads", () => {
  test('a shell call is Bash with its command line', () => {
    const out = codexToClaudePayload({
      ...codexInput('/w', 'Bash', { command: 'curl https://example.com' }),
      agile_vendor: 'codex',
    });
    expect(out.tool_name).toBe('Bash');
    expect(out.tool_input).toEqual({ command: 'curl https://example.com' });
    expect(out.cwd).toBe('/w');
    expect(out.agile_vendor).toBeUndefined();
    // Whether Codex reads additionalContext is unmeasured: normal messages are not folded in.
    expect(out.no_additional_context_channel).toBe(true);
    // An argv: a shell's -lc script, else the words quoted.
    expect(
      codexToClaudePayload(codexInput('/w', 'Bash', { command: ['bash', '-lc', 'ls -la'] }))
        .tool_input,
    ).toEqual({ command: 'ls -la' });
    expect(
      codexToClaudePayload(codexInput('/w', 'Bash', { command: ['git', 'commit', '-m', 'a b'] }))
        .tool_input,
    ).toEqual({ command: "git commit -m 'a b'" });
    expect(codexToClaudePayload(codexInput('/w', 'Bash', {})).tool_input).toEqual({});
  });

  const PATCH = [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '@@',
    '-old',
    '+new',
    '*** Add File: /abs/new.ts',
    '+x',
    '*** Delete File: gone.ts',
    '*** Update File: src/b.ts',
    '*** Move to: src/c.ts',
    '*** End Patch',
  ].join('\n');

  test('an apply_patch edit is Edit with every path the patch names, absolute from cwd', () => {
    expect(patchPaths(PATCH)).toEqual([
      'src/a.ts',
      '/abs/new.ts',
      'gone.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
    const out = codexToClaudePayload(codexInput('/w', 'apply_patch', { command: PATCH }));
    expect(out.tool_name).toBe('Edit');
    expect(out.codex_tool_name).toBe('apply_patch');
    expect(out.tool_input).toEqual({
      file_path: '/w/src/a.ts',
      file_paths: ['/w/src/a.ts', '/abs/new.ts', '/w/gone.ts', '/w/src/b.ts', '/w/src/c.ts'],
    });
    // The other places the unmeasured input might carry it: `input`, `patch`, an argv.
    for (const input of [{ input: PATCH }, { patch: PATCH }, { command: ['apply_patch', PATCH] }]) {
      expect(
        codexToClaudePayload(codexInput('/w', 'apply_patch', input)).tool_input?.file_path,
      ).toBe('/w/src/a.ts');
    }
    // Claude-style Edit/Write input.
    expect(
      codexToClaudePayload(codexInput('/w', 'Write', { file_path: 'x.ts', content: 'y' }))
        .tool_input,
    ).toEqual({ file_path: '/w/x.ts', file_paths: ['/w/x.ts'] });
  });

  test('an edit whose paths cannot be read is Edit with no path (denied downstream)', () => {
    for (const input of [{}, { command: 'not a patch' }, { command: 42 }]) {
      const out = codexToClaudePayload(codexInput('/w', 'apply_patch', input));
      expect(out.tool_name).toBe('Edit');
      expect(out.tool_input).toEqual({});
    }
  });

  test('an MCP tool passes as Codex named it', () => {
    const out = codexToClaudePayload(
      codexInput('/w', 'mcp__agile__progress', { session: 's', text: 'hi' }),
    );
    expect(out.tool_name).toBe('mcp__agile__progress');
    expect(out.tool_input).toEqual({ session: 's', text: 'hi' });
  });
});

describe('Codex calls through HookService: the same rules as Claude', () => {
  const SESSION = '01ARZ3NDEKTSV4RRFFQ69GC0DX';
  let store: StateStore;
  let bus: Bus;
  let repo: string;
  let worktree: string;
  let stream: string;

  function patternRule(pattern: RulePattern): KnowledgeItem {
    return validateKnowledgeItem({
      id: `K-${ulid()}`,
      kind: 'standard',
      text: 'fixture',
      scope: { kind: 'global' },
      status: 'accepted',
      enforcement: 'action',
      check: { by: 'pattern', pattern },
      critical: true,
      source: { by: 'builtin' },
      stats: {},
      created_at: new Date().toISOString(),
    });
  }

  beforeEach(async () => {
    repo = join(dir, 'repo');
    initRepo(repo);
    worktree = repo;
    const init = runInit(join(dir, 'home'));
    store = StateStore.open(init.stateRoot);
    bus = new Bus(store, init.stateRoot);
    const streams = new StreamService(store);
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    stream = (await streams.create('human', { title: 'codex', goal: 'gate me', repo: 'demo' })).id;
    const record: AgentRecord = {
      vendor: 'codex',
      model: 'gpt-5.5',
      stream,
      pid: 4242,
      role: 'worker',
      worktree,
      last_seen: new Date().toISOString(),
    };
    await store.putAgent(SESSION, record);
  });

  afterEach(async () => {
    await store.flush();
    store.close();
  });

  function service(sightings?: HookSightings): HookService {
    const secrets = patternRule({ kind: 'path_deny', args: { globs: ['**/*.pem'] } });
    return new HookService(store, bus, {
      rules: { inScope: () => [secrets], recordFired: async () => undefined },
      ...(sightings !== undefined ? { sightings } : {}),
    });
  }

  async function decide(svc: HookService, tool: string, input: Record<string, unknown>) {
    const out = await svc.preToolUse({
      ...codexInput(worktree, tool, input),
      agile_agent: SESSION,
      agile_vendor: 'codex',
    });
    return {
      decision: out.hookSpecificOutput.permissionDecision,
      reason: out.hookSpecificOutput.permissionDecisionReason ?? '',
    };
  }

  test('an edit to a protected path is denied, one inside the worktree allowed, an unknown one denied', async () => {
    const svc = service();
    const protectedEdit = await decide(svc, 'apply_patch', {
      command:
        '*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: secrets/key.pem\n+x\n*** End Patch',
    });
    expect(protectedEdit.decision).toBe('deny');
    expect(protectedEdit.reason).toContain('secrets/key.pem');
    expect(protectedEdit.reason).toContain('*.pem');

    const ok = await decide(svc, 'apply_patch', {
      command: '*** Begin Patch\n*** Update File: src/a.ts\n+y\n*** End Patch',
    });
    expect(ok.decision).toBe('allow');

    // As a Claude Edit with no file_path: the target can't be verified.
    const unknown = await decide(svc, 'apply_patch', { something: 'else' });
    expect(unknown.decision).toBe('deny');
    expect(unknown.reason).toContain('cannot verify the edit target');

    // A multi-file patch reaching outside the worktree is denied on that file.
    const outside = await decide(svc, 'apply_patch', {
      command: `*** Begin Patch\n*** Update File: src/a.ts\n*** Update File: ${join(dir, 'elsewhere.ts')}\n*** End Patch`,
    });
    expect(outside.decision).toBe('deny');
    expect(outside.reason).toContain('elsewhere.ts');
  });

  test('a network command is held (no gates wired here: denied, never allowed); a plain one passes', async () => {
    const svc = service();
    expect((await decide(svc, 'Bash', { command: 'curl https://example.com' })).decision).toBe(
      'deny',
    );
    expect((await decide(svc, 'Bash', { command: 'ls' })).decision).toBe('allow');
    // The same pattern rules: a `git -C` out of the worktree (path_deny's command half).
    expect(
      (await decide(svc, 'Bash', { command: `git -C ${join(dir, 'other')} commit -m x` })).decision,
    ).toBe('deny');
  });

  test('every call it attributes is a sighting for that session', async () => {
    const sightings = new HookSightings();
    const svc = service(sightings);
    await decide(svc, 'Bash', { command: 'ls' });
    await decide(svc, 'Bash', { command: 'curl https://example.com' });
    expect(sightings.count(SESSION)).toBe(2);
    // An unresolvable cwd is denied and attributed to no one.
    await svc.preToolUse({
      ...codexInput(join(dir, 'nowhere'), 'Bash', { command: 'ls' }),
      agile_vendor: 'codex',
    });
    expect(sightings.count(SESSION)).toBe(2);
    sightings.forget(SESSION);
    expect(sightings.count(SESSION)).toBe(0);
  });
});

describe('fail closed: calls the hook never saw', () => {
  function watch(count: () => number, onUngated: () => void, graceMs = 10) {
    return new CodexGateWatch({ session: 's', sightings: { count }, graceMs, onUngated });
  }

  test('two execute/edit calls with no hook record stop the session, once', async () => {
    let stops = 0;
    const w = watch(
      () => 0,
      () => stops++,
    );
    w.toolCall('read-1', 'read');
    w.toolCall('search-1', 'search');
    w.toolCall('exec-1', 'execute');
    await Bun.sleep(30);
    expect(stops).toBe(0);
    w.toolCall('exec-1', 'execute'); // the same call's update counts once
    await Bun.sleep(30);
    expect(stops).toBe(0);
    w.toolCall('edit-1', 'edit');
    await Bun.sleep(30);
    expect(stops).toBe(1);
    w.toolCall('exec-2', 'execute');
    await Bun.sleep(30);
    expect(stops).toBe(1);
  });

  test('calls the hook saw (records keep up) never stop it', async () => {
    let records = 0;
    let stops = 0;
    const w = watch(
      () => records,
      () => stops++,
    );
    for (let i = 0; i < 6; i++) {
      records += 1;
      w.toolCall(`exec-${i}`, i % 2 === 0 ? 'execute' : 'edit');
    }
    await Bun.sleep(30);
    expect(stops).toBe(0);
  });

  test('a record that trails its ACP report within the grace is enough', async () => {
    let records = 0;
    let stops = 0;
    const w = watch(
      () => records,
      () => stops++,
      40,
    );
    w.toolCall('a', 'execute');
    w.toolCall('b', 'execute');
    records = 2;
    await Bun.sleep(80);
    expect(stops).toBe(0);
    w.dispose();
  });

  test('the stop names the cause', () => {
    expect(CODEX_UNGATED_REASON).toBe(
      "Codex ran a command its gate never saw: its hook isn't trusted or didn't fire",
    );
  });
});

test('the default trust check reads only config.toml under the Codex home', () => {
  // The module never creates or edits it: a missing home stays missing.
  const home = join(dir, 'no-codex');
  codexTrustFor(dir, home);
  expect(existsSync(home)).toBe(false);
});
