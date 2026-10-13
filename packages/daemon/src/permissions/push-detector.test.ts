/**
 * T143's acceptance criterion: a table-driven test of ≥ 30 command strings
 * over the `no_push_protected` detector (cockpit design §5.4, D8, D11),
 * including every evasion form the design names.
 *
 * Written before the detector itself. The three outcomes are `allow`,
 * `deny` (a protected-branch write the detector positively identified) and
 * `unknown` (a command whose git subcommand the detector cannot read — a
 * deny too, but with the fail-closed reason, which is a different claim).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANNOT_DETERMINE_REASON,
  type GitAliasValue,
  type PushDetectorContext,
  detectProtectedBranchWrite,
  detectPush,
  readGitAlias,
  worktreeGitAliases,
} from './push-detector';

const PROTECTED = ['main', 'master'];

function ctx(overrides: Partial<PushDetectorContext> = {}): PushDetectorContext {
  return {
    protectedBranches: PROTECTED,
    upstream: () => 'origin/T143-builtin-pattern-rules',
    head: () => 'T143-builtin-pattern-rules',
    ...overrides,
  };
}

type Expectation = 'allow' | 'deny' | 'unknown';

interface Row {
  command: string;
  expect: Expectation;
  /** Non-default context for this row (an unresolvable upstream, a protected HEAD, …). */
  context?: Partial<PushDetectorContext>;
  why: string;
}

const ROWS: Row[] = [
  // --- plain pushes -------------------------------------------------------
  { command: 'git push origin main', expect: 'deny', why: 'the base case' },
  { command: 'git push origin master', expect: 'deny', why: 'master is protected too (D8)' },
  {
    command: 'git push origin T143-builtin-pattern-rules',
    expect: 'allow',
    why: 'an explicitly named non-protected branch is allowed (D7)',
  },
  {
    command: 'git push -u origin T143-builtin-pattern-rules',
    expect: 'allow',
    why: '-u does not change the refspec',
  },
  { command: 'git push -u origin main', expect: 'deny', why: 'nor does it launder one' },
  {
    command: 'git push origin T143-x main',
    expect: 'deny',
    why: 'every refspec is checked, not just the first',
  },

  // --- refspec spellings --------------------------------------------------
  { command: 'git push origin HEAD:main', expect: 'deny', why: 'the protected name is the dest' },
  {
    command: 'git push origin main:T143-x',
    expect: 'allow',
    why: 'main on the LEFT is a source, not a destination',
  },
  {
    command: 'git push origin +main',
    expect: 'deny',
    why: 'the + force shorthand still names main',
  },
  {
    command: 'git push origin refs/heads/main',
    expect: 'deny',
    why: 'the fully-qualified ref ends in the protected name',
  },
  {
    command: 'git push origin HEAD:refs/heads/master',
    expect: 'deny',
    why: 'qualified on the right-hand side',
  },
  { command: 'git push --all origin', expect: 'deny', why: '--all reaches every branch' },
  { command: 'git push --mirror origin', expect: 'deny', why: '--mirror reaches every ref' },
  {
    command: 'git push --delete origin main',
    expect: 'deny',
    why: 'deleting main is a write to main',
  },

  // --- bare push: resolved against the upstream ---------------------------
  {
    command: 'git push',
    expect: 'allow',
    why: 'the upstream resolves to a non-protected branch',
  },
  {
    command: 'git push',
    expect: 'deny',
    context: { upstream: () => 'origin/main' },
    why: 'the upstream resolves to main',
  },
  {
    command: 'git push origin',
    expect: 'deny',
    context: { upstream: () => 'origin/master' },
    why: 'a remote with no refspec is still the upstream branch',
  },
  {
    command: 'git push',
    expect: 'deny',
    context: { upstream: () => undefined },
    why: 'an unresolvable upstream denies (§5.4)',
  },
  {
    command: 'git push',
    expect: 'deny',
    context: { upstream: () => 'main' },
    why: 'an upstream with no remote prefix is compared as-is',
  },

  // --- HEAD as a destination (T143 review finding 1) ---------------------
  {
    command: 'git push origin HEAD',
    expect: 'deny',
    context: { head: () => 'main' },
    why: 'HEAD pushes the checked-out branch to its same-named remote ref',
  },
  {
    command: 'git push origin HEAD',
    expect: 'allow',
    why: 'on the ticket branch, HEAD is the ticket branch',
  },
  {
    command: 'git push origin @',
    expect: 'deny',
    context: { head: () => 'master' },
    why: '@ is the same spelling',
  },
  {
    command: 'git push origin HEAD',
    expect: 'deny',
    context: { head: () => undefined },
    why: 'a detached or unreadable HEAD cannot be shown to be safe',
  },
  {
    command: 'git push -u origin HEAD',
    expect: 'deny',
    context: { head: () => 'main' },
    why: '-u does not change what HEAD resolves to',
  },

  // --- reaching a push without the `push` subcommand (review finding 2) --
  {
    command: 'git -c alias.p=push p origin main',
    expect: 'unknown',
    why: 'an alias redefines the subcommand token',
  },
  {
    command: 'git -c alias.p=push p origin T143-x',
    expect: 'unknown',
    why: 'fail closed even when the branch looks fine — the alias is unreadable',
  },
  {
    command: 'git -c alias.co=checkout co main',
    expect: 'unknown',
    why: 'any alias override at all, not just a push one',
  },
  {
    command: 'git send-pack origin refs/heads/x:refs/heads/main',
    expect: 'unknown',
    why: 'the plumbing push is built on',
  },
  {
    command: 'git http-push https://x refs/heads/main',
    expect: 'unknown',
    why: 'the dumb-HTTP twin',
  },
  {
    command: 'git remote-ext origin',
    expect: 'unknown',
    why: 'a transport helper invoked directly',
  },
  {
    command: 'git -c core.pager=cat push origin T143-x',
    expect: 'allow',
    why: 'an ordinary -c override is not an alias',
  },
  {
    command: 'git remote -v',
    expect: 'allow',
    why: 'not allow-listing git: an unnamed subcommand still passes',
  },
  {
    command: 'git bisect start',
    expect: 'allow',
    why: 'an unknown subcommand is ordinary work, not a fail-closed deny',
  },

  // --- anchored on the subcommand, not a substring ------------------------
  { command: 'git stash push', expect: 'allow', why: 'stash push is not a push' },
  { command: 'git stash push -m "wip on main"', expect: 'allow', why: 'nor with a message' },
  { command: 'git log --grep push', expect: 'allow', why: 'a log search for the word push' },
  { command: 'git log --grep "push origin main"', expect: 'allow', why: 'even spelled in full' },
  { command: 'git commit -m "no push to main yet"', expect: 'allow', why: 'a commit message' },
  { command: 'echo git push origin main', expect: 'allow', why: 'echo is not git' },
  { command: 'git status', expect: 'allow', why: 'an ordinary read' },

  // --- -c / -C / global option prefixes ----------------------------------
  { command: 'git -C /tmp/repo push origin main', expect: 'deny', why: '-C prefix skipped' },
  {
    command: 'git -C /tmp/repo push origin T143-x',
    expect: 'allow',
    why: '-C alone is not the offence',
  },
  {
    command: 'git -c user.name=x push origin main',
    expect: 'deny',
    why: '-c k=v prefix skipped',
  },
  {
    command: 'git --no-pager -c core.pager=cat push origin master',
    expect: 'deny',
    why: 'several global options before the subcommand',
  },
  {
    command: 'git -C /tmp/repo -c push.default=simple push origin main',
    expect: 'deny',
    why: '-C and -c together',
  },

  // --- chains, subshells and pipe glue ------------------------------------
  {
    command: 'git status && git push origin main',
    expect: 'deny',
    why: '&& chains are tokenised, not scanned',
  },
  { command: 'git add -A ; git push origin master', expect: 'deny', why: '; chains too' },
  { command: 'git fetch || git push origin main', expect: 'deny', why: '|| chains too' },
  {
    command: 'sh -c "git push origin main"',
    expect: 'deny',
    why: 'sh -c is recursed into',
  },
  {
    command: 'bash -c "cd sub && git push origin main"',
    expect: 'deny',
    why: 'nested chain inside bash -c',
  },
  {
    command: 'git log --oneline | head -5',
    expect: 'allow',
    why: 'pipe glue around a read',
  },
  {
    command: 'FOO=1 git push origin main',
    expect: 'deny',
    why: 'env assignment prefixes are stripped',
  },
  { command: 'env git push origin main', expect: 'deny', why: 'wrapper commands too' },

  // --- obfuscated forms fail closed --------------------------------------
  { command: '$(echo git) push origin main', expect: 'unknown', why: 'command substitution' },
  { command: 'git push origin $(cat branch.txt)', expect: 'unknown', why: 'a computed refspec' },
  { command: '`echo git` push origin main', expect: 'unknown', why: 'backticks' },
  { command: 'eval "git push origin main"', expect: 'unknown', why: 'eval' },
  { command: 'git ${SUB} origin main', expect: 'unknown', why: 'a computed subcommand' },
  { command: 'git push origin "main', expect: 'unknown', why: 'unbalanced quotes' },

  // --- T516: escapes and continuations are read as bash reads them -------
  {
    command: 'echo \\"; git push origin main',
    expect: 'deny',
    why: 'an escaped quote opens no quote, so the ; separates',
  },
  { command: "echo \\'; git push origin main", expect: 'deny', why: 'nor does an escaped single' },
  {
    command: 'echo \\" && git push origin HEAD:main',
    expect: 'deny',
    why: 'and && after one',
  },
  { command: 'git push origin ma\\in', expect: 'deny', why: 'an escaped letter is the letter' },
  { command: 'git push origin \\\nmain', expect: 'deny', why: 'a continuation joins the line' },
  {
    command: "echo $'\\'' ; git push origin main ; echo ''",
    expect: 'deny',
    why: "$'\\'' is one quote mark, not a closed and an open quote",
  },
  {
    command: 'echo \\\\ "; git push origin main"',
    expect: 'allow',
    why: 'an escaped backslash escapes nothing after it: the quote is real, the push is text',
  },
  {
    command: "git push origin $'\\x6dain'",
    expect: 'unknown',
    why: "an ANSI-C refspec can't be read",
  },
  {
    command: 'echo $\\\n(git push origin main)',
    expect: 'unknown',
    why: 'a continuation inside $( is still $(',
  },

  // --- merging into a protected branch is the same act (§5.4) ------------
  {
    command: 'git checkout main && git merge T143-x',
    expect: 'deny',
    why: 'the acceptance criterion: a merge into main inside the worktree',
  },
  {
    command: 'git switch master && git merge --no-ff T143-x',
    expect: 'deny',
    why: 'git switch is the same move',
  },
  {
    command: 'git checkout T143-x && git merge origin/main',
    expect: 'allow',
    why: 'merging main INTO the ticket branch is the safe direction',
  },
  {
    command: 'git merge T143-x',
    expect: 'deny',
    context: { head: () => 'main' },
    why: 'already on main, no checkout needed',
  },
  {
    command: 'git merge T143-x',
    expect: 'allow',
    why: 'on the ticket branch, merging is ordinary work',
  },
  {
    command: 'git merge T143-x',
    expect: 'deny',
    context: { head: () => undefined },
    why: 'an unreadable HEAD cannot be shown to be safe',
  },
  {
    command: 'git checkout main',
    expect: 'allow',
    why: 'checking main out writes nothing to it',
  },
];

describe('no_push_protected detector', () => {
  test('the table covers at least 30 command strings', () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(30);
  });

  for (const row of ROWS) {
    const label = `${row.expect}: ${row.command} (${row.why})`;
    test(label, () => {
      const reason = detectProtectedBranchWrite(row.command, ctx(row.context));
      if (row.expect === 'allow') {
        expect(reason).toBeUndefined();
        return;
      }
      expect(reason).toBeString();
      if (row.expect === 'unknown') {
        expect(reason).toContain(CANNOT_DETERMINE_REASON);
      } else {
        expect(reason).not.toContain(CANNOT_DETERMINE_REASON);
      }
    });
  }
});

describe('no_push detector (D7: retired by default)', () => {
  test.each([
    ['git push origin T143-x', true],
    ['git push', true],
    ['git -C /tmp/repo push origin T143-x', true],
    ['git status && git push origin T143-x', true],
    ['git stash push', false],
    ['git log --grep push', false],
    ['echo push', false],
    // Fail-closed forms are denies here too (review finding 2).
    ['git -c alias.p=push p origin T143-x', true],
    ['git send-pack origin refs/heads/x:refs/heads/main', true],
    ['git http-push https://x refs/heads/main', true],
    ['git remote-ext origin', true],
    ['git bisect start', false],
  ] as const)('%s -> %p', (command, denied) => {
    const reason = detectPush(command);
    expect(reason !== undefined).toBe(denied);
  });

  test('an undeterminable command fails closed', () => {
    expect(detectPush('$(echo git) push origin main')).toContain(CANNOT_DETERMINE_REASON);
  });
});

// T525: a subcommand that isn't a builtin is read through the alias the
// worktree's config gives it, as git does (builtin first, then the alias).
describe('T525: a push through a configured git alias', () => {
  const ALIASES: Record<string, string> = {
    p: 'push',
    pf: 'push --force',
    pm: 'push origin HEAD:main',
    x: '!git push origin main',
    co: 'checkout',
    a: 'b',
    b: 'push',
    l1: 'l2',
    l2: 'l1',
    sp: 'send-pack',
    q: '"push" origin',
    bs: 'push origin feature\\x',
    empty: '',
    opts: '--no-pager',
    // Shadowed by the builtin: git never runs it, so neither is it read.
    status: 'push origin main',
  };

  /** A lookup like git's: alias names ignore case. */
  function lookup(name: string): GitAliasValue {
    const value = ALIASES[name.toLowerCase()];
    return value === undefined ? 'unset' : { expansion: value };
  }

  function aliasCtx(overrides: Partial<PushDetectorContext> = {}): PushDetectorContext {
    return ctx({ alias: lookup, ...overrides });
  }

  const ALIAS_ROWS: Row[] = [
    { command: 'git p origin main', expect: 'deny', why: 'the acceptance criterion' },
    { command: 'git p origin T143-x', expect: 'allow', why: 'a non-protected branch, as for push' },
    { command: 'git P origin main', expect: 'deny', why: 'alias names ignore case' },
    { command: 'git pm', expect: 'deny', why: 'the alias names the refspec HEAD:main' },
    {
      command: 'git p',
      expect: 'deny',
      context: { upstream: () => 'origin/main' },
      why: 'no refspec: the upstream is main',
    },
    { command: 'git p', expect: 'allow', why: 'no refspec: the upstream is the ticket branch' },
    { command: 'git -C /tmp/repo p origin main', expect: 'deny', why: '-C prefix skipped' },
    { command: 'git -c user.name=x p origin main', expect: 'deny', why: '-c k=v prefix skipped' },
    { command: 'git -c user.name=x p origin T143-x', expect: 'allow', why: 'and not an offence' },
    { command: 'git --no-pager p origin master', expect: 'deny', why: 'a global option first' },
    { command: 'git q main', expect: 'deny', why: 'a quoted word in the alias value' },
    { command: 'git a origin main', expect: 'deny', why: 'an alias naming another alias' },
    { command: 'sh -c "git p origin main"', expect: 'deny', why: 'sh -c is recursed into' },
    {
      command: 'git co main && git merge T143-x',
      expect: 'deny',
      why: 'checkout through an alias still moves HEAD',
    },
    { command: 'git status', expect: 'allow', why: 'a builtin: alias.status is never run' },
    { command: 'git zz origin main', expect: 'allow', why: 'no such alias: not a push' },
    { command: 'git x', expect: 'unknown', why: 'a ! alias is a shell command' },
    { command: 'git l1', expect: 'unknown', why: 'an alias loop' },
    { command: 'git sp origin x:main', expect: 'unknown', why: 'push plumbing through an alias' },
    {
      command: 'git bs',
      expect: 'unknown',
      why: 'a backslash escape the tokenizer does not model',
    },
    { command: 'git empty origin main', expect: 'unknown', why: 'an empty alias names nothing' },
    { command: 'git opts push origin main', expect: 'unknown', why: 'nor one of options only' },
    {
      command: 'git Push origin main',
      expect: 'unknown',
      why: 'a builtin in another case runs the builtin on a case-insensitive filesystem',
    },
    {
      command: 'git p.q origin main',
      expect: 'unknown',
      why: 'an alias subsection git matches ignoring case',
    },
    {
      command: 'git --git-dir=/x/.git p origin T143-x',
      expect: 'unknown',
      why: "another repo's aliases",
    },
    {
      command: 'HOME=. git p origin T143-x',
      expect: 'unknown',
      why: 'a global config the agent may have written',
    },
    {
      command: 'HOME=.; git p origin T143-x',
      expect: 'unknown',
      why: 'a bare assignment moves it for every later command',
    },
    {
      command: 'HOME=. git push origin T143-x',
      expect: 'allow',
      why: 'a builtin reads no alias, wherever the config is',
    },
    {
      command: 'git --config-env alias.zz=V zz origin T143-x',
      expect: 'unknown',
      why: '--config-env defines an alias as -c does',
    },
    {
      command: 'git --config-env=alias.zz=V zz origin T143-x',
      expect: 'unknown',
      why: 'in either form',
    },
    {
      command: 'git -c include.path=/tmp/aliases zz origin T143-x',
      expect: 'unknown',
      why: 'an included file can define one',
    },
    {
      command: 'git p origin main',
      expect: 'unknown',
      context: { alias: () => 'failed' },
      why: 'a lookup that failed',
    },
    {
      command: 'git p origin T143-x',
      expect: 'unknown',
      context: { alias: undefined },
      why: 'no lookup wired: fail closed',
    },
  ];

  for (const row of ALIAS_ROWS) {
    test(`${row.expect}: ${row.command} (${row.why})`, () => {
      const reason = detectProtectedBranchWrite(row.command, aliasCtx(row.context));
      if (row.expect === 'allow') {
        expect(reason).toBeUndefined();
        return;
      }
      expect(reason).toBeString();
      if (row.expect === 'unknown') expect(reason).toContain(CANNOT_DETERMINE_REASON);
      else expect(reason).not.toContain(CANNOT_DETERMINE_REASON);
    });
  }

  test('the shell alias reason names it and says what to do instead', () => {
    expect(detectProtectedBranchWrite('git x', aliasCtx())).toContain(
      'git alias `x` runs a shell command (`!git push origin main`): run what it stands for directly',
    );
  });

  test.each([
    ['git p origin T143-x', true],
    ['git a origin T143-x', true],
    ['git x', true],
    ['git co main', false],
    ['git status', false],
  ] as const)('no_push: %s -> %p', (command, denied) => {
    expect(detectPush(command, lookup) !== undefined).toBe(denied);
  });

  test('a builtin spawns no lookup; an alias name is looked up once per worktree', () => {
    const reads: string[] = [];
    const aliases = worktreeGitAliases('/wt', (_cwd, name) => {
      reads.push(name);
      return lookup(name);
    });
    const context = aliasCtx({ alias: aliases });
    for (const command of [
      'git status',
      'git log --oneline -5 && git diff',
      'git push origin T143-x',
      'git -C /tmp/repo commit -m x',
      'git checkout -b T143-y',
    ]) {
      detectProtectedBranchWrite(command, context);
      detectPush(command, aliases);
    }
    expect(reads).toEqual([]);

    detectProtectedBranchWrite('git p origin T143-x && git p origin T143-y', context);
    detectProtectedBranchWrite('git P origin T143-x', context);
    detectPush('git p origin T143-x', aliases);
    expect(reads).toEqual(['p']);
  });
});

// T525: the lookup itself, against a real repo's git config.
describe('T525: readGitAlias reads the config git would', () => {
  let repo: string;
  let home: string;

  function git(args: string[], cwd = repo): void {
    const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'agile-alias-'));
    home = mkdtempSync(join(tmpdir(), 'agile-alias-home-'));
    git(['init', '-q', '-b', 'main']);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  /** Only a fake `HOME` for the global config: nothing of the developer's leaks in. */
  function env(): Record<string, string> {
    return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  }

  test("the repo's alias, its value exactly, and unset", () => {
    git(['config', 'alias.pf', 'push --force']);
    git(['config', 'alias.x', '!git push origin main']);
    expect(readGitAlias(repo, 'pf', env())).toEqual({ expansion: 'push --force' });
    expect(readGitAlias(repo, 'x', env())).toEqual({ expansion: '!git push origin main' });
    expect(readGitAlias(repo, 'PF', env())).toEqual({ expansion: 'push --force' });
    expect(readGitAlias(repo, 'nope', env())).toBe('unset');
  });

  test('an alias only in the global config, and one in an included file', () => {
    writeFileSync(join(home, '.gitconfig'), '[alias]\n\tgp = push\n');
    const included = join(home, 'aliases.inc');
    writeFileSync(included, '[alias]\n\tip = push origin main\n');
    git(['config', 'include.path', included]);
    expect(readGitAlias(repo, 'gp', env())).toEqual({ expansion: 'push' });
    expect(readGitAlias(repo, 'ip', env())).toEqual({ expansion: 'push origin main' });
  });

  test('a lookup that cannot run fails, never reads as unset', () => {
    expect(readGitAlias(join(repo, 'gone'), 'p', env())).toBe('failed');
    writeFileSync(join(repo, '.git', 'config'), '[alias\n');
    expect(readGitAlias(repo, 'p', env())).toBe('failed');
  });
});
