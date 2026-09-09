import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseArgs } from '../args';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { parseHaltScope, runHalt, runResume } from './halt';

let daemon: TestDaemon;

beforeEach(async () => {
  daemon = await startTestDaemon();
});

afterEach(async () => {
  await daemon.cleanup();
});

describe('parseHaltScope', () => {
  test('defaults to global', () => {
    expect(parseHaltScope(undefined)).toBe('global');
    expect(parseHaltScope('global')).toBe('global');
  });

  test('passes a team: scope through unchanged', () => {
    expect(parseHaltScope('team:backend')).toBe('team:backend');
  });

  test('splits a comma-separated ticket list', () => {
    expect(parseHaltScope('TKT-0001,TKT-0002')).toEqual(['TKT-0001', 'TKT-0002']);
  });
});

describe('runHalt / runResume', () => {
  test('creates a global halt by default and resumes it', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    let haltCode: number;
    try {
      haltCode = await runHalt(daemon.socketPath, parseArgs(['--reason', 'test halt']), false);
    } finally {
      console.log = original;
    }
    expect(haltCode).toBe(0);
    expect(lines.join('\n')).toMatch(/halted\s+H-\d+/);

    const halts = daemon.store.listHalts();
    expect(halts).toHaveLength(1);
    expect(halts[0]?.scope).toBe('global');
    expect(halts[0]?.reason).toBe('test halt');

    const resumeCode = await runResume(
      daemon.socketPath,
      parseArgs([halts[0]?.id as string]),
      false,
    );
    expect(resumeCode).toBe(0);
    expect(daemon.store.listHalts()).toHaveLength(0);
  });

  test('json mode round-trips a scoped halt', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await runHalt(daemon.socketPath, parseArgs(['--scope', 'TKT-0001', '--reason', 'r']), true);
    } finally {
      console.log = original;
    }
    const halt = JSON.parse(lines.join('\n'));
    expect(halt.scope).toEqual(['TKT-0001']);
  });

  test('resume without an id throws a usage error', async () => {
    await expect(runResume(daemon.socketPath, parseArgs([]), false)).rejects.toThrow(
      /usage: agile resume/,
    );
  });
});
