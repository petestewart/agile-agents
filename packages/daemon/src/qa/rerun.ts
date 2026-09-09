/**
 * Per-criterion execution with the §13 rerun/flaky policy
 * (design/agile-agents-design.md §13 "Flakiness": "one rerun before
 * calling a failure; two different results is a `flaky` finding filed to
 * the KB").
 *
 * Executes via the same `runTestRun` (`../tools/test-run.ts`, T011) the
 * `test_run` MCP tool uses — this ticket doesn't own `tools/**`, so rather
 * than duplicate its command-allow-list/parsing, it calls the exported pure
 * function directly (no `ToolService`/ledger dependency needed for the
 * daemon-side protocol; the manager can still route this through
 * `ToolService.callTool('test_run', ...)` instead if a ledger line per QA
 * run is wanted — see `protocol.ts`'s file header).
 */

import type { QaCriterionStatus } from '@agile-agents/shared';
import { QA_REPORT_MAX_EVIDENCE_CHARS } from '@agile-agents/shared';
import type { RunTestRunOptions, TestRunOutput } from '../tools/test-run';
import { TestRunDeniedError, runTestRun as defaultRunTestRun } from '../tools/test-run';
import type { QaCriterion } from './criteria';

export type RunTestRunFn = (opts: RunTestRunOptions) => Promise<TestRunOutput>;

export interface QaCriterionResult {
  criterion: string;
  command?: string;
  status: QaCriterionStatus;
  evidence: string;
}

export interface FlakyFinding {
  criterion: QaCriterion;
  command: string;
  first: TestRunOutput;
  second: TestRunOutput;
}

export interface RunCriterionOptions {
  criterion: QaCriterion;
  /** Command supplied by the QA model turn's `qa_plan` verb — `undefined` means "not exercisable from outside" (§13), a `skipped` finding, not a failure. */
  command: string | undefined;
  worktree: string;
  repoRoot: string;
  runTestRun?: RunTestRunFn;
}

export interface RunCriterionResult {
  result: QaCriterionResult;
  /** Present only when the criterion failed then passed on rerun — the caller (`QaProtocol`) files this to the KB (§13). */
  flaky?: FlakyFinding;
}

function truncateEvidence(text: string): string {
  return text.length > QA_REPORT_MAX_EVIDENCE_CHARS
    ? `${text.slice(0, QA_REPORT_MAX_EVIDENCE_CHARS - 1)}…`
    : text;
}

function skippedResult(
  criterion: QaCriterion,
  command: string | undefined,
  reason: string,
): RunCriterionResult {
  return {
    result: {
      criterion: criterion.text,
      ...(command !== undefined ? { command } : {}),
      status: 'skipped',
      evidence: truncateEvidence(reason),
    },
  };
}

/**
 * Runs one criterion's command, applying the one-rerun-on-failure policy:
 * pass first try -> `pass`; fail then pass on rerun -> `flaky` (+ the
 * `FlakyFinding` the caller files to the KB); fail twice -> `fail` (observed
 * via the second run's `test_run` summary vs. the criterion text as
 * "expected"); no command at all -> `skipped`, never executed.
 *
 * Review round fix: a command `test_run` itself refuses at spawn time
 * (`TestRunDeniedError` — not on the allow-list, e.g. `test_run`'s allowed
 * shape changed under a plan written before this ticket's own up-front
 * `qa_plan` validation existed, or a caller bypassing `QaProtocol.plan`'s
 * validation entirely) must not abort the whole QA round — it becomes this
 * criterion's own `skipped` finding (with the denial reason as evidence),
 * and every other planned criterion still runs.
 */
export async function runCriterionWithRerun(
  opts: RunCriterionOptions,
): Promise<RunCriterionResult> {
  const { criterion, command, worktree, repoRoot } = opts;
  const runTestRun = opts.runTestRun ?? defaultRunTestRun;

  if (command === undefined) {
    return skippedResult(
      criterion,
      undefined,
      'no command supplied via qa_plan — cannot be exercised from outside (§13 finding)',
    );
  }

  let first: TestRunOutput;
  try {
    first = await runTestRun({ input: { command }, worktree, repoRoot });
  } catch (err) {
    if (err instanceof TestRunDeniedError) {
      return skippedResult(criterion, command, `command denied: ${err.message}`);
    }
    throw err;
  }
  if (first.ok) {
    return {
      result: {
        criterion: criterion.text,
        command,
        status: 'pass',
        evidence: truncateEvidence(`${command} -> ${first.summary}`),
      },
    };
  }

  const second = await runTestRun({ input: { command }, worktree, repoRoot });
  if (second.ok) {
    return {
      result: {
        criterion: criterion.text,
        command,
        status: 'flaky',
        evidence: truncateEvidence(
          `failed once (${first.summary}), passed on rerun — filed as flaky, not a reject`,
        ),
      },
      flaky: { criterion, command, first, second },
    };
  }

  return {
    result: {
      criterion: criterion.text,
      command,
      status: 'fail',
      evidence: truncateEvidence(`observed: ${second.summary} | expected: ${criterion.text}`),
    },
  };
}
