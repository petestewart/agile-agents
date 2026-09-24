/**
 * The GitHub port (projects-design §18): the subset of GitHub the daemon
 * uses, bound to one repository. `rest.ts` is the one adapter; tests run it
 * against `fake-server.ts`.
 *
 * Reads the PR poller repeats take an optional ETag and answer
 * `{ notModified: true }` on a 304, so polling costs no rate limit when
 * nothing changed.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface GitHubRepoInfo {
  default_branch: string;
  allow_auto_merge: boolean;
}

export interface GitHubPull {
  number: number;
  /** GraphQL id, for `enablePullRequestAutoMerge`. */
  node_id: string;
  html_url: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  merge_commit_sha: string | null;
  mergeable: boolean | null;
  mergeable_state: string;
  auto_merge: boolean;
  head: { ref: string; sha: string | null };
  base: { ref: string; sha: string | null };
}

export interface GitHubReview {
  id: number;
  user: string;
  state: string;
  body: string;
  commit_id: string;
}

export interface GitHubReviewComment {
  id: number;
  user: string;
  body: string;
  path: string;
  line: number | null;
}

export interface GitHubIssueComment {
  id: number;
  user: string;
  body: string;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  /** The run's `output` summary and text, joined (T246: the CI log excerpt); absent when empty. */
  output?: string;
}

export interface GitHubCombinedStatus {
  state: 'success' | 'failure' | 'pending' | 'error';
  statuses: Array<{ context: string; state: string }>;
}

export interface GitHubCompare {
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  ahead_by: number;
  behind_by: number;
}

/** A conditional read: fresh data with its ETag, or a 304. */
export type Conditional<T> =
  | { notModified: false; data: T; etag: string | null }
  | { notModified: true; etag: string };

export interface ReadOptions {
  /** Sent as `If-None-Match`. */
  etag?: string;
}

export interface CreatePullInput {
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

export interface UpdatePullInput {
  title?: string;
  body?: string;
  base?: string;
  state?: 'open' | 'closed';
}

export type GitHubErrorKind =
  /** `gh` missing or logged out, or the token was refused (401). */
  | 'auth'
  /** 403/429 with `x-ratelimit-remaining: 0` or `retry-after`. */
  | 'rate_limited'
  | 'not_found'
  /** 422: e.g. a PR already exists for the branch. */
  | 'validation'
  /** 405 on merge: not mergeable. */
  | 'not_mergeable'
  | 'graphql'
  | 'http';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly kind: GitHubErrorKind,
    readonly status?: number,
    /** Epoch seconds when a rate limit lifts, when GitHub said. */
    readonly resetAt?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GitHubPort {
  readonly repo: RepoRef;
  getRepo(): Promise<GitHubRepoInfo>;
  createPull(input: CreatePullInput): Promise<GitHubPull>;
  updatePull(number: number, input: UpdatePullInput): Promise<GitHubPull>;
  getPull(number: number, opts?: ReadOptions): Promise<Conditional<GitHubPull>>;
  /** Open PRs by default; `head` is a branch name in this repo. */
  listPulls(filter?: {
    state?: 'open' | 'closed' | 'all';
    head?: string;
    base?: string;
  }): Promise<GitHubPull[]>;
  listReviews(number: number, opts?: ReadOptions): Promise<Conditional<GitHubReview[]>>;
  listReviewComments(
    number: number,
    opts?: ReadOptions,
  ): Promise<Conditional<GitHubReviewComment[]>>;
  listIssueComments(number: number, opts?: ReadOptions): Promise<Conditional<GitHubIssueComment[]>>;
  listCheckRuns(ref: string, opts?: ReadOptions): Promise<Conditional<GitHubCheckRun[]>>;
  getCombinedStatus(ref: string, opts?: ReadOptions): Promise<Conditional<GitHubCombinedStatus>>;
  /** GraphQL `enablePullRequestAutoMerge` on the PR's `node_id`. */
  enableAutoMerge(nodeId: string): Promise<void>;
  /** Only the fake supports this in tests; real merges are GitHub's (auto-merge) or the human's. */
  mergePull(number: number, method?: 'merge' | 'squash'): Promise<{ sha: string }>;
  compare(base: string, head: string): Promise<GitHubCompare>;
}
