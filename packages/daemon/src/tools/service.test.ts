/**
 * T125: the daemon starts from any cwd, so it no longer has a repo root to
 * hand `ToolService`. A service built without one must refuse the
 * repo-dependent verbs with a reason naming the tool, rather than running
 * them against an arbitrary directory (or, worse, filing their cache and
 * raw output there). T132 resolves the worktree per call from the calling
 * agent's stream, at which point the refusal stops firing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init';
import { loadToolRegistry } from './registry';
import { FakeRunner } from './runner';
import { ToolRepoUnavailableError, ToolService } from './service';
import type { LoadedTool } from './types';

let home: string;
let registry: LoadedTool[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-tool-service-'));
  registry = loadToolRegistry(runInit(home).stateRoot);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const ctx = { agent: 'eng-1', ticket: 'TKT-0001' } as const;

describe('ToolService without a repoRoot (T125)', () => {
  test('still lists its registry tools', () => {
    const service = new ToolService({ registry, runner: new FakeRunner() });
    expect(service.listTools().map((t) => t.name)).toContain('read_summary');
  });

  test('read_summary refuses with a reason naming the tool', async () => {
    const service = new ToolService({ registry, runner: new FakeRunner() });
    await expect(service.callTool(ctx, 'read_summary', { path: 'a.ts' })).rejects.toBeInstanceOf(
      ToolRepoUnavailableError,
    );
    await expect(service.callTool(ctx, 'read_summary', { path: 'a.ts' })).rejects.toThrow(
      /read_summary: no repo is attached/,
    );
  });

  test('test_run refuses too, when it is registered', async () => {
    if (!registry.some((t) => t.definition.name === 'test_run')) return;
    const service = new ToolService({ registry, runner: new FakeRunner() });
    await expect(service.callTool(ctx, 'test_run', { command: 'bun test' })).rejects.toThrow(
      /test_run: no repo is attached/,
    );
  });
});
