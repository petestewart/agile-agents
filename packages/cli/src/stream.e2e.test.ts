/**
 * T120 acceptance, end to end: `agile stream new|list|show|say|close`
 * against a real in-process daemon over a real unix socket on a temp
 * `AGILE_HOME`. No vendor, no network — and, for a stream with no repo, no
 * git: the test asserts that nothing under the home or the daemon's repo
 * gains a worktree.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Stream } from '@agile-agents/shared';
import { runCli } from './index';
import { type TestDaemon, startTestDaemon } from './test-support';

let daemon: TestDaemon;

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(String(msg));
  try {
    const code = await runCli(argv, daemon.repo);
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

async function newStream(title: string, extra: string[] = []): Promise<Stream> {
  const result = await cli([
    'stream',
    'new',
    '--title',
    title,
    '--goal',
    `goal: ${title}`,
    ...extra,
    '--json',
  ]);
  expect(result.code).toBe(0);
  return JSON.parse(result.out) as Stream;
}

beforeEach(async () => {
  daemon = await startTestDaemon('agile-stream-e2e-');
});

afterEach(async () => {
  await daemon.cleanup();
});

describe('agile stream against a daemon on a temp AGILE_HOME', () => {
  test('new/list/show/say/close round-trips and writes the home files', async () => {
    const root = await newStream('Ship the cockpit');
    const child = await newStream('Design the tree', ['--parent', root.id]);

    // The record and its thread are plain files in the home (§7.2).
    expect(existsSync(join(daemon.home, 'streams', `${root.id}.yaml`))).toBe(true);
    expect(readFileSync(join(daemon.home, 'threads', `${root.id}.jsonl`), 'utf8')).toContain(
      'stream created',
    );

    const listed = await cli(['stream', 'list']);
    expect(listed.code).toBe(0);
    // Indented tree: the child line is indented under the root line.
    const lines = listed.out.split('\n');
    expect(lines[0]).toContain(root.id);
    expect(lines[0]).toContain('idle/open');
    expect(lines[1]?.startsWith('  ')).toBe(true);
    expect(lines[1]).toContain(child.id);

    expect((await cli(['stream', 'say', root.id, 'let us start with the tree'])).code).toBe(0);

    const shown = await cli(['stream', 'show', root.id]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('Ship the cockpit');
    expect(shown.out).toContain('let us start with the tree');
    expect(shown.out).toContain('created on first attach');

    const closed = await cli(['stream', 'close', root.id, '--note', 'parked']);
    expect(closed.code).toBe(0);
    const after = await cli(['stream', 'show', root.id, '--json']);
    const record = (JSON.parse(after.out) as { stream: Stream }).stream;
    expect(record.human.status).toBe('closed');
    expect(record.human.note).toBe('parked');
    expect(record.agent.status).toBe('idle');
    // T126 (QA rough edge 2): the note is on the thread too, so a later
    // reader sees that — and why — the stream was closed.
    expect(after.out).toContain('closed: parked');
    const shownAfter = await cli(['stream', 'show', root.id]);
    expect(shownAfter.out).toContain('closed: parked');
  });

  test('a stream with no repo never touches git', async () => {
    const stream = await newStream('Planning only');
    await cli(['stream', 'say', stream.id, 'thinking out loud']);
    await cli(['stream', 'close', stream.id]);

    expect(existsSync(join(daemon.home, '.worktrees'))).toBe(false);
    expect(existsSync(join(daemon.repo, '.worktrees'))).toBe(false);
    expect(existsSync(join(daemon.home, '.git'))).toBe(false);
    const branches = Bun.spawnSync(['git', 'branch', '--list'], {
      cwd: daemon.repo,
      stdout: 'pipe',
    });
    expect(new TextDecoder().decode(branches.stdout).trim()).toBe('');
  });

  test('--repo must name a registered repo, and the error says so', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    try {
      expect(
        await runCli(
          ['stream', 'new', '--title', 't', '--goal', 'g', '--repo', 'ghost'],
          daemon.repo,
        ),
      ).toBe(1);
    } finally {
      console.error = original;
    }
    expect(errors.join('\n')).toContain('unknown repo: ghost');

    // Registered, it works — and still creates no branch or worktree here.
    expect((await cli(['repo', 'add', daemon.repo, '--name', 'alpha'])).code).toBe(0);
    const stream = await newStream('With a repo', ['--repo', 'alpha']);
    expect(stream.repo).toBe('alpha');
    expect(stream.branch).toBeUndefined();
    expect(existsSync(join(daemon.repo, '.worktrees'))).toBe(false);
  });

  test('archived streams drop out of list until --all', async () => {
    const keep = await newStream('Keep');
    const gone = await newStream('Archive me');
    expect((await cli(['stream', 'archive', gone.id])).code).toBe(0);

    const listed = await cli(['stream', 'list']);
    expect(listed.out).toContain(keep.id);
    expect(listed.out).not.toContain(gone.id);

    const all = await cli(['stream', 'list', '--all']);
    expect(all.out).toContain(gone.id);
    expect(all.out).toContain('(archived)');
    // The record is still on disk: archiving moves nothing (§7.2).
    expect(existsSync(join(daemon.home, 'streams', `${gone.id}.yaml`))).toBe(true);
  });

  test('a thread body over the cap is refused with a clear message', async () => {
    const stream = await newStream('Cap');
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    try {
      expect(await runCli(['stream', 'say', stream.id, 'x'.repeat(801)], daemon.repo)).toBe(1);
    } finally {
      console.error = original;
    }
    expect(errors.join('\n')).toContain('the cap is 800');
  });
});
