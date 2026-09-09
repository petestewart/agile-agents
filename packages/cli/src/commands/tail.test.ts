import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event } from '@agile-agents/shared';
import { runTail } from './tail';

let dir: string;
let eventsPath: string;

function line(event: Partial<Event> & Pick<Event, 'kind'>): string {
  return `${JSON.stringify({ ts: new Date().toISOString(), data: {}, ...event })}\n`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agile-cli-tail-'));
  mkdirSync(join(dir, 'log'), { recursive: true });
  eventsPath = join(dir, 'log', 'events.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runTail (no --follow)', () => {
  test('prints every existing line, unfiltered', async () => {
    writeFileSync(
      eventsPath,
      line({ kind: 'ticket_put', ticket: 'TKT-0001' }) + line({ kind: 'message', agent: 'em' }),
    );
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      const code = await runTail({ eventsPath, filters: {}, follow: false, json: false });
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    expect(lines).toHaveLength(2);
  });

  test('filters by ticket/agent/kind', async () => {
    writeFileSync(
      eventsPath,
      line({ kind: 'ticket_put', ticket: 'TKT-0001' }) +
        line({ kind: 'ticket_put', ticket: 'TKT-0002' }) +
        line({ kind: 'message', agent: 'em' }),
    );
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await runTail({ eventsPath, filters: { ticket: 'TKT-0001' }, follow: false, json: true });
    } finally {
      console.log = original;
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).ticket).toBe('TKT-0001');
  });

  test('a missing events file is not an error — nothing to print', async () => {
    const code = await runTail({
      eventsPath: join(dir, 'nope.jsonl'),
      filters: {},
      follow: false,
      json: false,
    });
    expect(code).toBe(0);
  });
});

describe('runTail --follow', () => {
  test('picks up lines appended after start, then stops on abort', async () => {
    writeFileSync(eventsPath, line({ kind: 'ticket_put', ticket: 'TKT-0001' }));
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);

    const controller = new AbortController();
    const run = runTail({
      eventsPath,
      filters: {},
      follow: true,
      json: true,
      pollMs: 20,
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    appendFileSync(eventsPath, line({ kind: 'halt_created' }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();
    await run;
    console.log = original;

    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => JSON.parse(l).kind === 'halt_created')).toBe(true);
  });
});
