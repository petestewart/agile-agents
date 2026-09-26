/** T367: the Add repository dialog's pure half. */

import { describe, expect, test } from 'bun:test';
import {
  baseName,
  breadcrumbs,
  cleanDaemonError,
  cloneParentCandidates,
  describeCloneError,
  joinPath,
  looksLikeGithubShorthand,
  looksLikeRepoUrl,
  parentPath,
  parseRepoSource,
  remoteSlug,
  remoteWebUrl,
  sourceRemote,
  splitTypedPath,
  tildify,
} from './repos';

describe('splitTypedPath', () => {
  test('nothing typed lists home', () => {
    expect(splitTypedPath('')).toEqual({ dir: undefined, prefix: '' });
    expect(splitTypedPath('   ')).toEqual({ dir: undefined, prefix: '' });
  });

  test('~ and a trailing slash list that folder', () => {
    expect(splitTypedPath('~')).toEqual({ dir: '~', prefix: '' });
    expect(splitTypedPath('~/')).toEqual({ dir: '~', prefix: '' });
    expect(splitTypedPath('~/Projects/')).toEqual({ dir: '~/Projects', prefix: '' });
    expect(splitTypedPath('/')).toEqual({ dir: '/', prefix: '' });
    expect(splitTypedPath('/srv//')).toEqual({ dir: '/srv', prefix: '' });
  });

  test('the last segment is the autocomplete prefix', () => {
    expect(splitTypedPath('~/Pro')).toEqual({ dir: '~', prefix: 'Pro' });
    expect(splitTypedPath('/tmp')).toEqual({ dir: '/', prefix: 'tmp' });
    expect(splitTypedPath('/home/pete/Projects/sh')).toEqual({
      dir: '/home/pete/Projects',
      prefix: 'sh',
    });
  });

  test('a bare word is looked up in home', () => {
    expect(splitTypedPath('Proj')).toEqual({ dir: undefined, prefix: 'Proj' });
  });
});

describe('path helpers', () => {
  test('tildify shortens paths under home only', () => {
    expect(tildify('/home/pete', '/home/pete')).toBe('~');
    expect(tildify('/home/pete/Projects/shop', '/home/pete')).toBe('~/Projects/shop');
    expect(tildify('/home/peter/x', '/home/pete')).toBe('/home/peter/x');
    expect(tildify('/srv/x', undefined)).toBe('/srv/x');
    expect(tildify('/srv/x', '/')).toBe('/srv/x');
  });

  test('joinPath, parentPath, baseName', () => {
    expect(joinPath('/', 'tmp')).toBe('/tmp');
    expect(joinPath('/home/pete', 'x')).toBe('/home/pete/x');
    expect(parentPath('/home/pete/x')).toBe('/home/pete');
    expect(parentPath('/tmp')).toBe('/');
    expect(parentPath('/')).toBe('/');
    expect(parentPath('/home/pete/x/')).toBe('/home/pete');
    expect(baseName('/home/pete/shop')).toBe('shop');
    expect(baseName('/home/pete/shop/')).toBe('shop');
    expect(baseName('/')).toBe('/');
  });

  test('breadcrumbs start at ~ under home, else at /', () => {
    expect(breadcrumbs('/home/pete/Projects/shop', '/home/pete')).toEqual([
      { label: '~', path: '/home/pete' },
      { label: 'Projects', path: '/home/pete/Projects' },
      { label: 'shop', path: '/home/pete/Projects/shop' },
    ]);
    expect(breadcrumbs('/home/pete', '/home/pete')).toEqual([{ label: '~', path: '/home/pete' }]);
    expect(breadcrumbs('/srv/git', '/home/pete')).toEqual([
      { label: '/', path: '/' },
      { label: 'srv', path: '/srv' },
      { label: 'git', path: '/srv/git' },
    ]);
    expect(breadcrumbs('/', '/home/pete')).toEqual([{ label: '/', path: '/' }]);
  });
});

describe('parseRepoSource', () => {
  const ok = (text: string) => {
    const r = parseRepoSource(text);
    if (!r?.ok) throw new Error(`expected ${text} to parse: ${JSON.stringify(r)}`);
    return r.source;
  };

  test('empty is nothing to say yet', () => {
    expect(parseRepoSource('  ')).toBeUndefined();
  });

  test('GitHub owner/repo is https', () => {
    expect(ok('acme/shop')).toEqual({
      kind: 'github',
      protocol: 'https',
      host: 'github.com',
      owner: 'acme',
      name: 'shop',
      display: 'https://github.com/acme/shop.git',
    });
    expect(ok('acme/shop.git').name).toBe('shop');
  });

  test('scp-like SSH', () => {
    expect(ok('git@github.com:acme/web-app.git')).toEqual({
      kind: 'github',
      protocol: 'ssh',
      host: 'github.com',
      owner: 'acme',
      name: 'web-app',
      display: 'git@github.com:acme/web-app.git',
    });
    expect(ok('git@gitlab.com:group/sub/tool.git')).toMatchObject({
      kind: 'gitlab',
      owner: 'group/sub',
      name: 'tool',
    });
  });

  test('https, with credentials dropped from what is shown', () => {
    expect(ok('https://pete:secret@github.com/acme/docs-site')).toMatchObject({
      kind: 'github',
      protocol: 'https',
      owner: 'acme',
      name: 'docs-site',
      display: 'https://github.com/acme/docs-site',
    });
    expect(ok('github.com/acme/api')).toMatchObject({
      kind: 'github',
      protocol: 'https',
      display: 'https://github.com/acme/api',
    });
    expect(ok('https://git.example.com/team/app.git')).toMatchObject({
      kind: 'other',
      host: 'git.example.com',
      owner: 'team',
      name: 'app',
    });
  });

  test('ssh:// keeps its user but never a password', () => {
    expect(ok('ssh://git:pw@bitbucket.org/acme/api.git')).toMatchObject({
      kind: 'bitbucket',
      protocol: 'ssh',
      display: 'ssh://git@bitbucket.org/acme/api.git',
    });
  });

  test('a local repo: absolute, ~ or file://', () => {
    expect(ok('/srv/git/ledger.git')).toEqual({
      kind: 'other',
      protocol: 'file',
      name: 'ledger',
      display: '/srv/git/ledger.git',
    });
    expect(ok('~/mirrors/ledger').name).toBe('ledger');
    expect(ok('file:///srv/git/ledger.git')).toMatchObject({ protocol: 'file', name: 'ledger' });
  });

  test('refusals say what is accepted', () => {
    const bad = (text: string) => {
      const r = parseRepoSource(text);
      expect(r?.ok).toBe(false);
      return r?.ok === false ? r.reason : '';
    };
    expect(bad('ext::sh -c touch')).toContain('Not a git URL');
    expect(bad('ftp://x/y')).toContain('Not a git URL');
    expect(bad('-u')).toContain('Not a git URL');
    expect(bad('../mirror')).toContain('absolute path');
    expect(bad('https://github.com/')).toContain('name');
  });

  test('sourceRemote: a hosted source is a remote, a local one is not', () => {
    expect(sourceRemote(ok('git@github.com:acme/api.git'))).toEqual({
      kind: 'github',
      protocol: 'ssh',
      url: 'git@github.com:acme/api.git',
      owner: 'acme',
      name: 'api',
    });
    expect(sourceRemote(ok('/srv/git/api.git'))).toBeUndefined();
  });
});

describe('looksLikeRepoUrl', () => {
  test('remote URLs switch the folder field to cloning', () => {
    for (const url of [
      'https://github.com/acme/shop',
      'git@github.com:acme/shop.git',
      'ssh://git@host/x.git',
      'github.com/acme/shop',
      'GitLab.com/group/tool',
    ]) {
      expect(looksLikeRepoUrl(url)).toBe(true);
    }
  });

  test('folders, file:// and half-typed words do not', () => {
    for (const text of [
      '',
      '~/Projects',
      '/srv/git/x.git',
      'file:///srv/x',
      'acme/shop',
      'git@',
      'a b',
    ]) {
      expect(looksLikeRepoUrl(text)).toBe(false);
    }
  });

  test('owner/repo is a shorthand (for a paste)', () => {
    expect(looksLikeGithubShorthand('acme/shop')).toBe(true);
    expect(looksLikeGithubShorthand(' acme/shop.git ')).toBe(true);
    expect(looksLikeGithubShorthand('~/shop')).toBe(false);
    expect(looksLikeGithubShorthand('/srv/shop')).toBe(false);
    expect(looksLikeGithubShorthand('acme/.hidden')).toBe(false);
  });
});

describe('cloneParentCandidates', () => {
  test('next to the last repo, then ~/Projects, then home', () => {
    expect(cloneParentCandidates([])).toEqual(['~/Projects', '~']);
    expect(cloneParentCandidates([{ path: '/a/one' }, { path: '/home/pete/code/two' }])).toEqual([
      '/home/pete/code',
      '~/Projects',
      '~',
    ]);
  });
});

describe('display helpers', () => {
  test('remoteWebUrl and remoteSlug', () => {
    const gh = { kind: 'github', protocol: 'ssh', url: 'u', owner: 'acme', name: 'api' } as const;
    expect(remoteWebUrl(gh)).toBe('https://github.com/acme/api');
    expect(remoteSlug(gh)).toBe('acme/api');
    expect(
      remoteWebUrl({ kind: 'other', protocol: 'https', url: 'u', owner: 'a', name: 'b' }),
    ).toBe(undefined);
    expect(remoteSlug({ kind: 'other', protocol: 'file', url: '/x', name: 'x' })).toBeUndefined();
    expect(remoteSlug(undefined)).toBeUndefined();
  });

  test('cleanDaemonError drops the RPC prefix', () => {
    expect(cleanDaemonError('state.repo_add: /x does not exist')).toBe('/x does not exist');
    expect(cleanDaemonError('no such folder: /x')).toBe('no such folder: /x');
  });

  test('describeCloneError: the daemon hint, git output, and an SSH fallback hint', () => {
    expect(
      describeCloneError(
        'git clone of git@github.com:a/b.git failed — ssh has no key this host accepts: check `ssh -T` from a terminal, or use the https URL:\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      ),
    ).toEqual({
      title: 'Git clone of git@github.com:a/b.git failed',
      hint: 'Ssh has no key this host accepts: check `ssh -T` from a terminal, or use the https URL',
      detail:
        'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
    });
    expect(
      describeCloneError('git clone of ssh://h/x failed:\nssh: connect to host h port 22: refused')
        .hint,
    ).toContain('SSH key');
    expect(describeCloneError('/home/p/x already exists and is not empty')).toEqual({
      title: '/home/p/x already exists and is not empty',
      hint: 'Pick another name or destination folder.',
    });
    expect(describeCloneError('state.repo_add: boom').title).toBe('Boom');
  });
});
