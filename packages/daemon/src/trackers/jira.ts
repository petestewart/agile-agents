/**
 * The Jira REST (v3) adapter for the tracker port. Auth is Basic
 * `email:token` when `email` is set (Jira Cloud API token), else a Bearer
 * personal access token. HTTPS only, except a loopback `base_url` (the fake).
 */

import { isLoopbackUrl } from '../github/rest';
import {
  type CreateIssueInput,
  TrackerError,
  type TrackerIssue,
  type TrackerPort,
  httpError,
} from './port';

export interface JiraOptions {
  base_url: string;
  email?: string;
  token: string;
}

const FIELDS = 'summary,description,status,issuetype,parent';

interface JiraIssueJson {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    issuetype?: { name?: string };
    parent?: { key?: string };
  };
}

/** Plain text from an Atlassian Document Format node (or a v2 string). */
export function adfText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text ?? '';
  const parts = (n.content ?? []).map(adfText);
  const block = n.type === 'doc' || n.type === 'bulletList' || n.type === 'orderedList';
  return parts.join(block ? '\n' : '');
}

function adfDoc(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

export function createJira(opts: JiraOptions): TrackerPort {
  const base = opts.base_url.replace(/\/+$/, '');
  if (!base.startsWith('https://') && !isLoopbackUrl(base))
    throw new TrackerError('jira: base_url must be https', 'validation');
  const auth = opts.email
    ? `Basic ${Buffer.from(`${opts.email}:${opts.token}`).toString('base64')}`
    : `Bearer ${opts.token}`;

  async function call<T>(what: string, method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: auth,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new TrackerError(`jira: ${what} failed (network)`, 'http');
    }
    if (!res.ok) throw httpError('jira', what, res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  const toIssue = (j: JiraIssueJson): TrackerIssue => ({
    key: j.key,
    id: j.id,
    title: j.fields.summary ?? '',
    description: adfText(j.fields.description),
    status: j.fields.status?.name ?? '',
    url: `${base}/browse/${j.key}`,
    kind: j.fields.issuetype?.name?.toLowerCase() === 'epic' ? 'epic' : 'issue',
    ...(j.fields.parent?.key ? { parent: j.fields.parent.key } : {}),
  });
  const enc = encodeURIComponent;
  const getIssue = async (key: string) =>
    toIssue(
      await call<JiraIssueJson>(
        'get issue',
        'GET',
        `/rest/api/3/issue/${enc(key)}?fields=${FIELDS}`,
      ),
    );

  return {
    system: 'jira',
    getIssue,
    async listEpicChildren(epicKey) {
      if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(epicKey))
        throw new TrackerError(`jira: not an issue key: ${epicKey}`, 'validation');
      const jql = enc(`parent = ${epicKey} ORDER BY key ASC`);
      const out: TrackerIssue[] = [];
      let token: string | undefined;
      do {
        const page = await call<{ issues: JiraIssueJson[]; nextPageToken?: string }>(
          'list epic children',
          'GET',
          `/rest/api/3/search/jql?jql=${jql}&fields=${FIELDS}&maxResults=100${token ? `&nextPageToken=${enc(token)}` : ''}`,
        );
        out.push(...page.issues.map(toIssue));
        token = page.nextPageToken;
      } while (token);
      return out;
    },
    async addComment(key, body) {
      const r = await call<{ id: string }>(
        'add comment',
        'POST',
        `/rest/api/3/issue/${enc(key)}/comment`,
        {
          body: adfDoc(body),
        },
      );
      return { id: String(r.id) };
    },
    async addLink(key, link) {
      await call('add link', 'POST', `/rest/api/3/issue/${enc(key)}/remotelink`, {
        object: { url: link.url, title: link.title },
      });
    },
    async transitionStatus(key, status) {
      const path = `/rest/api/3/issue/${enc(key)}/transitions`;
      const { transitions } = await call<{
        transitions: Array<{ id: string; name: string; to?: { name?: string } }>;
      }>('list transitions', 'GET', path);
      const want = status.toLowerCase();
      const t =
        transitions.find((x) => x.to?.name?.toLowerCase() === want) ??
        transitions.find((x) => x.name.toLowerCase() === want);
      if (!t) throw new TrackerError(`jira: no transition of ${key} to "${status}"`, 'validation');
      await call('transition status', 'POST', path, { transition: { id: t.id } });
    },
    async createIssue(input: CreateIssueInput) {
      const r = await call<{ key: string }>('create issue', 'POST', '/rest/api/3/issue', {
        fields: {
          project: { key: input.project },
          summary: input.title,
          issuetype: { name: 'Task' },
          ...(input.description ? { description: adfDoc(input.description) } : {}),
          ...(input.parent ? { parent: { key: input.parent } } : {}),
        },
      });
      return getIssue(r.key);
    },
  };
}
