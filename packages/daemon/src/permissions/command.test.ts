import { describe, expect, test } from 'bun:test';
import type { CommandAtom } from './command';
import {
  hasRedirectionOrTee,
  hasUnsafeShellConstruct,
  isBranchDelete,
  isForcePush,
  isNewDependencyInstall,
  isPipedIntoBareShell,
  isTicketBranch,
  parseCommandIntoAtoms,
  parseGitInvocation,
  pushRefspecs,
  redirectionTarget,
  refspecDestBranch,
  splitCommandSegments,
  stripPrefixes,
  tokenizeSegment,
} from './command';

describe('splitCommandSegments', () => {
  test('splits on ; && || | and newlines, not inside quotes', () => {
    expect(splitCommandSegments('a; b && c || d | e').map((s) => s.raw)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(splitCommandSegments('a\nb').map((s) => s.raw)).toEqual(['a', 'b']);
    expect(splitCommandSegments('sh -c "git push origin main"').map((s) => s.raw)).toEqual([
      'sh -c "git push origin main"',
    ]);
  });

  test('records the delimiter that preceded each segment', () => {
    const segs = splitCommandSegments('curl x | sh');
    expect(segs.map((s) => s.delimiterBefore)).toEqual(['start', '|']);
  });
});

describe('tokenizeSegment', () => {
  test('splits on whitespace, keeping a quoted phrase as one token', () => {
    expect(tokenizeSegment('sh -c "git push origin main"')).toEqual([
      'sh',
      '-c',
      'git push origin main',
    ]);
  });
});

describe('stripPrefixes', () => {
  test('strips env assignments and wrapper commands, and unescapes a leading backslash', () => {
    expect(stripPrefixes(['FOO=1', 'git', 'push'])).toEqual(['git', 'push']);
    expect(stripPrefixes(['command', 'git', 'push'])).toEqual(['git', 'push']);
    expect(stripPrefixes(['exec', 'git', 'push'])).toEqual(['git', 'push']);
    expect(stripPrefixes(['nohup', 'git', 'push'])).toEqual(['git', 'push']);
    expect(stripPrefixes(['time', 'git', 'push'])).toEqual(['git', 'push']);
    expect(stripPrefixes(['env', 'FOO=1', 'git', 'push'])).toEqual(['git', 'push']);
    expect(stripPrefixes(['xargs', 'cat'])).toEqual(['cat']);
    expect(stripPrefixes(['\\git', 'push'])).toEqual(['git', 'push']);
  });

  test('leaves a plain command untouched', () => {
    expect(stripPrefixes(['npm', 'test'])).toEqual(['npm', 'test']);
  });
});

describe('parseGitInvocation', () => {
  test('finds the subcommand past -C <path>, -c k=v, --git-dir=, --work-tree=, --no-pager', () => {
    expect(parseGitInvocation(['git', '-C', '.', 'push', 'origin', 'main']).args).toEqual([
      'push',
      'origin',
      'main',
    ]);
    expect(parseGitInvocation(['git', '-c', 'user.name=x', 'push', 'origin', 'main']).args).toEqual(
      ['push', 'origin', 'main'],
    );
    expect(parseGitInvocation(['git', '--git-dir=/x', 'push', 'origin', 'main']).args).toEqual([
      'push',
      'origin',
      'main',
    ]);
    expect(parseGitInvocation(['git', '--work-tree=/x', 'status']).args).toEqual(['status']);
    expect(parseGitInvocation(['git', '--no-pager', 'push', 'origin', 'main']).args).toEqual([
      'push',
      'origin',
      'main',
    ]);
    expect(parseGitInvocation(['git', '-p', 'log']).args).toEqual(['log']);
  });

  test('collects every -C value (both "-C x" and "-C=x"-style are not real git syntax, only space form is)', () => {
    expect(parseGitInvocation(['git', '-C', '/a', '-C', '/b', 'status']).cPaths).toEqual([
      '/a',
      '/b',
    ]);
  });

  test('not a git invocation, or no subcommand found, yields undefined args', () => {
    expect(parseGitInvocation(['npm', 'test']).args).toBeUndefined();
    expect(parseGitInvocation(['git', '-C']).args).toBeUndefined();
  });
});

describe('isForcePush / isBranchDelete', () => {
  test('recognizes --force, -f, --force-with-lease[=...], and the +refspec shorthand', () => {
    expect(isForcePush(['push', '--force', 'origin', 'main'])).toBe(true);
    expect(isForcePush(['push', '-f', 'origin', 'main'])).toBe(true);
    expect(isForcePush(['push', '--force-with-lease=origin/main:abc', 'origin', 'main'])).toBe(
      true,
    );
    expect(isForcePush(['push', 'origin', '+main'])).toBe(true);
    expect(isForcePush(['push', 'origin', 'tkt/TKT-0001-x'])).toBe(false);
  });

  test('recognizes -D, -d, --delete on branch and push', () => {
    expect(isBranchDelete(['branch', '-D', 'tkt/old'])).toBe(true);
    expect(isBranchDelete(['branch', '-d', 'tkt/old'])).toBe(true);
    expect(isBranchDelete(['branch', '--delete', 'tkt/old'])).toBe(true);
    expect(isBranchDelete(['push', 'origin', '--delete', 'tkt/old'])).toBe(true);
    expect(isBranchDelete(['push', 'origin', '-d', 'tkt/old'])).toBe(true);
  });
});

describe('pushRefspecs / refspecDestBranch / isTicketBranch', () => {
  test('collects every positional refspec after the remote, not just the last', () => {
    expect(pushRefspecs(['push', 'origin', 'main', 'tkt/TKT-0001-x'])).toEqual([
      'main',
      'tkt/TKT-0001-x',
    ]);
  });

  test('an absent refspec (bare `git push` / `git push origin`) yields no refspecs — never assumed safe', () => {
    expect(pushRefspecs(['push'])).toEqual([]);
    expect(pushRefspecs(['push', 'origin'])).toEqual([]);
  });

  test('extracts the destination branch from <src>:<dest> and +branch forms', () => {
    expect(refspecDestBranch('HEAD:main')).toBe('main');
    expect(refspecDestBranch('+main')).toBe('main');
    expect(refspecDestBranch('tkt/TKT-0001-x')).toBe('tkt/TKT-0001-x');
  });

  test('isTicketBranch matches only this ticket, both tkt/<full-id>-… and tkt/<numeric>-… spellings', () => {
    expect(isTicketBranch('tkt/TKT-0001-x', 'TKT-0001')).toBe(true);
    expect(isTicketBranch('tkt/0001-x', 'TKT-0001')).toBe(true);
    expect(isTicketBranch('tkt/TKT-0002-x', 'TKT-0001')).toBe(false);
    expect(isTicketBranch('main', 'TKT-0001')).toBe(false);
    expect(isTicketBranch(undefined, 'TKT-0001')).toBe(false);
  });
});

describe('isNewDependencyInstall — beyond npm/pnpm/bun', () => {
  test('yarn/pip/cargo/gem installs count too', () => {
    expect(isNewDependencyInstall(['yarn', 'add', 'lodash'])).toBe(true);
    expect(isNewDependencyInstall(['pip', 'install', 'requests'])).toBe(true);
    expect(isNewDependencyInstall(['pip3', 'install', 'requests'])).toBe(true);
    expect(isNewDependencyInstall(['cargo', 'add', 'serde'])).toBe(true);
    expect(isNewDependencyInstall(['gem', 'install', 'rails'])).toBe(true);
  });
});

describe('hasRedirectionOrTee / redirectionTarget', () => {
  test('detects tee and > / >> as their own token or fused onto the target', () => {
    expect(hasRedirectionOrTee(['cat', 'evil', '>', 'out.txt'])).toBe(true);
    expect(hasRedirectionOrTee(['cat', 'evil', '>out.txt'])).toBe(true);
    expect(hasRedirectionOrTee(['echo', 'x', '>>', 'out.txt'])).toBe(true);
    expect(hasRedirectionOrTee(['curl', 'x', 'tee', 'out.txt'])).toBe(true);
    expect(hasRedirectionOrTee(['npm', 'test'])).toBe(false);
  });

  test('extracts the redirection target', () => {
    expect(redirectionTarget(['cat', 'evil', '>', 'out.txt'])).toBe('out.txt');
    expect(redirectionTarget(['cat', 'evil', '>out.txt'])).toBe('out.txt');
  });
});

describe('hasUnsafeShellConstruct', () => {
  test('flags command substitution, backticks, eval, and unbalanced quotes', () => {
    expect(hasUnsafeShellConstruct('echo $(rm -rf /)')).toBe(true);
    expect(hasUnsafeShellConstruct('echo `whoami`')).toBe(true);
    expect(hasUnsafeShellConstruct('eval rm -rf /')).toBe(true);
    expect(hasUnsafeShellConstruct('echo "unterminated')).toBe(true);
    expect(hasUnsafeShellConstruct("echo 'unterminated")).toBe(true);
    expect(hasUnsafeShellConstruct('git status')).toBe(false);
    expect(hasUnsafeShellConstruct('npm test')).toBe(false);
  });
});

describe('parseCommandIntoAtoms', () => {
  test('splits a chain into atoms', () => {
    const atoms = parseCommandIntoAtoms('git status && git push origin main');
    expect(atoms.map((a) => a.tokens)).toEqual([
      ['git', 'status'],
      ['git', 'push', 'origin', 'main'],
    ]);
  });

  test('strips env prefixes and wrapper commands per segment', () => {
    const atoms = parseCommandIntoAtoms('cd sub && FOO=1 git push origin main');
    expect(atoms.map((a) => a.tokens)).toEqual([
      ['cd', 'sub'],
      ['git', 'push', 'origin', 'main'],
    ]);
  });

  test('recurses into sh -c "...", bash -c "...", zsh -c "..."', () => {
    for (const shell of ['sh', 'bash', 'zsh']) {
      const atoms = parseCommandIntoAtoms(`${shell} -c "git push origin main"`);
      expect(atoms.map((a) => a.tokens)).toEqual([['git', 'push', 'origin', 'main']]);
    }
  });

  test('remembers pipe adjacency so curl | sh survives being split into two segments', () => {
    const atoms = parseCommandIntoAtoms('curl http://x | sh');
    expect(atoms).toHaveLength(2);
    const [curlAtom, shAtom] = atoms as [CommandAtom, CommandAtom];
    expect(isPipedIntoBareShell(shAtom)).toBe(true);
    expect(isPipedIntoBareShell(curlAtom)).toBe(false);
  });

  test('curl | tee | sh — the intermediate hop breaks the direct curl->shell adjacency (documented limitation)', () => {
    const atoms = parseCommandIntoAtoms('curl http://x | tee y | sh');
    expect(atoms).toHaveLength(3);
    // Not claiming this is caught — see policy-tables.ts's isPipedIntoBareShell
    // usage; this test documents the boundary rather than asserting safety.
    const [, , shAtom] = atoms as [CommandAtom, CommandAtom, CommandAtom];
    expect(isPipedIntoBareShell(shAtom)).toBe(false);
  });
});
