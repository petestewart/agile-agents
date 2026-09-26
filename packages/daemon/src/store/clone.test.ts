import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init';
import {
  CloneError,
  cloneEnv,
  cloneRepo,
  defaultCloneParent,
  describeCloneFailure,
  resolveCloneSource,
} from './clone';
import { StateStore } from './store';

let scratch: string;
let home: string;
let store: StateStore;

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
}

/** A bare repo with one commit, the offline stand-in for a hosted remote. */
function bareRepo(name: string): string {
  const work = join(scratch, `${name}-work`);
  mkdirSync(work);
  git(['init', '-q', '-b', 'main'], work);
  writeFileSync(join(work, 'README.md'), '# hi\n');
  git(['add', '.'], work);
  git(
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'init',
    ],
    work,
  );
  const bare = join(scratch, 'remotes', `${name}.git`);
  mkdirSync(join(scratch, 'remotes'), { recursive: true });
  git(['clone', '-q', '--bare', work, bare], scratch);
  return bare;
}

async function refusal(p: Promise<unknown>): Promise<CloneError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CloneError) return err;
    throw err;
  }
  throw new Error('expected a CloneError');
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'agile-clone-'));
  home = join(scratch, 'home');
  mkdirSync(home);
  store = StateStore.open(runInit(join(scratch, 'agile-home')).stateRoot);
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('resolveCloneSource (T362)', () => {
  test.each([
    ['acme/shop', 'https://github.com/acme/shop.git', 'shop'],
    ['acme/shop.git', 'https://github.com/acme/shop.git', 'shop'],
    ['github.com/acme/shop', 'https://github.com/acme/shop', 'shop'],
    ['https://github.com/acme/shop', 'https://github.com/acme/shop', 'shop'],
    ['git@github.com:acme/shop.git', 'git@github.com:acme/shop.git', 'shop'],
    ['ssh://git@git.corp.example/team/api.git', 'ssh://git@git.corp.example/team/api.git', 'api'],
    ['/srv/git/ledger.git', '/srv/git/ledger.git', 'ledger'],
  ])('%s', (input, url, name) => {
    expect(resolveCloneSource(input, home)).toMatchObject({ url, name });
  });

  test('`~` is expanded; credentials stay out of what is shown', () => {
    expect(resolveCloneSource('~/src/x.git', home)).toMatchObject({
      url: join(home, 'src/x.git'),
      name: 'x',
    });
    const withToken = resolveCloneSource('https://u:s3cr3t@github.com/acme/shop.git', home);
    expect(withToken.url).toContain('s3cr3t'); // git gets what the human typed
    expect(withToken.display).toBe('https://github.com/acme/shop.git');
  });

  test('a relative path, a remote helper, an option or a nameless URL is refused, never echoing a secret', () => {
    expect(() => resolveCloneSource('./shop', home)).toThrow('must be an absolute path');
    expect(() => resolveCloneSource('ext::sh -c touch% /tmp/x', home)).toThrow('not a git URL');
    expect(() => resolveCloneSource('-uhttps://x/y', home)).toThrow('not a git URL');
    expect(() => resolveCloneSource('https://github.com/', home)).toThrow('give a destination');
    try {
      resolveCloneSource('svn+ssh://u:s3cr3t@host/r', home);
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as Error).message).not.toContain('s3cr3t');
    }
  });
});

describe('defaultCloneParent (T362)', () => {
  test("the last registered repo's folder, else ~/Projects, else home", () => {
    expect(defaultCloneParent({}, home)).toBe(home);
    mkdirSync(join(home, 'Projects'));
    expect(defaultCloneParent({}, home)).toBe(join(home, 'Projects'));
    mkdirSync(join(scratch, 'code', 'api'), { recursive: true });
    const repos = {
      old: { path: join(home, 'Projects', 'old'), protected_branches: [] },
      api: { path: join(scratch, 'code', 'api'), protected_branches: [] },
    };
    expect(defaultCloneParent(repos, home)).toBe(join(scratch, 'code'));
    // A last repo whose folder is gone falls through.
    expect(
      defaultCloneParent({ gone: { path: '/nowhere/at/all', protected_branches: [] } }, home),
    ).toBe(join(home, 'Projects'));
  });
});

describe('describeCloneFailure (T362)', () => {
  test("git's last lines, userinfo scrubbed, with the fix when there is one", () => {
    const msg = describeCloneFailure(
      "Cloning into 'shop'...\nremote: Repository not found.\nfatal: repository 'https://u:s3cr3t@github.com/a/b.git/' not found\n",
      'https://github.com/a/b.git',
    );
    expect(msg).toContain('git clone of https://github.com/a/b.git failed:');
    expect(msg).toContain("fatal: repository 'https://github.com/a/b.git/' not found");
    expect(msg).not.toContain('s3cr3t');
    expect(describeCloneFailure('Host key verification failed.\nfatal: x', 'u')).toContain(
      'known_hosts',
    );
    expect(describeCloneFailure('git@h: Permission denied (publickey).', 'u')).toContain(
      'ssh has no key',
    );
    expect(
      describeCloneFailure(
        "fatal: could not read Username for 'https://h': terminal prompts disabled",
        'u',
      ),
    ).toContain('credential helper');
  });
});

describe('cloneEnv (T362)', () => {
  test('ssh never prompts unless the operator chose an ssh command; no daemon secret reaches git', () => {
    const base = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      TYPESAFE_API_KEY: 'k-s3cr3t',
    };
    const env = cloneEnv(base, scratch);
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.HOME).toBe(home);
    expect(JSON.stringify(env)).not.toContain('s3cr3t');
    expect(cloneEnv({ ...base, GIT_SSH_COMMAND: 'ssh -i key' }, scratch).GIT_SSH_COMMAND).toBe(
      'ssh -i key',
    );
    writeFileSync(join(home, '.gitconfig'), '[core]\n\tsshCommand = ssh -i work_key\n');
    expect(cloneEnv(base, scratch).GIT_SSH_COMMAND).toBeUndefined();
  });
});

describe('cloneRepo (T362)', () => {
  test('clones a local bare repo next to the last registered repo and registers it as the human', async () => {
    const source = bareRepo('shop');
    const result = await cloneRepo(store, { url: source }, { home });
    const dest = realpathSync(join(home, 'shop'));
    expect(result).toEqual({ name: 'shop', path: dest });
    expect(existsSync(join(dest, 'README.md'))).toBe(true);
    expect(store.getRepos().shop?.path).toBe(dest);
    const event = store.listEvents().at(-1);
    expect(event?.kind).toBe('repos_put');
    expect(event?.agent).toBe('human');

    // The next one lands beside it, under the name given.
    const other = bareRepo('ledger');
    expect(await cloneRepo(store, { url: `file://${other}`, name: 'books' }, { home })).toEqual({
      name: 'books',
      path: realpathSync(join(home, 'ledger')),
    });
  });

  test('an explicit dest, including an empty existing folder', async () => {
    const source = bareRepo('shop');
    mkdirSync(join(scratch, 'empty'));
    const result = await cloneRepo(store, { url: source, dest: join(scratch, 'empty') }, { home });
    expect(result.path).toBe(realpathSync(join(scratch, 'empty')));
    expect(existsSync(join(scratch, 'empty', 'README.md'))).toBe(true);
  });

  test('refused before git runs: a taken name, a non-empty dest, a missing parent, a bad body', async () => {
    const source = bareRepo('shop');
    await cloneRepo(store, { url: source }, { home });
    const taken = await refusal(
      cloneRepo(store, { url: source, dest: join(scratch, 'x') }, { home }),
    );
    expect(taken.status).toBe(409);
    expect(taken.message).toContain('a repo named shop is already registered');

    mkdirSync(join(scratch, 'full'));
    writeFileSync(join(scratch, 'full', 'keep.txt'), 'mine');
    const full = await refusal(
      cloneRepo(store, { url: source, dest: join(scratch, 'full'), name: 'b' }, { home }),
    );
    expect(full.status).toBe(409);
    expect(full.message).toBe(`${join(scratch, 'full')} already exists and is not empty`);

    const orphan = await refusal(
      cloneRepo(
        store,
        { url: source, dest: join(scratch, 'no', 'such', 'dir'), name: 'c' },
        { home },
      ),
    );
    expect(orphan.message).toContain('does not exist');
    expect(existsSync(join(scratch, 'no'))).toBe(false);

    expect(
      (await refusal(cloneRepo(store, { url: source, extra: 1 }, { home }))).message,
    ).toContain('invalid clone request');
    const relative = await refusal(
      cloneRepo(store, { url: source, dest: 'rel', name: 'd' }, { home }),
    );
    expect(relative.status).toBe(400);
    expect(relative.message).toContain('must be absolute');

    // T389: a name the registry can't keep, given or taken from the URL.
    const badName = await refusal(
      cloneRepo(store, { url: source, dest: join(scratch, 'y'), name: '__proto__' }, { home }),
    );
    expect(badName.status).toBe(400);
    const spaced = bareRepo('two words');
    const derived = await refusal(
      cloneRepo(store, { url: spaced, dest: join(scratch, 'z') }, { home }),
    );
    expect(derived.message).toContain("can't be a repo's name");
    expect(existsSync(join(scratch, 'z'))).toBe(false);
  });

  test("a failing clone is a 400 quoting git's stderr, and leaves nothing behind", async () => {
    const err = await refusal(
      cloneRepo(store, { url: join(scratch, 'remotes', 'missing.git') }, { home }),
    );
    expect(err.status).toBe(400);
    expect(err.message).toContain('git clone of');
    expect(err.message).toContain('missing.git');
    expect(existsSync(join(home, 'missing'))).toBe(false);
    expect(store.getRepos()).toEqual({});
  });

  test('a clone that outlives the timeout is stopped, its ssh with it, and its folder removed', async () => {
    // An "ssh" that never answers stands in for a stalled network (and outlives git).
    // T397: its marker file shows whether it was left running after git stopped.
    const marker = join(scratch, 'ssh-still-ran');
    const env = { ...process.env, GIT_SSH_COMMAND: `sleep 2; touch ${marker}; true` };
    const started = Date.now();
    const err = await refusal(
      cloneRepo(
        store,
        { url: 'ssh://git@git.invalid/acme/shop.git' },
        { home, env, timeoutMs: 300 },
      ),
    );
    expect(Date.now() - started).toBeLessThan(2500); // not held by the orphaned "ssh"
    expect(err.message).toContain('was stopped after');
    expect(existsSync(join(home, 'shop'))).toBe(false);
    expect(store.getRepos()).toEqual({});
    await Bun.sleep(2500);
    expect(existsSync(marker)).toBe(false);
  }, 15_000);
});
