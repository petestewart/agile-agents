/**
 * T338: names, not ids. Agent text, thread lines and cards carry node,
 * project and contract ids; the cockpit shows each one it knows as its
 * title (a link to the node), at render time — the stored text keeps the
 * id. Bare `http(s)` URLs become links too; nothing else does.
 */

import type { CockpitFrame } from './feed-types';

/** What an id reads as, and the node its link opens. */
export interface NameRef {
  title: string;
  node: string;
}

export type Names = ReadonlyMap<string, NameRef>;

export const NO_NAMES: Names = new Map();

/** Every node, project (its root) and contract (its owning node) the cockpit frame knows. */
export function namesOf(
  cockpit: Pick<CockpitFrame, 'streams' | 'projects' | 'contracts'> | undefined,
): Names {
  const names = new Map<string, NameRef>();
  if (cockpit === undefined) return names;
  for (const s of cockpit.streams) names.set(s.id, { title: s.title, node: s.id });
  for (const p of cockpit.projects) names.set(p.id, { title: p.name, node: p.root });
  for (const c of cockpit.contracts ?? []) names.set(c.id, { title: c.title, node: c.node });
  return names;
}

export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'url'; url: string }
  | { kind: 'ref'; id: string; ref: NameRef };

/**
 * An `http(s)` URL, stopping at whitespace, a quote or an angle bracket —
 * raw, or as `escapeHtml` left them — so the same pass runs on raw and
 * escaped text. It stops at markdown.ts's private-use placeholder too,
 * so a code span right after a URL is never pulled into its `href`.
 */
const URL_SOURCE = String.raw`https?:\/\/(?:(?!&quot;|&#39;|&lt;|&gt;)[^\s"'<>\ue000])+`;
/** A node/project/contract id (`<ulid>`, `P-<ulid>`, `C-<ulid>`), not inside a path or a longer word. */
const ID_SOURCE = String.raw`(?<![\w/.-])(?:[PC]-)?[0-9A-HJKMNP-TV-Z]{26}(?![\w/-]|\.\w)`;
const TOKEN = new RegExp(`(${URL_SOURCE})|(${ID_SOURCE})`, 'g');

/** Sentence punctuation that ends a URL rather than belonging to it. */
function trimUrl(url: string): string {
  let out = url.replace(/[.,;:!?]+$/, '');
  // A closing paren belongs to the URL only when it opened one.
  while (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, -1).replace(/[.,;:!?]+$/, '');
  }
  return out;
}

/** Splits `text` into plain runs, URLs and known ids. An unknown id stays text. */
export function tokenize(text: string, names: Names): Token[] {
  const out: Token[] = [];
  let last = 0;
  const push = (t: string) => {
    if (t === '') return;
    const prev = out[out.length - 1];
    if (prev?.kind === 'text') prev.text += t;
    else out.push({ kind: 'text', text: t });
  };
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (m[1] !== undefined) {
      const url = trimUrl(m[1]);
      push(text.slice(last, at));
      out.push({ kind: 'url', url });
      last = at + url.length;
      continue;
    }
    const id = m[2] as string;
    const ref = names.get(id);
    if (ref === undefined) continue;
    push(text.slice(last, at));
    out.push({ kind: 'ref', id, ref });
    last = at + id.length;
  }
  push(text.slice(last));
  return out;
}
