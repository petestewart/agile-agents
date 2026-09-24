/**
 * `DocsService`: docs are plain Markdown, in `<repo>/.agile-docs/*.md`
 * (tracked, shared by the repo's streams) or `<home>/streams/<id>.docs/*.md`
 * (one stream's notes). No index: listing is a `readdir`, search a
 * case-insensitive substring scan. A stream sees its repo's docs plus the
 * stream docs of every ancestor, root→leaf.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { UlidSchema } from '@agile-agents/shared';
import type { StateStore } from '../store';
import type { StreamService } from '../streams/service';

/** Larger bodies are truncated with a marker: a brief is a prompt, not an archive. */
export const DOC_BODY_CAP_BYTES = 16 * 1024;
/** `search` returns at most this many hits. */
export const MAX_SEARCH_HITS = 50;

const TRUNCATION_MARKER = '\n\n… [truncated: doc exceeds 16 KiB]\n';

export interface Doc {
  /** Which of the two homes it came from. */
  source: 'repo' | 'stream';
  /** Absolute path on disk. */
  path: string;
  /** File name, e.g. `brief.md`. */
  name: string;
  /** File contents, truncated at `DOC_BODY_CAP_BYTES`. */
  body: string;
}

export interface SearchHit {
  /** Absolute path of the file the line is in. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** The matching line, trimmed. */
  text: string;
}

/** The read side the `search_docs` verb is typed against. */
export interface DocsSearch {
  search(query: string, ctx: { stream?: string }): Promise<SearchHit[]>;
}

/** `*.md` files directly in `dir`, sorted. A missing dir is no docs, not an error. */
function listMarkdown(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.md'))
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => join(dir, name));
}

function readDoc(source: Doc['source'], path: string): Doc | undefined {
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(body, 'utf8') > DOC_BODY_CAP_BYTES) {
    body =
      Buffer.from(body, 'utf8').subarray(0, DOC_BODY_CAP_BYTES).toString('utf8') +
      TRUNCATION_MARKER;
  }
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { source, path, name, body };
}

export class DocsService implements DocsSearch {
  constructor(
    private readonly store: StateStore,
    private readonly streams: StreamService,
    /** The state home, where `streams/<id>.docs/` lives. */
    private readonly home: string,
  ) {}

  /** `<repo root>/.agile-docs/*.md`. An unregistered repo has no docs (not an error). */
  listRepoDocs(repoId: string): Doc[] {
    const entry = this.store.getRepos()[repoId];
    if (entry === undefined) return [];
    return listMarkdown(join(entry.path, '.agile-docs')).flatMap((path) => {
      const doc = readDoc('repo', path);
      return doc ? [doc] : [];
    });
  }

  /** `<home>/streams/<id>.docs/*.md`. */
  listStreamDocs(streamId: string): Doc[] {
    return listMarkdown(this.streamDocsDir(streamId)).flatMap((path) => {
      const doc = readDoc('stream', path);
      return doc ? [doc] : [];
    });
  }

  /** What a stream's agent sees: its repo's docs, then ancestor stream docs root→leaf, then its own. */
  docsForStream(streamId: string): Doc[] {
    const chain = this.ancestry(streamId);
    const leaf = chain[chain.length - 1];
    const docs: Doc[] = [];
    if (leaf?.repo !== undefined) docs.push(...this.listRepoDocs(leaf.repo));
    for (const stream of chain) docs.push(...this.listStreamDocs(stream.id));
    return docs;
  }

  /** Literal case-insensitive substring search (no regex). Without a stream, every doc in the home. */
  async search(query: string, ctx: { stream?: string } = {}): Promise<SearchHit[]> {
    const needle = query.toLowerCase();
    if (needle.length === 0) return [];
    const docs = ctx.stream !== undefined ? this.docsForStream(ctx.stream) : this.allDocs();
    const hits: SearchHit[] = [];
    for (const doc of docs) {
      const lines = doc.body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? '';
        if (!text.toLowerCase().includes(needle)) continue;
        hits.push({ path: doc.path, line: i + 1, text: text.trim() });
        if (hits.length >= MAX_SEARCH_HITS) return hits;
      }
    }
    return hits;
  }

  /** Every doc the home can see: all registered repos, all streams. */
  private allDocs(): Doc[] {
    const docs: Doc[] = [];
    for (const repoId of Object.keys(this.store.getRepos()).sort()) {
      docs.push(...this.listRepoDocs(repoId));
    }
    for (const stream of this.streams.list({ include_archived: true })) {
      docs.push(...this.listStreamDocs(stream.id));
    }
    return docs;
  }

  /** Root→leaf chain for `streamId` (the seen-set keeps it total). */
  private ancestry(streamId: string): Array<{ id: string; repo?: string }> {
    const chain: Array<{ id: string; repo?: string }> = [];
    const seen = new Set<string>();
    let id: string | undefined = streamId;
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      let stream: { id: string; parent?: string; repo?: string };
      try {
        stream = this.streams.get(id);
      } catch {
        break;
      }
      chain.unshift({ id: stream.id, ...(stream.repo !== undefined ? { repo: stream.repo } : {}) });
      id = stream.parent;
    }
    return chain;
  }

  /** `<home>/streams/<id>.docs`; the id is ULID-checked before it reaches a path. */
  private streamDocsDir(streamId: string): string {
    const result = UlidSchema.safeParse(streamId);
    if (!result.success) {
      throw new Error(
        `invalid Stream id: ${streamId} must be a 26-character Crockford-base32 ULID`,
      );
    }
    return join(this.home, 'streams', `${result.data}.docs`);
  }
}
