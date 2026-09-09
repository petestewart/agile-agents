import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Message } from '@agile-agents/shared';
import { parseArgs } from '../args';
import { callRpc } from '../client';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { buildSendMessage, runSend } from './send';

let daemon: TestDaemon;

beforeEach(async () => {
  daemon = await startTestDaemon();
});

afterEach(async () => {
  await daemon.cleanup();
});

describe('buildSendMessage', () => {
  test('mints id/ts and maps flags onto the Message shape', () => {
    const message = buildSendMessage(
      parseArgs([
        '--from',
        'daemon',
        '--to',
        'em',
        '--kind',
        'fyi',
        '--priority',
        'low',
        '--body',
        'hi',
      ]),
    );
    expect(message.from).toBe('daemon');
    expect(message.to).toEqual(['em']);
    expect(message.kind).toBe('fyi');
    expect(message.priority).toBe('low');
    expect(message.body).toBe('hi');
    expect(typeof message.id).toBe('string');
    expect(message.id as string).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(typeof message.ts).toBe('string');
  });

  test('splits a comma-separated --to into multiple recipients', () => {
    const message = buildSendMessage(
      parseArgs(['--from', 'daemon', '--to', 'em,architect', '--kind', 'fyi', '--body', 'hi']),
    );
    expect(message.to).toEqual(['em', 'architect']);
  });
});

describe('runSend', () => {
  test('a valid send is delivered — the recipient can poll it', async () => {
    const code = await runSend(
      daemon.socketPath,
      parseArgs(['--from', 'daemon', '--to', 'em', '--kind', 'fyi', '--body', 'hello em']),
      false,
    );
    expect(code).toBe(0);

    const inbox = await callRpc<Message[]>(daemon.socketPath, 'bus.poll', { agent: 'em' });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.body).toBe('hello em');
  });

  test('an invalid message (bad kind) is refused, non-zero exit, no throw', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(msg);
    let code: number;
    try {
      code = await runSend(
        daemon.socketPath,
        parseArgs(['--from', 'daemon', '--to', 'em', '--kind', 'not-a-real-kind', '--body', 'x']),
        false,
      );
    } finally {
      console.error = original;
    }
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/send refused/);
  });
});
