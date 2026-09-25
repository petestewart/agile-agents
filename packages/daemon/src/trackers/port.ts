/**
 * The tracker port (projects-design §14.10, Phase 13): the subset of Jira
 * and Linear the daemon uses. `jira.ts` (REST) and `linear.ts` (GraphQL)
 * are the adapters; tests run them against `fake-jira.ts` and
 * `fake-linear.ts`.
 *
 * Tokens (D31) are passed in by the caller from `config.yaml` and live only
 * in the adapter's closure. No adapter logs, and no error message ever
 * carries a token or an auth header.
 */

import type { TrackerSystem } from '@agile-agents/shared';

export interface TrackerIssue {
  /** The human key: `SHOP-11` in both systems. */
  key: string;
  /** The system's own id (Jira numeric id, Linear uuid). */
  id: string;
  title: string;
  /** Plain text (Jira's ADF flattened). */
  description: string;
  status: string;
  url: string;
  kind: 'epic' | 'issue';
  /** Parent (epic) key, when there is one. */
  parent?: string;
}

export interface CreateIssueInput {
  /** Jira project key or Linear team key (`SHOP`). */
  project: string;
  title: string;
  description?: string;
  /** Parent (epic) key. */
  parent?: string;
}

export type TrackerErrorKind =
  | 'auth'
  | 'rate_limited'
  | 'not_found'
  /** Bad input, or a status name with no matching transition/state. */
  | 'validation'
  | 'http';

export class TrackerError extends Error {
  constructor(
    message: string,
    readonly kind: TrackerErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TrackerError';
  }
}

export interface TrackerPort {
  readonly system: TrackerSystem;
  getIssue(key: string): Promise<TrackerIssue>;
  /** The issues whose parent is `epicKey`. */
  listEpicChildren(epicKey: string): Promise<TrackerIssue[]>;
  addComment(key: string, body: string): Promise<{ id: string }>;
  /** A web link on the issue (Jira remote link, Linear attachment). */
  addLink(key: string, link: { url: string; title: string }): Promise<void>;
  /** Moves the issue to the status/state named `status` (case-insensitive). */
  transitionStatus(key: string, status: string): Promise<void>;
  createIssue(input: CreateIssueInput): Promise<TrackerIssue>;
}

/** Maps an HTTP status to an error kind; the message never carries a response body or header. */
export function httpError(system: TrackerSystem, what: string, status: number): TrackerError {
  const kind: TrackerErrorKind =
    status === 401 || status === 403
      ? 'auth'
      : status === 429
        ? 'rate_limited'
        : status === 404
          ? 'not_found'
          : status === 400 || status === 422
            ? 'validation'
            : 'http';
  const hint = kind === 'auth' ? ` — check trackers.${system} in config.yaml` : '';
  return new TrackerError(`${system}: ${what} failed (${status})${hint}`, kind, status);
}
