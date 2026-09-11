import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderClaudeSettings, writeClaudeSettings } from './settings';

describe('renderClaudeSettings', () => {
  test('renders PreToolUse/PostToolUse/Stop, each invoking agile hook <event>, matcher "*"', () => {
    const settings = renderClaudeSettings({ agileBin: 'agile' });
    expect(settings).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'agile hook pre-tool-use || exit 2', timeout: 5 }],
          },
        ],
        PostToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'agile hook post-tool-use', timeout: 5 }],
          },
        ],
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: 'agile hook stop', timeout: 5 }] },
        ],
      },
    });
  });

  test('prefixes AGILE_SOCKET_PATH when socketPath is given', () => {
    const settings = renderClaudeSettings({ agileBin: 'agile', socketPath: '/tmp/agile.sock' });
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(
      'AGILE_SOCKET_PATH=/tmp/agile.sock agile hook pre-tool-use || exit 2',
    );
  });

  // T012 QA/review round: disambiguates a reviewer/engineer sharing one
  // worktree — see `hook/service.ts`'s `resolveAgentByCwd`.
  test('prefixes AGILE_AGENT when agentId is given', () => {
    const settings = renderClaudeSettings({ agileBin: 'agile', agentId: 'reviewer-1' });
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(
      'AGILE_AGENT=reviewer-1 agile hook pre-tool-use || exit 2',
    );
  });

  test('prefixes both AGILE_SOCKET_PATH and AGILE_AGENT, socket first, when both are given', () => {
    const settings = renderClaudeSettings({
      agileBin: 'agile',
      socketPath: '/tmp/agile.sock',
      agentId: 'reviewer-1',
    });
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(
      'AGILE_SOCKET_PATH=/tmp/agile.sock AGILE_AGENT=reviewer-1 agile hook pre-tool-use || exit 2',
    );
  });

  test('timeoutSeconds overrides the default 5s', () => {
    const settings = renderClaudeSettings({ agileBin: 'agile', timeoutSeconds: 8 });
    expect(settings.hooks.Stop[0]?.hooks[0]?.timeout).toBe(8);
  });

  test('the default (5s) exceeds the CLI RPC deadline (2000ms)', () => {
    const settings = renderClaudeSettings({ agileBin: 'agile' });
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.timeout).toBeGreaterThan(2);
  });
});

describe('writeClaudeSettings', () => {
  let dir: string;

  test('in a git worktree the hook config is git-excluded, so `git stash push -u` cannot remove it', () => {
    dir = mkdtempSync(join(tmpdir(), 'agile-settings-git-'));
    const git = (args: string[]) => {
      const r = Bun.spawnSync(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr));
      return new TextDecoder().decode(r.stdout).trim();
    };
    try {
      git(['init', '-q']);
      git(['config', 'user.email', 't@example.com']);
      git(['config', 'user.name', 't']);
      writeFileSync(join(dir, 'README.md'), 'x\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'init']);
      writeClaudeSettings(dir, { agileBin: 'agile' });
      writeClaudeSettings(dir, { agileBin: 'agile' }); // idempotent: one exclude line
      expect(git(['status', '--porcelain'])).toBe('');
      writeFileSync(join(dir, 'wip.txt'), 'wip\n');
      git(['stash', 'push', '-u']);
      expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true);
      expect(existsSync(join(dir, 'wip.txt'))).toBe(false);
      const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
      expect(exclude.split('\n').filter((l) => l === '.claude/')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writes .claude/settings.json under the worktree', () => {
    dir = mkdtempSync(join(tmpdir(), 'agile-settings-'));
    try {
      const written = writeClaudeSettings(dir, { agileBin: 'agile' });
      const onDisk = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
      expect(onDisk).toEqual(written);
      expect(onDisk.hooks.PreToolUse[0].hooks[0].command).toBe('agile hook pre-tool-use || exit 2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is idempotent: writing twice with the same inputs is byte-identical', () => {
    dir = mkdtempSync(join(tmpdir(), 'agile-settings-'));
    try {
      writeClaudeSettings(dir, { agileBin: 'agile' });
      const first = readFileSync(join(dir, '.claude', 'settings.json'), 'utf8');
      writeClaudeSettings(dir, { agileBin: 'agile' });
      const second = readFileSync(join(dir, '.claude', 'settings.json'), 'utf8');
      expect(second).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('merges without clobbering unrelated top-level keys or other hook events', () => {
    dir = mkdtempSync(join(tmpdir(), 'agile-settings-'));
    try {
      const claudeDir = join(dir, '.claude');
      require('node:fs').mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify(
          {
            permissions: { allow: ['Read'] },
            hooks: {
              UserPromptSubmit: [
                { matcher: '*', hooks: [{ type: 'command', command: 'echo hi', timeout: 1 }] },
              ],
            },
          },
          null,
          2,
        ),
      );

      const merged = writeClaudeSettings(dir, { agileBin: 'agile' });
      expect(merged.permissions).toEqual({ allow: ['Read'] });
      expect((merged.hooks as Record<string, unknown>).UserPromptSubmit).toBeDefined();
      expect((merged.hooks as Record<string, unknown>).PreToolUse).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('overwrites its own three event keys on re-render (new agileBin)', () => {
    dir = mkdtempSync(join(tmpdir(), 'agile-settings-'));
    try {
      writeClaudeSettings(dir, { agileBin: 'agile' });
      const merged = writeClaudeSettings(dir, { agileBin: '/usr/local/bin/agile' });
      expect(merged.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(
        '/usr/local/bin/agile hook pre-tool-use || exit 2',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
