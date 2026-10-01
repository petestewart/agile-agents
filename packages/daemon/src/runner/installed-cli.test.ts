/**
 * T480 (D49): a Claude or Codex session runs the CLI the operator installed,
 * not the bridge's bundled copy, unless the switch is off, nothing is on
 * PATH, or the session is sandboxed.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cliStamp,
  cliStampChanged,
  installedCliFor,
  installedCliForSpawn,
  installedCliOn,
  installedCliStatus,
  sessionCliPath,
} from './installed-cli';

const which = (found: Record<string, string>) => (bin: string) => found[bin] ?? null;

describe('T480: the installed CLI a bridge runs', () => {
  test('Claude and Codex resolve to their override env when on PATH', () => {
    const w = which({ claude: '/opt/homebrew/bin/claude', codex: '/usr/local/bin/codex' });
    expect(installedCliFor('claude', undefined, w)).toEqual({
      vendor: 'claude',
      label: 'Claude Code',
      path: '/opt/homebrew/bin/claude',
      env: { CLAUDE_CODE_EXECUTABLE: '/opt/homebrew/bin/claude' },
    });
    expect(installedCliFor('codex', {}, w)?.env).toEqual({ CODEX_PATH: '/usr/local/bin/codex' });
  });

  test('nothing on PATH, a vendor without a bundled copy, or the switch off: the bundled copy', () => {
    expect(installedCliFor('claude', undefined, which({}))).toBeUndefined();
    expect(installedCliFor('gemini', undefined, which({ gemini: '/x/gemini' }))).toBeUndefined();
    const off = { installed_cli: { claude: false } };
    expect(installedCliOn(off, 'claude')).toBe(false);
    expect(installedCliOn(off, 'codex')).toBe(true);
    expect(installedCliFor('claude', off, which({ claude: '/x/claude' }))).toBeUndefined();
    expect(installedCliFor('codex', off, which({ codex: '/x/codex' }))?.path).toBe('/x/codex');
  });

  test('a lookup that throws reads as not installed', () => {
    const boom = () => {
      throw new Error('no PATH');
    };
    expect(installedCliFor('claude', undefined, boom)).toBeUndefined();
    expect(installedCliStatus(undefined, boom).map((r) => r.path)).toEqual([undefined, undefined]);
  });

  test('a sandboxed session keeps the bundled copy', () => {
    const cli = installedCliFor('claude', undefined, which({ claude: '/x/claude' }));
    expect(installedCliForSpawn(cli, 'none')).toBe(cli);
    expect(installedCliForSpawn(cli, 'sandbox-exec')).toBeUndefined();
    expect(installedCliForSpawn(cli, 'container')).toBeUndefined();
    expect(installedCliForSpawn(undefined, 'none')).toBeUndefined();
  });

  test('Settings lists both bridged vendors with the switch and what PATH has', () => {
    expect(
      installedCliStatus({ installed_cli: { codex: false } }, which({ claude: '/x/claude' })),
    ).toEqual([
      { vendor: 'claude', label: 'Claude Code', on: true, path: '/x/claude' },
      { vendor: 'codex', label: 'Codex', on: false },
    ]);
  });
});

describe('T495: a CLI updated in place since a session spawned', () => {
  test('a rewrite, a symlink moved to a new version, or a removal is a change; nothing is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agile-cli-stamp-'));
    try {
      const v1 = join(dir, 'codex-0.147.0');
      const v2 = join(dir, 'codex-0.150.0');
      writeFileSync(v1, 'old');
      writeFileSync(v2, 'newer build');
      const onPath = join(dir, 'codex');
      symlinkSync(v1, onPath);
      const stamp = cliStamp(onPath);
      expect(stamp?.real).toBe(cliStamp(v1)?.real);
      if (stamp === undefined) throw new Error('no stamp');
      expect(cliStampChanged(stamp)).toBe(false);
      // A package manager repoints the link at the new version.
      rmSync(onPath);
      symlinkSync(v2, onPath);
      expect(cliStampChanged(stamp)).toBe(true);
      // Rewritten in place.
      const direct = cliStamp(v1);
      if (direct === undefined) throw new Error('no stamp');
      writeFileSync(v1, 'a newer build in place');
      expect(cliStampChanged(direct)).toBe(true);
      // Gone.
      rmSync(v1);
      expect(cliStampChanged(direct)).toBe(true);
      expect(cliStamp(join(dir, 'missing'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('which binary a session runs: the installed CLI, the vendor’s own command, never an npx bridge', () => {
    const installed = installedCliFor('codex', undefined, which({ codex: '/usr/local/bin/codex' }));
    expect(sessionCliPath({ command: 'npx' }, installed)).toBe('/usr/local/bin/codex');
    expect(sessionCliPath({ command: 'npx' }, undefined)).toBeUndefined();
    expect(sessionCliPath({ command: 'bun' }, undefined)).toBeUndefined();
    expect(sessionCliPath({ command: 'gemini' }, undefined, which({ gemini: '/x/gemini' }))).toBe(
      '/x/gemini',
    );
    expect(sessionCliPath({ command: '/opt/agy/agy_acp_server.par' }, undefined)).toBe(
      '/opt/agy/agy_acp_server.par',
    );
    expect(sessionCliPath({ command: 'cursor-agent' }, undefined, which({}))).toBeUndefined();
  });
});
