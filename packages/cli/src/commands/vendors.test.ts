/**
 * `agile vendors` and `agile vendors check [vendor]` (T489) over a real RPC
 * socket, with the self-check running the fake agent (never a vendor).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS } from '@agile-agents/acp-client';
import {
  BridgeInstallService,
  type RpcServerHandle,
  StateStore,
  VendorCheckService,
  buildVendorCheckRpcMethods,
  runInit,
  startRpcServer,
} from '@agile-agents/daemon';
import type { VendorChecksStatus } from '@agile-agents/shared';
import { runCli } from '../index';
import {
  runVendors,
  runVendorsCheck,
  runVendorsInstall,
  vendorRowCells,
  vendorRowNotes,
  wrapNote,
} from './vendors';

const FAKE_AGENT = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'daemon',
  'src',
  'runner',
  'fake-agent.ts',
);

let home: string;
let rpc: RpcServerHandle;
let socketPath: string;
let checks: VendorCheckService;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-cli-vendors-'));
  const init = runInit(home);
  const store = StateStore.open(init.stateRoot);
  const script = join(home, 'script.json');
  writeFileSync(
    script,
    JSON.stringify({
      steps: [{ type: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } }],
      modelOption: {
        current: 'gpt-6-astra',
        options: [
          { value: 'gpt-6-astra', name: 'GPT-6-Astra' },
          { value: 'gpt-5.5', name: 'GPT-5.5' },
        ],
      },
    }),
  );
  checks = new VendorCheckService({
    home,
    store,
    vendors: ['codex', 'gemini'],
    missing: (v) =>
      v === 'gemini' ? 'Gemini CLI can’t start: `gemini` is not on PATH.' : undefined,
    provider: (v) => ({
      ...ACP_PROVIDERS[v],
      command: 'bun',
      args: [FAKE_AGENT],
      envOverrides: { AGILE_FAKE_AGENT_SCRIPT: script },
    }),
    cliVersion: () => '0.50.0',
  });
  socketPath = join(home, 'agiled.sock');
  rpc = startRpcServer({
    socketPath,
    version: 'test',
    stateRoot: init.stateRoot,
    startedAt: Date.now(),
    extraMethods: buildVendorCheckRpcMethods(checks),
  });
  await rpc.listening;
});

afterEach(async () => {
  await rpc.close();
  await checks.settled();
  rmSync(home, { recursive: true, force: true });
});

async function capture(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    const code = await run();
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

describe('agile vendors (T489)', () => {
  test('the table before any check, a check of one vendor, then the table with its result', async () => {
    const before = await capture(() => runVendors(socketPath, false));
    expect(before.code).toBe(0);
    expect(before.out).toContain('VENDOR');
    expect(before.out).toMatch(/Codex\s+0\.50\.0\s+never/);
    expect(before.out).toMatch(
      /Gemini CLI\s+0\.50\.0\s+can’t start[^\n]*\n {2}Gemini CLI can’t start: `gemini` is not on PATH\./,
    );
    expect(before.out).toContain('Automatic checks: on');

    const checked = await capture(() => runVendorsCheck(socketPath, 'codex', false));
    expect(checked.code).toBe(0);
    expect(checked.out).toContain('Checking codex');
    const row = checked.out.split('\n').find((l) => l.startsWith('Codex')) ?? '';
    // Model ✓, no effort option —, resume ✓, the turn's tokens arrived.
    expect(row).toMatch(/✓\s+—\s+✓\s+per turn$/);
    // T494: no line pads to the widest note.
    for (const line of checked.out.split('\n')) expect(line).toBe(line.trimEnd());

    const json = await capture(() => runVendors(socketPath, true));
    const status = JSON.parse(json.out) as VendorChecksStatus;
    expect(status.vendors.find((v) => v.vendor === 'codex')?.last?.model.outcome).toBe('honoured');
  }, 30_000);

  test('a vendor that is not installed, or not a vendor, is refused in words', async () => {
    await expect(runVendorsCheck(socketPath, 'gemini', false)).rejects.toThrow('not on PATH');
    await expect(runVendorsCheck(socketPath, 'openai', true)).rejects.toThrow(
      'openai is not one of',
    );
  });

  test('a row in words: running, waiting, never, not installed', () => {
    const base = { vendor: 'claude' as const, label: 'Claude Code', installed: true };
    expect(vendorRowCells({ ...base, running: true, queued: false })[2]).toBe('checking…');
    expect(vendorRowCells({ ...base, running: false, queued: true })[2]).toBe('waiting');
    expect(vendorRowCells({ ...base, running: false, queued: false })[2]).toBe('never');
    expect(vendorRowCells({ ...base, installed: false, running: false, queued: false })[2]).toBe(
      'not installed',
    );
  });

  test('T494: long words go under the row, wrapped; an installed CLI with no bridge can’t start', () => {
    const missing = 'Pi can’t start: `pi-acp` is not on the daemon’s PATH.';
    const pi = {
      vendor: 'pi' as const,
      label: 'Pi',
      installed: false,
      cli_version: '0.87.1',
      missing,
      running: false,
      queued: false,
    };
    expect(vendorRowCells(pi)[2]).toBe('can’t start');
    expect(vendorRowNotes(pi)).toEqual([missing]);
    const lines = wrapNote(`Rate limits: ${'a=1, '.repeat(40)}`, 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith('  ')).toBe(true);
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  test('usage lists the verbs', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      await runCli(['vendors', 'bogus']);
    } finally {
      console.error = original;
    }
    expect(errors.join('\n')).toContain('vendors check [vendor]');
    expect(errors.join('\n')).toContain('vendors install antigravity');
  });
});

describe('agile vendors install (T500)', () => {
  let installHome: string;
  let installRpc: RpcServerHandle;
  let installSocket: string;

  beforeEach(async () => {
    installHome = mkdtempSync(join(tmpdir(), 'agile-cli-vendors-install-'));
    const init = runInit(installHome);
    const store = StateStore.open(init.stateRoot);
    // Fakes only: nothing is fetched or unpacked, and the server never runs.
    const installs = new BridgeInstallService({
      home: installHome,
      store,
      provider: (v) => ACP_PROVIDERS[v],
      host: { platform: 'linux', arch: 'x64' },
      download: async (_url, dest) => writeFileSync(dest, 'zip-bytes'),
      unzip: async (_archive, dir) => writeFileSync(join(dir, 'agy_acp_server.par'), 'fake'),
    });
    const service = new VendorCheckService({
      home: installHome,
      store,
      vendors: ['antigravity', 'codex'],
      missing: (v) => (v === 'antigravity' ? installs.missing(v) : undefined),
      installs,
    });
    installSocket = join(installHome, 'agiled.sock');
    installRpc = startRpcServer({
      socketPath: installSocket,
      version: 'test',
      stateRoot: init.stateRoot,
      startedAt: Date.now(),
      extraMethods: buildVendorCheckRpcMethods(service),
    });
    await installRpc.listening;
  });

  afterEach(async () => {
    await installRpc.close();
    rmSync(installHome, { recursive: true, force: true });
  });

  test('the table names the fix; install prints the manifest and how to sign in; then the table shows the hash', async () => {
    const before = await capture(() => runVendors(installSocket, false));
    expect(before.out).toContain(
      'ACP server 1.2.1 not installed: agile vendors install antigravity',
    );
    expect(before.out).toContain('Antigravity can');
    const sha = createHash('sha256').update('zip-bytes').digest('hex');
    const installed = await capture(() => runVendorsInstall(installSocket, 'antigravity', false));
    expect(installed.code).toBe(0);
    expect(installed.out).toContain('Installed antigravity-acp 1.2.1 (linux-x86_64)');
    expect(installed.out).toContain(`SHA-256 ${sha}`);
    expect(installed.out).toContain('run `agy` and sign in');
    expect(installed.out).toContain('agile vendors check antigravity');
    const after = await capture(() => runVendors(installSocket, false));
    expect(after.out).toContain(sha);
  });

  test('a vendor with nothing to download, or none named, is refused in words', async () => {
    await expect(runVendorsInstall(installSocket, 'codex', false)).rejects.toThrow(
      "Codex isn't installed by this app",
    );
    await expect(runVendorsInstall(installSocket, undefined, false)).rejects.toThrow(
      'agile vendors install: name a vendor',
    );
  });
});
