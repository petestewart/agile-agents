/**
 * A fake GitHub for tests (test support, like `runner/fake-agent.ts`):
 * a local `Bun.serve` server implementing the REST subset of
 * projects-design §18, backed by a bare git repo on disk that the test
 * repo uses as `origin` (a `file://` remote). No network.
 *
 * Usage:
 *   const gh = await startFakeGitHub({ owner: 'acme', repo: 'shop' });
 *   // gh.apiUrl  -> point `github.api_url` here; gh.token -> the static token
 *   // gh.remoteUrl -> `file://` URL of the bare repo; push branches to it
 *   ...
 *   await gh.stop(); // also deletes the bare repo unless `bareDir` was given
 *
 * REST (all need `Authorization: Bearer|token <gh.token>`, else 401):
 *   GET   /repos/:o/:r                           default_branch, allow_auto_merge
 *   GET   /repos/:o/:r/pulls?state=&head=&base=  POST /repos/:o/:r/pulls
 *   GET   /repos/:o/:r/pulls/:n                  PATCH (title, body, state, base)
 *   GET   /repos/:o/:r/pulls/:n/reviews          .../pulls/:n/comments (review comments)
 *   GET   /repos/:o/:r/issues/:n/comments
 *   GET   /repos/:o/:r/commits/:ref/check-runs   .../commits/:ref/status (combined)
 *   GET   /repos/:o/:r/compare/:base...:head     ahead_by / behind_by / status
 *   PUT   /repos/:o/:r/pulls/:n/merge            (merge_method merge|squash)
 *   POST  /graphql  mutation enablePullRequestAutoMerge(input:{pullRequestId})
 *         (pullRequestId is the PR's `node_id`)
 *
 * Every GET 200 carries an `ETag`; a matching `If-None-Match` gives 304.
 * PR head SHAs are read from the bare repo on each request, so a
 * `git push` moves the PR (and changes its ETag).
 *
 * Test controls (what a teammate or GitHub itself would do):
 *   gh.addReview(n, { state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED', user?, body? })
 *   gh.addReviewComment(n, { body, path?, line?, user? })
 *   gh.addIssueComment(n, { body, user? })
 *   gh.setCheck(ref, name, 'success' | 'failure' | ... | 'pending')  // ref = sha or branch
 *   gh.setStatus(ref, context, 'success' | 'failure' | 'pending' | 'error')
 *   gh.merge(n)       real merge commit into the base branch of the bare repo
 *   gh.close(n)
 *   gh.rateLimit(count = 1)  the next `count` requests get 403 + x-ratelimit-remaining: 0
 *   gh.pulls / gh.requests   inspect state and the request log (method, path, status;
 *                            never headers, so no token)
 * Auto-merge: once enabled, the PR merges as soon as it is approved (latest
 * review per user, none CHANGES_REQUESTED) and green (no failing or pending
 * check run or status on the head SHA). Checked after every control and request.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
export type CheckResult =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'pending';
export type StatusState = 'success' | 'failure' | 'pending' | 'error';

export interface FakePull {
  number: number;
  node_id: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
  state: 'open' | 'closed';
  merged: boolean;
  merge_commit_sha: string | null;
  auto_merge: boolean;
  reviews: Array<{ id: number; user: string; state: ReviewState; body: string; commit_id: string }>;
  reviewComments: Array<{ id: number; user: string; body: string; path: string; line: number }>;
  issueComments: Array<{ id: number; user: string; body: string }>;
}

export interface FakeGitHubOptions {
  owner?: string;
  repo?: string;
  defaultBranch?: string;
  allowAutoMerge?: boolean;
  token?: string;
  /** Use this bare repo instead of creating one (it is then not deleted on stop). */
  bareDir?: string;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Fake GitHub',
  GIT_AUTHOR_EMAIL: 'fake-github@example.com',
  GIT_COMMITTER_NAME: 'Fake GitHub',
  GIT_COMMITTER_EMAIL: 'fake-github@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

export async function startFakeGitHub(opts: FakeGitHubOptions = {}) {
  const owner = opts.owner ?? 'acme';
  const repo = opts.repo ?? 'demo';
  const defaultBranch = opts.defaultBranch ?? 'main';
  const token = opts.token ?? 'fake-github-token';
  const ownsBare = !opts.bareDir;
  const bareDir = opts.bareDir ?? mkdtempSync(join(tmpdir(), 'agile-fake-github-'));
  const git = (args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], {
      cwd: bareDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...GIT_ENV },
    });
    return {
      ok: r.exitCode === 0,
      out: r.stdout.toString().trim(),
      err: r.stderr.toString().trim(),
    };
  };
  if (ownsBare) git(['init', '-q', '--bare', `--initial-branch=${defaultBranch}`]);

  const pulls: FakePull[] = [];
  const checks = new Map<string, Map<string, CheckResult>>(); // sha -> name -> result
  const statuses = new Map<string, Map<string, StatusState>>(); // sha -> context -> state
  const requests: Array<{ method: string; path: string; status: number }> = [];
  let nextId = 1;
  let rateLimited = 0;

  const sha = (ref: string): string | null => {
    const r = git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
    return r.ok ? r.out : null;
  };
  const pull = (n: number): FakePull => {
    const p = pulls.find((x) => x.number === n);
    if (!p) throw new Error(`fake github: no PR #${n}`);
    return p;
  };

  function approved(p: FakePull): boolean {
    const latest = new Map<string, ReviewState>();
    for (const r of p.reviews) if (r.state !== 'COMMENTED') latest.set(r.user, r.state);
    const states = [...latest.values()];
    return states.includes('APPROVED') && !states.includes('CHANGES_REQUESTED');
  }
  function checkRuns(s: string | null) {
    return [...(s ? (checks.get(s) ?? new Map()) : new Map<string, CheckResult>())].map(
      ([name, result], i) => ({
        id: i + 1,
        name,
        head_sha: s,
        status: result === 'pending' ? 'in_progress' : 'completed',
        conclusion: result === 'pending' ? null : result,
      }),
    );
  }
  function combined(s: string | null) {
    const list = [...(s ? (statuses.get(s) ?? new Map()) : new Map<string, StatusState>())].map(
      ([context, state]) => ({ context, state }),
    );
    const states = list.map((x) => x.state);
    const state = states.some((x) => x === 'failure' || x === 'error')
      ? 'failure'
      : states.length === 0 || states.includes('pending')
        ? 'pending'
        : 'success';
    return { sha: s, state, total_count: list.length, statuses: list };
  }
  function green(s: string | null): boolean {
    const ok = new Set(['success', 'neutral', 'skipped']);
    if (checkRuns(s).some((c) => !c.conclusion || !ok.has(c.conclusion))) return false;
    const st = combined(s);
    return st.total_count === 0 || st.state === 'success';
  }

  function doMerge(
    p: FakePull,
    method = 'merge',
  ): { ok: true; sha: string } | { ok: false; message: string } {
    if (p.state !== 'open') return { ok: false, message: 'Pull Request is not open' };
    const baseSha = sha(`refs/heads/${p.base}`);
    const headSha = sha(`refs/heads/${p.head}`);
    if (!baseSha || !headSha) return { ok: false, message: 'Base or head branch is missing' };
    const tree = git(['merge-tree', '--write-tree', baseSha, headSha]);
    if (!tree.ok) return { ok: false, message: 'Merge conflict' };
    const treeSha = tree.out.split('\n')[0] ?? '';
    const parents = method === 'squash' ? ['-p', baseSha] : ['-p', baseSha, '-p', headSha];
    const msg = `${method === 'squash' ? p.title : `Merge pull request #${p.number} from ${p.head}`}`;
    const commit = git(['commit-tree', treeSha, ...parents, '-m', msg]);
    if (!commit.ok) return { ok: false, message: commit.err };
    const upd = git(['update-ref', `refs/heads/${p.base}`, commit.out, baseSha]);
    if (!upd.ok) return { ok: false, message: 'Base branch moved' };
    p.state = 'closed';
    p.merged = true;
    p.merge_commit_sha = commit.out;
    return { ok: true, sha: commit.out };
  }
  function settleAutoMerge() {
    for (const p of pulls) {
      if (p.state === 'open' && p.auto_merge && approved(p) && green(sha(`refs/heads/${p.head}`)))
        doMerge(p);
    }
  }

  function pullJson(p: FakePull) {
    const headSha = sha(`refs/heads/${p.head}`);
    const baseSha = sha(`refs/heads/${p.base}`);
    let mergeable: boolean | null = null;
    let mergeableState = 'unknown';
    if (p.state === 'open' && headSha && baseSha) {
      mergeable = git(['merge-tree', '--write-tree', baseSha, headSha]).ok;
      const behind = !git(['merge-base', '--is-ancestor', baseSha, headSha]).ok;
      mergeableState = !mergeable
        ? 'dirty'
        : !approved(p) || !green(headSha)
          ? 'blocked'
          : behind
            ? 'behind'
            : 'clean';
    }
    return {
      number: p.number,
      node_id: p.node_id,
      html_url: `https://github.com/${owner}/${repo}/pull/${p.number}`,
      title: p.title,
      body: p.body,
      state: p.state,
      draft: p.draft,
      merged: p.merged,
      merge_commit_sha: p.merge_commit_sha,
      mergeable,
      mergeable_state: mergeableState,
      auto_merge: p.auto_merge ? { merge_method: 'merge' } : null,
      head: { ref: p.head, sha: headSha },
      base: { ref: p.base, sha: baseSha },
    };
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const notFound = () => json(404, { message: 'Not Found' });

  async function route(req: Request, parts: string[], url: URL): Promise<Response> {
    const m = req.method;
    const body =
      m === 'GET' ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);

    if (parts[0] === 'graphql' && m === 'POST') {
      const q = String(body.query ?? '');
      if (!q.includes('enablePullRequestAutoMerge'))
        return json(200, { errors: [{ message: 'unsupported' }] });
      const vars = (body.variables ?? {}) as Record<string, unknown>;
      const id = String(vars.pullRequestId ?? /pullRequestId:\s*"([^"]+)"/.exec(q)?.[1] ?? '');
      const p = pulls.find((x) => x.node_id === id);
      if (!p)
        return json(200, {
          errors: [{ message: `Could not resolve to a node with the global id of '${id}'` }],
        });
      if (opts.allowAutoMerge === false)
        return json(200, {
          errors: [{ message: 'Auto merge is not allowed for this repository' }],
        });
      if (p.state !== 'open')
        return json(200, { errors: [{ message: 'Pull request is not open' }] });
      p.auto_merge = true;
      settleAutoMerge();
      return json(200, {
        data: { enablePullRequestAutoMerge: { pullRequest: { id: p.node_id, number: p.number } } },
      });
    }

    if (parts[0] !== 'repos' || parts[1] !== owner || parts[2] !== repo) return notFound();
    const [, , , kind, a, b] = parts;
    if (!kind && m === 'GET')
      return json(200, {
        full_name: `${owner}/${repo}`,
        name: repo,
        owner: { login: owner },
        default_branch: defaultBranch,
        allow_auto_merge: opts.allowAutoMerge ?? true,
      });

    if (kind === 'pulls' && !a) {
      if (m === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const head = url.searchParams.get('head')?.replace(/^[^:]+:/, '');
        const base = url.searchParams.get('base');
        return json(
          200,
          pulls
            .filter(
              (p) =>
                (state === 'all' || p.state === state) &&
                (!head || p.head === head) &&
                (!base || p.base === base),
            )
            .map(pullJson),
        );
      }
      if (m === 'POST') {
        const head = String(body.head ?? '').replace(/^[^:]+:/, '');
        const base = String(body.base ?? defaultBranch);
        if (!body.title || !sha(`refs/heads/${head}`) || !sha(`refs/heads/${base}`))
          return json(422, { message: 'Validation Failed' });
        if (pulls.some((p) => p.state === 'open' && p.head === head && p.base === base))
          return json(422, { message: `A pull request already exists for ${owner}:${head}.` });
        const number = pulls.length + 1;
        const p: FakePull = {
          number,
          node_id: `PR_fake${number}`,
          title: String(body.title),
          body: String(body.body ?? ''),
          head,
          base,
          draft: body.draft === true,
          state: 'open',
          merged: false,
          merge_commit_sha: null,
          auto_merge: false,
          reviews: [],
          reviewComments: [],
          issueComments: [],
        };
        pulls.push(p);
        return json(201, pullJson(p));
      }
    }

    if (kind === 'pulls' && a) {
      const p = pulls.find((x) => x.number === Number(a));
      if (!p) return notFound();
      if (!b && m === 'GET') return json(200, pullJson(p));
      if (!b && m === 'PATCH') {
        if (typeof body.title === 'string') p.title = body.title;
        if (typeof body.body === 'string') p.body = body.body;
        if (typeof body.base === 'string') p.base = body.base;
        if (body.state === 'closed' && !p.merged) p.state = 'closed';
        if (body.state === 'open' && !p.merged) p.state = 'open';
        return json(200, pullJson(p));
      }
      if (b === 'reviews' && m === 'GET')
        return json(
          200,
          p.reviews.map((r) => ({
            id: r.id,
            user: { login: r.user },
            state: r.state,
            body: r.body,
            commit_id: r.commit_id,
          })),
        );
      if (b === 'comments' && m === 'GET')
        return json(
          200,
          p.reviewComments.map((c) => ({
            id: c.id,
            user: { login: c.user },
            body: c.body,
            path: c.path,
            line: c.line,
          })),
        );
      if (b === 'merge' && m === 'PUT') {
        const r = doMerge(p, String(body.merge_method ?? 'merge'));
        return r.ok
          ? json(200, { merged: true, sha: r.sha, message: 'Pull Request successfully merged' })
          : json(405, r);
      }
    }

    if (kind === 'issues' && a && b === 'comments' && m === 'GET') {
      const p = pulls.find((x) => x.number === Number(a));
      if (!p) return notFound();
      return json(
        200,
        p.issueComments.map((c) => ({ id: c.id, user: { login: c.user }, body: c.body })),
      );
    }

    if (kind === 'commits' && a && m === 'GET') {
      // A ref may contain slashes: everything between `commits/` and the last segment.
      const ref = decodeURIComponent(parts.slice(4, -1).join('/'));
      const last = parts[parts.length - 1];
      const s = sha(ref) ?? (/^[0-9a-f]{40}$/.test(ref) ? ref : null);
      if (!s) return json(422, { message: `No commit found for SHA: ${ref}` });
      if (last === 'check-runs') {
        const runs = checkRuns(s);
        return json(200, { total_count: runs.length, check_runs: runs });
      }
      if (last === 'status') return json(200, combined(s));
    }

    if (kind === 'compare' && a && m === 'GET') {
      const [base = '', head = ''] = decodeURIComponent(parts.slice(4).join('/')).split('...');
      const bs = sha(base);
      const hs = sha(head);
      if (!bs || !hs) return notFound();
      const counts = git(['rev-list', '--left-right', '--count', `${bs}...${hs}`])
        .out.split(/\s+/)
        .map(Number);
      const behind = counts[0] ?? 0;
      const ahead = counts[1] ?? 0;
      const status =
        ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'identical';
      return json(200, { status, ahead_by: ahead, behind_by: behind, base_commit: { sha: bs } });
    }

    return notFound();
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const log = (res: Response) => {
        requests.push({ method: req.method, path: url.pathname + url.search, status: res.status });
        return res;
      };
      const auth = req.headers.get('authorization') ?? '';
      if (auth !== `Bearer ${token}` && auth !== `token ${token}`)
        return log(json(401, { message: 'Bad credentials' }));
      if (rateLimited > 0) {
        rateLimited--;
        return log(
          json(
            403,
            { message: 'API rate limit exceeded' },
            {
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
            },
          ),
        );
      }
      settleAutoMerge();
      const parts = url.pathname.split('/').filter(Boolean);
      let res = await route(req, parts, url);
      if (req.method === 'GET' && res.status === 200) {
        const text = await res.text();
        const etag = `"${new Bun.CryptoHasher('sha1').update(text).digest('hex')}"`;
        res =
          req.headers.get('if-none-match') === etag
            ? new Response(null, { status: 304, headers: { etag } })
            : new Response(text, {
                status: 200,
                headers: { 'content-type': 'application/json', etag },
              });
      }
      return log(res);
    },
  });

  const commitOf = (ref: string) => {
    const s = sha(ref) ?? sha(`refs/heads/${ref}`);
    if (!s) throw new Error(`fake github: unknown ref ${ref}`);
    return s;
  };

  return {
    apiUrl: `http://127.0.0.1:${server.port}`,
    token,
    owner,
    repo,
    bareDir,
    remoteUrl: `file://${bareDir}`,
    pulls: pulls as readonly FakePull[],
    requests,
    addReview(n: number, r: { state: ReviewState; user?: string; body?: string }) {
      const p = pull(n);
      p.reviews.push({
        id: nextId++,
        user: r.user ?? 'reviewer',
        state: r.state,
        body: r.body ?? '',
        commit_id: sha(`refs/heads/${p.head}`) ?? '',
      });
      settleAutoMerge();
    },
    addReviewComment(n: number, c: { body: string; path?: string; line?: number; user?: string }) {
      pull(n).reviewComments.push({
        id: nextId++,
        user: c.user ?? 'reviewer',
        body: c.body,
        path: c.path ?? 'README.md',
        line: c.line ?? 1,
      });
    },
    addIssueComment(n: number, c: { body: string; user?: string }) {
      pull(n).issueComments.push({ id: nextId++, user: c.user ?? 'reviewer', body: c.body });
    },
    setCheck(ref: string, name: string, result: CheckResult) {
      const s = commitOf(ref);
      if (!checks.has(s)) checks.set(s, new Map());
      checks.get(s)?.set(name, result);
      settleAutoMerge();
    },
    setStatus(ref: string, context: string, state: StatusState) {
      const s = commitOf(ref);
      if (!statuses.has(s)) statuses.set(s, new Map());
      statuses.get(s)?.set(context, state);
      settleAutoMerge();
    },
    merge(n: number, method: 'merge' | 'squash' = 'merge') {
      const r = doMerge(pull(n), method);
      if (!r.ok) throw new Error(`fake github: merge #${n} failed: ${r.message}`);
      return r.sha;
    },
    close(n: number) {
      const p = pull(n);
      if (!p.merged) p.state = 'closed';
    },
    rateLimit(count = 1) {
      rateLimited = count;
    },
    async stop() {
      server.stop(true);
      if (ownsBare) rmSync(bareDir, { recursive: true, force: true });
    },
  };
}

export type FakeGitHub = Awaited<ReturnType<typeof startFakeGitHub>>;
