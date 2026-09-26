import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoRemote } from '@agile-agents/shared';
import {
  RepoRemoteCache,
  parseRemoteUrl,
  readRemoteUrl,
  redactUserinfo,
  repoRemoteOf,
} from './remote-url';

describe('repoRemoteOf (T362)', () => {
  test.each<[string, RepoRemote]>([
    [
      'https://github.com/acme/shop.git',
      {
        kind: 'github',
        protocol: 'https',
        url: 'https://github.com/acme/shop.git',
        owner: 'acme',
        name: 'shop',
      },
    ],
    [
      'https://github.com/acme/shop',
      {
        kind: 'github',
        protocol: 'https',
        url: 'https://github.com/acme/shop',
        owner: 'acme',
        name: 'shop',
      },
    ],
    [
      'git@github.com:acme/shop.git',
      {
        kind: 'github',
        protocol: 'ssh',
        url: 'git@github.com:acme/shop.git',
        owner: 'acme',
        name: 'shop',
      },
    ],
    [
      'ssh://git@github.com/acme/shop.git',
      {
        kind: 'github',
        protocol: 'ssh',
        url: 'ssh://git@github.com/acme/shop.git',
        owner: 'acme',
        name: 'shop',
      },
    ],
    [
      'ssh://git@ssh.github.com:443/acme/shop.git',
      {
        kind: 'github',
        protocol: 'ssh',
        url: 'ssh://git@ssh.github.com:443/acme/shop.git',
        owner: 'acme',
        name: 'shop',
      },
    ],
    [
      'http://GitHub.com/Acme/Shop',
      {
        kind: 'github',
        protocol: 'https',
        url: 'http://github.com/Acme/Shop',
        owner: 'Acme',
        name: 'Shop',
      },
    ],
    [
      'git@gitlab.com:group/sub/proj.git',
      {
        kind: 'gitlab',
        protocol: 'ssh',
        url: 'git@gitlab.com:group/sub/proj.git',
        owner: 'group/sub',
        name: 'proj',
      },
    ],
    [
      'https://gitlab.com/group/proj',
      {
        kind: 'gitlab',
        protocol: 'https',
        url: 'https://gitlab.com/group/proj',
        owner: 'group',
        name: 'proj',
      },
    ],
    [
      'git@bitbucket.org:team/repo.git',
      {
        kind: 'bitbucket',
        protocol: 'ssh',
        url: 'git@bitbucket.org:team/repo.git',
        owner: 'team',
        name: 'repo',
      },
    ],
    [
      'https://github.example.com/acme/shop.git',
      {
        kind: 'other',
        protocol: 'https',
        url: 'https://github.example.com/acme/shop.git',
        owner: 'acme',
        name: 'shop',
      },
    ],
    [
      'git@git.corp.example:platform/api.git',
      {
        kind: 'other',
        protocol: 'ssh',
        url: 'git@git.corp.example:platform/api.git',
        owner: 'platform',
        name: 'api',
      },
    ],
    [
      'github.com:acme/shop',
      {
        kind: 'github',
        protocol: 'ssh',
        url: 'github.com:acme/shop',
        owner: 'acme',
        name: 'shop',
      },
    ],
    [
      'git://github.com/acme/shop.git',
      {
        kind: 'github',
        protocol: 'https',
        url: 'git://github.com/acme/shop.git',
        owner: 'acme',
        name: 'shop',
      },
    ],
    [
      'file:///srv/git/shop.git',
      { kind: 'other', protocol: 'file', url: 'file:///srv/git/shop.git', name: 'shop' },
    ],
    [
      '/srv/git/shop.git',
      { kind: 'other', protocol: 'file', url: '/srv/git/shop.git', name: 'shop' },
    ],
    [
      '/srv/work/shop/.git',
      { kind: 'other', protocol: 'file', url: '/srv/work/shop/.git', name: 'shop' },
    ],
    ['../shared.git', { kind: 'other', protocol: 'file', url: '../shared.git', name: 'shared' }],
  ])('%s', (url, expected) => {
    expect(repoRemoteOf(url)).toEqual(expected);
  });

  test('credentials never reach the display URL', () => {
    const cases: Array<[string, string]> = [
      [
        'https://x-access-token:s3cr3t@github.com/acme/shop.git',
        'https://github.com/acme/shop.git',
      ],
      ['https://ghp_s3cr3t@github.com/acme/shop', 'https://github.com/acme/shop'],
      ['http://pete:s3cr3t@git.corp.example/a/b.git', 'http://git.corp.example/a/b.git'],
      ['ssh://git:s3cr3t@github.com:22/acme/shop.git', 'ssh://git@github.com:22/acme/shop.git'],
      ['pete:s3cr3t@git.corp.example:a/b.git', 'pete@git.corp.example:a/b.git'],
    ];
    for (const [raw, shown] of cases) {
      const remote = repoRemoteOf(raw);
      expect(remote?.url).toBe(shown);
      expect(JSON.stringify(remote)).not.toContain('s3cr3t');
    }
  });

  test('a remote helper, an unknown scheme, an option-like host or control characters are not remotes', () => {
    for (const raw of [
      'ext::sh -c touch% /tmp/pwned',
      'persistent-https::example.com/r',
      'svn+ssh://host/repo',
      '-oProxyCommand=evil:repo',
      'ssh://-oProxyCommand=evil/repo',
      'https://github.com/a/b\nx',
      '   ',
    ]) {
      expect(parseRemoteUrl(raw)).toBeUndefined();
    }
  });

  test('redactUserinfo scrubs every scheme://user:pass@ in free text', () => {
    expect(
      redactUserinfo(
        "fatal: repository 'https://u:tok@github.com/a/b/' not found\nssh://git:pw@h/x also",
      ),
    ).toBe("fatal: repository 'https://github.com/a/b/' not found\nssh://h/x also");
  });
});

describe('RepoRemoteCache (T362)', () => {
  const entry = { path: '/repos/shop' };
  const github = 'git@github.com:acme/shop.git';

  function fakeReader(urls: Record<string, string | undefined>) {
    const calls: string[] = [];
    let release: () => void = () => {};
    let gate: Promise<void> = Promise.resolve();
    return {
      calls,
      hold() {
        gate = new Promise((r) => {
          release = r;
        });
      },
      release: () => release(),
      read: async (path: string, remote: string) => {
        calls.push(`${path}#${remote}`);
        await gate;
        return urls[`${path}#${remote}`];
      },
    };
  }

  test('peek never waits: undefined first, the remote once the background read lands, one read per TTL', async () => {
    let now = 0;
    const reader = fakeReader({ '/repos/shop#origin': github });
    let changes = 0;
    const cache = new RepoRemoteCache({
      read: reader.read,
      now: () => now,
      ttlMs: 1000,
      onChange: () => {
        changes += 1;
      },
    });
    expect(cache.peek(entry)).toBeUndefined();
    expect(cache.peek(entry)).toBeUndefined();
    expect(reader.calls).toEqual(['/repos/shop#origin']); // one read in flight, not two
    await cache.get(entry);
    expect(cache.peek(entry)?.kind).toBe('github');
    expect(changes).toBe(1);
    now = 999;
    cache.peek(entry);
    expect(reader.calls.length).toBe(1);
    now = 1000; // stale: the old answer now, a re-read behind it
    expect(cache.peek(entry)?.kind).toBe('github');
    await cache.get(entry);
    expect(reader.calls.length).toBe(2);
    expect(changes).toBe(1); // unchanged remote: no re-push
  });

  test('a local-only repo, a failing read and a named remote', async () => {
    let changes = 0;
    const cache = new RepoRemoteCache({
      read: async (_path, remote) => {
        if (remote === 'boom') throw new Error('git exploded');
        return remote === 'upstream' ? 'https://gitlab.com/g/p.git' : undefined;
      },
      onChange: () => {
        changes += 1;
      },
    });
    expect(await cache.get(entry)).toBeUndefined();
    expect(await cache.get({ ...entry, remote: 'boom' })).toBeUndefined();
    expect(changes).toBe(0); // nothing a frame showed has changed
    expect((await cache.get({ ...entry, remote: 'upstream' }))?.kind).toBe('gitlab');
    expect(changes).toBe(1);
  });

  test('invalidate forces a re-read, and a read begun before it never lands', async () => {
    const urls: Record<string, string | undefined> = { '/repos/shop#origin': github };
    const reader = fakeReader(urls);
    const cache = new RepoRemoteCache({ read: reader.read });
    expect((await cache.get(entry))?.protocol).toBe('ssh');
    urls['/repos/shop#origin'] = 'https://github.com/acme/shop.git';
    expect((await cache.get(entry))?.protocol).toBe('ssh'); // within the TTL
    reader.hold();
    cache.peek({ path: '/repos/other' }); // unrelated read in flight
    cache.invalidate(entry.path);
    const fresh = cache.get(entry);
    reader.release();
    expect((await fresh)?.protocol).toBe('https');
    expect(reader.calls.filter((c) => c === '/repos/shop#origin').length).toBe(2);
  });
});

describe('readRemoteUrl (T362)', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'agile-remote-url-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  function git(args: string[], cwd: string): void {
    const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  }

  test('reads a named remote; none, or a missing folder, is undefined', async () => {
    const repo = join(scratch, 'shop');
    mkdirSync(repo);
    git(['init', '-q'], repo);
    expect(await readRemoteUrl(repo, 'origin')).toBeUndefined();
    // A host no operator's `insteadOf` rewrites (git applies them, as it would to a fetch).
    git(['remote', 'add', 'origin', 'git@git.corp.example:acme/shop.git'], repo);
    expect(await readRemoteUrl(repo, 'origin')).toBe('git@git.corp.example:acme/shop.git');
    expect(await readRemoteUrl(repo, '--all')).toBeUndefined();
    expect(await readRemoteUrl(join(scratch, 'gone'), 'origin')).toBeUndefined();
  });
});
