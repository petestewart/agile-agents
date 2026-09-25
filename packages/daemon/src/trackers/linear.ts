/**
 * The Linear GraphQL adapter for the tracker port. Auth is the personal API
 * key as the `Authorization` header (Linear's scheme). HTTPS only, except a
 * loopback `api_url` (the fake). Every request names its `operationName`,
 * which is what the fake dispatches on.
 */

import { DEFAULT_LINEAR_API_URL } from '@agile-agents/shared';
import { isLoopbackUrl } from '../github/rest';
import { TrackerError, type TrackerIssue, type TrackerPort, httpError } from './port';

export interface LinearOptions {
  api_url?: string;
  token: string;
}

const ISSUE_FIELDS =
  'id identifier title description url state { name } parent { identifier } children(first: 1) { nodes { id } }';

interface LinearIssueJson {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  state?: { name?: string } | null;
  parent?: { identifier?: string } | null;
  children?: { nodes: unknown[] };
}

const toIssue = (j: LinearIssueJson): TrackerIssue => ({
  key: j.identifier,
  id: j.id,
  title: j.title,
  description: j.description ?? '',
  status: j.state?.name ?? '',
  url: j.url,
  // Linear has no epic type: an issue with children plays the epic.
  kind: (j.children?.nodes.length ?? 0) > 0 ? 'epic' : 'issue',
  ...(j.parent?.identifier ? { parent: j.parent.identifier } : {}),
});

export function createLinear(opts: LinearOptions): TrackerPort {
  const url = opts.api_url ?? DEFAULT_LINEAR_API_URL;
  if (!url.startsWith('https://') && !isLoopbackUrl(url))
    throw new TrackerError('linear: api_url must be https', 'validation');

  async function gql<T>(operationName: string, query: string, variables: object): Promise<T> {
    const what = operationName;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: opts.token, 'content-type': 'application/json' },
        body: JSON.stringify({ operationName, query, variables }),
      });
    } catch {
      throw new TrackerError(`linear: ${what} failed (network)`, 'http');
    }
    // Linear answers GraphQL errors (auth included) as JSON, often with a 400.
    const body = (await res.json().catch(() => ({}))) as {
      data?: T;
      errors?: Array<{ message?: string; extensions?: { code?: string } }>;
    };
    if (!body.errors?.length && !res.ok) throw httpError('linear', what, res.status);
    if (body.errors?.length || !body.data) {
      const code = body.errors?.[0]?.extensions?.code ?? '';
      const kind =
        code === 'AUTHENTICATION_ERROR'
          ? 'auth'
          : code === 'RATELIMITED'
            ? 'rate_limited'
            : 'validation';
      const notFound = /not found/i.test(body.errors?.[0]?.message ?? '');
      throw new TrackerError(
        `linear: ${what} failed (${code || 'graphql error'})`,
        notFound ? 'not_found' : kind,
      );
    }
    return body.data;
  }

  async function getIssue(key: string): Promise<TrackerIssue> {
    const d = await gql<{ issue: LinearIssueJson | null }>(
      'GetIssue',
      `query GetIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id: key },
    );
    if (!d.issue) throw new TrackerError(`linear: no issue ${key}`, 'not_found');
    return toIssue(d.issue);
  }
  const issueId = async (key: string) => (await getIssue(key)).id;
  const mutated = (ok: boolean | undefined, what: string) => {
    if (!ok) throw new TrackerError(`linear: ${what} was not applied`, 'validation');
  };

  return {
    system: 'linear',
    getIssue,
    async listEpicChildren(epicKey) {
      const out: TrackerIssue[] = [];
      let after: string | null = null;
      for (;;) {
        const d: {
          issue: {
            children: {
              nodes: LinearIssueJson[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          } | null;
        } = await gql(
          'EpicChildren',
          `query EpicChildren($id: String!, $after: String) { issue(id: $id) { children(first: 100, after: $after) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
          { id: epicKey, after },
        );
        if (!d.issue) throw new TrackerError(`linear: no issue ${epicKey}`, 'not_found');
        out.push(...d.issue.children.nodes.map(toIssue));
        if (!d.issue.children.pageInfo.hasNextPage) return out;
        after = d.issue.children.pageInfo.endCursor;
      }
    },
    async addComment(key, body) {
      const d = await gql<{ commentCreate: { success: boolean; comment?: { id: string } } }>(
        'AddComment',
        'mutation AddComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }',
        { input: { issueId: await issueId(key), body } },
      );
      mutated(d.commentCreate.success, 'add comment');
      return { id: d.commentCreate.comment?.id ?? '' };
    },
    async addLink(key, link) {
      const d = await gql<{ attachmentLinkURL: { success: boolean } }>(
        'AddLink',
        'mutation AddLink($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }',
        { issueId: await issueId(key), url: link.url, title: link.title },
      );
      mutated(d.attachmentLinkURL.success, 'add link');
    },
    async transitionStatus(key, status) {
      const d = await gql<{
        issue: {
          id: string;
          team: { states: { nodes: Array<{ id: string; name: string }> } };
        } | null;
      }>(
        'IssueStates',
        'query IssueStates($id: String!) { issue(id: $id) { id team { states { nodes { id name } } } } }',
        { id: key },
      );
      if (!d.issue) throw new TrackerError(`linear: no issue ${key}`, 'not_found');
      const want = status.toLowerCase();
      const state = d.issue.team.states.nodes.find((s) => s.name.toLowerCase() === want);
      if (!state) throw new TrackerError(`linear: no state "${status}" for ${key}`, 'validation');
      const u = await gql<{ issueUpdate: { success: boolean } }>(
        'TransitionIssue',
        'mutation TransitionIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',
        { id: d.issue.id, input: { stateId: state.id } },
      );
      mutated(u.issueUpdate.success, 'transition status');
    },
    async createIssue(input) {
      const t = await gql<{ teams: { nodes: Array<{ id: string }> } }>(
        'TeamByKey',
        'query TeamByKey($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }',
        { key: input.project },
      );
      const teamId = t.teams.nodes[0]?.id;
      if (!teamId) throw new TrackerError(`linear: no team ${input.project}`, 'not_found');
      const d = await gql<{ issueCreate: { success: boolean; issue?: LinearIssueJson } }>(
        'CreateIssue',
        `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
        {
          input: {
            teamId,
            title: input.title,
            ...(input.description ? { description: input.description } : {}),
            ...(input.parent ? { parentId: await issueId(input.parent) } : {}),
          },
        },
      );
      mutated(d.issueCreate.success && d.issueCreate.issue !== undefined, 'create issue');
      return toIssue(d.issueCreate.issue as LinearIssueJson);
    },
  };
}
