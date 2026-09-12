/**
 * Jira link settings (T045). Splits the configuration in three, on purpose:
 *
 * - **Secret** (`JIRA_EMAIL`, `JIRA_API_TOKEN`) is read straight from
 *   `process.env` and returned in a value that only ever reaches
 *   `HttpJiraClient`'s constructor. Nothing here writes either to a file —
 *   the ticket's hard rule ("credentials from the user's environment, never
 *   in `.agile/`"), and the same rule adapters follow for vendor logins.
 * - **Host-local, non-secret** (`baseUrl`, `pollIntervalMs`) comes from the
 *   `jira:` block of the repo-root `agile.config.yaml`, with env overrides —
 *   see `../config.ts`, which already owns reading that file.
 * - **The link itself** (`jira.project`) lives in that same file and is
 *   *written* here, by `agile sync jira link|unlink` and the equivalent RPC/
 *   HTTP actions. Deliberately not an `.agile/` artifact: T045 names exactly
 *   one new piece of durable sync state, the per-ticket mapping. A project
 *   key is not a secret, so a repo that commits `agile.config.yaml` leaks
 *   nothing by committing this.
 *
 * `resolveJiraSettings` returns `undefined` when the integration is not
 * configured, which is what makes the `daemon.ts` wiring a no-op on every
 * repo that has never touched Jira.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgileConfig } from '../config';

export interface JiraSettings {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** The linked project key at daemon start, if any — `link`/`unlink` change it at runtime. */
  project?: string;
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

  const project = env.JIRA_PROJECT_KEY ?? config.jira?.project;
  return {
    baseUrl,
    email,
    apiToken,
    ...(project ? { project } : {}),
    pollIntervalMs,
  };
}

function readConfigDocument(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const parsed = parseYaml(readFileSync(configPath, 'utf8'));
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${configPath} must be a mapping, got ${typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}

/** The `jira.project` key of `agile.config.yaml`, or `undefined`. */
export function readLinkedProject(configPath: string): string | undefined {
  const jira = readConfigDocument(configPath).jira;
  if (typeof jira !== 'object' || jira === null || Array.isArray(jira)) return undefined;
  const project = (jira as { project?: unknown }).project;
  return typeof project === 'string' && project.length > 0 ? project : undefined;
}

/**
 * Read-modify-write of `jira.project` in `agile.config.yaml`: creates the
 * file if absent, preserves every other key (including every other key of
 * the `jira:` block), and drops the key entirely when `project` is
 * `undefined`. Never writes a credential — the caller only ever hands it a
 * project key, and nothing else on this path has one.
 */
export function writeLinkedProject(configPath: string, project: string | undefined): void {
  const { jira: existing, ...rest } = readConfigDocument(configPath);
  const { project: _previous, ...otherJiraKeys } =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};

  const jira: Record<string, unknown> =
    project === undefined ? otherJiraKeys : { ...otherJiraKeys, project };

  const document =
    Object.keys(jira).length > 0 ? ({ ...rest, jira } as Record<string, unknown>) : rest;

  writeFileSync(configPath, stringifyYaml(document), 'utf8');
}
