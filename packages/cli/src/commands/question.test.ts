import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseArgs } from '../args';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { runQuestionAnswer, runQuestionList, runQuestionRaise } from './question';

let daemon: TestDaemon;
let stream: string;

beforeEach(async () => {
  daemon = await startTestDaemon('agile-cli-question-');
  stream = (await daemon.streamService.create('human', { title: 's', goal: 'g' })).id;
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

    await daemon.questionService.raise({
      stream,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'is the ticket right?',
    });
    const listed = await capture(() => runQuestionList(daemon.socketPath, false));
    expect(listed.out).toContain('is the ticket right?');
    expect(listed.out).toContain('01ARZ3NDEKTSV4RRFFQ69GE001');
  });

  test('answer --answer replies and marks the question answered', async () => {
    const q = await daemon.questionService.raise({
      stream,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'which wins?',
    });
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

  // T121: `decision` and `ticket` resolutions are deleted with the oracle
  // and the ticket model; `reply` is all there is.
  test('answer refuses any resolution other than reply', async () => {
    const q = await daemon.questionService.raise({
      stream,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'sqlite?',
    });
    expect(
      runQuestionAnswer(
        daemon.socketPath,
        parseArgs([q.id, '--answer', 'files for v0', '--as', 'decision']),
        true,
      ),
    ).resolves.toBe(0);
    expect(daemon.questionService.get(q.id).resolved_as).toBe('reply');
  });

  test('raise opens a question over RPC', async () => {
    const { code } = await capture(() =>
      runQuestionRaise(
        daemon.socketPath,
        parseArgs(['--stream', stream, '--text', 'a gap in the plan']),
        true,
      ),
    );
    expect(code).toBe(0);
    expect(daemon.questionService.listOpen().map((q) => q.text)).toEqual(['a gap in the plan']);
  });

  test('--answer is required', async () => {
    const q = await daemon.questionService.raise({ stream, raised_by: 'human', text: 'q' });
    expect(runQuestionAnswer(daemon.socketPath, parseArgs([q.id]), false)).rejects.toThrow(
      /--answer is required/,
    );
  });
});
