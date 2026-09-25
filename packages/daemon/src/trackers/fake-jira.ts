/**
 * A fake Jira for tests (test support, like `github/fake-server.ts`): a
 * local `Bun.serve` implementing the REST v3 subset `jira.ts` uses. No
 * network.
 *
 *   const jira = await startFakeJira();  // jira.baseUrl, jira.email, jira.token
 *   jira.addIssue({ key: 'SHOP-1', title: 'Checkout', kind: 'epic' });
 *   ...
 *   await jira.stop();
 *
 * REST (Basic `email:token` or Bearer `token`, else 401):
 *   GET  /rest/api/3/issue/:key                 POST /rest/api/3/issue
 *   GET  /rest/api/3/search/jql?jql=parent = K  (paged by nextPageToken, `pageSize`)
 *   POST /rest/api/3/issue/:key/comment         POST /rest/api/3/issue/:key/remotelink
 *   GET  /rest/api/3/issue/:key/transitions     POST (transition.id)
 * Every status is reachable from every other (one transition per status).
 * Test controls: addIssue, edit, rateLimit(count), issues, requests (method,
 * path, status; never headers, so no token).
 */

import { adfText } from './jira';

// biome-ignore lint/suspicious/noExplicitAny: test double; request bodies are loose JSON
type Loose = Record<string, any>;

export interface FakeJiraIssue {
  id: string;
  key: string;
  title: string;
  description: string;
  status: string;
  kind: 'epic' | 'issue';
  parent?: string;
  comments: Array<{ id: string; body: string }>;
  links: Array<{ url: string; title: string }>;
}

export const FAKE_JIRA_STATUSES = ['To Do', 'In Progress', 'In Review', 'Done'];

export async function startFakeJira(
  opts: { email?: string; token?: string; pageSize?: number } = {},
) {
  const email = opts.email ?? 'pete@example.com';
  const token = opts.token ?? 'fake-jira-token';
  const pageSize = opts.pageSize ?? 100;
  const accepted = new Set([
    `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
    `Bearer ${token}`,
  ]);
  const issues: FakeJiraIssue[] = [];
  const requests: Array<{ method: string; path: string; status: number }> = [];
  let nextId = 10000;
  let rateLimited = 0;
  const counters = new Map<string, number>();

  function addIssue(i: {
    key?: string;
    project?: string;
    title: string;
    description?: string;
    status?: string;
    kind?: 'epic' | 'issue';
    parent?: string;
  }): FakeJiraIssue {
    const project = i.key?.split('-')[0] ?? i.project ?? 'SHOP';
    const n = (counters.get(project) ?? 0) + 1;
    counters.set(project, n);
    const issue: FakeJiraIssue = {
      id: String(nextId++),
      key: i.key ?? `${project}-${n}`,
      title: i.title,
      description: i.description ?? '',
      status: i.status ?? 'To Do',
      kind: i.kind ?? 'issue',
      ...(i.parent ? { parent: i.parent } : {}),
      comments: [],
      links: [],
    };
    issues.push(issue);
    return issue;
  }
  const find = (key: string) => issues.find((x) => x.key === key);
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const toJson = (i: FakeJiraIssue) => ({
    id: i.id,
    key: i.key,
    fields: {
      summary: i.title,
      description: i.description
        ? {
            type: 'doc',
            version: 1,
            content: i.description
              .split('\n')
              .map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] })),
          }
        : null,
      status: { name: i.status },
      issuetype: { name: i.kind === 'epic' ? 'Epic' : 'Task' },
      ...(i.parent ? { parent: { key: i.parent } } : {}),
    },
  });
  const transitions = () =>
    FAKE_JIRA_STATUSES.map((s, n) => ({
      id: String(11 + n),
      name: `Move to ${s}`,
      to: { name: s },
    }));

  async function route(req: Request, url: URL): Promise<Response> {
    if (!accepted.has(req.headers.get('authorization') ?? ''))
      return json({ errorMessages: ['Unauthorized'] }, 401);
    if (rateLimited > 0) {
      rateLimited--;
      return json({ errorMessages: ['Rate limited'] }, 429);
    }
    const p = url.pathname;
    const body = req.method === 'POST' ? ((await req.json()) as Loose) : {};
    if (req.method === 'GET' && p === '/rest/api/3/search/jql') {
      const m = /^parent = ([A-Z0-9_]+-\d+)/i.exec(url.searchParams.get('jql') ?? '');
      if (!m) return json({ errorMessages: ['unsupported jql'] }, 400);
      const all = issues.filter((i) => i.parent === m[1]);
      const start = Number(url.searchParams.get('nextPageToken') ?? 0);
      const page = all.slice(start, start + pageSize);
      const next = start + pageSize < all.length ? String(start + pageSize) : undefined;
      return json({ issues: page.map(toJson), ...(next ? { nextPageToken: next } : {}) });
    }
    if (req.method === 'POST' && p === '/rest/api/3/issue') {
      const f = body.fields ?? {};
      if (!f.project?.key || !f.summary) return json({ errors: { summary: 'required' } }, 400);
      if (f.parent?.key && !find(f.parent.key)) return json({ errors: { parent: 'unknown' } }, 400);
      const i = addIssue({
        project: f.project.key,
        title: f.summary,
        description: adfText(f.description),
        kind: f.issuetype?.name === 'Epic' ? 'epic' : 'issue',
        ...(f.parent?.key ? { parent: f.parent.key } : {}),
      });
      return json({ id: i.id, key: i.key, self: `${url.origin}/rest/api/3/issue/${i.id}` }, 201);
    }
    const m = /^\/rest\/api\/3\/issue\/([^/]+)(?:\/(comment|remotelink|transitions))?$/.exec(p);
    const issue = m?.[1] ? find(decodeURIComponent(m[1])) : undefined;
    if (!m || !issue) return json({ errorMessages: ['Issue does not exist'] }, 404);
    const sub = m[2];
    if (req.method === 'GET' && !sub) return json(toJson(issue));
    if (req.method === 'POST' && sub === 'comment') {
      const c = { id: String(nextId++), body: adfText(body.body) };
      issue.comments.push(c);
      return json({ id: c.id }, 201);
    }
    if (req.method === 'POST' && sub === 'remotelink') {
      if (!body.object?.url) return json({ errors: { url: 'required' } }, 400);
      issue.links.push({ url: body.object.url, title: body.object.title ?? '' });
      return json({ id: nextId++ }, 201);
    }
    if (sub === 'transitions' && req.method === 'GET') return json({ transitions: transitions() });
    if (sub === 'transitions' && req.method === 'POST') {
      const t = transitions().find((x) => x.id === body.transition?.id);
      if (!t) return json({ errorMessages: ['bad transition'] }, 400);
      issue.status = t.to.name;
      return new Response(null, { status: 204 });
    }
    return json({ errorMessages: ['not found'] }, 404);
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const res = await route(req, url);
      requests.push({ method: req.method, path: url.pathname, status: res.status });
      return res;
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    email,
    token,
    issues: issues as readonly FakeJiraIssue[],
    requests,
    addIssue,
    edit(key: string, patch: Partial<Pick<FakeJiraIssue, 'title' | 'description' | 'status'>>) {
      const i = find(key);
      if (!i) throw new Error(`fake jira: no issue ${key}`);
      Object.assign(i, patch);
    },
    rateLimit(count = 1) {
      rateLimited = count;
    },
    async stop() {
      server.stop(true);
    },
  };
}

export type FakeJira = Awaited<ReturnType<typeof startFakeJira>>;
