import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FakeGitHub, startFakeGitHub } from './fake-server';

let gh: FakeGitHub;
let work: string;

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
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${gh.apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${gh.token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
const repoPath = () => `/repos/${gh.owner}/${gh.repo}`;
const mainSha = () => git(['rev-parse', 'main'], gh.bareDir);

async function openPr(branch: string, file = 'feature.txt'): Promise<number> {
  git(['checkout', '-q', '-b', branch, 'main']);
  commit(file, `${branch}\n`);
  git(['push', '-q', 'origin', branch]);
  const res = await api(`${repoPath()}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title: `PR ${branch}`, head: branch, base: 'main' }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { number: number }).number;
}

beforeEach(async () => {
  gh = await startFakeGitHub({ owner: 'acme', repo: 'shop' });
  work = mkdtempSync(join(tmpdir(), 'agile-fake-github-work-'));
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  commit('README.md', '# shop\n');
  git(['remote', 'add', 'origin', gh.remoteUrl]);
  git(['push', '-q', 'origin', 'main']);
});

afterEach(async () => {
  await gh.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('fake GitHub', () => {
  test('rejects a missing token', async () => {
    const res = await fetch(`${gh.apiUrl}${repoPath()}`);
    expect(res.status).toBe(401);
    expect(JSON.stringify(gh.requests)).not.toContain(gh.token);
  });

  test('repo, PR create, review, failing then passing check, merge moves the bare main', async () => {
    const repo = (await (await api(repoPath())).json()) as { default_branch: string };
    expect(repo.default_branch).toBe('main');
    const n = await openPr('stream/s1-feature');
    const before = mainSha();

    gh.addReview(n, { state: 'APPROVED', body: 'lgtm' });
    gh.addReviewComment(n, { body: 'nit', path: 'feature.txt' });
    gh.addIssueComment(n, { body: 'thanks' });
    const reviews = (await (await api(`${repoPath()}/pulls/${n}/reviews`)).json()) as Array<{
      state: string;
    }>;
    expect(reviews.map((r) => r.state)).toEqual(['APPROVED']);
    expect(
      ((await (await api(`${repoPath()}/pulls/${n}/comments`)).json()) as unknown[]).length,
    ).toBe(1);
    expect(
      ((await (await api(`${repoPath()}/issues/${n}/comments`)).json()) as unknown[]).length,
    ).toBe(1);

    gh.setCheck('stream/s1-feature', 'ci', 'failure');
    const headSha = git(['rev-parse', 'HEAD']);
    let runs = (await (await api(`${repoPath()}/commits/stream/s1-feature/check-runs`)).json()) as {
      check_runs: Array<{ conclusion: string }>;
    };
    expect(runs.check_runs[0]?.conclusion).toBe('failure');
    gh.setCheck(headSha, 'ci', 'success');
    runs = (await (
      await api(`${repoPath()}/commits/stream/s1-feature/check-runs`)
    ).json()) as typeof runs;
    expect(runs.check_runs[0]?.conclusion).toBe('success');

    const pr = (await (await api(`${repoPath()}/pulls/${n}`)).json()) as {
      mergeable_state: string;
    };
    expect(pr.mergeable_state).toBe('clean');
    const merged = await api(`${repoPath()}/pulls/${n}/merge`, { method: 'PUT', body: '{}' });
    expect(merged.status).toBe(200);
    expect(mainSha()).not.toBe(before);
    git(['merge-base', '--is-ancestor', headSha, mainSha()], gh.bareDir);
    expect(gh.pulls[0]?.merged).toBe(true);
  });

  test('conditional GET returns 304 until the PR changes', async () => {
    const n = await openPr('stream/s2');
    const first = await api(`${repoPath()}/pulls/${n}`);
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    const again = await api(`${repoPath()}/pulls/${n}`, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    commit('more.txt', 'x\n');
    git(['push', '-q', 'origin', 'stream/s2']);
    const changed = await api(`${repoPath()}/pulls/${n}`, { headers: { 'if-none-match': etag } });
    expect(changed.status).toBe(200);
  });

  test('rate limit gives 403 with remaining 0, then recovers', async () => {
    gh.rateLimit(1);
    const limited = await api(repoPath());
    expect(limited.status).toBe(403);
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
    expect((await api(repoPath())).status).toBe(200);
  });

  test('auto-merge via GraphQL merges once approved and green', async () => {
    const n = await openPr('stream/s3');
    const nodeId = gh.pulls[0]?.node_id;
    const res = await api('/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query:
          'mutation($id: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { id } } }',
        variables: { pullRequestId: nodeId },
      }),
    });
    expect(((await res.json()) as { errors?: unknown }).errors).toBeUndefined();
    const before = mainSha();
    gh.setCheck('stream/s3', 'ci', 'pending');
    gh.addReview(n, { state: 'APPROVED' });
    expect(gh.pulls[0]?.merged).toBe(false);
    gh.setCheck('stream/s3', 'ci', 'success');
    expect(gh.pulls[0]?.merged).toBe(true);
    expect(mainSha()).not.toBe(before);
  });

  test('compare, close, conflicting merge refused', async () => {
    const a = await openPr('stream/a', 'same.txt');
    git(['checkout', '-q', 'main']);
    const b = await openPr('stream/b', 'same.txt');
    gh.merge(a);
    const cmp = (await (await api(`${repoPath()}/compare/main...stream/b`)).json()) as {
      ahead_by: number;
      behind_by: number;
    };
    expect(cmp).toMatchObject({ ahead_by: 1, behind_by: 2 });
    const pr = (await (await api(`${repoPath()}/pulls/${b}`)).json()) as { mergeable: boolean };
    expect(pr.mergeable).toBe(false);
    expect(
      (await api(`${repoPath()}/pulls/${b}/merge`, { method: 'PUT', body: '{}' })).status,
    ).toBe(405);
    gh.close(b);
    const open = (await (await api(`${repoPath()}/pulls?state=open`)).json()) as unknown[];
    expect(open.length).toBe(0);
  });
});
