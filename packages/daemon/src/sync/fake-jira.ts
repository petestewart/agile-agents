/**
 * A fake Jira Cloud REST v3 server (T045 acceptance criterion: "Offline test
 * against a fake Jira server proves both directions and the conflict rule").
 *
 * Lives in `src/` rather than a test file so both `sync/jira.test.ts` and
 * `http.test.ts` can stand one up, the same way `tools/runner.ts`'s
 * `FakeRunner` is a `src/` export used only by tests. It speaks the exact
 * four endpoints `HttpJiraClient` calls, so the offline test exercises the
 * real client (URL shapes, ADF encoding, basic auth, transition lookup) and
 * not a mock of it.
 */

import { adfToText, textToAdf } from './client';

export interface FakeIssueState {
  key: string;
  summary: string;
  description: string;
  status: string;
  updated: string;
}

export interface FakeJiraHandle {
  baseUrl: string;
  issues: Map<string, FakeIssueState>;
  /** Every `authorization` header the server saw — asserted on by the credential test. */
  authHeaders: string[];
  /** Seed or overwrite an issue as if a human had edited it in Jira. */
  put(issue: FakeIssueState): void;
  stop(): void;
}

/** Jira's `yyyy/MM/dd HH:mm` JQL date literal back to epoch millis. */
function parseJqlTimestamp(value: string): number {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
}

/** The three transitions a default Jira software workflow offers. */
const TRANSITIONS = [
  { id: '11', name: 'To Do', to: { name: 'To Do' } },
  { id: '21', name: 'In Progress', to: { name: 'In Progress' } },
  { id: '31', name: 'Done', to: { name: 'Done' } },
];

export function startFakeJira(options: { now?: () => Date } = {}): FakeJiraHandle {
  const issues = new Map<string, FakeIssueState>();
  const authHeaders: string[] = [];
  const now = options.now ?? (() => new Date());

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      authHeaders.push(req.headers.get('authorization') ?? '');
      if (!req.headers.get('authorization')?.startsWith('Basic ')) {
        return Response.json({ errorMessages: ['unauthorised'] }, { status: 401 });
      }

      if (url.pathname === '/rest/api/3/search/jql') {
        const jql = url.searchParams.get('jql') ?? '';
        const project = /project = "([^"]+)"/.exec(jql)?.[1] ?? '';
        const sinceRaw = /updated >= "([^"]+)"/.exec(jql)?.[1];
        const since = sinceRaw ? parseJqlTimestamp(sinceRaw) : Number.NEGATIVE_INFINITY;
        const matching = [...issues.values()]
          .filter((i) => i.key.startsWith(`${project}-`))
          .filter((i) => !Number.isFinite(since) || Date.parse(i.updated) >= since)
          .sort((a, b) => a.updated.localeCompare(b.updated));
        return Response.json({
          issues: matching.map((i) => ({
            key: i.key,
            fields: {
              summary: i.summary,
              description: textToAdf(i.description),
              status: { name: i.status },
              updated: i.updated,
            },
          })),
        });
      }

      const transitionMatch = /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/.exec(url.pathname);
      if (transitionMatch) {
        const key = decodeURIComponent(transitionMatch[1] as string);
        const issue = issues.get(key);
        if (!issue) return Response.json({ errorMessages: ['not found'] }, { status: 404 });
        if (req.method === 'GET') return Response.json({ transitions: TRANSITIONS });
        const body = (await req.json()) as { transition?: { id?: string } };
        const target = TRANSITIONS.find((t) => t.id === body.transition?.id);
        if (!target) return Response.json({ errorMessages: ['bad transition'] }, { status: 400 });
        issues.set(key, { ...issue, status: target.to.name, updated: now().toISOString() });
        return new Response(null, { status: 204 });
      }

      const issueMatch = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(url.pathname);
      if (issueMatch && req.method === 'PUT') {
        const key = decodeURIComponent(issueMatch[1] as string);
        const issue = issues.get(key);
        if (!issue) return Response.json({ errorMessages: ['not found'] }, { status: 404 });
        const body = (await req.json()) as {
          fields?: { summary?: string; description?: unknown };
        };
        issues.set(key, {
          ...issue,
          ...(body.fields?.summary !== undefined ? { summary: body.fields.summary } : {}),
          ...(body.fields?.description !== undefined
            ? { description: adfToText(body.fields.description) }
            : {}),
          updated: now().toISOString(),
        });
        return new Response(null, { status: 204 });
      }

      return Response.json({ errorMessages: ['not found'] }, { status: 404 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    issues,
    authHeaders,
    put(issue) {
      issues.set(issue.key, issue);
    },
    stop() {
      server.stop(true);
    },
  };
}
