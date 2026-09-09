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

import { mkdirSync } from 'node:fs';
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
import { sandboxedSubprocessEnv } from '../subprocess-env';
import { CACHE_DIR_NAME, rawOutputPath } from './cache';
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
  /** True if the spawn timeout fired and the process was killed before it could finish. */
  timed_out?: boolean;
  /** Count of failures parsed but dropped from `failures[]` to keep the result small — see `MAX_FAILURES_RETURNED`. */
  omitted_failures?: number;
  /** The true number of failures parsed, regardless of how many `failures[]` actually carries — never dropped by the size budget (review round 2). */
  total_failures: number;
}

export class TestRunDeniedError extends Error {}

/** QA round 1 (T011): a runaway test process must not run forever or flood memory/the ledger. */
export const DEFAULT_TEST_RUN_TIMEOUT_MS = 120_000;
/** Bun's native `maxBuffer` (per stream) — a process that logs past this is killed and its output truncated, never buffered without bound. */
export const MAX_TEST_RUN_OUTPUT_BYTES = 1024 * 1024; // 1 MiB
/** Keeps the result well under the ~500-token acceptance cap even for a suite with dozens of failures — the rest are still on disk via `raw_output`. */
export const MAX_FAILURES_RETURNED = 10;

/** Standalone test-runner binaries beyond the `bun`/`npm`/`pnpm` repo-script allowance (§7's named parsers: "vitest/jest, pytest, go test"). */
const STANDALONE_TEST_BINARIES = new Set(['vitest', 'jest', 'pytest']);

/**
 * "only allowed repo-script commands run" (manager decision, reusing T010's
 * classifier): a `bun`/`npm`/`pnpm` `run`/`test`/`build` invocation
 * (`isRepoScriptCommand`), a bare `vitest`/`jest`/`pytest`, or `go test`.
 * No command chaining (`;`/`&&`/`||`/`|`) at all — `test_run` runs exactly
 * one program, directly, with no shell to chain through in the first place.
 *
 * Review round fix (blocker 4): `stripPrefixes` exists so the *classifier*
 * can see through a leading `env FOO=bar` / `nohup` / etc. wrapper to the
 * real command underneath — it was never meant to also decide what actually
 * gets executed. `runTestRun` spawns `tokenizeSegment(command)` verbatim
 * (the raw, un-stripped argv — no shell involved, ever), so classifying on
 * the stripped tokens while spawning the raw ones let `env
 * LD_PRELOAD=... bun test` classify as a plain `bun test` and then run with
 * the env-assignment/wrapper prefix still attached, live. `test_run` itself
 * has no legitimate reason to carry an env-assignment or wrapper prefix —
 * the ticket's own tool.yaml never asks for one — so this checks the raw
 * tokens equal the stripped ones and refuses outright when they don't,
 * rather than trying to launder the prefix away and spawn the "vetted" tail.
 */
export function isAllowedTestCommand(command: string): boolean {
  if (hasUnsafeShellConstruct(command)) return false;
  if (splitCommandSegments(command).length !== 1) return false;
  const rawTokens = tokenizeSegment(command);
  const strippedTokens = stripPrefixes(rawTokens);
  // Any difference at all (an env assignment/wrapper prefix stripped away,
  // or even a token `stripPrefixes`'s unescaping rewrote) means the argv
  // that would actually be spawned (`rawTokens`, verbatim, no shell) isn't
  // the same as the argv the check below is about to classify — refuse
  // rather than spawn something other than what was vetted.
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

/**
 * Review round 2 (blocker 1): the ≤500-token acceptance ceiling applies to
 * the WHOLE serialized `TestRunOutput`, not just `summary` — a 60-failure
 * bun test run was still ~850-1100 tokens even with `summary` capped and
 * `failures[]` limited to `MAX_FAILURES_RETURNED` entries, because each
 * entry's full `message`/`frames` still dominated the payload. `summary`
 * gets its own, tighter budget so `failures[]` has room left within the
 * shared ceiling — see `budgetTestRunOutput` for how the whole result is
 * kept under `MAX_RESULT_CHARS`.
 */
const MAX_RESULT_TOKENS = 500;
const MAX_RESULT_CHARS = MAX_RESULT_TOKENS * charsPerToken();
const MAX_SUMMARY_TOKENS = 120;
const MAX_SUMMARY_CHARS = MAX_SUMMARY_TOKENS * charsPerToken();
/** Step 2 of `budgetTestRunOutput`'s shrink ladder: a short excerpt is still enough to recognize which assertion failed. */
const MAX_FAILURE_MESSAGE_CHARS = 60;

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

function summarize(ok: boolean, failures: TestFailure[], passHint: string): string {
  if (ok) return passHint;
  const lines = failures.map((f) => `${f.name}: ${f.message}`.trim());
  return truncate(lines.join('\n'), MAX_SUMMARY_CHARS);
}

/** Best-effort "N passed" hint from common runner pass-count lines; falls back to a fixed string when no runner-specific count is recognized. */
function passSummary(output: string): string {
  const bunMatch = /(\d+)\s+pass\b/.exec(output);
  if (bunMatch?.[1]) return `${bunMatch[1]} passed`;
  const goMatch = /^PASS$/m.exec(output);
  if (goMatch) return 'passed';
  return 'tests passed';
}

export interface BudgetTestRunOutputInput {
  ok: boolean;
  /** Every failure parsed, unfiltered — `budgetTestRunOutput` decides how many (and how much of each) survive into the result. */
  allFailures: TestFailure[];
  summary: string;
  exitCode: number;
  rawOutputRelPath: string;
  timedOut: boolean;
}

/**
 * Assembles the final `TestRunOutput`, shrinking `failures[]` — first by
 * dropping stack frames, then by truncating each message, then by dropping
 * whole entries one at a time — until `JSON.stringify(result).length` fits
 * `MAX_RESULT_CHARS`. `total_failures` (the true count, always present) and
 * `raw_output` (the pointer to the untruncated log) are never dropped —
 * they're what let an agent decide whether the omitted detail is worth
 * reading from disk. Converges unconditionally: with `failures: []` the
 * result is just the envelope + `summary`, already within budget on its own.
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
  /** The ticket worktree — the hard boundary `cwd` may never escape ("never outside", §7 scope line). */
  worktree: string;
  /** For the host-local raw-output file — see `cache.ts`. */
  repoRoot: string;
  /** Overrides `DEFAULT_TEST_RUN_TIMEOUT_MS` — mainly for tests. */
  timeoutMs?: number;
  /** Overrides `MAX_TEST_RUN_OUTPUT_BYTES` — mainly for tests. */
  maxOutputBytes?: number;
}

export async function runTestRun(opts: RunTestRunOptions): Promise<TestRunOutput> {
  const { command } = opts.input;
  if (!isAllowedTestCommand(command)) {
    throw new TestRunDeniedError(
      `test_run: command not allowed (only bun/npm/pnpm run|test|build, vitest, jest, pytest, or go test): ${JSON.stringify(command)}`,
    );
  }

  const cwd = resolveCwd(opts.worktree, opts.input.cwd);
  // Review round fix (blocker 4): spawn exactly the tokens `isAllowedTestCommand`
  // vetted — never the raw, un-stripped ones — so a command that (somehow)
  // slipped an env-assignment/wrapper prefix past the check can't ever run
  // with that prefix live. `isAllowedTestCommand` already refuses any
  // command where stripping would change anything, so this is always
  // identical to `tokenizeSegment(command)` by the time it's reached — kept
  // explicit rather than relying on that invariant silently.
  const tokens = stripPrefixes(tokenizeSegment(command));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TEST_RUN_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? MAX_TEST_RUN_OUTPUT_BYTES;

  // T034 (T033 review round 3 follow-up): stdout/stderr go straight to
  // plain files, never `'pipe'` — the same fix T033 landed for the hook
  // CLI subprocess (`hook/rpc.test.ts`'s `runHookCli`). This was the only
  // remaining async `Bun.spawn` with piped stdio in the daemon that drains
  // *then* awaits `exited`: Bun's own epoll bookkeeping for piped stdio fds
  // can race `proc.exited` under load (`EBADF: bad file descriptor,
  // epoll_ctl`) — draining concurrently with `exited` (the fix tried
  // elsewhere first) only narrows that race, never closes it, because the
  // race is in the pipe/epoll path itself, not in drain ordering. The OS
  // dup2()s the child's fds onto regular files, so there is nothing left
  // to race. This also removes Bun's `maxBuffer` (a piped-stream-only
  // option, and the process-killing mechanism the old cap used) — the byte
  // ceiling below is now a size check on the captured files after the
  // process has already exited, never a reason to kill it early, and the
  // full, untruncated output is always on disk under
  // `<repoRoot>/.agile-daemon-cache/test-run/` regardless of size.
  //
  // `env`: T034 — never the daemon's inherited `process.env`/`$HOME`; a
  // test suite's own tooling (npm's debug logger, a package manager's
  // cache) must never write into the operator's real home directory.
  const runId = ulid();
  const captureDir = join(opts.repoRoot, CACHE_DIR_NAME, 'test-run');
  mkdirSync(captureDir, { recursive: true });
  const stdoutPath = join(captureDir, `${runId}.out`);
  const stderrPath = join(captureDir, `${runId}.err`);

  const proc = Bun.spawn(tokens, {
    cwd,
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    env: sandboxedSubprocessEnv(opts.repoRoot, 'test-run'),
  });
  const exitCode = await proc.exited;
  // Bun reports a timeout/signal kill as a negative/undefined-ish `exitCode`
  // depending on platform; `proc.signalCode` is the reliable signal.
  const timedOut = proc.signalCode !== null && proc.signalCode !== undefined;

  const stdoutFile = Bun.file(stdoutPath);
  const stderrFile = Bun.file(stderrPath);

  // The distilled text used for parsing/summarizing is capped per stream —
  // the same per-stream ceiling `maxBuffer` used to enforce — by reading
  // only the tail of a stream that exceeds it (a failing assertion or
  // `FAILED`/`--- FAIL` marker is far more likely to be near the end of a
  // noisy log than the start). The raw files on disk are never truncated.
  const [stdout, stderr] = await Promise.all([
    readCappedTail(stdoutFile, maxOutputBytes),
    readCappedTail(stderrFile, maxOutputBytes),
  ]);
  const combined = stderr.length > 0 ? `${stdout}\n${stderr}` : stdout;

  // Combine the two on-disk capture files into the one raw-output artifact
  // `raw_output` points to, streaming chunk-by-chunk rather than joining
  // JS strings — a multi-hundred-MB log must never be held whole in memory
  // just to copy it (review round fix: the old `writeRawOutput(path,
  // combined)` did exactly that, using the already-capped `combined`
  // string, which was fine only because `maxBuffer` had already capped it
  // upstream; that upstream cap is gone now).
  const rawRelPath = join(opts.input.command.split(/\s+/)[0] ?? 'run', `${runId}.log`);
  await writeRawOutputStream(rawOutputPath(opts.repoRoot, 'test_run', rawRelPath), [
    stdoutFile,
    stderrFile,
  ]);

  const allFailures = timedOut ? [] : exitCode === 0 ? [] : parseFailures(combined);
  const ok = !timedOut && exitCode === 0 && allFailures.length === 0;

  const summary = timedOut
    ? `test_run: killed after exceeding the ${timeoutMs}ms timeout — see raw_output`
    : summarize(ok, allFailures.slice(0, MAX_FAILURES_RETURNED), passSummary(combined));

  // Review round 2 (blocker 1): the whole serialized result, not just
  // `summary`, must stay under the token ceiling — `budgetTestRunOutput`
  // shrinks `failures[]` as needed; `total_failures`/`omitted_failures` and
  // `raw_output` always carry the true count and a pointer to everything
  // that got left out.
  return budgetTestRunOutput({
    ok,
    allFailures,
    summary,
    exitCode,
    rawOutputRelPath: join('test_run', rawRelPath),
    timedOut,
  });
}

/**
 * Reads `file` in full, unless it exceeds `capBytes` — then only the last
 * `capBytes` are read (`BunFile.slice` is a cheap, lazy view; no
 * intermediate copy of the skipped prefix is ever made). This is the size
 * check that replaces Bun's `maxBuffer` (T034): the process is never
 * killed for producing too much output, only the text used for parsing is
 * bounded.
 */
async function readCappedTail(
  file: ReturnType<typeof Bun.file>,
  capBytes: number,
): Promise<string> {
  if (file.size <= capBytes) return file.text();
  return file.slice(file.size - capBytes).text();
}

/**
 * Streams `parts` (in order) into `destPath`, never materializing the
 * whole concatenation as one JS string/buffer — the raw-output artifact
 * can legitimately be well past `maxOutputBytes` (that cap only bounds the
 * *distilled* text used for parsing), so copying it must not itself
 * reintroduce an unbounded in-memory buffer.
 */
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
