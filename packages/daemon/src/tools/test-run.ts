/**
 * `test_run` (design §4.1: command → failing test names, assertion
 * messages, relevant frames; never a green log). Runs `command` directly
 * with `Bun.spawn` in the stream worktree and parses its own output.
 *
 * Safety: only a known test-invocation shape runs (`isAllowedTestCommand`),
 * and no shell is involved (an argv array, never `sh -c`), so shell
 * metacharacters are inert.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ulid } from '@agile-agents/shared';
import {
  hasUnsafeShellConstruct,
  isPathInside,
  isRepoScriptCommand,
  splitCommandSegments,
  stripPrefixes,
  tokenizeSegment,
} from '../permissions/command';
import { DAEMON_CACHE_DIR, sandboxedSubprocessEnv } from '../subprocess-env';

/** Host-local path for a tool's full raw log, under the daemon cache's `raw/<tool>/`. */
function rawOutputPath(repoRoot: string, toolName: string, fileName: string): string {
  return join(repoRoot, DAEMON_CACHE_DIR, 'raw', toolName, fileName);
}

/** ~4 chars/token, behind the "under 500 tokens" output cap. */
function charsPerToken(): number {
  return 4;
}

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
  /** Path (relative to the cache root) to the full stdout+stderr: raw output to files with pointers. */
  raw_output: string;
  /** The timeout fired and the process was killed. */
  timed_out?: boolean;
  /** Failures parsed but dropped from `failures[]` to keep the result small. */
  omitted_failures?: number;
  /** The true failure count, never dropped by the size budget. */
  total_failures: number;
  /**
   * This run's own log alone exceeds the retained-bytes budget: it was
   * kept (the pointer is always live) and older runs were pruned harder.
   */
  raw_output_over_budget?: boolean;
}

export class TestRunDeniedError extends Error {}

/** A runaway test process must not run forever. */
export const DEFAULT_TEST_RUN_TIMEOUT_MS = 120_000;
/** Per-stream cap on the text read back for parsing (the tail is kept); the raw file is never truncated. */
export const MAX_TEST_RUN_OUTPUT_BYTES = 1024 * 1024; // 1 MiB
/** Keeps the result under the ~500-token cap; the rest stay on disk via `raw_output`. */
export const MAX_FAILURES_RETURNED = 10;
/**
 * Disk ceiling across many runs for the whole `raw/` cache tree (one
 * shared budget for every tool that writes there). After every run the
 * oldest raw logs are pruned back under it. An old pointer may dangle; the
 * alternative is unbounded growth.
 */
export const MAX_RETAINED_RAW_OUTPUT_BYTES = 200 * 1024 * 1024; // 200 MiB

/** Standalone test runners beyond the `bun`/`npm`/`pnpm` repo-script allowance. */
const STANDALONE_TEST_BINARIES = new Set(['vitest', 'jest', 'pytest']);

/**
 * Every in-flight run's raw-output paths (one daemon process, so
 * module-level is enough), so a concurrent run's prune never deletes files
 * still being written. Removed in a `finally` once the run is done.
 */
const inFlightRawOutputPaths = new Set<string>();

/**
 * Only allowed test commands run: a `bun`/`npm`/`pnpm` repo script
 * (`isRepoScriptCommand`), bare `vitest`/`jest`/`pytest`, or `go test`.
 * No chaining: exactly one program, no shell.
 *
 * The spawned argv is the raw tokens, so a command whose tokens change
 * under `stripPrefixes` (an `env LD_PRELOAD=... bun test` wrapper) is
 * refused outright rather than classified on the stripped tail.
 */
export function isAllowedTestCommand(command: string): boolean {
  if (hasUnsafeShellConstruct(command)) return false;
  if (splitCommandSegments(command).length !== 1) return false;
  const rawTokens = tokenizeSegment(command);
  const strippedTokens = stripPrefixes(rawTokens);
  // Any difference means the spawned argv isn't what gets classified: refuse.
  const tokensMatch =
    rawTokens.length === strippedTokens.length &&
    rawTokens.every((t, i) => t === strippedTokens[i]);
  if (!tokensMatch) return false;
  const tokens = strippedTokens;
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

// Failure parsers: one per named runner, plus a generic fallback.

const FAIL_CONTEXT_WINDOW = 12;

/** `bun test`: a `(fail) <name>` line, preceded by its `error:` block and `at ...` frames (bun prints the error first). */
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

/** pytest: `FAILED <nodeid> - <message>` summary lines, printed whatever the traceback verbosity. */
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

/** `go test`: `--- FAIL: TestName (0.00s)` blocks, message up to the next marker. */
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

/** Generic fallback: lines matching FAIL|✗|Error|AssertionError with 3 lines of context. */
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

/**
 * The ≤500-token ceiling applies to the whole serialized result, so
 * `summary` gets its own tighter budget and `budgetTestRunOutput` shrinks
 * `failures[]` into what is left.
 */
const MAX_RESULT_TOKENS = 500;
const MAX_RESULT_CHARS = MAX_RESULT_TOKENS * charsPerToken();
const MAX_SUMMARY_TOKENS = 120;
const MAX_SUMMARY_CHARS = MAX_SUMMARY_TOKENS * charsPerToken();
/** A short excerpt still identifies which assertion failed. */
const MAX_FAILURE_MESSAGE_CHARS = 60;

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

function summarize(ok: boolean, failures: TestFailure[], passHint: string): string {
  if (ok) return passHint;
  const lines = failures.map((f) => `${f.name}: ${f.message}`.trim());
  return truncate(lines.join('\n'), MAX_SUMMARY_CHARS);
}

/** Best-effort "N passed" hint from common pass-count lines. */
function passSummary(output: string): string {
  const bunMatch = /(\d+)\s+pass\b/.exec(output);
  if (bunMatch?.[1]) return `${bunMatch[1]} passed`;
  const goMatch = /^PASS$/m.exec(output);
  if (goMatch) return 'passed';
  return 'tests passed';
}

export interface BudgetTestRunOutputInput {
  ok: boolean;
  /** Every failure parsed; `budgetTestRunOutput` decides what survives. */
  allFailures: TestFailure[];
  summary: string;
  exitCode: number;
  rawOutputRelPath: string;
  timedOut: boolean;
  /** See `TestRunOutput.raw_output_over_budget`. */
  rawOutputOverBudget?: boolean;
}

/**
 * Builds the result, shrinking `failures[]` (drop frames, then truncate
 * messages, then drop entries) until it fits `MAX_RESULT_CHARS`.
 * `total_failures` and `raw_output` always survive so the agent can decide
 * whether to read the rest. With `failures: []` it always fits.
 */
export function budgetTestRunOutput(input: BudgetTestRunOutputInput): TestRunOutput {
  const totalFailures = input.allFailures.length;

  const assemble = (failures: TestFailure[]): TestRunOutput => {
    const omitted = totalFailures - failures.length;
    return {
      ok: input.ok,
      failures,
      summary: input.summary,
      exit_code: input.exitCode,
      raw_output: input.rawOutputRelPath,
      total_failures: totalFailures,
      ...(input.timedOut ? { timed_out: true } : {}),
      ...(omitted > 0 ? { omitted_failures: omitted } : {}),
      ...(input.rawOutputOverBudget ? { raw_output_over_budget: true } : {}),
    };
  };
  const fits = (failures: TestFailure[]): boolean =>
    JSON.stringify(assemble(failures)).length <= MAX_RESULT_CHARS;

  let failures = input.allFailures.slice(0, MAX_FAILURES_RETURNED);
  if (fits(failures)) return assemble(failures);

  failures = failures.map((f) => ({ ...f, frames: [] }));
  if (fits(failures)) return assemble(failures);

  failures = failures.map((f) => ({
    ...f,
    message: truncate(f.message, MAX_FAILURE_MESSAGE_CHARS),
  }));
  if (fits(failures)) return assemble(failures);

  while (failures.length > 0 && !fits(failures)) {
    failures = failures.slice(0, failures.length - 1);
  }
  return assemble(failures);
}

export interface RunTestRunOptions {
  input: TestRunInput;
  /** The stream worktree: `cwd` may never escape it. */
  worktree: string;
  /** Root for the host-local raw-output file. */
  repoRoot: string;
  /** Test overrides. */
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxRetainedRawBytes?: number;
}

export async function runTestRun(opts: RunTestRunOptions): Promise<TestRunOutput> {
  // Taken before anything else: any file with an mtime at or after this
  // belongs to a concurrent run and is protected from this run's prune.
  const runStartedAt = Date.now();
  const { command } = opts.input;
  if (!isAllowedTestCommand(command)) {
    throw new TestRunDeniedError(
      `test_run: command not allowed (only bun/npm/pnpm run|test|build, vitest, jest, pytest, or go test): ${JSON.stringify(command)}`,
    );
  }

  const cwd = resolveCwd(opts.worktree, opts.input.cwd);
  // Identical to the raw tokens once `isAllowedTestCommand` passed; kept
  // explicit rather than relying on that invariant silently.
  const tokens = stripPrefixes(tokenizeSegment(command));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TEST_RUN_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? MAX_TEST_RUN_OUTPUT_BYTES;
  const maxRetainedRawBytes = opts.maxRetainedRawBytes ?? MAX_RETAINED_RAW_OUTPUT_BYTES;

  // stdout/stderr go straight to files, never `'pipe'`: Bun's epoll
  // bookkeeping for piped fds can race `proc.exited` under load (`EBADF`),
  // and draining concurrently only narrows the race. The output cap is a
  // size check on the files afterwards, never a reason to kill the process.
  //
  // `env` is sandboxed: a suite's tooling must never write into the
  // operator's real home. The capture files live in the `raw/test_run/`
  // cache tree, outside that sandbox home, so a suite that cleans "its own"
  // home can't disturb the files recording its output.
  const runId = ulid();
  const bin = opts.input.command.split(/\s+/)[0] ?? 'run';
  const testRunRawRoot = join(opts.repoRoot, DAEMON_CACHE_DIR, 'raw', 'test_run');
  // Pruning sweeps the whole `raw/` tree: one shared budget for every tool.
  const rawTreeRoot = join(opts.repoRoot, DAEMON_CACHE_DIR, 'raw');
  const rawDir = join(testRunRawRoot, bin);
  mkdirSync(rawDir, { recursive: true });
  const stdoutPath = join(rawDir, `${runId}.out`);
  const stderrPath = join(rawDir, `${runId}.err`);
  const rawRelPath = join(bin, `${runId}.log`);
  const rawLogPath = rawOutputPath(opts.repoRoot, 'test_run', rawRelPath);

  // Registered before the capture files exist, removed after this run's
  // own prune, so a concurrent sweep can never delete them.
  for (const path of [stdoutPath, stderrPath, rawLogPath]) {
    inFlightRawOutputPaths.add(path);
  }
  try {
    const proc = Bun.spawn(tokens, {
      cwd,
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      env: sandboxedSubprocessEnv(opts.repoRoot, 'test-run'),
    });
    const exitCode = await proc.exited;
    // `proc.signalCode` is the reliable timeout/kill signal across platforms.
    const timedOut = proc.signalCode !== null && proc.signalCode !== undefined;

    const stdoutFile = Bun.file(stdoutPath);
    const stderrFile = Bun.file(stderrPath);

    // The text used for parsing is capped per stream by reading the tail (a
    // failure marker is likelier near the end). The raw files stay whole.
    const [stdout, stderr] = await Promise.all([
      readCappedTail(stdoutFile, maxOutputBytes),
      readCappedTail(stderrFile, maxOutputBytes),
    ]);
    const combined = stderr.length > 0 ? `${stdout}\n${stderr}` : stdout;

    // Stream both captures into the one combined log chunk by chunk: a huge
    // log must never be held in memory whole.
    await writeRawOutputStream(rawLogPath, [stdoutFile, stderrFile]);

    // Folded into the combined log: remove the captures. Best effort.
    for (const path of [stdoutPath, stderrPath]) {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    }

    // Prune the oldest raw logs back under budget; never fails the run.
    // Protected: this run's files, every in-flight run's files, and anything
    // written since this run started (a concurrent sibling that has already
    // finished and deregistered). So a run's `raw_output` survives every
    // sweep by a run that started before or during it.
    let rawOutputOverBudget = false;
    try {
      rawOutputOverBudget = pruneRawTestRunOutputs(
        rawTreeRoot,
        maxRetainedRawBytes,
        new Set([stdoutPath, stderrPath, rawLogPath, ...inFlightRawOutputPaths]),
        runStartedAt,
      );
    } catch {
      // Best-effort housekeeping.
    }

    const allFailures = timedOut ? [] : exitCode === 0 ? [] : parseFailures(combined);
    const ok = !timedOut && exitCode === 0 && allFailures.length === 0;

    const summary = timedOut
      ? `test_run: killed after exceeding the ${timeoutMs}ms timeout — see raw_output`
      : summarize(ok, allFailures.slice(0, MAX_FAILURES_RETURNED), passSummary(combined));

    // The whole serialized result stays under the token ceiling.
    return budgetTestRunOutput({
      ok,
      allFailures,
      summary,
      exitCode,
      rawOutputRelPath: join('test_run', rawRelPath),
      timedOut,
      rawOutputOverBudget,
    });
  } finally {
    for (const path of [stdoutPath, stderrPath, rawLogPath]) {
      inFlightRawOutputPaths.delete(path);
    }
  }
}

/** Reads `file`, or only its last `capBytes` when larger (`slice` is a lazy view). */
async function readCappedTail(
  file: ReturnType<typeof Bun.file>,
  capBytes: number,
): Promise<string> {
  if (file.size <= capBytes) return file.text();
  return file.slice(file.size - capBytes).text();
}

/** Streams `parts` in order into `destPath`, never holding the whole log in memory. */
async function writeRawOutputStream(
  destPath: string,
  parts: readonly ReturnType<typeof Bun.file>[],
): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true });
  const writer = Bun.file(destPath).writer();
  try {
    for (const part of parts) {
      if (part.size === 0) continue;
      for await (const chunk of part.stream()) {
        writer.write(chunk);
      }
    }
  } finally {
    await writer.end();
  }
}

function collectFilesRecursive(dir: string, acc: string[] = []): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc; // doesn't exist yet
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Deletes the oldest files (by mtime) under `rootDir` until the total is
 * at or under `maxTotalBytes`. Never a candidate: a path in
 * `protectedPaths`, or a file with `mtimeMs >= minProtectedMtimeMs` (the
 * caller's start time, so a finished concurrent sibling's log survives).
 * A plain oldest-first sweep once deleted the very log it had just
 * returned. Returns `true` when the protected files alone still exceed the
 * budget (surfaced as `raw_output_over_budget`).
 */
export function pruneRawTestRunOutputs(
  rootDir: string,
  maxTotalBytes: number,
  protectedPaths: ReadonlySet<string>,
  minProtectedMtimeMs?: number,
): boolean {
  const files = collectFilesRecursive(rootDir).map((path) => {
    const stat = statSync(path);
    return { path, size: stat.size, mtimeMs: stat.mtimeMs };
  });
  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= maxTotalBytes) return false;

  const isProtected = (file: { path: string; mtimeMs: number }): boolean =>
    protectedPaths.has(file.path) ||
    (minProtectedMtimeMs !== undefined && file.mtimeMs >= minProtectedMtimeMs);
  const prunable = files.filter((file) => !isProtected(file)).sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of prunable) {
    if (total <= maxTotalBytes) break;
    try {
      unlinkSync(file.path);
      total -= file.size;
    } catch {
      // Already gone, or a race: best effort.
    }
  }
  return total > maxTotalBytes;
}
