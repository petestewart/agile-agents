/**
 * The REST adapter for the GitHub port (projects-design §18, P18/D32):
 * `fetch` against `github.api_url`, with the user's own `gh` login.
 *
 * The token is fetched from `gh auth token` for each call, held in a local
 * for that call only, and never stored, logged, put in an error or event,
 * or sent to the browser. A static token is accepted only when `api_url`
 * is a loopback address (the fake GitHub in tests).
 */

import {
  type Conditional,
  type CreatePullInput,
  GitHubError,
  type GitHubPort,
  type GitHubPull,
  type ReadOptions,
  type RepoRef,
  type UpdatePullInput,
} from './port';

import { DEFAULT_GITHUB_API_URL } from '@agile-agents/shared';

const GH_LOGIN_HINT = 'run `gh auth login`';

/** Where a token comes from; called once per request. */
export type TokenSource = () => Promise<string>;

/**
 * `gh auth token`, with stdout captured and never echoed. A missing or
 * logged-out `gh` is one `auth` error naming the fix.
 */
export const GH_TOKEN_TIMEOUT_MS = 2000;

export function ghTokenSource(ghCommand = 'gh', timeoutMs = GH_TOKEN_TIMEOUT_MS): TokenSource {
  return async () => {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([ghCommand, 'auth', 'token'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      });
    } catch {
      throw new GitHubError(
        `GitHub auth unavailable: \`gh\` not found — install the GitHub CLI and ${GH_LOGIN_HINT}`,
        'auth',
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const result = await Promise.race([
      Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]),
      timedOut,
    ]);
    clearTimeout(timer);
    if (result === 'timeout') {
      proc.kill();
      throw new GitHubError(
        `GitHub auth unavailable: \`gh auth token\` timed out — ${GH_LOGIN_HINT}`,
        'auth',
      );
    }
    const [out, code] = result;
    const token = out.trim();
    if (code !== 0 || token === '')
      throw new GitHubError(
        `GitHub auth unavailable: \`gh\` is not logged in — ${GH_LOGIN_HINT}`,
        'auth',
      );
    return token;
  };
}

/** For `agile daemon status`: whether a token could be had, never the token. */
export async function githubAuthAvailable(source: TokenSource = ghTokenSource()): Promise<boolean> {
  try {
    await source();
    return true;
  } catch {
    return false;
  }
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === 'localhost' || host === '[::1]' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * `owner/repo` from a GitHub remote: `git@github.com:o/r.git`,
 * `ssh://git@github.com/o/r.git`, `https://github.com/o/r(.git)`.
 * Credentials in an https URL are dropped, never returned.
 */
export function repoFromRemoteUrl(remoteUrl: string): RepoRef {
  const url = remoteUrl.trim();
  const scp = /^[^@/\s]+@[^:/\s]+:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  let path: string[] | undefined;
  if (scp?.[1] && scp[2]) path = [scp[1], scp[2]];
  else {
    try {
      const u = new URL(url);
      if (['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol))
        path = u.pathname
          .replace(/\.git\/?$/, '')
          .split('/')
          .filter(Boolean);
    } catch {
      // fall through
    }
  }
  const [owner, repo] = path ?? [];
  if (path?.length !== 2 || !owner || !repo)
    throw new Error('cannot infer GitHub owner/repo from the remote URL (expected …/owner/repo)');
  return { owner, repo };
}

export interface GitHubRestOptions {
  /** `github.api_url`; default `https://api.github.com`. */
  apiUrl?: string;
  /** Either `repo`, or a `remoteUrl` to infer it from. */
  repo?: RepoRef;
  remoteUrl?: string;
  /** Tests only: refused unless `apiUrl` is loopback. */
  staticToken?: string;
  /** Defaults to `gh auth token`. */
  tokenSource?: TokenSource;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const login = (u: unknown): string => str((u as Json | null)?.login);

function toPull(p: Json): GitHubPull {
  const side = (s: unknown) => {
    const o = (s ?? {}) as Json;
    return { ref: str(o.ref), sha: typeof o.sha === 'string' ? o.sha : null };
  };
  return {
    number: Number(p.number),
    node_id: str(p.node_id),
    html_url: str(p.html_url),
    title: str(p.title),
    body: str(p.body),
    state: p.state === 'closed' ? 'closed' : 'open',
    draft: p.draft === true,
    merged: p.merged === true,
    merge_commit_sha: typeof p.merge_commit_sha === 'string' ? p.merge_commit_sha : null,
    mergeable: typeof p.mergeable === 'boolean' ? p.mergeable : null,
    mergeable_state: str(p.mergeable_state) || 'unknown',
    auto_merge: p.auto_merge != null && p.auto_merge !== false,
    head: side(p.head),
    base: side(p.base),
  };
}

export function createGitHubRest(options: GitHubRestOptions): GitHubPort {
  const apiUrl = (options.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/+$/, '');
  if (options.staticToken !== undefined && !isLoopbackUrl(apiUrl))
    throw new Error('a static GitHub token is only accepted for a loopback api_url (tests)');
  const staticToken = options.staticToken;
  const tokenSource: TokenSource =
    staticToken !== undefined ? async () => staticToken : (options.tokenSource ?? ghTokenSource());
  const doFetch = options.fetch ?? fetch;
  const repo =
    options.repo ??
    (options.remoteUrl !== undefined ? repoFromRemoteUrl(options.remoteUrl) : undefined);
  if (!repo) throw new Error('createGitHubRest needs `repo` or `remoteUrl`');
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;

  async function call(
    method: string,
    path: string,
    body?: unknown,
    etag?: string,
  ): Promise<{ status: number; json: unknown; etag: string | null }> {
    const token = await tokenSource();
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (etag) headers['if-none-match'] = etag;
    let res: Response;
    try {
      res = await doFetch(`${apiUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      // The fetch error names the URL at most; never the headers.
      throw new GitHubError(`GitHub ${method} ${path}: ${(err as Error).message}`, 'http');
    }
    const resEtag = res.headers.get('etag');
    if (res.status === 304) return { status: 304, json: null, etag: resEtag ?? etag ?? null };
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.ok) return { status: res.status, json, etag: resEtag };
    const message = str((json as Json | null)?.message) || res.statusText || 'error';
    const what = `GitHub ${method} ${path}: ${res.status} ${message}`;
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (
      (res.status === 403 || res.status === 429) &&
      (remaining === '0' || res.headers.has('retry-after'))
    ) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      throw new GitHubError(
        what,
        'rate_limited',
        res.status,
        Number.isFinite(reset) && reset > 0 ? reset : undefined,
      );
    }
    if (res.status === 401) throw new GitHubError(`${what} — ${GH_LOGIN_HINT}`, 'auth', 401);
    if (res.status === 404) throw new GitHubError(what, 'not_found', 404);
    if (res.status === 422) throw new GitHubError(what, 'validation', 422);
    if (res.status === 405) throw new GitHubError(what, 'not_mergeable', 405);
    throw new GitHubError(what, 'http', res.status);
  }

  async function read<T>(
    path: string,
    map: (j: unknown) => T,
    opts?: ReadOptions,
  ): Promise<Conditional<T>> {
    const r = await call('GET', path, undefined, opts?.etag);
    if (r.status === 304) return { notModified: true, etag: r.etag ?? '' };
    return { notModified: false, data: map(r.json), etag: r.etag };
  }
  const list = (j: unknown): Json[] => (Array.isArray(j) ? (j as Json[]) : []);
  const ref = (r: string) => r.split('/').map(encodeURIComponent).join('/');

  return {
    repo,
    async getRepo() {
      const j = (await call('GET', base)).json as Json;
      return {
        default_branch: str(j.default_branch),
        allow_auto_merge: j.allow_auto_merge === true,
      };
    },
    async createPull(input: CreatePullInput) {
      return toPull((await call('POST', `${base}/pulls`, input)).json as Json);
    },
    async updatePull(number: number, input: UpdatePullInput) {
      return toPull((await call('PATCH', `${base}/pulls/${number}`, input)).json as Json);
    },
    getPull: (number, opts) => read(`${base}/pulls/${number}`, (j) => toPull(j as Json), opts),
    async listPulls(filter = {}) {
      const q = new URLSearchParams({ state: filter.state ?? 'open', per_page: '100' });
      if (filter.head) q.set('head', `${repo.owner}:${filter.head}`);
      if (filter.base) q.set('base', filter.base);
      return list((await call('GET', `${base}/pulls?${q}`)).json).map(toPull);
    },
    listReviews: (number, opts) =>
      read(
        `${base}/pulls/${number}/reviews?per_page=100`,
        (j) =>
          list(j).map((r) => ({
            id: Number(r.id),
            user: login(r.user),
            state: str(r.state),
            body: str(r.body),
            commit_id: str(r.commit_id),
          })),
        opts,
      ),
    listReviewComments: (number, opts) =>
      read(
        `${base}/pulls/${number}/comments?per_page=100`,
        (j) =>
          list(j).map((c) => ({
            id: Number(c.id),
            user: login(c.user),
            body: str(c.body),
            path: str(c.path),
            line: typeof c.line === 'number' ? c.line : null,
          })),
        opts,
      ),
    listIssueComments: (number, opts) =>
      read(
        `${base}/issues/${number}/comments?per_page=100`,
        (j) => list(j).map((c) => ({ id: Number(c.id), user: login(c.user), body: str(c.body) })),
        opts,
      ),
    listCheckRuns: (r, opts) =>
      read(
        `${base}/commits/${ref(r)}/check-runs?per_page=100`,
        (j) =>
          list((j as Json | null)?.check_runs).map((c) => ({
            id: Number(c.id),
            name: str(c.name),
            status: str(c.status),
            conclusion: typeof c.conclusion === 'string' ? c.conclusion : null,
          })),
        opts,
      ),
    getCombinedStatus: (r, opts) =>
      read(
        `${base}/commits/${ref(r)}/status`,
        (j) => {
          const o = (j ?? {}) as Json;
          return {
            state: (str(o.state) || 'pending') as 'success' | 'failure' | 'pending' | 'error',
            statuses: list(o.statuses).map((s) => ({
              context: str(s.context),
              state: str(s.state),
            })),
          };
        },
        opts,
      ),
    async enableAutoMerge(nodeId: string) {
      const query =
        'mutation($pullRequestId: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) { pullRequest { id } } }';
      const j = (await call('POST', '/graphql', { query, variables: { pullRequestId: nodeId } }))
        .json as Json | null;
      const errors = list(j?.errors);
      if (errors.length > 0)
        throw new GitHubError(
          `GitHub enablePullRequestAutoMerge: ${errors.map((e) => str(e.message)).join('; ')}`,
          'graphql',
        );
    },
    async mergePull(number: number, method: 'merge' | 'squash' = 'merge') {
      const j = (await call('PUT', `${base}/pulls/${number}/merge`, { merge_method: method }))
        .json as Json;
      return { sha: str(j.sha) };
    },
    async compare(baseRef: string, headRef: string) {
      const j = (await call('GET', `${base}/compare/${ref(baseRef)}...${ref(headRef)}`))
        .json as Json;
      return {
        status: str(j.status) as 'ahead' | 'behind' | 'diverged' | 'identical',
        ahead_by: Number(j.ahead_by ?? 0),
        behind_by: Number(j.behind_by ?? 0),
      };
    },
  };
}
