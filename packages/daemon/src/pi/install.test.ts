import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXTENSION_MARKER,
  ForeignPiExtensionError,
  installPiExtension,
  resolvePiAgentDir,
} from './install';

let dir: string;

/** A legitimate "our own file" source — every real `agile-extension.ts` copy carries `EXTENSION_MARKER` on its first line (see that file's header). */
function ownSource(body: string): string {
  return `// ${EXTENSION_MARKER}\n${body}`;
}

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
      extensionSource: ownSource('export default () => {};'),
    });
    expect(result.extensionPath).toBe(join(dir, 'extensions', 'agile.ts'));
    expect(result.settingsPath).toBe(join(dir, 'settings.json'));
    expect(existsSync(result.extensionPath)).toBe(true);
    expect(existsSync(result.settingsPath)).toBe(true);
  });

  it('writes the extension source verbatim', () => {
    const source = ownSource('export default function () {}\n');
    installPiExtension({ agentDir: dir, extensionSource: source });
    expect(readFileSync(join(dir, 'extensions', 'agile.ts'), 'utf8')).toBe(source);
  });

  it('sets quietStartup: true in settings.json by default, merging existing keys', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }));

    const result = installPiExtension({ agentDir: dir, extensionSource: ownSource('x') });
    expect(result.settingsWritten).toBe(true);
    expect(result.settingsError).toBeUndefined();
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(settings.quietStartup).toBe(true);
    expect(settings.theme).toBe('dark');
  });

  it('is idempotent: a second identical call reports no writes', () => {
    const source = ownSource('export default function () {}\n');
    const first = installPiExtension({ agentDir: dir, extensionSource: source });
    expect(first.extensionWritten).toBe(true);
    expect(first.settingsWritten).toBe(true);

    const second = installPiExtension({ agentDir: dir, extensionSource: source });
    expect(second.extensionWritten).toBe(false);
    expect(second.settingsWritten).toBe(false);
  });

  it('rewrites the extension file when its content changed (still ours — carries the marker)', () => {
    installPiExtension({ agentDir: dir, extensionSource: ownSource('v1') });
    const result = installPiExtension({ agentDir: dir, extensionSource: ownSource('v2') });
    expect(result.extensionWritten).toBe(true);
    expect(readFileSync(join(dir, 'extensions', 'agile.ts'), 'utf8')).toBe(ownSource('v2'));
  });

  it('quietStartup: false is honored and only rewrites when it actually changes', () => {
    const first = installPiExtension({
      agentDir: dir,
      extensionSource: ownSource('x'),
      quietStartup: false,
    });
    expect(first.settingsWritten).toBe(true);
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(settings.quietStartup).toBe(false);

    const second = installPiExtension({
      agentDir: dir,
      extensionSource: ownSource('x'),
      quietStartup: false,
    });
    expect(second.settingsWritten).toBe(false);
  });

  // Round 2 review fix (B2): refuse to overwrite a foreign extensions/agile.ts.
  describe('foreign extension file (B2)', () => {
    it('throws ForeignPiExtensionError rather than overwriting a file with no marker', () => {
      mkdirSync(join(dir, 'extensions'), { recursive: true });
      const foreignPath = join(dir, 'extensions', 'agile.ts');
      writeFileSync(foreignPath, '// MY OWN pi extension\nexport default () => {};\n');

      expect(() =>
        installPiExtension({ agentDir: dir, extensionSource: ownSource('daemon copy') }),
      ).toThrow(ForeignPiExtensionError);
      // Untouched.
      expect(readFileSync(foreignPath, 'utf8')).toBe(
        '// MY OWN pi extension\nexport default () => {};\n',
      );
    });

    it("the thrown error names the extension's path", () => {
      mkdirSync(join(dir, 'extensions'), { recursive: true });
      writeFileSync(join(dir, 'extensions', 'agile.ts'), 'foreign content');
      try {
        installPiExtension({ agentDir: dir, extensionSource: ownSource('x') });
        throw new Error('expected installPiExtension to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ForeignPiExtensionError);
        expect((err as InstanceType<typeof ForeignPiExtensionError>).extensionPath).toBe(
          join(dir, 'extensions', 'agile.ts'),
        );
      }
    });

    it('a file that already carries the marker is treated as ours and safely rewritten', () => {
      mkdirSync(join(dir, 'extensions'), { recursive: true });
      writeFileSync(join(dir, 'extensions', 'agile.ts'), ownSource('old version'));
      const result = installPiExtension({
        agentDir: dir,
        extensionSource: ownSource('new version'),
      });
      expect(result.extensionWritten).toBe(true);
      expect(readFileSync(join(dir, 'extensions', 'agile.ts'), 'utf8')).toBe(
        ownSource('new version'),
      );
    });
  });

  // Round 2 review fix (B3): a hand-edited/JSONC settings.json must not crash.
  describe('unparseable settings.json (B3)', () => {
    it('leaves a JSONC settings.json untouched and reports settingsError, without throwing', () => {
      mkdirSync(dir, { recursive: true });
      const settingsPath = join(dir, 'settings.json');
      const jsonc = '{\n  // a human comment\n  "theme": "dark",\n}\n';
      writeFileSync(settingsPath, jsonc);

      let result: ReturnType<typeof installPiExtension> | undefined;
      expect(() => {
        result = installPiExtension({ agentDir: dir, extensionSource: ownSource('x') });
      }).not.toThrow();

      expect(result?.settingsWritten).toBe(false);
      expect(result?.settingsError).toBeDefined();
      // Untouched — comments/trailing comma preserved verbatim.
      expect(readFileSync(settingsPath, 'utf8')).toBe(jsonc);
      // The extension file — the load-bearing part — was still written.
      expect(existsSync(result?.extensionPath ?? '')).toBe(true);
      expect(readFileSync(result?.extensionPath ?? '', 'utf8')).toBe(ownSource('x'));
    });
  });
});
