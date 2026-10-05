/**
 * `agile codex install-gate|status` against an in-process daemon (T512):
 * the three entries land in the test's own Codex home (never the machine's
 * `~/.codex`), the script in the test's agile home, the legacy repo-root
 * files are swept, and `status` reports per entry without any of Codex's
 * `config.toml`. No vendor, no network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../index';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { formatDaemonStatus } from './daemon';

let daemon: TestDaemon;

beforeEach(async () => {
  daemon = await startTestDaemon('agile-cli-codex-');
});

afterEach(async () => {
  await daemon.cleanup();
});

/** One CLI run through the real dispatch, stdout and stderr captured. */
async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (msg: string) => out.push(String(msg));
  console.error = (msg: string) => err.push(String(msg));
  try {
    const code = await runCli(argv, daemon.repo);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** What Codex's `/hooks` writes when each entry is trusted. */
function trust(slots: number[]): void {
  const hooks = join(daemon.codexHome, 'hooks.json');
  writeFileSync(
    join(daemon.codexHome, 'config.toml'),
    slots
      .map(
        (i) =>
          `[hooks.state.${JSON.stringify(`${hooks}:pre_tool_use:${i}:0`)}]\ntrusted_hash = "sha256:feedface"\n`,
      )
      .join(''),
  );
}

describe('agile codex', () => {
  test('install-gate writes the entries and the script, sweeps old repo-root files, then says to trust them', async () => {
    // A registered repo with T511's files at its root.
    const repo = daemon.repo;
    expect((await cli(['repo', 'add', repo, '--name', 'demo'])).code).toBe(0);
    mkdirSync(join(repo, '.codex'));
    writeFileSync(
      join(repo, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: join(repo, '.codex', 'agile-pre-tool-use.sh') }],
            },
          ],
        },
      }),
    );
    writeFileSync(join(repo, '.codex', 'agile-pre-tool-use.sh'), '#!/bin/sh\nexit 2\n');

    const installed = await cli(['codex', 'install-gate']);
    expect(installed.code).toBe(0);
    const hooksPath = join(daemon.codexHome, 'hooks.json');
    const script = join(daemon.home, 'agile-pre-tool-use.sh');
    expect(installed.out).toContain(`Added the three agile gate hooks to ${hooksPath}`);
    expect(installed.out).toContain(`script: ${script} (written)`);
    expect(installed.out).toContain(`removed old gate file: ${join(repo, '.codex', 'hooks.json')}`);
    expect(installed.out.trimEnd().split('\n').at(-1)).toBe(
      'Now open `codex`, run `/hooks`, and trust the three `agile gate` hooks (Hooks need review → trust each).',
    );
    const file = JSON.parse(readFileSync(hooksPath, 'utf8'));
    expect(
      file.hooks.PreToolUse.map((m: { matcher: string; hooks: Array<{ command: string }> }) => [
        m.matcher,
        m.hooks[0]?.command,
      ]),
    ).toEqual([
      ['Bash', script],
      ['apply_patch|Edit|Write', script],
      ['mcp__.*', script],
    ]);
    expect(readFileSync(script, 'utf8')).toContain(
      `hook pre-tool-use --vendor codex --home ${daemon.home} --repo ${repo} || exit 2`,
    );
    expect(existsSync(join(repo, '.codex'))).toBe(false);
    // Codex's config is never written.
    expect(existsSync(join(daemon.codexHome, 'config.toml'))).toBe(false);

    // Again: nothing changes.
    const before = readFileSync(hooksPath, 'utf8');
    const again = await cli(['codex', 'install-gate']);
    expect(again.out).toContain(`already in ${hooksPath} (unchanged)`);
    expect(again.out).toContain('(unchanged)');
    expect(readFileSync(hooksPath, 'utf8')).toBe(before);
  });

  test('status: not installed, installed but untrusted (per entry), trusted; never the hash', async () => {
    const missing = await cli(['codex', 'status']);
    expect(missing.code).toBe(0);
    expect(missing.out).toContain(`hooks.json: ${join(daemon.codexHome, 'hooks.json')}`);
    expect(missing.out).toContain('installed: no');
    expect(missing.out).toContain('Run `agile codex install-gate`.');

    await cli(['codex', 'install-gate']);
    trust([0, 2]);
    const partial = await cli(['codex', 'status']);
    expect(partial.out.split('\n')).toEqual([
      `hooks.json: ${join(daemon.codexHome, 'hooks.json')}`,
      'installed: yes',
      'trusted: no',
      '  Bash: trusted',
      '  apply_patch|Edit|Write: not trusted',
      '  mcp__.*: trusted',
      `script: ${join(daemon.home, 'agile-pre-tool-use.sh')}`,
      'Now open `codex`, run `/hooks`, and trust the three `agile gate` hooks (Hooks need review → trust each).',
    ]);

    trust([0, 1, 2]);
    const trusted = await cli(['codex', 'status', '--json']);
    expect(JSON.parse(trusted.out)).toMatchObject({ installed: true, trusted: true });
    expect(trusted.out).not.toContain('feedface');
    // install-gate on a trusted gate: nothing more to do.
    expect((await cli(['codex', 'install-gate'])).out).toContain(
      'Codex already trusts all three: nothing more to do.',
    );
  });

  test('install-gate refuses a hooks.json that is not valid JSON and leaves it', async () => {
    mkdirSync(daemon.codexHome, { recursive: true });
    writeFileSync(join(daemon.codexHome, 'hooks.json'), '{"hooks": ');
    const result = await cli(['codex', 'install-gate']);
    expect(result.code).toBe(1);
    expect(result.err).toContain("isn't valid JSON; Codex's gate can't be merged into it");
    expect(readFileSync(join(daemon.codexHome, 'hooks.json'), 'utf8')).toBe('{"hooks": ');
  });

  test('the daemon status line', () => {
    const report = {
      running: true,
      pid: 1,
      home: '/h',
      port: 4600,
      socketPath: '/h/agiled.sock',
      pidPath: '/h/agiled.pid',
      logPath: '/h/log/agiled.log',
    };
    const gate = {
      hooks_path: '/c/hooks.json',
      script_path: '/h/agile-pre-tool-use.sh',
      entries: [],
    };
    expect(
      formatDaemonStatus({
        ...report,
        codexGate: { ...gate, installed: true, trusted: true },
      }),
    ).toContain('\nCodex gate: installed, trusted');
    expect(
      formatDaemonStatus({
        ...report,
        codexGate: { ...gate, installed: false, trusted: false },
      }),
    ).toContain('\nCodex gate: not installed — run agile codex install-gate');
    expect(
      formatDaemonStatus({
        ...report,
        codexGate: { ...gate, installed: true, trusted: false },
      }),
    ).toContain('\nCodex gate: installed, not trusted — in Codex run /hooks');
    expect(formatDaemonStatus(report)).not.toContain('Codex gate');
  });

  test('the usage text names both commands', async () => {
    const result = await cli(['codex']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('codex install-gate');
    expect(result.err).toContain('codex status');
  });
});
