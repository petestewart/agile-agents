/**
 * Jira Cloud REST v3 client, behind a small interface (T045 — design/
 * agile-agents-design.md §17 "Control room v2": "**Jira is two-way sync**,
 * not import").
 *
 * `JiraClient` is the only surface `JiraSync` (`./jira.ts`) talks to, so the
 * offline test can stand up a three-route `Bun.serve` fake rather than a
 * mock of the whole REST surface, and so a future tracker (GitHub issues,
 * Linear) can be added as a second implementation instead of a second sync
 * engine.
 *
 * Endpoints used (Jira Cloud platform REST v3):
 *   GET  /rest/api/3/search/jql?jql=...   incremental pull
 *   PUT  /rest/api/3/issue/<key>          summary/description push
 *   GET  /rest/api/3/issue/<key>/transitions   available transitions
 *   POST /rest/api/3/issue/<key>/transitions   status push
 *
 * Auth is HTTP basic with the operator's own account email + API token
 * (Atlassian's documented Cloud scheme). The daemon holds no credentials of
 * its own and never persists these — same rule adapters follow for vendor
 * logins (CLAUDE.md "No vendor credentials in the daemon").
 */

/** The normalised issue shape the sync engine works in — plain text, not ADF. */
export interface JiraIssue {
  key: string;
  summary: string;
  /** Flattened to plain text; see `adfToText`. */
  description: string;
  /** `fields.status.name`, e.g. `To Do`. */
  status: string;
  /** `fields.updated` — ISO-8601. The pull cursor and half the conflict rule. */
  updated: string;
}

export interface JiraClient {
  /**
   * Every issue in `projectKey` whose `updated` is at or after `since`
   * (omit for "everything"), oldest first. `since` is inclusive by design:
   * Jira's JQL `updated >=` has minute granularity, so an exclusive cursor
   * would drop a second issue edited in the same minute as the last one
   * pulled. Re-seeing an issue is harmless — the shadow comparison in
   * `jira.ts` makes a no-change pull a no-op.
   */
  searchUpdatedSince(projectKey: string, since?: string): Promise<JiraIssue[]>;
  /** Push title/description. Omitted fields are left alone. */
  updateIssue(key: string, fields: { summary?: string; description?: string }): Promise<void>;
  /** Push status by *target status name*; resolves the transition id itself. */
  transitionIssue(key: string, statusName: string): Promise<void>;
}

export class JiraApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}

/**
 * Atlassian Document Format -> plain text. v3 returns rich `description`
 * documents; the local ticket carries prose. Walks the node tree collecting
 * `text` leaves, one line per top-level block — enough to round-trip
 * anything this integration writes (see `textToAdf`) and to render anything
 * a human typed in Jira as readable prose.
 */
export function adfToText(doc: unknown): string {
  if (doc === null || doc === undefined) return '';
  if (typeof doc === 'string') return doc;
  if (typeof doc !== 'object') return '';

  const node = doc as { type?: string; text?: string; content?: unknown[] };
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';

  const parts = node.content.map((child) => adfToText(child));
  // Top-level blocks (paragraphs) become lines; inline runs concatenate.
  return node.type === 'doc' ? parts.join('\n') : parts.join('');
}

/** Plain text -> minimal ADF document (one paragraph per line; empty lines dropped). */
export function textToAdf(text: string): unknown {
  const paragraphs = text.split('\n');
  return {
    type: 'doc',
    version: 1,
    content: paragraphs
      .filter((line) => line.length > 0)
      .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  };
}

export interface HttpJiraClientOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Test seam — defaults to global `fetch`. */
  fetch?: typeof fetch;
}

interface RawIssue {
  key?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    updated?: string;
  };
}

function normalise(raw: RawIssue): JiraIssue {
  return {
    key: raw.key ?? '',
    summary: raw.fields?.summary ?? '',
    description: adfToText(raw.fields?.description),
    status: raw.fields?.status?.name ?? '',
    updated: raw.fields?.updated ?? '',
  };
}

/** JQL is a quoted-string language; a stray `"` or `\` would otherwise change the query's meaning. */
function jqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class HttpJiraClient implements JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly doFetch: typeof fetch;

  constructor(options: HttpJiraClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.authHeader = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString('base64')}`;
    this.doFetch = options.fetch ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: this.authHeader,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new JiraApiError(response.status, `jira ${init.method ?? 'GET'} ${path}: ${body}`);
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : undefined;
  }

  async searchUpdatedSince(projectKey: string, since?: string): Promise<JiraIssue[]> {
    const clauses = [`project = ${jqlString(projectKey)}`];
    if (since) clauses.push(`updated >= ${jqlString(toJqlTimestamp(since))}`);
    const jql = `${clauses.join(' AND ')} ORDER BY updated ASC`;
    const query = new URLSearchParams({
      jql,
      fields: 'summary,description,status,updated',
      maxResults: '100',
    });
    const body = (await this.request(`/rest/api/3/search/jql?${query.toString()}`)) as {
      issues?: RawIssue[];
    };
    return (body?.issues ?? []).map(normalise);
  }

  async updateIssue(
    key: string,
    fields: { summary?: string; description?: string },
  ): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (fields.summary !== undefined) payload.summary = fields.summary;
    if (fields.description !== undefined) payload.description = textToAdf(fields.description);
    if (Object.keys(payload).length === 0) return;
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields: payload }),
    });
  }

  async transitionIssue(key: string, statusName: string): Promise<void> {
    const body = (await this.request(
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    )) as { transitions?: Array<{ id?: string; name?: string; to?: { name?: string } }> };
    const wanted = statusName.toLowerCase();
    const match = (body?.transitions ?? []).find(
      (t) => t.to?.name?.toLowerCase() === wanted || t.name?.toLowerCase() === wanted,
    );
    if (!match?.id) {
      // Not fatal to a sync pass: `jira.ts` logs and moves on, so one issue
      // whose workflow lacks the target status can't stall every other push.
      throw new JiraApiError(409, `no transition to "${statusName}" available on ${key}`);
    }
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } }),
    });
  }
}

/** Jira's JQL date literal is `yyyy/MM/dd HH:mm`, not ISO-8601. */
export function toJqlTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
