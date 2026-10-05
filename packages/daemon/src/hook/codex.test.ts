/**
 * T506: Codex's own PreToolUse gate (`codex.ts`). T512: the gate script in
 * the agile home, `install-gate`'s merge into `$CODEX_HOME/hooks.json`, the
 * start check of its entries and their per-hook trust, the legacy sweep, and
 * which calls the CLI gates; T506's project trust read of
 * `$CODEX_HOME/config.toml`, the input translation, and
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
  readdirSync,
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
  CODEX_GATE_MISSING_LEAD,
  CODEX_GATE_UNTRUSTED_LEAD,
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
  codexCallGated,
  codexGateRefusal,
  codexGateStatus,
  codexHomeDir,
  codexToClaudePayload,
  codexTrustFor,
  codexTrustTarget,
  codexUntrustedMessage,
  installCodexGate,
  patchPaths,
  renderCodexGateScript,
  sweepLegacyCodexHooks,
  writeCodexGateScript,
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

/** A Codex home with Codex's own trust records for `slots` (`i:j` of `PreToolUse`) of its `hooks.json`. */
function trustSlots(codexHome: string, slots: string[], hooksPath = join(codexHome, 'hooks.json')) {
  const toml = slots
    .map(
      (slot) =>
        `[hooks.state.${JSON.stringify(`${hooksPath}:pre_tool_use:${slot}`)}]\ntrusted_hash = "sha256:${'ab'.repeat(16)}"\n`,
    )
    .join('\n');
  writeFileSync(join(codexHome, 'config.toml'), `model = "gpt-5.5"\n${toml}`);
}

const GATE = (home: string) =>
  CODEX_HOOK_MATCHERS.map((matcher) => ({
    matcher,
    hooks: [
      {
        type: 'command',
        command: join(home, 'agile-pre-tool-use.sh'),
        statusMessage: 'agile gate',
      },
    ],
  }));

describe('T512: the gate script in the agile home', () => {
  test('renders the CLI with --home and every repo root, quoted, sorted once; exit 2 if it cannot run', () => {
    const body = renderCodexGateScript({
      agileBin: 'agile',
      socketPath: '/tmp/agile s.sock',
      home: '/h/agile home',
      repoRoots: ['/r/b', "/r/it's a", '/r/b'],
    });
    expect(body.startsWith('#!/bin/sh\n')).toBe(true);
    expect(body.trimEnd().split('\n').at(-1)).toBe(
      "AGILE_SOCKET_PATH='/tmp/agile s.sock' agile hook pre-tool-use --vendor codex --home '/h/agile home' --repo /r/b --repo '/r/it'\\''s a' || exit 2",
    );
    // No session id in the file: every Codex session shares it.
    expect(body).not.toContain('AGILE_AGENT');
    // The same set in another order is the same bytes.
    expect(
      renderCodexGateScript({
        agileBin: 'agile',
        socketPath: '/tmp/agile s.sock',
        home: '/h/agile home',
        repoRoots: ["/r/it's a", '/r/b'],
      }),
    ).toBe(body);
    // No repo registered: the home only.
    expect(renderCodexGateScript({ agileBin: 'agile', home: '/h', repoRoots: [] })).toContain(
      '\nagile hook pre-tool-use --vendor codex --home /h || exit 2\n',
    );
  });

  test('the script runs: stdin and every argument reach the CLI, and a CLI that cannot run exits 2', () => {
    const fake = join(dir, 'fake-agile');
    writeFileSync(
      fake,
      `#!/bin/sh\ncat > ${join(dir, 'stdin.json')}\nprintf '%s\\n' "$AGILE_SOCKET_PATH" "$@" > ${join(dir, 'argv.txt')}\nexit 0\n`,
    );
    chmodSync(fake, 0o755);
    const script = join(dir, 'gate.sh');
    writeFileSync(
      script,
      renderCodexGateScript({
        agileBin: fake,
        socketPath: '/s.sock',
        home: '/h',
        repoRoots: ['/r/a,b', "/r/it's here"],
      }),
    );
    chmodSync(script, 0o755);
    const ok = Bun.spawnSync([script], { stdin: Buffer.from('{"tool_name":"Bash"}') });
    expect(ok.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'stdin.json'), 'utf8')).toBe('{"tool_name":"Bash"}');
    expect(readFileSync(join(dir, 'argv.txt'), 'utf8').trim().split('\n')).toEqual([
      '/s.sock',
      'hook',
      'pre-tool-use',
      '--vendor',
      'codex',
      '--home',
      '/h',
      '--repo',
      '/r/a,b',
      '--repo',
      "/r/it's here",
    ]);
    // Codex runs a call whose hook exited with anything but 2: a missing CLI must block.
    writeFileSync(
      script,
      renderCodexGateScript({ agileBin: join(dir, 'missing-agile'), home: '/h', repoRoots: [] }),
    );
    const missing = Bun.spawnSync([script], { stdin: Buffer.from('{}'), stderr: 'pipe' });
    expect(missing.exitCode).toBe(2);
  });

  test('written into the home, 0755, only when it changed (an unchanged file is never rewritten)', () => {
    const home = join(dir, 'home');
    mkdirSync(home);
    const options = { agileBin: 'agile', socketPath: '/s.sock', home, repoRoots: ['/r'] };
    const first = writeCodexGateScript(options);
    expect(first).toEqual({ path: join(home, 'agile-pre-tool-use.sh'), changed: true });
    expect(statSync(first.path).mode & 0o777).toBe(0o755);
    const inode = statSync(first.path).ino;
    expect(writeCodexGateScript(options).changed).toBe(false);
    expect(statSync(first.path).ino).toBe(inode);
    // A new repo (or CLI path, or socket) is picked up: renamed into place.
    expect(writeCodexGateScript({ ...options, repoRoots: ['/r', '/s'] }).changed).toBe(true);
    expect(readFileSync(first.path, 'utf8')).toContain('--repo /r --repo /s || exit 2');
    expect(statSync(first.path).mode & 0o777).toBe(0o755);
    expect(readdirSync(home)).toEqual(['agile-pre-tool-use.sh']);
  });
});

describe('T512: agile codex install-gate (installCodexGate)', () => {
  function setup() {
    const home = join(dir, 'home');
    mkdirSync(home);
    const codexHome = join(dir, 'codex');
    const script = { agileBin: 'agile', socketPath: '/s.sock', home, repoRoots: [] as string[] };
    return { home, codexHome, script, hooks: join(codexHome, 'hooks.json') };
  }

  test('fresh: creates $CODEX_HOME/hooks.json with the three entries naming the home script, and the script', () => {
    const { home, codexHome, script, hooks } = setup();
    const result = installCodexGate({ codexHome, script });
    expect(JSON.parse(readFileSync(hooks, 'utf8'))).toEqual({ hooks: { PreToolUse: GATE(home) } });
    expect(result).toMatchObject({
      hooks_path: hooks,
      hooks: 'added',
      script_path: join(home, 'agile-pre-tool-use.sh'),
      script: 'written',
      swept: [],
    });
    expect(readFileSync(join(home, 'agile-pre-tool-use.sh'), 'utf8')).toContain(
      `--vendor codex --home ${home} || exit 2`,
    );
    // Installed, not yet trusted: that is Codex's own step (/hooks).
    expect(result.status).toMatchObject({ installed: true, trusted: false });
    // Codex's config is never written.
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(false);
  });

  test('again: nothing is written (the same bytes, the same file)', () => {
    const { codexHome, script, hooks } = setup();
    installCodexGate({ codexHome, script });
    const before = readFileSync(hooks, 'utf8');
    const inode = statSync(hooks).ino;
    const again = installCodexGate({ codexHome, script });
    expect(again.hooks).toBe('unchanged');
    expect(again.script).toBe('unchanged');
    expect(readFileSync(hooks, 'utf8')).toBe(before);
    expect(statSync(hooks).ino).toBe(inode);
    expect(readdirSync(codexHome)).toEqual(['hooks.json']);
  });

  test("keeps other keys, events and someone else's matchers; an entry added after ours stays put", () => {
    const { home, codexHome, script, hooks } = setup();
    mkdirSync(codexHome);
    const theirs = { type: 'command', command: '/home/p/bin/audit.sh' };
    writeFileSync(
      hooks,
      JSON.stringify({
        mine: true,
        hooks: {
          Stop: [{ hooks: [theirs] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [theirs] }],
        },
      }),
    );
    expect(installCodexGate({ codexHome, script }).hooks).toBe('added');
    const merged = JSON.parse(readFileSync(hooks, 'utf8'));
    expect(merged.mine).toBe(true);
    expect(merged.hooks.Stop).toEqual([{ hooks: [theirs] }]);
    expect(merged.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [theirs] }, ...GATE(home)]);

    // The operator adds a matcher after ours: a re-install leaves the file
    // alone, so our entries keep their index (and Codex's trust in them).
    merged.hooks.PreToolUse.push({ matcher: 'Read', hooks: [theirs] });
    writeFileSync(hooks, JSON.stringify(merged, null, 2));
    const before = readFileSync(hooks, 'utf8');
    expect(installCodexGate({ codexHome, script }).hooks).toBe('unchanged');
    expect(readFileSync(hooks, 'utf8')).toBe(before);
  });

  test('an old entry of ours (another script path) is replaced, not doubled', () => {
    const { home, codexHome, script, hooks } = setup();
    mkdirSync(codexHome);
    writeFileSync(
      hooks,
      JSON.stringify({ hooks: { PreToolUse: GATE(join(dir, 'old-home', '.codex')) } }),
    );
    expect(installCodexGate({ codexHome, script }).hooks).toBe('added');
    expect(JSON.parse(readFileSync(hooks, 'utf8')).hooks.PreToolUse).toEqual(GATE(home));
  });

  test('a hooks.json that is not valid JSON is refused, never overwritten, and nothing else is written', () => {
    const { home, codexHome, script, hooks } = setup();
    mkdirSync(codexHome);
    writeFileSync(hooks, '{"hooks": ');
    expect(() => installCodexGate({ codexHome, script })).toThrow(
      `${hooks} isn't valid JSON; Codex's gate can't be merged into it`,
    );
    expect(readFileSync(hooks, 'utf8')).toBe('{"hooks": ');
    expect(existsSync(join(home, 'agile-pre-tool-use.sh'))).toBe(false);
    writeFileSync(hooks, '[1]');
    expect(() => installCodexGate({ codexHome, script })).toThrow("isn't a JSON object");
  });

  test('sweeps the legacy repo-root files of every repo it is given', () => {
    const { codexHome, script } = setup();
    const repo = join(dir, 'repo');
    initRepo(repo);
    mkdirSync(join(repo, '.codex'));
    writeFileSync(
      join(repo, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: GATE(join(repo, '.codex')) } }),
    );
    writeFileSync(join(repo, '.codex', 'agile-pre-tool-use.sh'), '#!/bin/sh\nexit 2\n');
    const result = installCodexGate({
      codexHome,
      script: { ...script, repoRoots: [repo] },
      sweep: [repo],
    });
    expect(result.swept).toEqual([
      {
        dir: repo,
        removed: [
          join(repo, '.codex', 'hooks.json'),
          join(repo, '.codex', 'agile-pre-tool-use.sh'),
          join(repo, '.codex'),
        ],
      },
    ]);
    expect(existsSync(join(repo, '.codex'))).toBe(false);
  });
});

describe('T512: the start check reads hooks.json and config.toml (codexGateStatus, codexGateRefusal)', () => {
  function installed(): { home: string; codexHome: string; hooks: string } {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const codexHome = join(dir, 'codex');
    installCodexGate({ codexHome, script: { agileBin: 'agile', home, repoRoots: [] } });
    return { home, codexHome, hooks: join(codexHome, 'hooks.json') };
  }

  test('missing: no hooks.json, or none of ours in it', () => {
    const home = join(dir, 'home');
    const codexHome = join(dir, 'codex');
    mkdirSync(codexHome, { recursive: true });
    const refusal = codexGateRefusal(codexHome, home);
    expect(refusal).toBe(
      `${CODEX_GATE_MISSING_LEAD} (no agile gate entries in ${join(codexHome, 'hooks.json')})`,
    );
    expect(CODEX_GATE_MISSING_LEAD).toBe(
      "Codex's gate isn't installed: run `agile codex install-gate`, then trust it in Codex (/hooks)",
    );
    expect(codexGateStatus(codexHome, home)).toEqual({
      hooks_path: join(codexHome, 'hooks.json'),
      script_path: join(home, 'agile-pre-tool-use.sh'),
      installed: false,
      trusted: false,
      entries: CODEX_HOOK_MATCHERS.map((matcher) => ({ matcher, trusted: false })),
    });
    // Someone else's hooks only, or two of our three: still missing.
    writeFileSync(
      join(codexHome, 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: GATE(home).slice(0, 2) } }),
    );
    expect(codexGateRefusal(codexHome, home)?.startsWith(CODEX_GATE_MISSING_LEAD)).toBe(true);
    // Not valid JSON: missing, and says why.
    writeFileSync(join(codexHome, 'hooks.json'), '{');
    expect(codexGateRefusal(codexHome, home)).toBe(
      `${CODEX_GATE_MISSING_LEAD} (${join(codexHome, 'hooks.json')} isn't valid JSON)`,
    );
  });

  test('untrusted: installed, but Codex holds no trusted_hash for them', () => {
    const { home, codexHome } = installed();
    expect(codexGateRefusal(codexHome, home)).toBe(`${CODEX_GATE_UNTRUSTED_LEAD} (0 of 3 trusted)`);
    expect(CODEX_GATE_UNTRUSTED_LEAD).toBe(
      "Codex's gate isn't trusted yet: in Codex run /hooks and trust the three agile gate hooks",
    );
    // A project trust alone is not a hook's trust; nor is a state entry with no hash.
    writeFileSync(
      join(codexHome, 'config.toml'),
      `[projects."/"]\ntrust_level = "trusted"\n[hooks.state.${JSON.stringify(`${join(codexHome, 'hooks.json')}:pre_tool_use:0:0`)}]\nenabled = true\n`,
    );
    expect(codexGateStatus(codexHome, home).entries.map((e) => e.trusted)).toEqual([
      false,
      false,
      false,
    ]);
    // Not valid TOML: untrusted, never thrown.
    writeFileSync(join(codexHome, 'config.toml'), '[hooks.state.\n');
    expect(codexGateRefusal(codexHome, home)?.startsWith(CODEX_GATE_UNTRUSTED_LEAD)).toBe(true);
  });

  test('partially trusted: each entry says which; the start is still refused', () => {
    const { home, codexHome } = installed();
    trustSlots(codexHome, ['0:0', '2:0']);
    const status = codexGateStatus(codexHome, home);
    expect(status.installed).toBe(true);
    expect(status.trusted).toBe(false);
    expect(status.entries).toEqual([
      { matcher: 'Bash', index: 0, trusted: true },
      { matcher: 'apply_patch|Edit|Write', index: 1, trusted: false },
      { matcher: 'mcp__.*', index: 2, trusted: true },
    ]);
    expect(codexGateRefusal(codexHome, home)).toBe(`${CODEX_GATE_UNTRUSTED_LEAD} (2 of 3 trusted)`);
    // A hash for another slot or another file is not one of ours.
    trustSlots(codexHome, ['0:0', '1:1', '2:0']);
    expect(codexGateStatus(codexHome, home).trusted).toBe(false);
    trustSlots(codexHome, ['0:0', '1:0', '2:0'], join(dir, 'other', 'hooks.json'));
    expect(codexGateStatus(codexHome, home).trusted).toBe(false);
  });

  test('trusted: all three, by index; the hash itself is never returned', () => {
    const { home, codexHome } = installed();
    trustSlots(codexHome, ['0:0', '1:0', '2:0']);
    const status = codexGateStatus(codexHome, home);
    expect(status).toMatchObject({ installed: true, trusted: true });
    expect(codexGateRefusal(codexHome, home)).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain('sha256');
    // Read only.
    const toml = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    codexGateStatus(codexHome, home);
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(toml);
  });

  test('the path in config.toml may be the real path of a symlinked Codex home', () => {
    const { home, codexHome } = installed();
    const link = join(dir, 'codex-link');
    symlinkSync(codexHome, link);
    // Codex wrote the real path; the daemon reads through the link, and the other way round.
    trustSlots(codexHome, ['0:0', '1:0', '2:0'], join(codexHome, 'hooks.json'));
    expect(codexGateStatus(link, home).trusted).toBe(true);
    trustSlots(codexHome, ['0:0', '1:0', '2:0'], join(link, 'hooks.json'));
    expect(codexGateStatus(codexHome, home).trusted).toBe(true);
  });

  test("an entry inserted before ours moves our index: Codex's trust no longer matches", () => {
    const { home, codexHome, hooks } = installed();
    trustSlots(codexHome, ['0:0', '1:0', '2:0']);
    const file = JSON.parse(readFileSync(hooks, 'utf8'));
    file.hooks.PreToolUse.unshift({ matcher: 'Read', hooks: [{ type: 'command', command: '/x' }] });
    writeFileSync(hooks, JSON.stringify(file));
    expect(codexGateStatus(codexHome, home).entries.map((e) => e.index)).toEqual([1, 2, 3]);
    expect(codexGateRefusal(codexHome, home)).toBe(`${CODEX_GATE_UNTRUSTED_LEAD} (2 of 3 trusted)`);
  });
});

describe('T512: the legacy sweep of <repo>/.codex/', () => {
  function legacy(repo: string, file: unknown): void {
    mkdirSync(join(repo, '.codex'), { recursive: true });
    writeFileSync(join(repo, '.codex', 'hooks.json'), JSON.stringify(file));
    writeFileSync(join(repo, '.codex', 'agile-pre-tool-use.sh'), '#!/bin/sh\nexit 2\n');
  }

  test("ours go, everyone else's stay (their matchers, other events), and the script goes", () => {
    const repo = join(dir, 'repo');
    initRepo(repo);
    const theirs = { type: 'command', command: '/home/p/bin/audit.sh' };
    legacy(repo, {
      hooks: {
        Stop: [{ hooks: [theirs] }],
        PreToolUse: [
          { matcher: 'Bash', hooks: [theirs, GATE(join(repo, '.codex'))[0]?.hooks[0]] },
          ...GATE(join(repo, '.codex')),
        ],
      },
    });
    const result = sweepLegacyCodexHooks(repo);
    expect(result).toEqual({
      dir: repo,
      removed: [join(repo, '.codex', 'hooks.json'), join(repo, '.codex', 'agile-pre-tool-use.sh')],
    });
    expect(JSON.parse(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8'))).toEqual({
      hooks: { Stop: [{ hooks: [theirs] }], PreToolUse: [{ matcher: 'Bash', hooks: [theirs] }] },
    });
    expect(existsSync(join(repo, '.codex', 'agile-pre-tool-use.sh'))).toBe(false);
    // Again: nothing more to do.
    expect(sweepLegacyCodexHooks(repo)).toEqual({ dir: repo, removed: [] });
  });

  test('only ours: the file, the script and the empty .codex dir all go', () => {
    const repo = join(dir, 'repo');
    initRepo(repo);
    legacy(repo, { hooks: { PreToolUse: GATE(join(repo, '.codex')) } });
    sweepLegacyCodexHooks(repo);
    expect(existsSync(join(repo, '.codex'))).toBe(false);
  });

  test('another top-level key keeps the file; a stray file keeps the dir', () => {
    const repo = join(dir, 'repo');
    initRepo(repo);
    legacy(repo, { theirs: 1, hooks: { PreToolUse: GATE(join(repo, '.codex')) } });
    writeFileSync(join(repo, '.codex', 'notes.md'), 'mine\n');
    sweepLegacyCodexHooks(repo);
    expect(JSON.parse(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8'))).toEqual({
      theirs: 1,
      hooks: {},
    });
    expect(readdirSync(join(repo, '.codex')).sort()).toEqual(['hooks.json', 'notes.md']);
  });

  test('a hooks.json that is not valid JSON is left as it is, and the result says so', () => {
    const repo = join(dir, 'repo');
    initRepo(repo);
    mkdirSync(join(repo, '.codex'));
    writeFileSync(join(repo, '.codex', 'hooks.json'), '{"hooks": ');
    const result = sweepLegacyCodexHooks(repo);
    expect(result.left).toBe(
      `${join(repo, '.codex', 'hooks.json')} isn't valid JSON; left as it is`,
    );
    expect(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8')).toBe('{"hooks": ');
  });

  test('a tracked file is left as it is', () => {
    const repo = join(dir, 'repo');
    initRepo(repo);
    legacy(repo, { hooks: { PreToolUse: GATE(join(repo, '.codex')) } });
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'their codex dir'], repo);
    const before = readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8');
    const result = sweepLegacyCodexHooks(repo);
    expect(result.removed).toEqual([]);
    expect(result.left).toContain('is tracked by git; left as it is');
    expect(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8')).toBe(before);
    expect(existsSync(join(repo, '.codex', 'agile-pre-tool-use.sh'))).toBe(true);
  });

  test('no .codex dir: nothing to do', () => {
    expect(sweepLegacyCodexHooks(dir)).toEqual({ dir, removed: [] });
  });
});

describe('T512: which calls the CLI gates (codexCallGated)', () => {
  function layout() {
    const repo = join(dir, 'repo');
    const wt = join(repo, '.worktrees', '01ABC-csv');
    const home = join(dir, 'agile-home');
    mkdirSync(join(wt, 'src'), { recursive: true });
    mkdirSync(join(home, 'sessions', '01XYZ'), { recursive: true });
    return { repo, wt, home, scope: { repos: [join(dir, 'other'), repo], home } };
  }

  test('with --home: inside any .worktrees/ or under the home is gated; anything else is not', () => {
    const { repo, wt, home, scope } = layout();
    for (const cwd of [wt, join(wt, 'src'), home, join(home, 'sessions', '01XYZ')]) {
      expect(codexCallGated(cwd, scope)).toBe(true);
    }
    for (const cwd of [
      repo,
      join(repo, 'src'),
      join(repo, '.worktrees'),
      `${repo}/.worktreesX/a`,
      join(dir, 'elsewhere'),
      `${home}-x`,
    ]) {
      expect(codexCallGated(cwd, scope)).toBe(false);
    }
  });

  test('a missing, non-string or relative cwd is gated (fail closed)', () => {
    const { scope } = layout();
    for (const cwd of [undefined, '', 42, 'repo', './x']) {
      expect(codexCallGated(cwd, scope)).toBe(true);
    }
  });

  test('every path form: a link into a worktree or the home is gated, a repo reached by a link too', () => {
    const { repo, wt, home, scope } = layout();
    symlinkSync(wt, join(dir, 'into-wt'));
    symlinkSync(home, join(dir, 'into-home'));
    symlinkSync(repo, join(dir, 'repo-link'));
    expect(codexCallGated(join(dir, 'into-wt'), scope)).toBe(true);
    expect(codexCallGated(join(dir, 'into-home', 'sessions'), scope)).toBe(true);
    expect(codexCallGated(wt, { repos: [join(dir, 'repo-link')], home })).toBe(true);
    expect(codexCallGated(join(dir, 'repo-link', 'src'), scope)).toBe(false);
  });

  test('without --home (a T511 script): at or under <repo>/.worktrees is gated, as before', () => {
    const { repo, wt } = layout();
    expect(codexCallGated(join(repo, '.worktrees'), { repos: [repo] })).toBe(true);
    expect(codexCallGated(wt, { repos: [repo] })).toBe(true);
    expect(codexCallGated(repo, { repos: [repo] })).toBe(false);
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
