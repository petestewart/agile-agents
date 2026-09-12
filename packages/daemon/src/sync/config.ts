/**
 * Jira link settings resolution (T045). Splits the configuration in two, on
 * purpose:
 *
 * - **Non-secret** (`baseUrl`, `projectKey`, `pollIntervalMs`) comes from the
 *   host-local `agile.config.yaml` (`jira:` block) with env overrides — see
 *   `../config.ts`, which already owns that file.
 * - **Secret** (`JIRA_EMAIL`, `JIRA_API_TOKEN`) is read straight from
 *   `process.env` here and returned in a value that only ever reaches
 *   `HttpJiraClient`'s constructor. Nothing in this module writes either to
 *   `.agile/` — the ticket's hard rule ("credentials from the user's
 *   environment, never in `.agile/`"), and the same rule adapters follow for
 *   vendor logins.
 *
 * `resolveJiraSettings` returns `undefined` when the integration is not
 * configured, which is what makes the `daemon.ts` wiring a no-op on every
 * repo that has never touched Jira.
 */

import type { AgileConfig } from '../config';

export interface JiraSettings {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Optional default project key — `sync.jira_link` may name a different one. */
  projectKey?: string;
  pollIntervalMs: number;
}

/** CLAUDE.md's tunables are all in this range; a Jira pull is cheap but not free. */
export const DEFAULT_JIRA_POLL_INTERVAL_MS = 60 * 1000;

export interface ResolveJiraOptions {
  /** Test seam — defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export function resolveJiraSettings(
  config: Pick<AgileConfig, 'jira'>,
  options: ResolveJiraOptions = {},
): JiraSettings | undefined {
  const env = options.env ?? process.env;
  const baseUrl = env.JIRA_BASE_URL ?? config.jira?.baseUrl;
  const email = env.JIRA_EMAIL;
  const apiToken = env.JIRA_API_TOKEN;
  // All three are required: a base URL with no credentials cannot call a
  // single endpoint, and credentials with no base URL have nowhere to go.
  if (!baseUrl || !email || !apiToken) return undefined;

  const envPoll = env.JIRA_POLL_INTERVAL_MS ? Number(env.JIRA_POLL_INTERVAL_MS) : undefined;
  const pollIntervalMs =
    envPoll !== undefined && Number.isFinite(envPoll) && envPoll > 0
      ? envPoll
      : (config.jira?.pollIntervalMs ?? DEFAULT_JIRA_POLL_INTERVAL_MS);

  const projectKey = env.JIRA_PROJECT_KEY ?? config.jira?.projectKey;
  return {
    baseUrl,
    email,
    apiToken,
    ...(projectKey ? { projectKey } : {}),
    pollIntervalMs,
  };
}
