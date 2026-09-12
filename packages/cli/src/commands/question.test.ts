import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseArgs } from '../args';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { runQuestionAnswer, runQuestionList, runQuestionRaise } from './question';

let daemon: TestDaemon;

beforeEach(async () => {
  daemon = await startTestDaemon('agile-cli-question-');
});

afterEach(async () => {
  await daemon.cleanup();
});

/** Captures `console.log` around one command run (same helper shape as `gate.test.ts`). */
async function capture(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    const code = await run();
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

describe('agile question', () => {
  test('list prints open questions and says so when there are none', async () => {
    const empty = await capture(() => runQuestionList(daemon.socketPath, false));
    expect(empty.out).toContain('(none open)');

    await daemon.questionService.raise({ raised_by: 'eng-1', text: 'is the ticket right?' });
    const listed = await capture(() => runQuestionList(daemon.socketPath, false));
    expect(listed.out).toContain('is the ticket right?');
    expect(listed.out).toContain('eng-1');
  });

  test('answer --answer replies and marks the question answered', async () => {
    const q = await daemon.questionService.raise({ raised_by: 'eng-1', text: 'which wins?' });
    const { code, out } = await capture(() =>
      runQuestionAnswer(
        daemon.socketPath,
        parseArgs([q.id, '--answer', 'the spec wins', '--by', 'pete']),
        false,
      ),
    );
    expect(code).toBe(0);
    expect(out).toContain('answered');
    expect(daemon.questionService.get(q.id).answer).toBe('the spec wins');
    expect(daemon.questionService.get(q.id).resolved_as).toBe('reply');
  });

  test('answer --as decision records a DEC-* and links it', async () => {
    const q = await daemon.questionService.raise({ raised_by: 'eng-1', text: 'sqlite or files?' });
    const { out } = await capture(() =>
      runQuestionAnswer(
        daemon.socketPath,
        parseArgs([q.id, '--answer', 'files for v0', '--as', 'decision']),
        true,
      ),
    );
    const parsed = JSON.parse(out) as { question: { resolved_as: string } };
    expect(parsed.question.resolved_as).toMatch(/^DEC-\d{4}$/);
    expect(Object.keys(daemon.store.listOracleIndex())).toContain(parsed.question.resolved_as);
  });

  test('raise opens a question over RPC', async () => {
    const { code } = await capture(() =>
      runQuestionRaise(daemon.socketPath, parseArgs(['--text', 'a gap in the plan']), true),
    );
    expect(code).toBe(0);
    expect(daemon.questionService.listOpen().map((q) => q.text)).toEqual(['a gap in the plan']);
  });

  test('--answer is required', async () => {
    const q = await daemon.questionService.raise({ raised_by: 'em', text: 'q' });
    expect(runQuestionAnswer(daemon.socketPath, parseArgs([q.id]), false)).rejects.toThrow(
      /--answer is required/,
    );
  });
});
