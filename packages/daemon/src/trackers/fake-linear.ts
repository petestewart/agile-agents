/**
 * A fake Linear for tests (test support, like `github/fake-server.ts`): a
 * local `Bun.serve` GraphQL endpoint answering the operations `linear.ts`
 * sends, dispatched on `operationName` (no GraphQL parsing). No network.
 *
 *   const linear = await startFakeLinear();  // linear.apiUrl, linear.token
 *   linear.addIssue({ key: 'SHOP-1', title: 'Checkout' });
 *
 * Operations: GetIssue, EpicChildren (paged by `pageSize`), AddComment,
 * AddLink, IssueStates, TransitionIssue, TeamByKey, CreateIssue. A wrong
 * `Authorization` gets an AUTHENTICATION_ERROR (as Linear does).
 * Test controls: addIssue, edit, rateLimit(count), issues, requests
 * (operation and status; never headers, so no token).
 */

// biome-ignore lint/suspicious/noExplicitAny: test double; request bodies are loose JSON
type Loose = Record<string, any>;

export interface FakeLinearIssue {
  id: string;
  key: string;
  team: string;
  title: string;
  description: string;
  state: string;
  parent?: string;
  comments: Array<{ id: string; body: string }>;
  links: Array<{ url: string; title: string }>;
}

export const FAKE_LINEAR_STATES = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done'];

export async function startFakeLinear(opts: { token?: string; pageSize?: number } = {}) {
  const token = opts.token ?? 'lin_api_fake-linear-token';
  const pageSize = opts.pageSize ?? 100;
  const issues: FakeLinearIssue[] = [];
  const requests: Array<{ operation: string; status: number }> = [];
  const counters = new Map<string, number>();
  let nextId = 1;
  let rateLimited = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
  const teamId = (key: string) => `team-${key}`;
  const stateId = (name: string) => `state-${name.toLowerCase().replace(/\s+/g, '-')}`;

  function addIssue(i: {
    key?: string;
    team?: string;
    title: string;
    description?: string;
    state?: string;
    parent?: string;
  }): FakeLinearIssue {
    const team = i.key?.split('-')[0] ?? i.team ?? 'SHOP';
    const n = (counters.get(team) ?? 0) + 1;
    counters.set(team, n);
    const issue: FakeLinearIssue = {
      id: uuid(),
      key: i.key ?? `${team}-${n}`,
      team,
      title: i.title,
      description: i.description ?? '',
      state: i.state ?? 'Todo',
      ...(i.parent ? { parent: i.parent } : {}),
      comments: [],
      links: [],
    };
    issues.push(issue);
    return issue;
  }
  const find = (idOrKey: string) => issues.find((x) => x.id === idOrKey || x.key === idOrKey);
  const toJson = (i: FakeLinearIssue) => ({
    id: i.id,
    identifier: i.key,
    title: i.title,
    description: i.description || null,
    url: `https://linear.app/fake/issue/${i.key}`,
    state: { name: i.state },
    parent: i.parent ? { identifier: i.parent } : null,
    children: {
      nodes: issues
        .filter((c) => c.parent === i.key)
        .slice(0, 1)
        .map((c) => ({ id: c.id })),
    },
  });
  const error = (message: string, code = 'INVALID_INPUT') => ({
    data: null,
    errors: [{ message, extensions: { code } }],
  });

  function run(op: string, v: Loose): unknown {
    switch (op) {
      case 'GetIssue': {
        const i = find(v.id);
        return i ? { data: { issue: toJson(i) } } : error('Entity not found: Issue');
      }
      case 'EpicChildren': {
        const i = find(v.id);
        if (!i) return error('Entity not found: Issue');
        const all = issues.filter((c) => c.parent === i.key);
        const start = v.after ? Number(v.after) : 0;
        const end = start + pageSize;
        return {
          data: {
            issue: {
              children: {
                nodes: all.slice(start, end).map(toJson),
                pageInfo: {
                  hasNextPage: end < all.length,
                  endCursor: end < all.length ? String(end) : null,
                },
              },
            },
          },
        };
      }
      case 'AddComment': {
        const i = find(v.input?.issueId);
        if (!i) return error('Entity not found: Issue');
        const c = { id: uuid(), body: String(v.input.body ?? '') };
        i.comments.push(c);
        return { data: { commentCreate: { success: true, comment: { id: c.id } } } };
      }
      case 'AddLink': {
        const i = find(v.issueId);
        if (!i) return error('Entity not found: Issue');
        i.links.push({ url: v.url, title: v.title ?? '' });
        return { data: { attachmentLinkURL: { success: true } } };
      }
      case 'IssueStates': {
        const i = find(v.id);
        if (!i) return error('Entity not found: Issue');
        const nodes = FAKE_LINEAR_STATES.map((name) => ({ id: stateId(name), name }));
        return { data: { issue: { id: i.id, team: { states: { nodes } } } } };
      }
      case 'TransitionIssue': {
        const i = find(v.id);
        const s = FAKE_LINEAR_STATES.find((name) => stateId(name) === v.input?.stateId);
        if (!i || !s) return error('Entity not found');
        i.state = s;
        return { data: { issueUpdate: { success: true } } };
      }
      case 'TeamByKey': {
        const known = new Set([...issues.map((i) => i.team), 'SHOP']);
        return { data: { teams: { nodes: known.has(v.key) ? [{ id: teamId(v.key) }] : [] } } };
      }
      case 'CreateIssue': {
        const inp = v.input ?? {};
        const team = String(inp.teamId ?? '').replace(/^team-/, '');
        if (!team || !inp.title) return error('teamId and title are required');
        const parent = inp.parentId ? find(inp.parentId) : undefined;
        if (inp.parentId && !parent) return error('Entity not found: parent');
        const i = addIssue({
          team,
          title: inp.title,
          ...(inp.description ? { description: inp.description } : {}),
          ...(parent ? { parent: parent.key } : {}),
        });
        return { data: { issueCreate: { success: true, issue: toJson(i) } } };
      }
      default:
        return error(`unknown operation ${op}`, 'GRAPHQL_VALIDATION_FAILED');
    }
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      let operation = '?';
      let res: Response;
      if (req.method !== 'POST') res = new Response('not found', { status: 404 });
      else {
        const body = (await req.json()) as {
          operationName?: string;
          variables?: Loose;
        };
        operation = body.operationName ?? '?';
        if (req.headers.get('authorization') !== token)
          res = Response.json(error('Authentication required', 'AUTHENTICATION_ERROR'), {
            status: 400,
          });
        else if (rateLimited > 0) {
          rateLimited--;
          res = Response.json(error('Rate limit exceeded', 'RATELIMITED'), { status: 400 });
        } else res = Response.json(run(operation, body.variables ?? {}));
      }
      requests.push({ operation, status: res.status });
      return res;
    },
  });

  return {
    apiUrl: `http://127.0.0.1:${server.port}/graphql`,
    token,
    issues: issues as readonly FakeLinearIssue[],
    requests,
    addIssue,
    edit(key: string, patch: Partial<Pick<FakeLinearIssue, 'title' | 'description' | 'state'>>) {
      const i = find(key);
      if (!i) throw new Error(`fake linear: no issue ${key}`);
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

export type FakeLinear = Awaited<ReturnType<typeof startFakeLinear>>;
