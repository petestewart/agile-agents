import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitCommandError,
  describeGitNetworkFailure,
  git,
  gitNetwork,
  gitWrite,
  networkGitEnv,
  removeWorktreeSafely,
  runGit,
} from './git';

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
        Reflect.deleteProperty(process.env, 'GIT_CONFIG_GLOBAL');
      } else {
        process.env.GIT_CONFIG_GLOBAL = original;
      }
    }
  });
});

describe('T534: a directory that is gone is a failed result, never a throw', () => {
  test("git, gitWrite and gitNetwork answer in git's own words; runGit throws its own error", () => {
    const gone = join(repoRoot, '.worktrees', 'gone');
    const missing = `fatal: cannot change to '${gone}': No such file or directory`;
    for (const result of [
      git(['status', '--porcelain'], gone, repoRoot),
      gitWrite(['merge', '--no-edit', 'main'], gone, repoRoot),
      gitNetwork(['fetch', 'origin'], gone),
    ]) {
      expect(result).toEqual({ exitCode: 128, stdout: '', stderr: missing });
    }
    expect(() => runGit(['rev-parse', 'HEAD'], gone, repoRoot)).toThrow(GitCommandError);
    expect(existsSync(gone)).toBe(false);
  });

  test('a repo root that is gone is not made again by the sandbox', () => {
    const goneRoot = join(repoRoot, 'deleted-repo');
    expect(git(['status'], goneRoot, goneRoot).exitCode).toBe(128);
    expect(existsSync(goneRoot)).toBe(false);
  });

  test('a cwd that is a file, not a dir, fails too', () => {
    const file = join(repoRoot, 'README.md');
    const result = git(['status'], file, repoRoot);
    expect(result.exitCode).not.toBe(0);
  });

  test("removeWorktreeSafely: a worktree whose dir was deleted is dropped from git's list; its branch stays", () => {
    const wt = join(repoRoot, '.worktrees', 'deleted');
    rawGit(['worktree', 'add', '-q', '-b', 'deleted', wt, 'main'], repoRoot);
    rmSync(wt, { recursive: true, force: true });
    expect(removeWorktreeSafely(repoRoot, wt)).toEqual({ removed: true });
    expect(runGit(['worktree', 'list', '--porcelain'], repoRoot, repoRoot)).not.toContain(wt);
    expect(git(['rev-parse', '--verify', 'refs/heads/deleted'], repoRoot, repoRoot).exitCode).toBe(
      0,
    );
    // A path git never had is gone too.
    expect(removeWorktreeSafely(repoRoot, join(repoRoot, '.worktrees', 'never'))).toEqual({
      removed: true,
    });
  });
});

/** Every hook a merge, commit, checkout, ref update, push or gc can run. */
const HOOKS = [
  'pre-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-merge-commit',
  'post-merge',
  'post-checkout',
  'post-rewrite',
  'reference-transaction',
  'pre-push',
  'pre-auto-gc',
];

/** Each hook appends its name to `marker` when it runs. */
function armHooks(dir: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  for (const hook of HOOKS) {
    writeFileSync(join(dir, hook), `#!/bin/sh\necho ${hook} >> '${marker}'\n`, { mode: 0o755 });
  }
}

/** Raw git for the fixture itself: never runs a hook. */
function quietGit(args: string[], cwd: string): void {
  rawGit(['-c', 'core.hooksPath=/dev/null', ...args], cwd);
}

describe('T536: no repo hook runs on a daemon git call', () => {
  let marker: string;
  let bare: string;

  beforeEach(() => {
    marker = join(repoRoot, '..', `${repoRoot.split('/').pop()}-hooks-ran`);
    bare = mkdtempSync(join(tmpdir(), 'agile-landing-git-bare-'));
    rawGit(['init', '-q', '--bare', '-b', 'main', bare], repoRoot);
    rawGit(['remote', 'add', 'origin', bare], repoRoot);
  });

  afterEach(() => {
    rmSync(marker, { force: true });
    rmSync(bare, { recursive: true, force: true });
  });

  const ran = () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : []);

  test("hooks in the repo's git dir: worktree add, merge, commit, ref updates, reset, push, fetch", () => {
    quietGit(['checkout', '-q', '-b', 'feature'], repoRoot);
    writeFileSync(join(repoRoot, 'f.txt'), 'f\n');
    quietGit(['add', '-A'], repoRoot);
    quietGit(['commit', '-q', '-m', 'feature'], repoRoot);
    quietGit(['checkout', '-q', 'main'], repoRoot);
    armHooks(join(repoRoot, '.git', 'hooks'), marker);
    // The fixture's hooks are live: plain git runs them.
    rawGit(['update-ref', 'refs/heads/control', 'HEAD'], repoRoot);
    expect(ran()).toContain('reference-transaction');
    rmSync(marker);

    const wt = join(repoRoot, '.worktrees', 'land');
    const steps = [
      git(['worktree', 'add', '--detach', wt, 'main'], repoRoot, repoRoot),
      gitWrite(['merge', '--no-ff', '-m', 'land feature', 'feature'], wt, repoRoot),
      gitWrite(['commit', '--allow-empty', '-m', 'empty'], wt, repoRoot),
      git(['update-ref', 'refs/heads/main', 'HEAD'], wt, repoRoot),
      gitWrite(['reset', '--hard', 'main'], repoRoot, repoRoot),
      git(['branch', '-D', 'control'], repoRoot, repoRoot),
      gitNetwork(['push', '-q', 'origin', 'main'], repoRoot),
      gitNetwork(['fetch', '-q', 'origin', 'main'], repoRoot),
      git(['worktree', 'remove', wt], repoRoot, repoRoot),
    ];
    expect(steps.map((r) => r.exitCode)).toEqual(steps.map(() => 0));
    expect(runGit(['show', 'main:f.txt'], repoRoot, repoRoot)).toBe('f');
    expect(ran()).toEqual([]);
  });

  test('D4: a hook an agent commits into a tracked core.hooksPath never runs on a sync merge or a push', () => {
    quietGit(['config', 'core.hooksPath', '.githooks'], repoRoot);
    const wt = join(repoRoot, '.worktrees', 'agent');
    quietGit(['worktree', 'add', '-q', '-b', 'agent', wt, 'main'], repoRoot);
    // The agent, in its worktree, commits hooks on its own branch.
    armHooks(join(wt, '.githooks'), marker);
    quietGit(['add', '-A'], wt);
    quietGit(['commit', '-q', '-m', 'agent work'], wt);
    // Main moves on.
    writeFileSync(join(repoRoot, 'b.txt'), 'b\n');
    quietGit(['add', '-A'], repoRoot);
    quietGit(['commit', '-q', '-m', 'main moves'], repoRoot);
    rawGit(['update-ref', 'refs/heads/control', 'HEAD'], wt);
    expect(ran()).toContain('reference-transaction');
    rmSync(marker);

    // What MainSync.syncNode runs, then its push of a PR branch.
    const merge = gitWrite(['merge', '--no-edit', '-m', 'sync main', 'main'], wt, repoRoot);
    expect(merge.exitCode).toBe(0);
    expect(gitNetwork(['push', '-q', 'origin', 'HEAD:refs/heads/agent'], wt).exitCode).toBe(0);
    expect(ran()).toEqual([]);
  });

  test('a hook committed under the checkout (where an empty hooks dir could live) never runs', () => {
    const inRepo = join(repoRoot, '.agile-daemon-cache', 'git', 'no-hooks');
    armHooks(inRepo, marker);
    quietGit(['add', '-f', '-A'], repoRoot);
    quietGit(['commit', '-q', '-m', 'landed: hooks inside the checkout'], repoRoot);
    quietGit(['branch', 'feature'], repoRoot);
    rawGit(
      ['-c', `core.hooksPath=${inRepo}`, 'update-ref', 'refs/heads/control', 'HEAD'],
      repoRoot,
    );
    expect(ran()).toContain('reference-transaction');
    rmSync(marker);

    quietGit(['checkout', '-q', 'feature'], repoRoot);
    writeFileSync(join(repoRoot, 'f.txt'), 'f\n');
    quietGit(['add', '-A'], repoRoot);
    quietGit(['commit', '-q', '-m', 'feature'], repoRoot);
    quietGit(['checkout', '-q', 'main'], repoRoot);
    const merge = gitWrite(['merge', '--no-ff', '-m', 'land', 'feature'], repoRoot, repoRoot);
    expect(merge.exitCode).toBe(0);
    expect(ran()).toEqual([]);
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
