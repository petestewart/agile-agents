/**
 * T284 (projects-design §9.3, §14.6, P14): the import index and the
 * `symbol_changed` alert. TS/JS only, by regex: `index/<repo>.json` maps
 * each file on main to its exports and what it imports from which file.
 * After a node's `touched` moves, its changed exports (`prices.ts:salePrice`)
 * go on its card, and a sibling on the same repo whose own changes import
 * one gets `symbol_changed`, plus the parent.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import {
  type ImportIndex,
  type ImportIndexEntry,
  type ReposConfig,
  type Stream,
  validateImportIndex,
} from '@agile-agents/shared';
import { git } from '../delivery/git';
import { mainBranch } from '../delivery/service';
import type { EmitRouted } from '../events/producers';
import type { StateStore } from '../store';
import type { StreamService } from '../streams/service';
import { isLiveWorkNode } from './overlap';

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const INDEX_MAX_FILES = 5_000;
const EXPORTS_CHANGED_MAX = 200;
const IDENT = '[A-Za-z_$][\\w$]*';
const DECL = `(?:async\\s+)?(?:abstract\\s+)?(?:declare\\s+)?(?:const|let|var|function\\*?|class|type|interface|enum|namespace)\\s+(${IDENT})`;

export function isSourceFile(file: string): boolean {
  return SOURCE.test(file) && !file.endsWith('.d.ts');
}

/** Comments out, line numbers kept (a block comment keeps its newlines). */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

function listNames(body: string): Array<{ local: string; exported: string }> {
  return body
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((part) => {
      const [local, exported] = part.split(/\s+as\s+/);
      return { local: (local ?? '').trim(), exported: (exported ?? local ?? '').trim() };
    })
    .filter((n) => n.local !== '');
}

export interface ScannedImport {
  spec: string;
  names: string[];
}

export interface Scanned {
  exports: string[];
  imports: ScannedImport[];
  /** Exported name → its declaration's lines (1-based, inclusive), for changed-export detection. */
  ranges: Map<string, [number, number]>;
}

/** The regex scan of one TS/JS file (P14). */
export function scanSource(raw: string): Scanned {
  const text = stripComments(raw);
  const lines = text.split('\n');
  const exports = new Set<string>();
  const imports: ScannedImport[] = [];
  // Top-level declarations: a line at column 0 up to the next one.
  const topLevel: number[] = [];
  for (let i = 0; i < lines.length; i++) if (/^[A-Za-z@]/.test(lines[i] ?? '')) topLevel.push(i);
  const declRange = new Map<string, [number, number]>();
  topLevel.forEach((start, k) => {
    const end = (topLevel[k + 1] ?? lines.length) - 1;
    const line = lines[start] ?? '';
    const m = new RegExp(`^(?:export\\s+)?(?:default\\s+)?${DECL}`).exec(line);
    if (m?.[1] !== undefined) declRange.set(m[1], [start + 1, end + 1]);
    if (/^export\s+default\b/.test(line)) declRange.set('default', [start + 1, end + 1]);
  });
  const ranges = new Map<string, [number, number]>();
  const exported = (name: string, local = name) => {
    exports.add(name);
    const r = declRange.get(local);
    if (r !== undefined) ranges.set(name, r);
  };

  for (const m of text.matchAll(new RegExp(`^export\\s+(default\\s+)?${DECL}`, 'gm'))) {
    exported(m[1] !== undefined ? 'default' : (m[2] as string));
  }
  if (/^export\s+default\b/m.test(text)) exported('default');
  for (const m of text.matchAll(
    /^export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/gm,
  )) {
    const names = listNames(m[1] ?? '');
    for (const n of names) exported(n.exported, n.local);
    if (m[2] !== undefined) imports.push({ spec: m[2], names: names.map((n) => n.local) });
  }
  for (const m of text.matchAll(/^export\s+\*\s*(?:as\s+(\S+)\s+)?from\s*['"]([^'"]+)['"]/gm)) {
    if (m[1] !== undefined) exported(m[1]);
    imports.push({ spec: m[2] as string, names: ['*'] });
  }
  for (const m of text.matchAll(
    /(?:^|[;\n])\s*import\s+(?:type\s+)?([\w$\s{},*]+?)\s+from\s*['"]([^'"]+)['"]/g,
  )) {
    const clause = m[1] ?? '';
    const names: string[] = [];
    if (/\*\s*as\s/.test(clause)) names.push('*');
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const n of listNames(braces[1] ?? '')) names.push(n.local);
    const head =
      clause
        .replace(/\{[^}]*\}/, '')
        .split(',')[0]
        ?.trim() ?? '';
    if (head !== '' && !head.startsWith('*')) names.push('default');
    imports.push({ spec: m[2] as string, names });
  }
  for (const m of text.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)) {
    imports.push({ spec: m[1] as string, names: ['*'] });
  }
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports.push({ spec: m[1] as string, names: ['*'] });
  }
  return { exports: [...exports].sort(), imports, ranges };
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/** A relative specifier to a repo file in `known`; bare packages resolve to nothing. */
export function resolveSpec(
  from: string,
  spec: string,
  known: ReadonlySet<string>,
): string | undefined {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const stem = base.replace(/\.[cm]?jsx?$/, '');
  const candidates = [
    base,
    ...EXTENSIONS.map((e) => stem + e),
    ...EXTENSIONS.map((e) => `${base}/index${e}`),
  ];
  return candidates.find((c) => known.has(c));
}

/** One file's index entry: its exports and its resolved imports. */
export function indexEntry(
  file: string,
  text: string,
  known: ReadonlySet<string>,
): ImportIndexEntry {
  const scanned = scanSource(text);
  const imports: ImportIndexEntry['imports'] = [];
  for (const imp of scanned.imports) {
    const target = resolveSpec(file, imp.spec, known);
    if (target !== undefined) imports.push({ from: target, names: imp.names });
  }
  return { exports: scanned.exports, imports };
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function readAt(rev: string, file: string, cwd: string, repoRoot: string): string | undefined {
  const r = git(['show', `${rev}:${file}`], cwd, repoRoot);
  return r.exitCode === 0 ? r.stdout : undefined;
}

/** Builds the index from the tree at `rev` (main). */
export function buildIndex(
  repo: string,
  repoRoot: string,
  rev: string,
  now: Date = new Date(),
): ImportIndex | undefined {
  const sha = git(['rev-parse', rev], repoRoot, repoRoot);
  const tree = git(['ls-tree', '-r', '--name-only', rev], repoRoot, repoRoot);
  if (sha.exitCode !== 0 || tree.exitCode !== 0) return undefined;
  const all = tree.stdout.split('\n').filter(Boolean);
  const known = new Set(all);
  const files: ImportIndex['files'] = {};
  for (const file of all.filter(isSourceFile).slice(0, INDEX_MAX_FILES)) {
    const text = readAt(sha.stdout, file, repoRoot, repoRoot);
    if (text !== undefined) files[file] = indexEntry(file, text, known);
  }
  return { repo, sha: sha.stdout, files, built_at: now.toISOString() };
}

/** The new-side lines a diff against `base` changed (a pure deletion marks the lines around it). */
function changedLines(worktree: string, repoRoot: string, base: string, file: string): Set<number> {
  const r = git(['diff', '-U0', base, '--', file], worktree, repoRoot);
  const out = new Set<number>();
  for (const m of r.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) {
      out.add(start);
      out.add(start + 1);
    }
    for (let i = 0; i < count; i++) out.add(start + i);
  }
  return out;
}

/**
 * The node's changed exports as `file:name`: an export whose declaration
 * lines the diff touches, a removed export, or an export of a new file.
 */
export function changedExports(
  worktree: string,
  repoRoot: string,
  base: string,
  files: readonly string[],
): string[] {
  const out: string[] = [];
  for (const file of files.filter(isSourceFile)) {
    const before = readAt(base, file, worktree, repoRoot);
    const current = readText(join(worktree, file));
    const was = before === undefined ? undefined : scanSource(before);
    const is = current === undefined ? undefined : scanSource(current);
    const names = new Set<string>();
    if (is !== undefined) {
      const lines = was === undefined ? undefined : changedLines(worktree, repoRoot, base, file);
      for (const name of is.exports) {
        const range = is.ranges.get(name);
        if (lines === undefined || was?.exports.includes(name) !== true) names.add(name);
        else if (range !== undefined) {
          for (let l = range[0]; l <= range[1]; l++) {
            if (lines.has(l)) {
              names.add(name);
              break;
            }
          }
        }
      }
    }
    for (const name of was?.exports ?? []) if (!is?.exports.includes(name)) names.add(name);
    for (const name of [...names].sort()) out.push(`${file}:${name}`);
  }
  return out.slice(0, EXPORTS_CHANGED_MAX);
}

function importsSymbol(entry: ImportIndexEntry | undefined, file: string, name: string): boolean {
  return (
    entry?.imports.some(
      (i) => i.from === file && (i.names.includes(name) || i.names.includes('*')),
    ) === true
  );
}

export interface SymbolWatcherOptions {
  store: StateStore;
  streams: StreamService;
  repos: () => ReposConfig;
  emit?: EmitRouted;
  now?: () => Date;
}

/** Keeps `index/<repo>.json` and each card's `exports_changed` current; emits `symbol_changed`. */
export class SymbolWatcher {
  constructor(private readonly options: SymbolWatcherOptions) {}

  private indexPath(repo: string): string {
    return `index/${repo}.json`;
  }

  /** The repo's index at main, rebuilt (and stored) when main has moved. */
  async index(repo: string): Promise<ImportIndex | undefined> {
    const entry = this.options.repos()[repo];
    if (entry === undefined) return undefined;
    const main = mainBranch(entry, entry.path);
    const sha = git(['rev-parse', main], entry.path, entry.path);
    if (sha.exitCode !== 0) return undefined;
    const path = this.indexPath(repo);
    try {
      const cached = this.options.store.getEntity(path, validateImportIndex);
      if (cached.sha === sha.stdout) return cached;
    } catch {
      // Missing or stale-shaped: a derived cache, so rebuild it.
    }
    const built = buildIndex(repo, entry.path, main, this.options.now?.());
    if (built === undefined) return undefined;
    return this.options.store.putEntity(path, validateImportIndex, built);
  }

  /** After `touched` moved: recompute the node's changed exports and alert importing siblings of new ones. */
  async onTouched(id: string): Promise<void> {
    const { streams, store } = this.options;
    const all = streams.list();
    const s = all.find((x) => x.id === id);
    if (s?.touched === undefined || s.worktree === undefined || s.repo === undefined) return;
    const entry = this.options.repos()[s.repo];
    if (entry === undefined) return;
    const worktree = isAbsolute(s.worktree) ? s.worktree : join(entry.path, s.worktree);
    const changed = changedExports(worktree, entry.path, s.touched.base, s.touched.files);
    const before = store.getCard(id)?.exports_changed ?? [];
    if (before.join('\n') === changed.join('\n')) return;
    await store.updateCard(id, (card) =>
      card === undefined
        ? undefined
        : {
            ...card,
            exports_changed: changed,
            updated_at: (this.options.now?.() ?? new Date()).toISOString(),
          },
    );
    const fresh = changed.filter((c) => !before.includes(c));
    if (fresh.length === 0 || this.options.emit === undefined || s.parent === undefined) return;
    const index = await this.index(s.repo);
    for (const sib of this.siblings(s, all)) {
      const view = this.siblingView(sib, index, entry.path);
      for (const symbol of fresh) {
        const sep = symbol.lastIndexOf(':');
        const file = symbol.slice(0, sep);
        const name = symbol.slice(sep + 1);
        const importer = Object.keys(view)
          .sort()
          .find((f) => importsSymbol(view[f], file, name));
        if (importer === undefined) continue;
        await this.options.emit({
          type: 'symbol_changed',
          subject: id,
          repo: s.repo,
          ...(s.project !== undefined ? { project: s.project } : {}),
          by: 'daemon',
          siblings: [sib.id],
          payload: { sibling: id, symbol, file: importer },
        });
      }
    }
  }

  private siblings(s: Stream, all: readonly Stream[]): Stream[] {
    return all.filter(
      (o) => o.id !== s.id && o.parent === s.parent && o.repo === s.repo && isLiveWorkNode(o, all),
    );
  }

  /**
   * What the sibling itself uses: its touched source files, scanned in its
   * worktree and resolved against main's files. Imports it didn't write are
   * main's, shared by every sibling, so they single nobody out.
   */
  private siblingView(
    sib: Stream,
    index: ImportIndex | undefined,
    repoRoot: string,
  ): Record<string, ImportIndexEntry> {
    const view: Record<string, ImportIndexEntry> = {};
    if (sib.worktree === undefined) return view;
    const worktree = isAbsolute(sib.worktree) ? sib.worktree : join(repoRoot, sib.worktree);
    const touched = (sib.touched?.files ?? []).filter(isSourceFile);
    const known = new Set([...Object.keys(index?.files ?? {}), ...touched]);
    for (const file of touched) {
      const text = readText(join(worktree, file));
      if (text !== undefined) view[file] = indexEntry(file, text, known);
    }
    return view;
  }
}
