import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPiExtension, resolvePiAgentDir } from './install';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agile-pi-install-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolvePiAgentDir', () => {
  it('honors PI_CODING_AGENT_DIR when set', () => {
    expect(resolvePiAgentDir({ env: { PI_CODING_AGENT_DIR: '/custom/pi' } })).toBe('/custom/pi');
  });

  it('falls back to <home>/.pi/agent', () => {
    expect(resolvePiAgentDir({ env: {}, homeDir: '/home/x' })).toBe('/home/x/.pi/agent');
  });
});

describe('installPiExtension', () => {
  it('never touches the real home directory — writes only under the injected agentDir', () => {
    const result = installPiExtension({
      agentDir: dir,
      extensionSource: 'export default () => {};',
    });
    expect(result.extensionPath).toBe(join(dir, 'extensions', 'agile.ts'));
    expect(result.settingsPath).toBe(join(dir, 'settings.json'));
    expect(existsSync(result.extensionPath)).toBe(true);
    expect(existsSync(result.settingsPath)).toBe(true);
  });

  it('writes the extension source verbatim', () => {
    const source = '// agile pi extension\nexport default function () {}\n';
    installPiExtension({ agentDir: dir, extensionSource: source });
    expect(readFileSync(join(dir, 'extensions', 'agile.ts'), 'utf8')).toBe(source);
  });

  it('sets quietStartup: true in settings.json by default, merging existing keys', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }));

    const result = installPiExtension({ agentDir: dir, extensionSource: 'x' });
    expect(result.settingsWritten).toBe(true);
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(settings.quietStartup).toBe(true);
    expect(settings.theme).toBe('dark');
  });

  it('is idempotent: a second identical call reports no writes', () => {
    const source = 'export default function () {}\n';
    const first = installPiExtension({ agentDir: dir, extensionSource: source });
    expect(first.extensionWritten).toBe(true);
    expect(first.settingsWritten).toBe(true);

    const second = installPiExtension({ agentDir: dir, extensionSource: source });
    expect(second.extensionWritten).toBe(false);
    expect(second.settingsWritten).toBe(false);
  });

  it('rewrites the extension file when its content changed', () => {
    installPiExtension({ agentDir: dir, extensionSource: 'v1' });
    const result = installPiExtension({ agentDir: dir, extensionSource: 'v2' });
    expect(result.extensionWritten).toBe(true);
    expect(readFileSync(join(dir, 'extensions', 'agile.ts'), 'utf8')).toBe('v2');
  });

  it('quietStartup: false is honored and only rewrites when it actually changes', () => {
    const first = installPiExtension({ agentDir: dir, extensionSource: 'x', quietStartup: false });
    expect(first.settingsWritten).toBe(true);
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(settings.quietStartup).toBe(false);

    const second = installPiExtension({ agentDir: dir, extensionSource: 'x', quietStartup: false });
    expect(second.settingsWritten).toBe(false);
  });
});
