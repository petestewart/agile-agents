/**
 * `agile vendors` and `agile vendors check [vendor]` (T489) over a real RPC
 * socket, with the self-check running the fake agent (never a vendor).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS } from '@agile-agents/acp-client';
import {
  type RpcServerHandle,
  StateStore,
  VendorCheckService,
  buildVendorCheckRpcMethods,
  runInit,
  startRpcServer,
} from '@agile-agents/daemon';
import type { VendorChecksStatus } from '@agile-agents/shared';
import { runCli } from '../index';
import { runVendors, runVendorsCheck, vendorRowCells } from './vendors';

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
    expect(before.out).toMatch(/Gemini CLI\s+0\.50\.0\s+not installed/);
    expect(before.out).toContain('Automatic checks: on');

    const checked = await capture(() => runVendorsCheck(socketPath, 'codex', false));
    expect(checked.code).toBe(0);
    expect(checked.out).toContain('Checking codex');
    const row = checked.out.split('\n').find((l) => l.startsWith('Codex')) ?? '';
    // Model ✓, no effort option —, the reply's usage fields, resume ✓.
    expect(row).toMatch(/✓\s+—\s+reply: inputTokens, outputTokens\s+✓/);

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
  });
});
