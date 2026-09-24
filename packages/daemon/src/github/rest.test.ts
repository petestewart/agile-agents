import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FakeGitHub, startFakeGitHub } from './fake-server';
import { GitHubError, type GitHubPort } from './port';
import {
  createGitHubRest,
  ghTokenSource,
  githubAuthAvailable,
  isLoopbackUrl,
  repoFromRemoteUrl,
} from './rest';

const TOKEN = 'ghs_T221sentinelTOKENvalue0123456789';

let gh: FakeGitHub;
let work: string;
let port: GitHubPort;

function git(args: string[], cwd = work): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}
function commit(file: string, text: string) {
  writeFileSync(join(work, file), text);
  git(['add', '-A']);
  git(['commit', '-q', '-m', `edit ${file}`]);
}
function pushBranch(branch: string) {
  git(['checkout', '-q', '-b', branch, 'main']);
  commit(`${branch}.txt`, `${branch}\n`);
  git(['push', '-q', 'origin', branch]);
}
/** A stand-in `gh` that prints (or fails to print) a token. */
function fakeGh(body: string): string {
  const path = join(work, 'gh');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(async () => {
  gh = await startFakeGitHub({ owner: 'acme', repo: 'shop', token: TOKEN });
  work = mkdtempSync(join(tmpdir(), 'agile-github-rest-'));
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  commit('README.md', '# shop\n');
  git(['remote', 'add', 'origin', gh.remoteUrl]);
  git(['push', '-q', 'origin', 'main']);
  port = createGitHubRest({
    apiUrl: gh.apiUrl,
    repo: { owner: 'acme', repo: 'shop' },
    staticToken: TOKEN,
  });
});

afterEach(async () => {
  await gh.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('GitHub REST adapter against the fake', () => {
  test('repo, PR create/update/get/list, reviews, comments, checks, status, compare, merge', async () => {
    expect(await port.getRepo()).toEqual({ default_branch: 'main', allow_auto_merge: true });
    pushBranch('feat');
    const pr = await port.createPull({ title: 'Feat', head: 'feat', base: 'main', body: 'b' });
    expect(pr.number).toBe(1);
    expect(pr.state).toBe('open');
    expect(pr.head.ref).toBe('feat');
    expect(pr.head.sha).toBe(git(['rev-parse', 'feat']));

    const updated = await port.updatePull(1, { title: 'Feat 2' });
    expect(updated.title).toBe('Feat 2');
    expect((await port.listPulls({ head: 'feat' })).map((p) => p.number)).toEqual([1]);
    expect(await port.listPulls({ head: 'nope' })).toEqual([]);

    gh.addReview(1, { state: 'CHANGES_REQUESTED', user: 'amy', body: 'fix it' });
    gh.addReviewComment(1, { body: 'nit', path: 'feat.txt', line: 1 });
    gh.addIssueComment(1, { body: 'hello', user: 'bob' });
    const reviews = await port.listReviews(1);
    expect(reviews.notModified).toBe(false);
    if (!reviews.notModified)
      expect(reviews.data[0]).toMatchObject({ user: 'amy', state: 'CHANGES_REQUESTED' });
    const rc = await port.listReviewComments(1);
    if (!rc.notModified)
      expect(rc.data[0]).toMatchObject({ body: 'nit', path: 'feat.txt', line: 1 });
    const ic = await port.listIssueComments(1);
    if (!ic.notModified)
      expect(ic.data).toEqual([expect.objectContaining({ user: 'bob', body: 'hello' })]);

    gh.setCheck('feat', 'ci', 'failure');
    gh.setStatus('feat', 'lint', 'success');
    const runs = await port.listCheckRuns('feat');
    if (!runs.notModified)
      expect(runs.data).toEqual([expect.objectContaining({ name: 'ci', conclusion: 'failure' })]);
    const st = await port.getCombinedStatus('feat');
    if (!st.notModified) expect(st.data.state).toBe('success');

    expect(await port.compare('main', 'feat')).toEqual({
      status: 'ahead',
      ahead_by: 1,
      behind_by: 0,
    });

    gh.addReview(1, { state: 'APPROVED', user: 'amy' });
    gh.setCheck('feat', 'ci', 'success');
    const merged = await port.mergePull(1);
    expect(merged.sha).toBe(git(['rev-parse', 'main'], gh.bareDir));
    const after = await port.getPull(1);
    if (!after.notModified) expect(after.data).toMatchObject({ merged: true, state: 'closed' });
  });

  test('conditional GET: an unchanged PR answers notModified, a push changes it', async () => {
    pushBranch('feat');
    await port.createPull({ title: 'Feat', head: 'feat', base: 'main' });
    const first = await port.getPull(1);
    expect(first.notModified).toBe(false);
    const etag = first.etag ?? '';
    expect(etag).not.toBe('');
    expect(await port.getPull(1, { etag })).toEqual({ notModified: true, etag });
    commit('more.txt', 'x');
    git(['push', '-q', 'origin', 'feat']);
    expect((await port.getPull(1, { etag })).notModified).toBe(false);
  });

  test('auto-merge through the GraphQL mutation merges once approved and green', async () => {
    pushBranch('feat');
    const pr = await port.createPull({ title: 'Feat', head: 'feat', base: 'main' });
    await port.enableAutoMerge(pr.node_id);
    const pending = await port.getPull(1);
    if (!pending.notModified)
      expect(pending.data).toMatchObject({ auto_merge: true, merged: false });
    gh.addReview(1, { state: 'APPROVED' });
    const done = await port.getPull(1);
    if (!done.notModified) expect(done.data.merged).toBe(true);
    await expect(port.enableAutoMerge('PR_nope')).rejects.toMatchObject({ kind: 'graphql' });
  });

  test('errors carry a kind: validation, not_found, rate_limited, auth', async () => {
    pushBranch('feat');
    await port.createPull({ title: 'Feat', head: 'feat', base: 'main' });
    await expect(
      port.createPull({ title: 'Again', head: 'feat', base: 'main' }),
    ).rejects.toMatchObject({
      kind: 'validation',
      status: 422,
    });
    await expect(port.getPull(99)).rejects.toMatchObject({ kind: 'not_found' });
    gh.rateLimit(1);
    const err = await port.getRepo().catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.kind).toBe('rate_limited');
    expect(err.resetAt).toBeGreaterThan(0);
    const wrong = createGitHubRest({
      apiUrl: gh.apiUrl,
      repo: { owner: 'acme', repo: 'shop' },
      staticToken: 'wrong',
    });
    await expect(wrong.getRepo()).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });
});

describe('token source', () => {
  test('a static token is refused for a non-loopback api_url', () => {
    expect(() =>
      createGitHubRest({
        apiUrl: 'https://api.github.com',
        repo: { owner: 'a', repo: 'b' },
        staticToken: TOKEN,
      }),
    ).toThrow(/only accepted for a loopback api_url/);
    expect(isLoopbackUrl('http://127.0.0.1:1234')).toBe(true);
    expect(isLoopbackUrl('http://localhost')).toBe(true);
    expect(isLoopbackUrl('https://127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackUrl('https://api.github.com')).toBe(false);
  });

  test('gh auth token is called per request', async () => {
    const counter = join(work, 'calls');
    const ghPath = fakeGh(`echo x >> '${counter}'; echo '${TOKEN}'`);
    const viaGh = createGitHubRest({
      apiUrl: gh.apiUrl,
      repo: { owner: 'acme', repo: 'shop' },
      tokenSource: ghTokenSource(ghPath),
    });
    await viaGh.getRepo();
    await viaGh.getRepo();
    expect((await Bun.file(counter).text()).trim().split('\n')).toHaveLength(2);
    expect(await githubAuthAvailable(ghTokenSource(ghPath))).toBe(true);
  });

  test('a missing gh gives one clear error; so does a logged-out gh', async () => {
    const missing = createGitHubRest({
      apiUrl: gh.apiUrl,
      repo: { owner: 'acme', repo: 'shop' },
      tokenSource: ghTokenSource(join(work, 'no-such-gh')),
    });
    const err = await missing.getRepo().catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.kind).toBe('auth');
    expect(err.message).toBe(
      'GitHub auth unavailable: `gh` not found — install the GitHub CLI and run `gh auth login`',
    );
    expect(gh.requests).toHaveLength(0);
    const loggedOut = fakeGh('echo "not logged in" >&2; exit 1');
    await expect(ghTokenSource(loggedOut)()).rejects.toThrow(/not logged in — run `gh auth login`/);
    expect(await githubAuthAvailable(ghTokenSource(join(work, 'no-such-gh')))).toBe(false);
  });

  test('the token never appears in output, errors, results or the request log', async () => {
    const seen: string[] = [];
    const orig = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: console.debug,
      out: process.stdout.write,
      err: process.stderr.write,
    };
    const capture = (...args: unknown[]) => {
      seen.push(args.map(String).join(' '));
      return true;
    };
    console.log = console.error = console.warn = console.info = console.debug = capture;
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;
    try {
      const viaGh = createGitHubRest({
        apiUrl: gh.apiUrl,
        repo: { owner: 'acme', repo: 'shop' },
        tokenSource: ghTokenSource(fakeGh(`echo '${TOKEN}'`)),
      });
      const collect = async (p: Promise<unknown>) => {
        try {
          seen.push(JSON.stringify(await p));
        } catch (e) {
          const err = e as Error;
          seen.push(err.message, String(err.stack), JSON.stringify(err));
        }
      };
      pushBranch('feat');
      await collect(viaGh.getRepo());
      await collect(viaGh.createPull({ title: 'F', head: 'feat', base: 'main' }));
      await collect(viaGh.createPull({ title: 'F', head: 'feat', base: 'main' }));
      await collect(viaGh.getPull(1));
      await collect(viaGh.getPull(42));
      await collect(viaGh.enableAutoMerge('PR_nope'));
      gh.rateLimit(1);
      await collect(viaGh.listReviews(1));
      await collect(
        createGitHubRest({
          apiUrl: 'http://127.0.0.1:1',
          repo: { owner: 'acme', repo: 'shop' },
          staticToken: TOKEN,
        }).getRepo(),
      );
    } finally {
      console.log = orig.log;
      console.error = orig.error;
      console.warn = orig.warn;
      console.info = orig.info;
      console.debug = orig.debug;
      process.stdout.write = orig.out;
      process.stderr.write = orig.err;
    }
    seen.push(JSON.stringify(gh.requests));
    expect(seen.length).toBeGreaterThan(8);
    for (const line of seen) expect(line).not.toContain(TOKEN);
  });
});

describe('repoFromRemoteUrl', () => {
  test.each([
    ['git@github.com:acme/shop.git', 'acme', 'shop'],
    ['git@github.com:acme/shop', 'acme', 'shop'],
    ['ssh://git@github.com/acme/shop.git', 'acme', 'shop'],
    ['https://github.com/acme/shop.git', 'acme', 'shop'],
    ['https://github.com/acme/shop', 'acme', 'shop'],
    ['https://x-access-token:secret@github.com/acme/shop.git', 'acme', 'shop'],
  ])('%s', (url, owner, repo) => {
    expect(repoFromRemoteUrl(url)).toEqual({ owner, repo });
  });
  test('an unrecognisable remote is refused without echoing it', () => {
    expect(() => repoFromRemoteUrl('https://user:secret@github.com/only-owner')).toThrow(
      /cannot infer/,
    );
    expect(() => repoFromRemoteUrl('file:///tmp/bare')).toThrow(/cannot infer/);
  });
});
