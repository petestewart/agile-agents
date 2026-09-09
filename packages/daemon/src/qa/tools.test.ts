import { describe, expect, test } from 'bun:test';
import type { QaProtocol } from './protocol';
import { QaToolError, registerQaTools } from './tools';

function fakeProtocol() {
  const calls: unknown[] = [];
  const fake = {
    calls,
    plan(ticket: unknown, mapping: unknown) {
      calls.push(['plan', ticket, mapping]);
    },
    run(ticket: unknown) {
      calls.push(['run', ticket]);
      return Promise.resolve([]);
    },
    submit(ticket: unknown, agent: unknown) {
      calls.push(['submit', ticket, agent]);
      return Promise.resolve({ ticket, round: 1, lines: [], verdict: 'accept' });
    },
  };
  return fake;
}

function asProtocol(fake: ReturnType<typeof fakeProtocol>): QaProtocol {
  return fake as unknown as QaProtocol;
}

describe('registerQaTools', () => {
  test('exposes qa_plan, qa_run, qa_submit', () => {
    const tools = registerQaTools(asProtocol(fakeProtocol()));
    expect(tools.map((t) => t.name).sort()).toEqual(['qa_plan', 'qa_run', 'qa_submit']);
  });

  test('rejects a caller whose agent id is not the qa role', async () => {
    const tools = registerQaTools(asProtocol(fakeProtocol()));
    const qaRun = tools.find((t) => t.name === 'qa_run');
    await expect(qaRun?.handler({ agent: 'eng-1', ticket: 'TKT-0001' }, {})).rejects.toThrow(
      QaToolError,
    );
  });

  test('rejects a session with no ticket context', async () => {
    const tools = registerQaTools(asProtocol(fakeProtocol()));
    const qaRun = tools.find((t) => t.name === 'qa_run');
    await expect(qaRun?.handler({ agent: 'qa-1' }, {})).rejects.toThrow(QaToolError);
  });

  test('qa_plan forwards a well-formed {criterionIndex: command} mapping', async () => {
    const protocol = fakeProtocol();
    const tools = registerQaTools(asProtocol(protocol));
    const qaPlan = tools.find((t) => t.name === 'qa_plan');
    await qaPlan?.handler(
      { agent: 'qa-1', ticket: 'TKT-0001' },
      { plan: { 0: 'bun test a.test.ts' } },
    );
    expect(protocol.calls).toEqual([['plan', 'TKT-0001', { 0: 'bun test a.test.ts' }]]);
  });

  test('qa_plan rejects a non-string command', async () => {
    const tools = registerQaTools(asProtocol(fakeProtocol()));
    const qaPlan = tools.find((t) => t.name === 'qa_plan');
    await expect(
      qaPlan?.handler({ agent: 'qa-1', ticket: 'TKT-0001' }, { plan: { 0: 42 } }),
    ).rejects.toThrow(QaToolError);
  });

  test('qa_submit forwards ticket + calling agent', async () => {
    const protocol = fakeProtocol();
    const tools = registerQaTools(asProtocol(protocol));
    const qaSubmit = tools.find((t) => t.name === 'qa_submit');
    await qaSubmit?.handler({ agent: 'qa-1', ticket: 'TKT-0001' }, {});
    expect(protocol.calls).toEqual([['submit', 'TKT-0001', 'qa-1']]);
  });
});
