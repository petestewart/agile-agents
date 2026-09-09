import { describe, expect, test } from 'bun:test';
import type { CommandAtom } from './command';
import {
  hasRedirectionOrTee,
  hasUnresolvedRedirection,
  hasUnsafeShellConstruct,
  hasWritingRedirectionOrTee,
  isBenignRedirectTarget,
  isBranchDelete,
  isForcePush,
  isNewDependencyInstall,
  isPipedIntoBareShell,
  isTicketBranch,
  parseCommandIntoAtoms,
  parseGitInvocation,
  pushRefspecs,
  redirectionTarget,
  redirectionTargets,
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

describe('hasRedirectionOrTee / redirectionTarget / redirectionTargets', () => {
  test('detects tee and > / >> as their own token or fused onto the target', () => {
    expect(hasRedirectionOrTee(['cat', 'evil', '>', 'out.txt'])).toBe(true);
    expect(hasRedirectionOrTee(['cat', 'evil', '>out.txt'])).toBe(true);
    expect(hasRedirectionOrTee(['echo', 'x', '>>', 'out.txt'])).toBe(true);
    expect(hasRedirectionOrTee(['curl', 'x', 'tee', 'out.txt'])).toBe(true);
    expect(hasRedirectionOrTee(['npm', 'test'])).toBe(false);
  });

  test('detects fd-prefixed and combined forms (review round 2, opus R2-1): 1>, 2>, &>, >|, <>, 2>>', () => {
    for (const tokens of [
      ['cat', 'f', '1>', 'g'],
      ['cat', 'f', '1>g'],
      ['cat', 'f', '2>', 'g'],
      ['cat', 'f', '&>', 'g'],
      ['cat', 'f', '&>g'],
      ['echo', 'x', '&>>', 'g'],
      ['echo', 'x', '2>>', 'g'],
      ['cmd', '>|', 'g'],
      ['cmd', '<>', 'g'],
    ]) {
      expect(hasRedirectionOrTee(tokens)).toBe(true);
    }
  });

  test('a bare "&" (background job operator) is not mistaken for a redirection', () => {
    expect(hasRedirectionOrTee(['npm', 'test', '&'])).toBe(false);
  });

  test('extracts the redirection target, including fd-prefixed/fused forms', () => {
    expect(redirectionTarget(['cat', 'evil', '>', 'out.txt'])).toBe('out.txt');
    expect(redirectionTarget(['cat', 'evil', '>out.txt'])).toBe('out.txt');
    expect(redirectionTarget(['cat', 'evil', '1>', 'out.txt'])).toBe('out.txt');
    expect(redirectionTarget(['npm', 'run', 'build', '1>/etc/x'])).toBe('/etc/x');
    expect(redirectionTarget(['cat', 'evil', '&>', 'out.txt'])).toBe('out.txt');
  });

  test('redirectionTargets collects every target, not just the first (opus "newly visible" finding)', () => {
    expect(redirectionTargets(['cmd', '>', 'a.txt', '2>', 'b.txt'])).toEqual(['a.txt', 'b.txt']);
  });

  test('a bare fd-duplication (2>&1) has no real target, and is not mistaken for one', () => {
    expect(hasRedirectionOrTee(['cmd', '2>&1'])).toBe(true);
    expect(redirectionTargets(['cmd', '2>&1'])).toEqual([]);
  });
});

describe('isBenignRedirectTarget (T029)', () => {
  test('recognizes /dev/null and fd-dup/fd-close forms', () => {
    expect(isBenignRedirectTarget('/dev/null')).toBe(true);
    expect(isBenignRedirectTarget('&1')).toBe(true);
    expect(isBenignRedirectTarget('&2')).toBe(true);
    expect(isBenignRedirectTarget('&10')).toBe(true);
    expect(isBenignRedirectTarget('&-')).toBe(true);
  });

  test('a real file path, or no target at all, is not benign', () => {
    expect(isBenignRedirectTarget('out.log')).toBe(false);
    expect(isBenignRedirectTarget('/dev/nullish')).toBe(false);
    expect(isBenignRedirectTarget('&')).toBe(false);
    expect(isBenignRedirectTarget(undefined)).toBe(false);
  });
});

describe('redirectionTargets / hasWritingRedirectionOrTee — benign forms excluded (T029)', () => {
  test('benign redirect tokens have no non-benign target and are not a writing redirection', () => {
    for (const tokens of [
      ['cmd', '2>&1'],
      ['cmd', '2>/dev/null'],
      ['cmd', '>/dev/null'],
      ['cmd', '&>/dev/null'],
      ['cmd', '&>>/dev/null'],
      ['cmd', '1>&2'],
      ['cmd', '2>&-'],
    ]) {
      expect(redirectionTargets(tokens)).toEqual([]);
      expect(hasWritingRedirectionOrTee(tokens)).toBe(false);
      // still recognized as *touching* redirection syntax, per the narrower helper
      expect(hasRedirectionOrTee(tokens)).toBe(true);
    }
  });

  test('a real file-target redirect is unaffected: still a target, still a writing redirection', () => {
    expect(redirectionTargets(['cmd', '>', 'out.txt'])).toEqual(['out.txt']);
    expect(hasWritingRedirectionOrTee(['cmd', '>', 'out.txt'])).toBe(true);
    expect(redirectionTargets(['cmd', '2>', 'err.log'])).toEqual(['err.log']);
    expect(hasWritingRedirectionOrTee(['cmd', '2>', 'err.log'])).toBe(true);
  });

  test('a mix of a benign and a real target keeps only the real one', () => {
    expect(redirectionTargets(['cmd', '2>&1', '1>', 'out.log'])).toEqual(['out.log']);
    expect(hasWritingRedirectionOrTee(['cmd', '2>&1', '1>', 'out.log'])).toBe(true);
  });

  test('tee and process substitution are still writing redirections regardless of any benign target present', () => {
    expect(hasWritingRedirectionOrTee(['cmd', '2>&1', '|', 'tee', 'out.log'])).toBe(true);
    expect(hasWritingRedirectionOrTee(['diff', '<(cmd)', '2>&1'])).toBe(true);
  });

  test('an unresolved redirect (nothing after the operator) is not benign', () => {
    expect(hasUnresolvedRedirection(['cmd', '>'])).toBe(true);
    expect(hasWritingRedirectionOrTee(['cmd', '>'])).toBe(true);
    expect(hasUnresolvedRedirection(['cmd', '2>&1'])).toBe(false);
  });

  test('a bare input redirect (<file) is invisible to redirection detection entirely — it is a read', () => {
    expect(hasRedirectionOrTee(['cat', '<', 'notes.txt'])).toBe(false);
    expect(hasWritingRedirectionOrTee(['cat', '<', 'notes.txt'])).toBe(false);
    expect(hasRedirectionOrTee(['cat', '<notes.txt'])).toBe(false);
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
