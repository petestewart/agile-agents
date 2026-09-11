/**
 * `diff_summary` tool (T016 — design/agile-agents-design.md §7 "Tool
 * framework": "`diff_summary` returns changed symbols and risk notes, not
 * the diff (the diff is a path)"; §12 "Review protocol": "Reads diff
 * summary + contract first, diff second, source third, all through tools").
 *
 * `git diff <integration>...<ticket-branch>` in the ticket worktree ->
 * changed files, best-effort symbols, risk notes. The raw diff is written
 * once to the host-local cache dir (`tools/cache.ts`'s `rawOutputPath`
 * convention — same host-local, gitignored root every other tool's raw
 * output already uses) and only its path is returned; `hunks` carries
 * per-file line ranges + a content hash (metadata, never diff text) so
 * `rereview.ts` can tell whether a later round touched the same lines.
 */

import { createHash } from 'node:crypto';
import { sandboxedSubprocessEnv } from '../subprocess-env';
import { rawOutputPath, writeRawOutput } from '../tools/cache';
import { charsPerToken } from '../tools/runner';

export class DiffSummaryError extends Error {}

export interface DiffHunk {
  path: string;
  /** New-side (post-change) line range this hunk covers. */
  newStart: number;
  newEnd: number;
  /**
   * Hash of the hunk's own body lines only — the `@@ -a,b +c,d @@` header is
   * deliberately excluded (opus review, blocker 1): the header encodes exact
   * line numbers, so an unrelated edit earlier in the file that shifts this
   * hunk down/up with no content change would otherwise change the hash and
   * make `rereview.ts` treat unchanged code as "changed" — fail-open on the
   * one check this hash exists to make fail-closed. Unchanged across rounds
   * iff the hash matches.
   */
  hash: string;
}

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFileSummary {
  path: string;
  status: DiffFileStatus;
  /** Best-effort regex hits over added lines — functions/classes/exports touched. Capped, see `MAX_SYMBOLS_PER_FILE`. */
  symbols: string[];
}

export interface DiffSummaryOutput {
  base: string;
  head: string;
  files: DiffFileSummary[];
  riskNotes: string[];
  hunks: DiffHunk[];
  /** Path to the untruncated raw diff, host-local — never shipped inline (§7). */
  rawDiffPath: string;
  truncated: boolean;
}

export interface RunDiffSummaryOptions {
  /** The ticket's worktree — `git diff` runs here. */
  worktree: string;
  /** Base ref (§15's `integration`). */
  base: string;
  /** Head ref/branch (the ticket's own branch, already checked out in `worktree` — `HEAD` works just as well since the worktree *is* that branch, but the explicit ref name makes the summary self-describing). */
  head: string;
  /** Repo root — for the host-local raw-output cache path. */
  repoRoot: string;
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string, repoRoot: string): GitResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: sandboxedSubprocessEnv(repoRoot, 'git'),
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

const LOCKFILE_NAMES = [
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
];

const MANIFEST_NAMES = ['package.json', 'Cargo.toml', 'pyproject.toml', 'Gemfile'];

const TEST_PATH_PATTERN = /(\.|\/)(test|spec)s?\.[a-z0-9]+$|(^|\/)(tests?|specs?)\//i;

/** Best-effort function/class/export detection over one added line — deliberately loose (a heuristic for risk/attention, not a parser). */
const SYMBOL_PATTERNS = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z0-9_$]+)/,
  /\b(?:function|class)\s+([A-Za-z0-9_$]+)/,
  /^\s*def\s+([A-Za-z0-9_]+)/,
];

function extractSymbol(line: string): string | undefined {
  for (const pattern of SYMBOL_PATTERNS) {
    const match = pattern.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

const MAX_SYMBOLS_PER_FILE = 20;
const MAX_RISK_NOTES = 30;
/** Large-file risk note threshold — lines changed (added+removed) in one file. */
const LARGE_FILE_LINE_THRESHOLD = 300;
/** Overall output token cap (§7's `read_summary` seeds 400; diff_summary gets the same order of magnitude — this is a distilled summary, not a report). */
const MAX_OUTPUT_TOKENS = 800;

interface ParsedFileDiff {
  path: string;
  status: DiffFileStatus;
  addedLines: string[];
  removedCount: number;
  hunks: DiffHunk[];
}

/**
 * Minimal unified-diff parser: enough for file boundaries, hunk headers
 * (`@@ -a,b +c,d @@`), and added/removed line counts — not a general-purpose
 * diff library, since all this tool needs is symbols/risk/hunk-ranges, never
 * the diff text itself back out.
 */
function parseUnifiedDiff(raw: string): ParsedFileDiff[] {
  const lines = raw.split('\n');
  const files: ParsedFileDiff[] = [];
  let current: ParsedFileDiff | undefined;
  let currentHunkLines: string[] = [];
  let currentHunk: { newStart: number; newEnd: number } | undefined;

  const flushHunk = () => {
    if (current && currentHunk) {
      current.hunks.push({
        path: current.path,
        newStart: currentHunk.newStart,
        newEnd: currentHunk.newEnd,
        hash: createHash('sha256').update(currentHunkLines.join('\n')).digest('hex'),
      });
    }
    currentHunkLines = [];
    currentHunk = undefined;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushHunk();
      // "diff --git a/path b/path"
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const path = match?.[2] ?? match?.[1] ?? line.slice('diff --git '.length);
      current = { path, status: 'modified', addedLines: [], removedCount: 0, hunks: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from') || line.startsWith('rename to')) {
      current.status = 'renamed';
      continue;
    }
    const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkHeader) {
      flushHunk();
      const newStart = Number(hunkHeader[1]);
      const newLen = hunkHeader[2] !== undefined ? Number(hunkHeader[2]) : 1;
      currentHunk = { newStart, newEnd: newLen > 0 ? newStart + newLen - 1 : newStart };
      // Body lines only — never the header itself, see `DiffHunk.hash`'s doc.
      currentHunkLines = [];
      continue;
    }
    if (currentHunk) currentHunkLines.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.removedCount += 1;
    }
  }
  flushHunk();
  return files;
}

function buildRiskNotes(files: ParsedFileDiff[]): string[] {
  const notes: string[] = [];
  for (const file of files) {
    const changedLines = file.addedLines.length + file.removedCount;
    if (changedLines > LARGE_FILE_LINE_THRESHOLD) {
      notes.push(`large change: ${file.path} (${changedLines} lines)`);
    }
    const base = file.path.split('/').pop() ?? file.path;
    if (LOCKFILE_NAMES.includes(base)) {
      notes.push(`lockfile changed: ${file.path}`);
    }
    if (MANIFEST_NAMES.includes(base)) {
      notes.push(`dependency manifest changed: ${file.path}`);
    }
    if (file.status === 'deleted' && TEST_PATH_PATTERN.test(file.path)) {
      notes.push(`test file deleted: ${file.path}`);
    }
  }
  return notes.slice(0, MAX_RISK_NOTES);
}

export function runDiffSummary(opts: RunDiffSummaryOptions): DiffSummaryOutput {
  const range = `${opts.base}...${opts.head}`;
  const result = git(['diff', range], opts.worktree, opts.repoRoot);
  if (result.exitCode !== 0) {
    throw new DiffSummaryError(`git diff ${range} failed in ${opts.worktree}: ${result.stderr}`);
  }
  const raw = result.stdout;

  const rawPath = rawOutputPath(
    opts.repoRoot,
    'diff_summary',
    `${opts.head.replace(/[^A-Za-z0-9_.-]/g, '_')}-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}.diff`,
  );
  writeRawOutput(rawPath, raw);

  const parsed = parseUnifiedDiff(raw);

  const files: DiffFileSummary[] = parsed.map((f) => {
    const symbols = [
      ...new Set(f.addedLines.map(extractSymbol).filter((s): s is string => !!s)),
    ].slice(0, MAX_SYMBOLS_PER_FILE);
    return { path: f.path, status: f.status, symbols };
  });

  const riskNotes = buildRiskNotes(parsed);
  const hunks = parsed.flatMap((f) => f.hunks);

  const output: DiffSummaryOutput = {
    base: opts.base,
    head: opts.head,
    files,
    riskNotes,
    hunks,
    rawDiffPath: rawPath,
    truncated: false,
  };

  // Token cap applies only to the reviewer-facing fields (files/riskNotes/
  // symbols) — `hunks` is protocol-internal bookkeeping the re-review rule
  // depends on for correctness, never a reviewer-facing payload, so it is
  // never a candidate for truncation (opus review, blocker 1: "truncation
  // must never drop the hunk record"). The size check itself is therefore
  // computed on the output *without* hunks.
  const maxChars = MAX_OUTPUT_TOKENS * charsPerToken();
  const displaySize = () => JSON.stringify({ ...output, hunks: [] }).length;
  if (displaySize() > maxChars) {
    output.truncated = true;
    output.riskNotes = output.riskNotes.slice(0, 5);
    output.files = output.files.map((f) => ({ ...f, symbols: f.symbols.slice(0, 5) }));
  }

  return output;
}
