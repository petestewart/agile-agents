/**
 * T111 acceptance: one daemon, started against a temp `AGILE_HOME`, serves
 * two registered repos (PLAN.md §5, D9) — and registering them creates no
 * `.agile/` directory inside either repo.
 *
 * Offline: a real in-process daemon over a real unix socket, driven through
 * the real `agile repo add|list` CLI dispatch. No vendor, no network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReposConfig } from '@agile-agents/shared';
import { callRpc } from './client';
import { runCli } from './index';
import { type TestDaemon, startTestDaemon } from './test-support';

let daemon: TestDaemon;
let repoA: string;
let repoB: string;

function makeRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
  return dir;
}

/** Captures `console.log` for one CLI invocation. */
async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    const code = await runCli(argv, daemon.repo);
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

beforeEach(async () => {
  daemon = await startTestDaemon('agile-repo-e2e-');
  repoA = makeRepo('agile-repo-e2e-a-');
  repoB = makeRepo('agile-repo-e2e-b-');
});

afterEach(async () => {
  await daemon.cleanup();
  rmSync(repoA, { recursive: true, force: true });
  rmSync(repoB, { recursive: true, force: true });
});

describe('agile repo add/list against a daemon on a temp AGILE_HOME', () => {
  test('registers two repos, lists both, and writes repos.yaml in the home', async () => {
    expect((await cli(['repo', 'add', repoA, '--name', 'alpha'])).code).toBe(0);
    expect(
      (await cli(['repo', 'add', repoB, '--name', 'beta', '--target-branch', 'integration'])).code,
    ).toBe(0);

    const listed = await cli(['repo', 'list']);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('alpha');
    expect(listed.out).toContain('beta');
    expect(listed.out).toContain('target=integration');

    // The registry is one plain file in the home, not in either repo.
    const reposYaml = readFileSync(join(daemon.home, 'repos.yaml'), 'utf8');
    expect(reposYaml).toContain('alpha:');
    expect(reposYaml).toContain('beta:');

    // Same answer over RPC, which is what the UI and every other client use.
    const repos = await callRpc<ReposConfig>(daemon.socketPath, 'state.repo_list', {});
    expect(Object.keys(repos).sort()).toEqual(['alpha', 'beta']);
    // D8: protected branches default to main + master.
    expect(repos.alpha?.protected_branches).toEqual(['main', 'master']);
    expect(repos.beta?.target_branch).toBe('integration');
  });

  test('registering a repo never creates a .agile/ directory inside it', async () => {
    await cli(['repo', 'add', repoA]);
    await cli(['repo', 'add', repoB]);
    for (const repo of [repoA, repoB, daemon.repo]) {
      expect(existsSync(join(repo, '.agile'))).toBe(false);
    }
    // And no orphan state branch is left behind anywhere either.
    for (const repo of [repoA, repoB]) {
      const branches = Bun.spawnSync(['git', 'branch', '--list'], { cwd: repo, stdout: 'pipe' });
      expect(new TextDecoder().decode(branches.stdout)).not.toContain('agile-state');
    }
  });

  test('re-adding the same name replaces that entry only', async () => {
    await cli(['repo', 'add', repoA, '--name', 'alpha']);
    await cli(['repo', 'add', repoB, '--name', 'beta']);
    await cli(['repo', 'add', repoA, '--name', 'alpha', '--protected', 'main,release']);

    const repos = await callRpc<ReposConfig>(daemon.socketPath, 'state.repo_list', {});
    expect(Object.keys(repos).sort()).toEqual(['alpha', 'beta']);
    expect(repos.alpha?.protected_branches).toEqual(['main', 'release']);
    expect(repos.beta?.protected_branches).toEqual(['main', 'master']);
  });

  test('adding a path that does not exist fails with a clear message', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      expect(await runCli(['repo', 'add', join(tmpdir(), 'no-such-repo-t111')], daemon.repo)).toBe(
        1,
      );
    } finally {
      console.error = original;
    }
    expect(errors.join('\n')).toContain('does not exist');
  });
});
