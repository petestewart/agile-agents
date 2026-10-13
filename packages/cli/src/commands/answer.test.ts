/**
 * `agile answer` against an in-process daemon: one verb for the one inbox
 * list (T138). A `Q-` id keeps T121's behaviour; a `HIL-` id decides the
 * gate through the unchanged `gate.*` RPC.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { HilRequest, Policy } from '@agile-agents/shared';
import { parseArgs } from '../args';
import { runCli } from '../index';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { runAnswer } from './answer';

let daemon: TestDaemon;
let stream: string;

const POLICY: Policy = {
  gates: { land: 'human', rule_accept: 'human', classifier_review: 'human' },
  breaker_signals: [],
};

beforeEach(async () => {
  daemon = await startTestDaemon('agile-cli-answer-');
  stream = (await daemon.streamService.create('human', { title: 's', goal: 'g' })).id;
});

afterEach(async () => {
  await daemon.cleanup();
});

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

async function routedGate(): Promise<HilRequest> {
  return daemon.gateService.request('classifier_review', {
    policy: POLICY,
    stream,
    summary: 'editing a dependency manifest/lockfile is never automatic',
    call: { tool: 'Edit', path: '/tmp/wt/package.json', fingerprint: '0123456789abcdef' },
  });
}

describe('agile answer', () => {
  test('a Q- id answers the question', async () => {
    const question = await daemon.questionService.raise({
      stream,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'comma or semicolon?',
    });
    const { code, out } = await capture(() =>
      runAnswer(daemon.socketPath, parseArgs([question.id, 'semicolon', '—', 'the export']), false),
    );
    expect(code).toBe(0);
    expect(out).toContain('semicolon — the export');
  });

  test('a HIL- id with yes approves the gate, with the rest of the line as the note', async () => {
    const gate = await routedGate();
    const { code, out } = await capture(() =>
      runAnswer(daemon.socketPath, parseArgs([gate.id, 'yes', 'pin', 'the', 'version']), false),
    );
    expect(code).toBe(0);
    expect(out).toContain('approve');
    expect(out).toContain('pin the version');
    const resolved = daemon.gateService.get(gate.id);
    expect(resolved.status).toBe('resolved');
    expect(resolved.decision).toBe('approve');
    expect(resolved.note).toBe('pin the version');
  });

  test('decision and note in one quoted argument is accepted (T145)', async () => {
    const gate = await routedGate();
    const { code, out } = await capture(() =>
      runAnswer(daemon.socketPath, parseArgs([gate.id, 'yes pin the version']), false),
    );
    expect(code).toBe(0);
    expect(out).toContain('approve');
    const resolved = daemon.gateService.get(gate.id);
    expect(resolved.decision).toBe('approve');
    expect(resolved.note).toBe('pin the version');
  });

  test('a single quoted word still decides, with no note (T145)', async () => {
    const gate = await routedGate();
    const { code } = await capture(() =>
      runAnswer(daemon.socketPath, parseArgs([gate.id, 'no']), false),
    );
    expect(code).toBe(0);
    const resolved = daemon.gateService.get(gate.id);
    expect(resolved.decision).toBe('deny');
    expect(resolved.note).toBeUndefined();
  });

  test('a HIL- id with no denies it, and a bare note with no verdict is a usage error', async () => {
    const gate = await routedGate();
    await expect(
      capture(() => runAnswer(daemon.socketPath, parseArgs([gate.id, 'not', 'now']), false)),
    ).rejects.toThrow(/yes\|no/);
    expect(daemon.gateService.get(gate.id).status).toBe('pending');

    const { code } = await capture(() =>
      runAnswer(daemon.socketPath, parseArgs([gate.id, 'no', 'use', 'the', 'lockfile']), false),
    );
    expect(code).toBe(0);
    const resolved = daemon.gateService.get(gate.id);
    expect(resolved.decision).toBe('deny');
    expect(resolved.note).toBe('use the lockfile');
  });
});

/** T523 (CLI audit C3): `agile answer` keeps an unquoted answer as typed. */
describe('agile answer free text', () => {
  async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (msg: string) => out.push(String(msg));
    console.error = (msg: string) => err.push(String(msg));
    try {
      return { code: await runCli(argv, daemon.repo), out: out.join('\n'), err: err.join('\n') };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  test('an option-shaped word is refused by name and nothing is answered; -- keeps it', async () => {
    const question = await daemon.questionService.raise({
      stream,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'how do I push?',
    });
    // Was: `--no-verify` ate "then" and "use push" was sent, exit 0.
    const refused = await cli(['answer', question.id, 'use', '--no-verify', 'then', 'push']);
    expect(refused.code).toBe(1);
    expect(refused.err).toBe(
      'agile answer: unknown option --no-verify (its options: --by). If it is part of the text, quote the text or put -- before it',
    );
    expect(daemon.questionService.get(question.id).status).toBe('open');

    const kept = await cli(['answer', question.id, '--', 'use', '--no-verify', 'then', 'push']);
    expect(kept.code).toBe(0);
    expect(daemon.questionService.get(question.id).answer).toBe('use --no-verify then push');
  });

  test('--by still reads anywhere, and a line may start with "-"', async () => {
    const question = await daemon.questionService.raise({
      stream,
      raised_by: '01ARZ3NDEKTSV4RRFFQ69GE001',
      text: 'how far?',
    });
    const { code } = await cli(['answer', question.id, '-1', 'step', '--by', 'pete', 'back']);
    expect(code).toBe(0);
    const answered = daemon.questionService.get(question.id);
    expect(answered.answer).toBe('-1 step back');
    expect(answered.answered_by).toBe('pete');
  });
});
