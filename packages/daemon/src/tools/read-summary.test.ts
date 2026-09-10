import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init';
import { ReadSummaryError, runReadSummary } from './read-summary';
import { loadToolRegistry } from './registry';
import { FakeRunner } from './runner';
import type { LoadedTool } from './types';

let repo: string;
let stateRoot: string;
let readSummaryTool: LoadedTool;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-read-summary-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  const tool = loadToolRegistry(stateRoot).find((t) => t.definition.name === 'read_summary');
  if (!tool) throw new Error('read_summary not seeded');
  readSummaryTool = tool;

  writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('runReadSummary', () => {
  test('a cache miss calls the runner and caches the result', async () => {
    const runner = new FakeRunner(() => ({
      text: JSON.stringify({ summary: 'exports x', refs: [{ path: 'a.ts', lines: '1-1' }] }),
      model: 'fake-model',
      inTokens: 10,
      outTokens: 5,
    }));

    const result = await runReadSummary({
      tool: readSummaryTool,
      ctx: { agent: 'eng-1', ticket: 'TKT-0001' },
      input: { path: 'a.ts', question: 'what does this export?' },
      worktree: repo,
      repoRoot: repo,
      sprintId: 'S-01',
      runner,
    });

    expect(result.cache).toBe('miss');
    expect(result.output.summary).toBe('exports x');
    expect(result.output.refs).toEqual([{ path: 'a.ts', lines: '1-1' }]);
    expect(runner.callCount).toBe(1);
  });

  test('a second identical call is a cache hit: the runner is not invoked again', async () => {
    const runner = new FakeRunner(() => ({
      text: JSON.stringify({ summary: 'exports x', refs: [] }),
      model: 'fake-model',
      inTokens: 10,
      outTokens: 5,
    }));

    const opts = {
      tool: readSummaryTool,
      ctx: { agent: 'eng-1', ticket: 'TKT-0001' },
      input: { path: 'a.ts', question: 'what does this export?' },
      worktree: repo,
      repoRoot: repo,
      sprintId: 'S-01',
      runner,
    };

    const first = await runReadSummary(opts);
    const second = await runReadSummary(opts);

    expect(first.cache).toBe('miss');
    expect(second.cache).toBe('hit');
    expect(second.output).toEqual(first.output);
    expect(second.inTokens).toBe(0);
    expect(second.outTokens).toBe(0);
    expect(runner.callCount).toBe(1);
  });

  test('a different question is a different cache key (new runner call)', async () => {
    const runner = new FakeRunner();
    const base = {
      tool: readSummaryTool,
      worktree: repo,
      repoRoot: repo,
      sprintId: 'S-01',
      runner,
      ctx: { agent: 'eng-1', ticket: 'TKT-0001' },
    };
    await runReadSummary({ ...base, input: { path: 'a.ts', question: 'q1' } });
    await runReadSummary({ ...base, input: { path: 'a.ts', question: 'q2' } });
    expect(runner.callCount).toBe(2);
  });

  test('a changed file content is a different cache key (file_hash)', async () => {
    const runner = new FakeRunner();
    const base = {
      tool: readSummaryTool,
      worktree: repo,
      repoRoot: repo,
      sprintId: 'S-01',
      runner,
      ctx: { agent: 'eng-1', ticket: 'TKT-0001' },
    };
    await runReadSummary({ ...base, input: { path: 'a.ts' } });
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    await runReadSummary({ ...base, input: { path: 'a.ts' } });
    expect(runner.callCount).toBe(2);
  });

  test("caps the summary at the tool's max_output_tokens (chars/4)", async () => {
    const longText = 'x'.repeat(10_000);
    const runner = new FakeRunner(() => ({
      text: JSON.stringify({ summary: longText, refs: [] }),
      model: 'fake',
      inTokens: 1,
      outTokens: 1,
    }));
    const result = await runReadSummary({
      tool: readSummaryTool,
      ctx: { agent: 'eng-1' },
      input: { path: 'a.ts' },
      worktree: repo,
      repoRoot: repo,
      sprintId: undefined,
      runner,
    });
    expect(result.output.summary.length).toBeLessThanOrEqual(400 * 4);
  });

  test('a non-JSON runner reply falls back to raw text as the summary', async () => {
    const runner = new FakeRunner(() => ({
      text: 'not json at all',
      model: 'fake',
      inTokens: 1,
      outTokens: 1,
    }));
    const result = await runReadSummary({
      tool: readSummaryTool,
      ctx: { agent: 'eng-1' },
      input: { path: 'a.ts' },
      worktree: repo,
      repoRoot: repo,
      sprintId: undefined,
      runner,
    });
    expect(result.output.summary).toBe('not json at all');
  });

  test("the daemon's own raw artifacts are readable: an absolute diff_summary pointer and a relative test_run pointer", async () => {
    // First live run: `diff_summary` returned a pointer under
    // `.agile-daemon-cache/raw/`, every reviewer called `read_summary` on
    // it, and the worktree containment check refused it.
    const rawDir = join(repo, '.agile-daemon-cache', 'raw', 'diff_summary');
    mkdirSync(rawDir, { recursive: true });
    const diffPath = join(rawDir, 'tkt_0001-abc.diff');
    writeFileSync(diffPath, '--- a/a.ts\n+++ b/a.ts\n');
    const testRunDir = join(repo, '.agile-daemon-cache', 'raw', 'test_run', 'bun');
    mkdirSync(testRunDir, { recursive: true });
    writeFileSync(join(testRunDir, 'run1.log'), '1 fail\n');

    const runner = new FakeRunner(() => ({
      text: JSON.stringify({ summary: 'ok', refs: [] }),
      model: 'fake-model',
      inTokens: 1,
      outTokens: 1,
    }));
    const viaAbsolute = await runReadSummary({
      tool: readSummaryTool,
      ctx: { agent: 'reviewer-1' },
      input: { path: diffPath },
      worktree: join(repo, '.worktrees', 'TKT-0001'),
      repoRoot: repo,
      sprintId: undefined,
      runner,
    });
    expect(viaAbsolute.output.summary).toBe('ok');
    const viaRelative = await runReadSummary({
      tool: readSummaryTool,
      ctx: { agent: 'eng-1' },
      input: { path: 'test_run/bun/run1.log' },
      worktree: join(repo, '.worktrees', 'TKT-0001'),
      repoRoot: repo,
      sprintId: undefined,
      runner,
    });
    expect(viaRelative.output.summary).toBe('ok');
    expect(runner.callCount).toBe(2);
  });

  test('a path escaping the worktree is refused', async () => {
    const runner = new FakeRunner();
    await expect(
      runReadSummary({
        tool: readSummaryTool,
        ctx: { agent: 'eng-1' },
        input: { path: '../../etc/passwd' },
        worktree: repo,
        repoRoot: repo,
        sprintId: undefined,
        runner,
      }),
    ).rejects.toThrow(ReadSummaryError);
  });
});
