/**
 * T343: `readOnlyGitEnv`, and against real local git (no network) that it
 * stops a repo's own config from running a program on a read-only git call.
 * Each marker command only creates a file in the temp dir.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_TREE_SHA, readOnlyGitEnv } from './git-env';

/** `GIT_CONFIG_KEY_n`/`VALUE_n` read back as ordered pairs. */
function configPairs(env: Record<string, string>): Array<[string, string]> {
  const count = Number(env.GIT_CONFIG_COUNT);
  return Array.from({ length: count }, (_, i) => [
    env[`GIT_CONFIG_KEY_${i}`] ?? '<missing>',
    env[`GIT_CONFIG_VALUE_${i}`] ?? '<missing>',
  ]);
}

describe('readOnlyGitEnv', () => {
  test('the engineer gets nothing', () => {
    expect(readOnlyGitEnv('engineer', { GIT_CONFIG_COUNT: '1' })).toEqual({});
  });

  test('the reviewer gets the empty-tree attributes, a cat pager and the forced config', () => {
    const env = readOnlyGitEnv('reviewer', {});
    expect(env.GIT_ATTR_SOURCE).toBe(EMPTY_TREE_SHA);
    expect(env.GIT_PAGER).toBe('cat');
    expect(configPairs(env)).toEqual([
      ['diff.external', ''],
      ['core.fsmonitor', 'false'],
      ['core.hooksPath', '/dev/null'],
      ['core.pager', 'cat'],
      ['gpg.program', 'false'],
      ['gpg.openpgp.program', 'false'],
      ['gpg.x509.program', 'false'],
      ['gpg.ssh.program', 'false'],
    ]);
  });

  test('existing GIT_CONFIG_COUNT entries are kept and ours come after them', () => {
    const env = readOnlyGitEnv('reviewer', {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Pat',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: '/tmp/x',
    });
    const pairs = configPairs(env);
    expect(env.GIT_CONFIG_COUNT).toBe('10');
    expect(pairs.slice(0, 3)).toEqual([
      ['user.name', 'Pat'],
      ['core.fsmonitor', '/tmp/x'],
      ['diff.external', ''],
    ]);
    // The later entry wins in git, so the forced value is last.
    expect(pairs.filter(([k]) => k === 'core.fsmonitor').at(-1)).toEqual([
      'core.fsmonitor',
      'false',
    ]);
  });

  test('a malformed GIT_CONFIG_COUNT starts ours from zero', () => {
    const env = readOnlyGitEnv('reviewer', { GIT_CONFIG_COUNT: 'lots' });
    expect(env.GIT_CONFIG_COUNT).toBe('8');
    expect(env.GIT_CONFIG_KEY_0).toBe('diff.external');
  });
});

describe('readOnlyGitEnv against real git', () => {
  let dir: string;
  let repo: string;
  let marker: string;
  let script: string;

  function git(args: string[], env?: Record<string, string>): number {
    const r = Bun.spawnSync(['git', ...args], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
      ...(env !== undefined ? { env } : {}),
    });
    return r.exitCode;
  }

  /** Runs `args` and reports whether the marker program ran. */
  function ran(args: string[], env: Record<string, string>): boolean {
    rmSync(marker, { force: true });
    git(args, env);
    return existsSync(marker);
  }

  const plainEnv = () => ({ ...(process.env as Record<string, string>) });
  const reviewerEnv = () => ({ ...plainEnv(), ...readOnlyGitEnv('reviewer', process.env) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agile-git-env-'));
    repo = join(dir, 'repo');
    marker = join(dir, 'marker');
    // A marker program (for the settings git runs directly, not through a shell).
    script = join(dir, 'marker.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(script, 0o755);
    Bun.spawnSync(['git', 'init', '-q', repo]);
    for (const [k, v] of [
      ['user.email', 't@example.com'],
      ['user.name', 'T'],
      ['commit.gpgsign', 'false'],
    ] as const) {
      git(['config', k, v]);
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Two commits touching `file`, then an uncommitted change to it. */
  function commitChanges(file: string, attributes: string): void {
    writeFileSync(join(repo, '.gitattributes'), `${attributes}\n`);
    writeFileSync(join(repo, file), '1\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'one']);
    writeFileSync(join(repo, file), '2\n');
    git(['commit', '-q', '-am', 'two']);
    writeFileSync(join(repo, file), '3\n');
  }

  const shellMarker = () => `touch '${marker}'; :`;

  test('a .gitattributes textconv runs on diff, log -p and show, and not under the env', () => {
    commitChanges('a.bin', '*.bin diff=evil');
    git(['config', 'diff.evil.textconv', shellMarker()]);
    for (const args of [['diff'], ['log', '-p', '-2'], ['show']]) {
      expect([args, ran(args, plainEnv())]).toEqual([args, true]);
      expect([args, ran(args, reviewerEnv())]).toEqual([args, false]);
    }
  });

  test('diff.<name>.command and diff.external run on diff, and not under the env', () => {
    commitChanges('a.bin', '*.bin diff=evil');
    git(['config', 'diff.evil.command', shellMarker()]);
    expect(ran(['diff'], plainEnv())).toBe(true);
    git(['config', '--unset', 'diff.evil.command']);
    git(['config', 'diff.external', shellMarker()]);
    expect(ran(['diff'], plainEnv())).toBe(true);
    git(['config', 'diff.evil.command', shellMarker()]);
    for (const args of [['diff'], ['log', '-p', '-2'], ['show']]) {
      expect([args, ran(args, reviewerEnv())]).toEqual([args, false]);
    }
  });

  test('a clean filter runs on diff and status, and not under the env', () => {
    commitChanges('a.txt', '*.txt filter=evil');
    git(['config', 'filter.evil.clean', script]);
    for (const args of [['diff'], ['status']]) {
      expect([args, ran(args, plainEnv())]).toEqual([args, true]);
      expect([args, ran(args, reviewerEnv())]).toEqual([args, false]);
    }
  });

  test('core.fsmonitor runs on status, and not under the env', () => {
    commitChanges('a.txt', '');
    git(['config', 'core.fsmonitor', shellMarker()]);
    expect(ran(['status'], plainEnv())).toBe(true);
    expect(ran(['status'], reviewerEnv())).toBe(false);
  });

  test('gpg.program runs on a signed commit under log.showSignature, and not under the env', () => {
    commitChanges('a.txt', '');
    const tree = new TextDecoder()
      .decode(Bun.spawnSync(['git', 'rev-parse', 'HEAD^{tree}'], { cwd: repo }).stdout)
      .trim();
    const body = [
      `tree ${tree}`,
      'author a <a@example.com> 1 +0000',
      'committer a <a@example.com> 1 +0000',
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ' ',
      ' -----END PGP SIGNATURE-----',
      '',
      'signed',
      '',
    ].join('\n');
    const signed = new TextDecoder()
      .decode(
        Bun.spawnSync(['git', 'hash-object', '-t', 'commit', '-w', '--stdin'], {
          cwd: repo,
          stdin: new TextEncoder().encode(body),
        }).stdout,
      )
      .trim();
    git(['config', 'gpg.program', script]);
    git(['config', 'log.showSignature', 'true']);
    for (const args of [
      ['log', '-1', signed],
      ['show', signed],
      ['log', '-1', '--format=%G?', signed],
    ]) {
      expect([args, ran(args, plainEnv())]).toEqual([args, true]);
      expect([args, ran(args, reviewerEnv())]).toEqual([args, false]);
    }
  });
});
