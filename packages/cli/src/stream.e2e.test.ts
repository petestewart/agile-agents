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
    // T128: a header row, then the indented tree under it.
    const lines = listed.out.split('\n');
    expect(lines[0]?.trimEnd().split(/\s{2,}/)).toEqual(['id', 'title', 'agent/human']);
    expect(lines[1]).toContain(root.id);
    expect(lines[1]).toContain('idle/open');
    expect(lines[2]?.startsWith('  ')).toBe(true);
    expect(lines[2]).toContain(child.id);

    expect((await cli(['stream', 'say', root.id, 'let us start with the tree'])).code).toBe(0);

    const shown = await cli(['stream', 'show', root.id]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('Ship the cockpit');
    expect(shown.out).toContain('let us start with the tree');
    // T128: no repo, so `repo -` and no branch/worktree placeholders.
    expect(shown.out).toMatch(/^repo\s+-$/m);
    expect(shown.out).not.toContain('created on first attach');
    expect(shown.out).not.toMatch(/^branch\s/m);
    expect(shown.out).not.toMatch(/^worktree\s/m);

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

    // T128: with a repo the three git lines stay, placeholders and all.
    const shown = await cli(['stream', 'show', stream.id]);
    expect(shown.out).toMatch(/^repo\s+alpha$/m);
    expect(shown.out).toMatch(/^branch\s+- \(created on first attach\)$/m);
    expect(shown.out).toMatch(/^worktree\s+- \(created on first attach\)$/m);
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

  /**
   * T136 (QA rough edge 6): finished streams stop mixing with active ones.
   * `--status` matches either half of the §2.2 pair and `--landed` is the
   * shortcut for the one an operator filters on most.
   */
  test('list --status/--landed filters the tree, and an unknown status is refused', async () => {
    const active = await newStream('Still going');
    const finished = await newStream('All done');
    await daemon.streamService.update('human', finished.id, { human: { status: 'landed' } });

    const all = await cli(['stream', 'list']);
    expect(all.out).toContain(active.id);
    expect(all.out).toContain(finished.id);

    const landed = await cli(['stream', 'list', '--landed']);
    expect(landed.code).toBe(0);
    expect(landed.out).toContain(finished.id);
    expect(landed.out).not.toContain(active.id);

    const open = await cli(['stream', 'list', '--status', 'open']);
    expect(open.out).toContain(active.id);
    expect(open.out).not.toContain(finished.id);

    // An agent-half value works through the same flag.
    const idle = await cli(['stream', 'list', '--status', 'idle']);
    expect(idle.out).toContain(active.id);

    // A status nothing matches says so rather than printing an empty table.
    const none = await cli(['stream', 'list', '--status', 'closed']);
    expect(none.code).toBe(0);
    expect(none.out).toContain('(none closed)');

    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    try {
      expect(await runCli(['stream', 'list', '--status', 'nope'], daemon.repo)).toBe(1);
    } finally {
      console.error = original;
    }
    expect(errors.join('\n')).toContain('--status must be one of');
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

describe('agile attach (T130) on a no-repo stream, against the fake driver', () => {
  test('prints the session line, records it, streams output onto the thread, and refuses a second attach', async () => {
    const stream = await newStream('Plan the migration');

    const attached = await cli(['attach', stream.id]);
    expect(attached.code).toBe(0);
    expect(attached.out).toMatch(
      new RegExp(
        `^agile attach: [0-9A-HJKMNP-TV-Z]{26} claude/default effort=\\w+ on ${stream.id}$`,
        'm',
      ),
    );
    // No repo, so no worktree line and nothing git-backed.
    expect(attached.out).not.toContain('worktree=');

    const shown = await cli(['stream', 'show', stream.id, '--json']);
    const record = (JSON.parse(shown.out) as { stream: Stream }).stream;
    expect(record.sessions.length).toBe(1);
    expect(record.sessions[0]?.role).toBe('worker');
    expect(record.agent.status).toBe('working');
    expect(record.branch).toBeUndefined();

    // The sessions strip prints `id vendor/model effort status`.
    const human = await cli(['stream', 'show', stream.id]);
    expect(human.out).toContain(`${record.sessions[0]?.id}  claude/default`);

    // §2.3: one live worker at a time.
    const second = await cli(['attach', stream.id]);
    expect(second.code).toBe(1);

    // The thread carries the daemon's own attach line.
    const thread = readFileSync(join(daemon.home, 'threads', `${stream.id}.jsonl`), 'utf8');
    expect(thread).toContain('worker attached: claude/default');

    // T137: detach says what it stopped, the stream goes back to `idle`
    // (nothing was produced by killing it), and the thread records who did.
    const detached = await cli(['detach', stream.id]);
    expect(detached.code).toBe(0);
    expect(detached.out).toBe(`agile detach: stopped ${record.sessions[0]?.id} on ${stream.id}`);
    const afterDetach = (
      JSON.parse((await cli(['stream', 'show', stream.id, '--json'])).out) as { stream: Stream }
    ).stream;
    expect(afterDetach.agent.status).toBe('idle');
    expect(afterDetach.sessions[0]?.status).toBe('stopped');
    expect(readFileSync(join(daemon.home, 'threads', `${stream.id}.jsonl`), 'utf8')).toContain(
      'worker detached by human',
    );

    // A second detach has nothing to stop: that is a failure, not a shrug.
    expect((await cli(['detach', stream.id])).code).toBe(1);
  }, 20_000);

  /**
   * T136 (QA rough edge 3): `detach` on a stream that never had a session
   * says so in one line, on stderr, and exits 1 — the T137 behaviour,
   * confirmed here for a stream that was never attached at all (the T130
   * test above only covers a second detach after a real one).
   */
  test('detach on a stream with no live session says so in one line and exits 1', async () => {
    const stream = await newStream('Never attached');
    const errors: string[] = [];
    const originalError = console.error;
    const logged: string[] = [];
    const originalLog = console.log;
    console.error = (msg: string) => errors.push(String(msg));
    console.log = (msg: string) => logged.push(String(msg));
    try {
      expect(await runCli(['detach', stream.id], daemon.repo)).toBe(1);
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
    expect(errors).toEqual([`agile detach: ${stream.id} has no live session`]);
    expect(logged).toEqual([]);
  });

  test('rejects an effort outside the D12 enum and an unknown role, without calling the daemon', async () => {
    const stream = await newStream('Plan something else');
    expect((await cli(['attach', stream.id, '--effort', 'extreme'])).code).toBe(1);
    // T131 made `reviewer` a real role; anything else is still refused here.
    expect((await cli(['attach', stream.id, '--role', 'architect'])).code).toBe(1);
    const shown = await cli(['stream', 'show', stream.id, '--json']);
    expect((JSON.parse(shown.out) as { stream: Stream }).stream.sessions.length).toBe(0);
  });
});
