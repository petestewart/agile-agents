import { describe, expect, test } from 'bun:test';
import { ACP_PROVIDERS } from '@agile-agents/acp-client';
import {
  type MethodTools,
  bunCommandRunner,
  commandText,
  compareVersions,
  detectInstall,
  firstLine,
  parseVersion,
  updaterEnv,
} from './methods';
import { bridgesOf } from './service';

const tools = (exists: string[] = [], onPath: Record<string, string> = {}): MethodTools => ({
  which: (command) => onPath[command] ?? null,
  exists: (path) => exists.includes(path),
});

describe('T481 versions', () => {
  test('the first semver-looking token of --version output', () => {
    expect(parseVersion('2.3.1 (Claude Code)')).toBe('2.3.1');
    expect(parseVersion('codex-cli 0.46.0\n')).toBe('0.46.0');
    expect(parseVersion('gemini v0.32.1')).toBe('0.32.1');
    expect(parseVersion('0.33.0-preview.2')).toBe('0.33.0-preview.2');
    expect(parseVersion('Node 22 / build 2026.09.29')).toBe('2026.09.29');
    expect(parseVersion('no version here')).toBeUndefined();
    expect(parseVersion('1.2')).toBeUndefined();
  });

  test('semver order, a pre-release before its release', () => {
    expect(compareVersions('2.2.9', '2.3.1')).toBe(-1);
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
  });
});

describe('T481 install method from the resolved path', () => {
  test('a Homebrew formula, even one holding a node_modules tree (gemini-cli)', () => {
    const path =
      '/opt/homebrew/Cellar/gemini-cli/0.32.1/libexec/lib/node_modules/@google/gemini-cli/dist/index.js';
    const { install, method } = detectInstall('gemini', path);
    expect(install).toEqual({
      method: 'brew',
      prefix: '/opt/homebrew',
      package: 'gemini-cli',
      cask: false,
    });
    const t = tools(['/opt/homebrew/bin/brew']);
    expect(method?.latest?.argv(install, t)).toEqual([
      '/opt/homebrew/bin/brew',
      'info',
      '--json=v2',
      'gemini-cli',
    ]);
    expect(method?.update(install, '/opt/homebrew/bin/gemini', t)).toEqual([
      '/opt/homebrew/bin/brew',
      'upgrade',
      'gemini-cli',
    ]);
    expect(
      method?.latest?.parse(
        JSON.stringify({ formulae: [{ versions: { stable: '0.33.0' } }], casks: [] }),
      ),
    ).toBe('0.33.0');
  });

  test('a Homebrew cask, an Intel prefix and Linuxbrew', () => {
    const cask = detectInstall('claude', '/opt/homebrew/Caskroom/claude-code/2.2.9/claude');
    expect(cask.install).toMatchObject({ method: 'brew', package: 'claude-code', cask: true });
    expect(cask.method?.update(cask.install, 'claude', tools([], { brew: '/x/brew' }))).toEqual([
      '/x/brew',
      'upgrade',
      '--cask',
      'claude-code',
    ]);
    expect(
      cask.method?.latest?.parse(JSON.stringify({ formulae: [], casks: [{ version: '2.3.1' }] })),
    ).toBe('2.3.1');
    expect(
      detectInstall('codex', '/usr/local/Cellar/codex/0.46.0/bin/codex').install,
    ).toMatchObject({ method: 'brew', package: 'codex', prefix: '/usr/local' });
    expect(
      detectInstall('gemini', '/home/linuxbrew/.linuxbrew/Cellar/gemini-cli/0.32.1/bin/gemini')
        .install,
    ).toMatchObject({ method: 'brew', prefix: '/home/linuxbrew/.linuxbrew' });
  });

  test('a global npm package, scoped or not, updated into the tree it came from', () => {
    const { install, method } = detectInstall(
      'claude',
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    );
    expect(install).toEqual({
      method: 'npm',
      prefix: '/usr/local',
      package: '@anthropic-ai/claude-code',
    });
    const t = tools(['/usr/local/bin/npm']);
    expect(method?.latest?.argv(install, t)).toEqual([
      '/usr/local/bin/npm',
      'view',
      '@anthropic-ai/claude-code',
      'version',
    ]);
    expect(method?.update(install, 'claude', t)).toEqual([
      '/usr/local/bin/npm',
      'install',
      '-g',
      '--prefix',
      '/usr/local',
      '@anthropic-ai/claude-code@latest',
    ]);
    expect(method?.latest?.parse('2.3.1\n')).toBe('2.3.1');
    const nvm = detectInstall(
      'pi-acp',
      '/Users/pete/.nvm/versions/node/v22.3.0/lib/node_modules/pi-acp/dist/index.js',
    );
    expect(nvm.install).toEqual({
      method: 'npm',
      prefix: '/Users/pete/.nvm/versions/node/v22.3.0',
      package: 'pi-acp',
    });
    // No npm beside the package: the one on PATH, still into that prefix.
    expect(nvm.method?.update(nvm.install, 'pi-acp', tools([], { npm: '/usr/bin/npm' }))).toEqual([
      '/usr/bin/npm',
      'install',
      '-g',
      '--prefix',
      '/Users/pete/.nvm/versions/node/v22.3.0',
      'pi-acp@latest',
    ]);
  });

  test("Claude Code's own installer is `claude update`, with no known newest version", () => {
    for (const path of [
      '/Users/pete/.local/share/claude/versions/2.2.9',
      '/Users/pete/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js',
    ]) {
      const { install, method } = detectInstall('claude', path);
      expect(install.method).toBe('native');
      expect(method?.latest).toBeUndefined();
      expect(method?.update(install, '/Users/pete/.local/bin/claude', tools())).toEqual([
        '/Users/pete/.local/bin/claude',
        'update',
      ]);
    }
  });

  test('anything else is unknown: never guessed', () => {
    // Cursor's own installer, Claude's native path for another vendor, a bun global, the npx cache.
    for (const [harness, path] of [
      ['cursor', '/Users/pete/.local/share/cursor-agent/versions/2026.09.20/cursor-agent'],
      ['codex', '/Users/pete/.local/share/claude/versions/2.2.9'],
      ['grok', '/Users/pete/.bun/install/global/node_modules/grok/bin/grok'],
      ['pi', '/Users/pete/.npm/_npx/a1b2c3/node_modules/pi/bin/pi'],
      ['grok', '/usr/bin/grok'],
    ] as const) {
      const found = detectInstall(harness, path);
      expect(found.install).toEqual({ method: 'unknown' });
      expect(found.method).toBeUndefined();
    }
  });
});

describe('T481 words and bridges', () => {
  test('an argv as a command to run by hand; the first line without its period', () => {
    expect(commandText(['brew', 'upgrade', 'gemini-cli'])).toBe('brew upgrade gemini-cli');
    expect(commandText(['/a b/npm', 'install'])).toBe("'/a b/npm' install");
    expect(firstLine('\n  npm ERR! code EACCES.\nmore')).toBe('npm ERR! code EACCES');
    expect(firstLine('   \n')).toBeUndefined();
  });

  test("each npx bridge's pinned version, read from the provider args", () => {
    const bridges = bridgesOf(ACP_PROVIDERS);
    expect(bridges.map((b) => [b.vendor, b.package])).toEqual([
      ['claude', '@agentclientprotocol/claude-agent-acp'],
      ['codex', '@agentclientprotocol/codex-acp'],
    ]);
    const pinned = (vendor: string) => bridges.find((b) => b.vendor === vendor)?.pinned;
    // The same versions providers.ts pins (a bump there moves these).
    expect(ACP_PROVIDERS.claude.args).toContain(
      `@agentclientprotocol/claude-agent-acp@${pinned('claude')}`,
    );
    expect(ACP_PROVIDERS.codex.args).toContain(`@agentclientprotocol/codex-acp@${pinned('codex')}`);
  });
});

describe('T481 the real runner', () => {
  test('a command past its timeout is killed and says so; no shell is involved', async () => {
    const started = Date.now();
    const slow = await bunCommandRunner([process.execPath, '-e', 'await Bun.sleep(10000)'], {
      timeoutMs: 300,
    });
    expect(slow.timedOut).toBe(true);
    expect(slow.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    const quick = await bunCommandRunner(
      [process.execPath, '-e', 'console.log("2.3.1 (x)"); console.error("warn")'],
      { timeoutMs: 10_000 },
    );
    expect(quick).toEqual({ code: 0, stdout: '2.3.1 (x)\n', stderr: 'warn\n', timedOut: false });
    // A shell metacharacter is an argument, not a pipeline.
    const literal = await bunCommandRunner(
      [process.execPath, '-e', 'console.log(process.argv.at(-1))', '; echo pwned'],
      { timeoutMs: 10_000 },
    );
    expect(literal.stdout).toBe('; echo pwned\n');
    const missing = await bunCommandRunner(['/nonexistent/agile-t481-cli', '--version'], {
      timeoutMs: 1_000,
    });
    expect(missing.code).toBeNull();
    expect(missing.error).toBeDefined();
  });
});

describe('T481: an updater never gets the classifier key', () => {
  test('updaterEnv keeps the operator env and drops TYPESAFE_API_KEY', () => {
    const env = updaterEnv({ HOME: '/h', PATH: '/bin', TYPESAFE_API_KEY: 'k' });
    expect(env).toEqual({ HOME: '/h', PATH: '/bin' });
  });
});
