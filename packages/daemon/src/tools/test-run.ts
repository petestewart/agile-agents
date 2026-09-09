/**
 * `test_run` (§7 "Tool framework": "test_run (command → failing test names,
 * assertion messages, relevant frames; never a green log)"). Unlike
 * `read_summary`, this tool never calls the runner/ACP layer — it executes
 * `command` directly with `Bun.spawn` in the ticket worktree and parses its
 * own output, so there is nothing to cache (a test run is not idempotent by
 * nature) and no `ledger` cost beyond the ledger line the caller (`service.ts`)
 * writes with `kind: reader`, `tokens: 0` model cost.
 *
 * Safety: only a known, safe test-invocation shape is ever executed — see
 * `isAllowedTestCommand`. No shell is involved (`Bun.spawn` gets an argv
 * array, never a string handed to `sh -c`), so shell metacharacters in
 * `command` are inert rather than a second attack surface on top of the
 * allow-list.
 */

import { isAbsolute, join, resolve } from 'node:path';
import { ulid } from '@agile-agents/shared';
import {
  hasUnsafeShellConstruct,
  isPathInside,
  isRepoScriptCommand,
  splitCommandSegments,
  stripPrefixes,
  tokenizeSegment,
} from '../permissions/command';
import { rawOutputPath, writeRawOutput } from './cache';
import { charsPerToken } from './runner';

export interface TestRunInput {
  command: string;
  cwd?: string;
}

export interface TestFailure {
  name: string;
  message: string;
  frames: string[];
}

export interface TestRunOutput {
  ok: boolean;
  failures: TestFailure[];
  summary: string;
  exit_code: number;
  /** Path (relative to the host-local cache root) to the full stdout+stderr — "raw output to files with pointers" (CLAUDE.md). */
  raw_output: string;
}

export class TestRunDeniedError extends Error {}

/** Standalone test-runner binaries beyond the `bun`/`npm`/`pnpm` repo-script allowance (§7's named parsers: "vitest/jest, pytest, go test"). */
const STANDALONE_TEST_BINARIES = new Set(['vitest', 'jest', 'pytest']);

/**
 * "only allowed repo-script commands run" (manager decision, reusing T010's
 * classifier): a `bun`/`npm`/`pnpm` `run`/`test`/`build` invocation
 * (`isRepoScriptCommand`), a bare `vitest`/`jest`/`pytest`, or `go test`.
 * No command chaining (`;`/`&&`/`||`/`|`) at all — `test_run` runs exactly
 * one program, directly, with no shell to chain through in the first place.
 */
export function isAllowedTestCommand(command: string): boolean {
  if (hasUnsafeShellConstruct(command)) return false;
  if (splitCommandSegments(command).length !== 1) return false;
  const tokens = stripPrefixes(tokenizeSegment(command));
  if (tokens.length === 0) return false;
  if (isRepoScriptCommand(tokens)) return true;
  const [bin, sub] = tokens;
  if (bin !== undefined && STANDALONE_TEST_BINARIES.has(bin)) return true;
  if (bin === 'go' && sub === 'test') return true;
  return false;
}

function resolveCwd(worktree: string, cwd: string | undefined): string {
  if (cwd === undefined) return worktree;
  const abs = isAbsolute(cwd) ? cwd : resolve(worktree, cwd);
  if (!isPathInside(abs, worktree)) {
    throw new TestRunDeniedError(`test_run: cwd escapes the ticket worktree: ${cwd}`);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Failure parsers — one per §7-named runner, plus a generic fallback.
// ---------------------------------------------------------------------------

const FAIL_CONTEXT_WINDOW = 12;

/** `bun test`: a `(fail) <name> [<duration>]` line, preceded (not followed — bun prints the error block first) by its `error: ...` / `Expected:`/`Received:` block and `at ...` frames. */
function parseBunFailures(output: string): TestFailure[] {
  const lines = output.split('\n');
  const failRe = /^\(fail\) (.+?)(?: \[[^\]]*\])?\s*$/;
  const failures: TestFailure[] = [];
  let windowStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = failRe.exec(lines[i] ?? '');
    if (!m) continue;
    const name = (m[1] ?? '').trim();
    const windowLines = lines.slice(Math.max(windowStart, i - FAIL_CONTEXT_WINDOW), i);
    const frames = windowLines.filter((l) => /^\s*at /.test(l)).map((l) => l.trim());
    const errorStart = windowLines.findIndex((l) => l.trim().startsWith('error:'));
    const messageLines =
      errorStart !== -1
        ? windowLines.slice(errorStart).filter((l) => !/^\s*at /.test(l) && l.trim().length > 0)
        : windowLines.filter((l) => l.trim().length > 0).slice(-3);
    failures.push({ name, message: messageLines.map((l) => l.trim()).join(' '), frames });
    windowStart = i + 1;
  }
  return failures;
}

/** vitest/jest: `✕`/`✗ <name>` marker, followed by an `● <name>` block with the assertion and `at ...` frames. */
function parseVitestJestFailures(output: string): TestFailure[] {
  const lines = output.split('\n');
  const markerRe = /^\s*(?:✕|✗)\s+(.+?)(?:\s+\(\d+\s*ms\))?\s*$/;
  const failures: TestFailure[] = [];
  const names: string[] = [];
  for (const l of lines) {
    const m = markerRe.exec(l);
    if (m?.[1]) names.push(m[1].trim());
  }
  if (names.length === 0) return [];

  for (const name of names) {
    const blockStart = lines.findIndex((l) => l.trim() === `● ${name}`);
    const windowLines =
      blockStart !== -1 ? lines.slice(blockStart + 1, blockStart + 1 + FAIL_CONTEXT_WINDOW) : [];
    const frames = windowLines.filter((l) => /^\s*at /.test(l)).map((l) => l.trim());
    const messageLines = windowLines.filter((l) => !/^\s*at /.test(l) && l.trim().length > 0);
    failures.push({ name, message: messageLines.map((l) => l.trim()).join(' '), frames });
  }
  return failures;
}

/** pytest: `FAILED <nodeid> - <message>` summary lines (short-test-summary-info), the reliably-parseable line pytest always prints regardless of traceback verbosity. */
function parsePytestFailures(output: string): TestFailure[] {
  const lines = output.split('\n');
  const failRe = /^FAILED (\S+)(?: - (.*))?$/;
  const failures: TestFailure[] = [];
  for (const line of lines) {
    const m = failRe.exec(line.trim());
    if (!m?.[1]) continue;
    const name = m[1];
    const message = m[2] ?? '';
    const frames = lines
      .filter((l) => l.trim().startsWith('E   '))
      .map((l) => l.trim())
      .slice(0, 5);
    failures.push({ name, message, frames });
  }
  return failures;
}

/** `go test`: `--- FAIL: TestName (0.00s)` blocks, with the indented lines up to the next `--- FAIL`/`--- PASS`/`===` marker as the message. */
function parseGoFailures(output: string): TestFailure[] {
  const lines = output.split('\n');
  const failRe = /^--- FAIL: (\S+) \(/;
  const failures: TestFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = failRe.exec(lines[i] ?? '');
    if (!m?.[1]) continue;
    const name = m[1];
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? '';
      if (/^(--- (FAIL|PASS)|=== RUN|PASS|FAIL)\b/.test(l.trim())) break;
      if (l.trim().length > 0) body.push(l.trim());
    }
    failures.push({ name, message: body.join(' ').slice(0, 400), frames: [] });
  }
  return failures;
}

/** Generic fallback (§7 scope line, verbatim): "lines matching FAIL|✗|Error|AssertionError with 3 lines of context". Used only when none of the named parsers found anything. */
function parseGenericFailures(output: string): TestFailure[] {
  const lines = output.split('\n');
  const markerRe = /FAIL|✗|Error|AssertionError/;
  const failures: TestFailure[] = [];
  let lastMatch = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!markerRe.test(line)) continue;
    if (i - lastMatch <= 3) continue; // already covered by a previous match's context window
    lastMatch = i;
    const context = lines.slice(i, Math.min(lines.length, i + 4));
    failures.push({
      name: line.trim().slice(0, 200),
      message: context.join(' ').trim(),
      frames: [],
    });
  }
  return failures;
}

function parseFailures(output: string): TestFailure[] {
  return (
    firstNonEmpty(parseBunFailures(output)) ??
    firstNonEmpty(parseVitestJestFailures(output)) ??
    firstNonEmpty(parsePytestFailures(output)) ??
    firstNonEmpty(parseGoFailures(output)) ??
    parseGenericFailures(output)
  );
}

function firstNonEmpty<T>(arr: T[]): T[] | undefined {
  return arr.length > 0 ? arr : undefined;
}

const MAX_SUMMARY_TOKENS = 500;
const MAX_SUMMARY_CHARS = MAX_SUMMARY_TOKENS * charsPerToken();

function summarize(ok: boolean, failures: TestFailure[], passHint: string): string {
  if (ok) return passHint;
  const lines = failures.map((f) => `${f.name}: ${f.message}`.trim());
  let summary = lines.join('\n');
  if (summary.length > MAX_SUMMARY_CHARS)
    summary = `${summary.slice(0, MAX_SUMMARY_CHARS)}\n[truncated]`;
  return summary;
}

/** Best-effort "N passed" hint from common runner pass-count lines; falls back to a fixed string when no runner-specific count is recognized. */
function passSummary(output: string): string {
  const bunMatch = /(\d+)\s+pass\b/.exec(output);
  if (bunMatch?.[1]) return `${bunMatch[1]} passed`;
  const goMatch = /^PASS$/m.exec(output);
  if (goMatch) return 'passed';
  return 'tests passed';
}

export interface RunTestRunOptions {
  input: TestRunInput;
  /** The ticket worktree — the hard boundary `cwd` may never escape ("never outside", §7 scope line). */
  worktree: string;
  /** For the host-local raw-output file — see `cache.ts`. */
  repoRoot: string;
}

export async function runTestRun(opts: RunTestRunOptions): Promise<TestRunOutput> {
  const { command } = opts.input;
  if (!isAllowedTestCommand(command)) {
    throw new TestRunDeniedError(
      `test_run: command not allowed (only bun/npm/pnpm run|test|build, vitest, jest, pytest, or go test): ${JSON.stringify(command)}`,
    );
  }

  const cwd = resolveCwd(opts.worktree, opts.input.cwd);
  const tokens = tokenizeSegment(command);

  const proc = Bun.spawn(tokens, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const combined = stderr.length > 0 ? `${stdout}\n${stderr}` : stdout;

  const rawRelPath = join(opts.input.command.split(/\s+/)[0] ?? 'run', `${ulid()}.log`);
  writeRawOutput(rawOutputPath(opts.repoRoot, 'test_run', rawRelPath), combined);

  const failures = exitCode === 0 ? [] : parseFailures(combined);
  const ok = exitCode === 0 && failures.length === 0;
  const summary = summarize(ok, failures, passSummary(combined));

  return { ok, failures, summary, exit_code: exitCode, raw_output: join('test_run', rawRelPath) };
}
