import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeGitNetworkFailure, git, gitNetwork, gitWrite, networkGitEnv, runGit } from './git';

let repoRoot: string;

function rawGit(args: string[], cwd: string): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'agile-landing-git-'));
  rawGit(['init', '-q', '-b', 'main'], repoRoot);
  rawGit(['config', 'user.email', 'test@example.com'], repoRoot);
  rawGit(['config', 'user.name', 'Test'], repoRoot);
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n');
  rawGit(['add', '-A'], repoRoot);
  rawGit(['commit', '-q', '-m', 'init'], repoRoot);
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('T034: git()/gitWrite()/runGit() spawn with a sandboxed HOME, never the real one', () => {
  test('git() run directly in repoRoot creates a sandboxed HOME under <repoRoot>/.agile-daemon-cache/git/', () => {
    runGit(['rev-parse', 'HEAD'], repoRoot, repoRoot);
    const sandboxedHome = join(repoRoot, '.agile-daemon-cache', 'git', 'home');
    expect(existsSync(sandboxedHome)).toBe(true);
  });

  test('git() run in a `.worktrees/<name>` subdirectory sandboxes under the *explicit repoRoot* passed in, not derived from cwd', () => {
    const worktreeDir = join(repoRoot, '.worktrees', 'TKT-0001');
    mkdirSync(join(repoRoot, '.worktrees'), { recursive: true });
    rawGit(['worktree', 'add', worktreeDir, '-b', 'tkt-0001', 'main'], repoRoot);

    // cwd is the worktree; repoRoot is passed explicitly and separately —
    // T034 round 2 dropped the earlier `/.worktrees/` string-heuristic in
    // favour of every caller stating its own repo root.
    const result = git(['status', '--porcelain'], worktreeDir, repoRoot);
    expect(result.exitCode).toBe(0);

    const sandboxedHome = join(repoRoot, '.agile-daemon-cache', 'git', 'home');
    expect(existsSync(sandboxedHome)).toBe(true);
    // Nothing sandboxed lands inside the worktree itself.
    expect(existsSync(join(worktreeDir, '.agile-daemon-cache'))).toBe(false);
  });

  test('an explicit repoRoot that differs from cwd is honoured exactly, not silently corrected', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'agile-landing-git-other-'));
    try {
      const result = git(['rev-parse', 'HEAD'], repoRoot, otherRoot);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(otherRoot, '.agile-daemon-cache', 'git', 'home'))).toBe(true);
      expect(existsSync(join(repoRoot, '.agile-daemon-cache'))).toBe(false);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  test('gitWrite() (rebase/merge/commit path) also sandboxes HOME, alongside the daemon author env', () => {
    const result = gitWrite(['commit', '--allow-empty', '-m', 'noop'], repoRoot, repoRoot);
    expect(result.exitCode).toBe(0);
    const sandboxedHome = join(repoRoot, '.agile-daemon-cache', 'git', 'home');
    expect(existsSync(sandboxedHome)).toBe(true);

    const author = runGit(['log', '-1', '--format=%an <%ae>'], repoRoot, repoRoot);
    expect(author).toBe('agiled <agiled@agile-agents.local>');
  });

  test('never overrides an already-set GIT_CONFIG_GLOBAL (production must not rely on it, but must not clobber it either)', () => {
    const original = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    try {
      // A plain `git()` call still succeeds with the override in place —
      // proof this module doesn't stomp on it, whatever the caller set.
      const result = git(['rev-parse', 'HEAD'], repoRoot, repoRoot);
      expect(result.exitCode).toBe(0);
    } finally {
      if (original === undefined) {
        process.env.GIT_CONFIG_GLOBAL = undefined;
      } else {
        process.env.GIT_CONFIG_GLOBAL = original;
      }
    }
  });
});

describe("T231: gitNetwork() uses the operator's real credential setup", () => {
  let realHome: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    // A fake "real HOME": its ~/.gitconfig holds the only credential helper
    // and the only insteadOf rewrite for the remote.
    realHome = mkdtempSync(join(tmpdir(), 'agile-real-home-'));
    const helper = join(realHome, 'helper.sh');
    writeFileSync(
      helper,
      '#!/bin/sh\n[ "$1" = get ] && printf "username=op\\npassword=from-real-home\\n"\nexit 0\n',
    );
    chmodSync(helper, 0o755);
    const bare = join(realHome, 'remote.git');
    rawGit(['init', '-q', '--bare', '-b', 'main', bare], realHome);
    writeFileSync(
      join(realHome, '.gitconfig'),
      [
        '[user]',
        '\tname = operator',
        '\temail = operator@example.com',
        '[credential]',
        `\thelper = ${helper}`,
        `[url "file://${bare}"]`,
        '\tinsteadOf = https://git.example.invalid/op/repo.git',
        '',
      ].join('\n'),
    );
    rawGit(['remote', 'add', 'origin', 'https://git.example.invalid/op/repo.git'], repoRoot);
    saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
    process.env.HOME = realHome;
    Reflect.deleteProperty(process.env, 'GIT_CONFIG_GLOBAL');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(realHome, { recursive: true, force: true });
  });

  test('push, ls-remote and fetch reach the remote through the real ~/.gitconfig; the sandbox does not', () => {
    const sandboxed = git(['push', 'origin', 'main:refs/heads/main'], repoRoot, repoRoot);
    expect(sandboxed.exitCode).not.toBe(0);

    const pushed = gitNetwork(['push', '-q', 'origin', 'main:refs/heads/main'], repoRoot);
    expect(pushed.stderr).toBe('');
    expect(pushed.exitCode).toBe(0);
    const head = git(['rev-parse', 'main'], repoRoot, repoRoot).stdout;
    const ls = gitNetwork(['ls-remote', 'origin', 'refs/heads/main'], repoRoot);
    expect(ls.stdout.split(/\s+/)[0]).toBe(head);
    expect(gitNetwork(['fetch', '-q', 'origin', 'main'], repoRoot).exitCode).toBe(0);
  });

  test('the credential helper configured only in the real HOME answers', () => {
    const input = new TextEncoder().encode('protocol=https\nhost=github.com\n\n');
    const fill = (env: Record<string, string | undefined>) =>
      new TextDecoder().decode(
        Bun.spawnSync(['git', 'credential', 'fill'], {
          cwd: repoRoot,
          env,
          stdin: input,
          stdout: 'pipe',
          stderr: 'pipe',
        }).stdout,
      );
    // gitNetwork's env is process.env + GIT_TERMINAL_PROMPT=0; assert the helper sees it.
    const viaNetwork = gitNetwork(['config', '--get', 'credential.helper'], repoRoot);
    expect(viaNetwork.stdout).toBe(join(realHome, 'helper.sh'));
    expect(fill({ ...process.env, GIT_TERMINAL_PROMPT: '0' })).toContain('password=from-real-home');
    const viaSandbox = git(['config', '--get', 'credential.helper'], repoRoot, repoRoot);
    expect(viaSandbox.stdout).toBe('');
  });

  test('a daemon secret never reaches a network git call', () => {
    const dump = join(realHome, 'env-names');
    const savedKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'dummy-not-a-key';
    try {
      // A shell alias sees exactly the env git (and so its helpers and hooks) got. Names only.
      const ran = gitNetwork(
        ['-c', `alias.envnames=!env | cut -d= -f1 > '${dump}'`, 'envnames'],
        repoRoot,
      );
      expect(ran.exitCode).toBe(0);
      const names = readFileSync(dump, 'utf8').split('\n');
      expect(names).not.toContain('TYPESAFE_API_KEY');
      expect(names).toContain('HOME');
      expect(names).toContain('GIT_TERMINAL_PROMPT');
      expect(networkGitEnv(process.env).HOME).toBe(realHome);
    } finally {
      if (savedKey === undefined) Reflect.deleteProperty(process.env, 'TYPESAFE_API_KEY');
      else process.env.TYPESAFE_API_KEY = savedKey;
    }
  });

  test('no credential fails fast with prompts off, and reads as one clear line', () => {
    writeFileSync(join(realHome, '.gitconfig'), '');
    const started = Date.now();
    const result = Bun.spawnSync(['git', 'credential', 'fill'], {
      cwd: repoRoot,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdin: new TextEncoder().encode('protocol=https\nhost=github.com\n\n'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(describeGitNetworkFailure(stderr, 'origin')).toContain('gh auth setup-git');
    expect(
      describeGitNetworkFailure(
        "fatal: could not read Username for 'https://github.com': Device not configured",
        'origin',
      ),
    ).toBe(
      'git has no working credentials for origin: run `gh auth setup-git` or configure a git credential helper, then retry',
    );
    expect(describeGitNetworkFailure('fatal: https://u:tok@host/x not found', 'o')).toBe(
      'fatal: https://host/x not found',
    );
  });
});
