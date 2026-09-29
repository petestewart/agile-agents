/**
 * T480 (D49): a Claude or Codex session runs the CLI the operator installed,
 * not the bridge's bundled copy, unless the switch is off, nothing is on
 * PATH, or the session is sandboxed.
 */

import { describe, expect, test } from 'bun:test';
import {
  installedCliFor,
  installedCliForSpawn,
  installedCliOn,
  installedCliStatus,
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
