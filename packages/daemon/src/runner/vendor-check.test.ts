/**
 * T489 (D58): the vendor self-check against the real `fake-agent.ts` over
 * real ACP: every outcome of the model, effort, prompt, usage, rate-limit
 * and resume steps; the result file; the service's latest-per-vendor, its
 * rebuild from the files and the automatic trigger. No vendor, no network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, type AcpProviderConfig } from '@agile-agents/acp-client';
import {
  type HomeConfig,
  type SessionVendor,
  VENDOR_CHECK_FILE,
  VENDOR_CHECK_PROMPT,
  type VendorCheckMode,
  type VendorCheckResult,
  VendorCheckResultSchema,
  ulid,
} from '@agile-agents/shared';
import type { FakeAgentScript } from './fake-agent';
import { SESSION_STATE_FILE, USAGE_LOG_FILE } from './session';
import {
  VendorCheckService,
  effortToTry,
  modelToTry,
  rateLimitFields,
  readVendorCheck,
  runVendorCheck,
  vendorCapabilities,
  vendorsLeftOut,
  writeVendorCheck,
} from './vendor-check';

const FAKE_AGENT_PATH = join(import.meta.dir, 'fake-agent.ts');

let home: string;
let scratch: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-vendor-check-'));
  scratch = mkdtempSync(join(tmpdir(), 'agile-vendor-check-scratch-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

function fakeProvider(vendor: SessionVendor, script: FakeAgentScript): AcpProviderConfig {
  const scriptPath = join(scratch, `${vendor}-${Bun.hash(JSON.stringify(script))}.json`);
  writeFileSync(scriptPath, JSON.stringify(script));
  return {
    ...ACP_PROVIDERS[vendor],
    command: 'bun',
    args: [FAKE_AGENT_PATH],
    envOverrides: { AGILE_FAKE_AGENT_SCRIPT: scriptPath },
  };
}

/** Codex as measured (LIVE-CHECKLIST §12): a model list and a `reasoning_effort` option. */
const CODEX_OPTIONS = {
  modelOption: {
    current: 'gpt-6-astra',
    options: [
      { value: 'gpt-6-astra', name: 'GPT-6-Astra' },
      { value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
    ],
  },
  effortOption: {
    id: 'reasoning_effort',
    current: 'medium',
    values: ['low', 'medium', 'high', 'xhigh'],
  },
};

async function check(
  vendor: SessionVendor,
  script: FakeAgentScript,
  extra: { promptTimeoutMs?: number; provider?: Partial<AcpProviderConfig> } = {},
): Promise<{ result: VendorCheckResult; dir: string; log: string[] }> {
  const logFile = join(scratch, `${vendor}-log.jsonl`);
  const session = ulid();
  const dir = join(home, 'sessions', session);
  const result = await runVendorCheck({
    vendor,
    provider: { ...fakeProvider(vendor, { ...script, logFile }), ...extra.provider },
    session,
    sessionDir: dir,
    reason: 'manual',
    by: 'human',
    cliVersion: '1.2.3',
    ...(extra.promptTimeoutMs !== undefined ? { promptTimeoutMs: extra.promptTimeoutMs } : {}),
  });
  let log: string[] = [];
  try {
    log = readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { method: string }).method);
  } catch {
    log = [];
  }
  return { result, dir, log };
}

describe('what a check sets (T489)', () => {
  test('a model other than the current, never the default or Auto when another is listed', () => {
    expect(
      modelToTry(
        [
          { value: 'default[]', name: 'Auto' },
          { value: 'gpt-5.5[context=272k]', name: 'gpt-5.5' },
        ],
        'gpt-5.5[context=272k]',
      ),
    ).toBe('default[]');
    expect(
      modelToTry(
        [
          { value: 'default[]', name: 'Auto' },
          { value: 'grok-4.7', name: 'Grok 4.7' },
          { value: 'gpt-5.5', name: 'gpt-5.5' },
        ],
        'default[]',
      ),
    ).toBe('grok-4.7');
    expect(
      modelToTry(
        [
          { value: 'default', name: 'Default (recommended)' },
          { value: 'sonnet', name: 'Sonnet' },
        ],
        'opus',
      ),
    ).toBe('sonnet');
    expect(modelToTry([{ value: 'grok-4.7', name: 'Grok 4.7' }], 'grok-4.7')).toBeUndefined();
  });

  test('an effort: a D12 level listed other than the current, cheapest first', () => {
    expect(effortToTry(['low', 'medium', 'high', 'xhigh'], 'medium')).toBe('low');
    expect(effortToTry(['low', 'medium'], 'low')).toBe('medium');
    expect(effortToTry(['xhigh', 'ultra'], 'xhigh')).toBeUndefined();
  });

  test('rate-limit fields: names and values kept, credentials never', () => {
    const out: Parameters<typeof rateLimitFields>[2] = [];
    rateLimitFields(
      {
        rateLimits: { weekly: { remaining: 42, resetsAt: '2026-10-05T00:00:00Z' } },
        planType: 'plus',
        apiKey: 'sk-live-abcdef',
        auth: { rateLimitToken: 'x' },
        quota: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
        contextWindow: 200000,
      },
      'turn_end',
      out,
    );
    // T494: what Claude Code and Codex send as `_meta.quota` is the session's
    // token counts, not what the plan has left.
    rateLimitFields(
      {
        quota: {
          token_count: { totalTokens: 47852, inputTokens: 2 },
          model_usage: [{ model: 'claude-opus-5-5', token_count: { totalTokens: 47852 } }],
        },
      },
      'turn_end',
      out,
    );
    expect(out).toEqual([
      { where: 'turn_end', name: 'rateLimits.weekly.remaining', value: '42' },
      { where: 'turn_end', name: 'rateLimits.weekly.resetsAt', value: '2026-10-05T00:00:00Z' },
      { where: 'turn_end', name: 'planType', value: 'plus' },
    ]);
  });
});

describe('runVendorCheck (T489)', () => {
  test('everything takes: model and effort honoured, the prompt finishes with usage, rate-limit fields, resume ok', async () => {
    const { result, dir, log } = await check('codex', {
      ...CODEX_OPTIONS,
      steps: [
        {
          type: 'usage_update',
          used: 1200,
          size: 272000,
          extra: { cost: { amount: 0.002, currency: 'USD' } },
        },
        { type: 'agent_text', text: 'OK' },
        {
          type: 'end_turn',
          usage: { inputTokens: 1100, outputTokens: 2, totalTokens: 1102 },
          _meta: { rateLimits: { primary: { usedPercent: 12, windowMinutes: 300 } } },
        },
      ],
    });
    expect(result.logged_in).toBe(true);
    expect(result.opened).toBe(true);
    expect(result.model).toEqual({
      outcome: 'honoured',
      from: 'gpt-6-astra',
      to: 'gpt-5.6-sol',
      after: 'gpt-5.6-sol',
      detail: 'Codex took gpt-5.6-sol',
    });
    expect(result.effort).toMatchObject({
      outcome: 'honoured',
      from: 'medium',
      to: 'low',
      after: 'low',
    });
    expect(result.prompt).toMatchObject({
      outcome: 'finished',
      reply: 'OK',
      stop_reason: 'end_turn',
    });
    expect(result.usage).toEqual({
      update_fields: ['used', 'size', 'cost'],
      reply_keys: ['stopReason', 'usage', '_meta'],
      reply_usage_fields: ['inputTokens', 'outputTokens', 'totalTokens'],
      cost: '{"amount":0.002,"currency":"USD"}',
      turn_tokens: true,
      context: true,
    });
    expect(result.rate_limits).toEqual([
      { where: 'turn_end', name: 'rateLimits.primary.usedPercent', value: '12' },
      { where: 'turn_end', name: 'rateLimits.primary.windowMinutes', value: '300' },
    ]);
    expect(result.resume).toEqual({ outcome: 'ok', detail: 'Codex loaded its session again' });
    expect(result.errors).toEqual([]);
    expect(result.cli_version).toBe('1.2.3');
    expect(result.bridge).toEqual({ package: '@agentclientprotocol/codex-acp', version: '1.10.0' });
    // One prompt, then the resume (no second prompt), in that order.
    expect(log).toEqual([
      'session/set_config_option',
      'session/set_config_option',
      'session/prompt',
      'session/load',
    ]);
    // The file sits beside session-state.json and usage.jsonl, validates and round-trips.
    const file = JSON.parse(readFileSync(join(dir, VENDOR_CHECK_FILE), 'utf8'));
    expect(VendorCheckResultSchema.parse(file)).toEqual(result);
    expect(readVendorCheck(dir)).toEqual(result);
    expect(JSON.parse(readFileSync(join(dir, SESSION_STATE_FILE), 'utf8')).vendor).toBe('codex');
    expect(readFileSync(join(dir, USAGE_LOG_FILE), 'utf8')).toContain('"kind":"turn_end"');
  }, 30_000);

  test('the prompt is the one tiny line', async () => {
    const logFile = join(scratch, 'prompt.jsonl');
    const session = ulid();
    await runVendorCheck({
      vendor: 'claude',
      provider: fakeProvider('claude', { steps: [{ type: 'end_turn' }], logFile }),
      session,
      sessionDir: join(home, 'sessions', session),
      reason: 'manual',
      by: 'human',
    });
    const prompt = readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map(
        (l) => JSON.parse(l) as { method: string; params?: { prompt?: Array<{ text: string }> } },
      )
      .find((l) => l.method === 'session/prompt');
    expect(prompt?.params?.prompt?.[0]?.text).toBe(VENDOR_CHECK_PROMPT);
  }, 30_000);

  test('a vendor that keeps its own model and effort: kept, with what it read back', async () => {
    const { result } = await check('codex', {
      ...CODEX_OPTIONS,
      setConfigOption: 'ignore',
      steps: [{ type: 'end_turn' }],
    });
    expect(result.model).toMatchObject({
      outcome: 'kept',
      to: 'gpt-5.6-sol',
      after: 'gpt-6-astra',
    });
    expect(result.model.detail).toBe(
      'Codex kept its own model (GPT-6-Astra); it did not take GPT-5.6-Sol',
    );
    expect(result.effort).toMatchObject({ outcome: 'kept', to: 'low', after: 'medium' });
  }, 30_000);

  test('a vendor that refuses the calls: refused, with the error in words', async () => {
    const { result } = await check('codex', {
      ...CODEX_OPTIONS,
      setConfigOption: 'error',
      steps: [{ type: 'end_turn' }],
    });
    expect(result.model.outcome).toBe('refused');
    expect(result.model.detail).toContain('Codex refused the model GPT-5.6-Sol (cannot set model)');
    expect(result.effort.outcome).toBe('refused');
    expect(result.errors).toEqual([
      'Codex refused the model gpt-5.6-sol: cannot set model',
      'Codex refused effort: cannot set reasoning_effort',
    ]);
    // The prompt still runs.
    expect(result.prompt.outcome).toBe('finished');
  }, 30_000);

  test('the model takes and the effort does not', async () => {
    const { result } = await check('codex', {
      ...CODEX_OPTIONS,
      setEffortOption: 'ignore',
      steps: [{ type: 'end_turn' }],
    });
    expect(result.model.outcome).toBe('honoured');
    expect(result.effort.outcome).toBe('kept');
  }, 30_000);

  test('no model list and no effort option: not applicable; no usage reported', async () => {
    const { result } = await check('gemini', { steps: [{ type: 'end_turn' }] });
    expect(result.model).toEqual({
      outcome: 'not_applicable',
      detail: 'Gemini CLI reported no model list',
    });
    expect(result.effort).toEqual({
      outcome: 'not_applicable',
      detail: 'Gemini CLI reported no effort option',
    });
    expect(result.prompt.outcome).toBe('finished');
    expect(result.usage).toEqual({
      update_fields: [],
      reply_keys: ['stopReason'],
      reply_usage_fields: [],
      turn_tokens: false,
      context: false,
    });
    expect(result.rate_limits).toEqual([]);
    // Gemini's provider isn't set up for session/load.
    expect(result.resume.outcome).toBe('not_supported');
  }, 30_000);

  test('a resume that fails: failed, and why', async () => {
    const { result } = await check('claude', {
      steps: [{ type: 'end_turn' }],
      loadFails: 'Session not found',
    });
    expect(result.resume).toEqual({
      outcome: 'failed',
      detail: 'session/load failed: Session not found',
    });
    expect(result.errors).toEqual(['Claude Code could not resume its session: Session not found']);
  }, 30_000);

  test('a vendor that authenticates first (Cursor) is checked; its resume is not supported here', async () => {
    const { result, log } = await check('cursor', {
      requireAuthMethod: 'cursor_login',
      modelOption: {
        current: 'default[]',
        options: [
          { value: 'default[]', name: 'Auto' },
          { value: 'grok-4.7[fast=true]', name: 'grok-4.7' },
        ],
      },
      setConfigOption: 'ignore',
      steps: [{ type: 'end_turn' }],
    });
    expect(log[0]).toBe('authenticate');
    expect(result.logged_in).toBe(true);
    expect(result.model).toMatchObject({ outcome: 'kept', to: 'grok-4.7[fast=true]' });
    expect(result.resume.outcome).toBe('not_supported');
  }, 30_000);

  test('a vendor that needs a login: "not logged in", and the check stops there', async () => {
    const { result, log } = await check(
      'grok',
      { requireAuthMethod: 'someone-else', steps: [{ type: 'end_turn' }] },
      { provider: { authMethods: ['grok.com'] } },
    );
    expect(result.logged_in).toBe(false);
    expect(result.opened).toBe(false);
    expect(result.errors).toEqual([
      'Grok CLI isn’t logged in. Log in from a terminal (log in to Grok CLI), then check it again.',
    ]);
    expect(result.model.outcome).toBe('skipped');
    expect(result.effort.outcome).toBe('skipped');
    expect(result.prompt.outcome).toBe('skipped');
    expect(result.resume.outcome).toBe('skipped');
    expect(log).not.toContain('session/prompt');
    expect(VendorCheckResultSchema.safeParse(result).success).toBe(true);
  }, 30_000);

  test('a login refused at the prompt (Claude Code’s words) reads "not logged in"', async () => {
    const { result } = await check('claude', {
      steps: [
        { type: 'agent_text', text: 'Invalid API key · Please run /login' },
        { type: 'reject_prompt', message: 'Internal error' },
      ],
    });
    expect(result.logged_in).toBe(false);
    expect(result.prompt.outcome).toBe('failed');
    expect(result.errors).toEqual([
      'Claude Code isn’t logged in. Log in from a terminal (run `claude` and type /login), then check it again.',
    ]);
    expect(result.resume.outcome).toBe('skipped');
  }, 30_000);

  test('a prompt with no reply in time: timed out, and the check goes on', async () => {
    const { result } = await check(
      'claude',
      { steps: [{ type: 'hang' }] },
      { promptTimeoutMs: 500 },
    );
    expect(result.prompt).toEqual({ outcome: 'timed_out', detail: 'no reply in 1 s' });
    expect(result.errors[0]).toBe('Claude Code did not answer the prompt in 1 s');
    expect(result.resume.outcome).toBe('ok');
  }, 30_000);

  test('a tool call the vendor asks for is refused', async () => {
    const answer = join(scratch, 'permission.json');
    const { result } = await check('claude', {
      steps: [
        {
          type: 'request_permission',
          toolCall: { toolCallId: 't1', kind: 'execute', title: 'ls' },
          options: [
            { optionId: 'allow', kind: 'allow_once' },
            { optionId: 'deny', kind: 'reject_once' },
          ],
          resultFile: answer,
        },
        { type: 'end_turn' },
      ],
    });
    expect(result.prompt.outcome).toBe('finished');
    expect(JSON.parse(readFileSync(answer, 'utf8'))).toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' },
    });
  }, 30_000);
});

// ------------------------------------------------------------ the service

function result(
  vendor: SessionVendor,
  finishedAt: string,
  overrides: Partial<VendorCheckResult> = {},
): VendorCheckResult {
  return {
    vendor,
    label: ACP_PROVIDERS[vendor].label,
    session: ulid(Date.parse(finishedAt)),
    started_at: finishedAt,
    finished_at: finishedAt,
    reason: 'manual',
    by: 'human',
    logged_in: true,
    opened: true,
    model: { outcome: 'honoured', to: 'b', after: 'b' },
    effort: { outcome: 'not_applicable' },
    prompt: { outcome: 'finished' },
    rate_limits: [],
    resume: { outcome: 'ok' },
    errors: [],
    ...overrides,
  };
}

function fakeStore(initial: VendorCheckMode | undefined) {
  let mode = initial;
  return {
    getHomeConfig: () => (mode !== undefined ? { vendor_checks: mode } : {}) as HomeConfig,
    setVendorCheckMode: async (next: VendorCheckMode) => {
      mode = next === 'auto' ? undefined : next;
      return {} as HomeConfig;
    },
  };
}

describe('VendorCheckService (T489)', () => {
  test('rebuilds the latest result per vendor from the session dirs; a bad file is skipped', () => {
    const older = result('cursor', '2026-09-30T08:00:00.000Z', { model: { outcome: 'kept' } });
    const newer = result('cursor', '2026-09-30T09:00:00.000Z');
    const claude = result('claude', '2026-09-29T09:00:00.000Z');
    for (const r of [older, newer, claude]) writeVendorCheck(join(home, 'sessions', r.session), r);
    const bad = join(home, 'sessions', ulid());
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, VENDOR_CHECK_FILE), '{"vendor":"codex"}');
    const service = new VendorCheckService({ home, missing: () => undefined }).load();
    expect(service.results()).toEqual({ cursor: newer, claude });
    expect(service.status().vendors.find((v) => v.vendor === 'cursor')?.last).toEqual(newer);
  });

  test('runs the installed vendors one at a time and keeps each result; a named vendor not installed is refused', async () => {
    const order: string[] = [];
    const service = new VendorCheckService({
      home,
      vendors: ['claude', 'codex', 'gemini'],
      missing: (v) =>
        v === 'gemini' ? 'Gemini CLI can’t start: `gemini` is not on PATH.' : undefined,
      provider: (v) => fakeProvider(v, { ...CODEX_OPTIONS, steps: [{ type: 'end_turn' }] }),
      cliVersion: (v) => (v === 'codex' ? '0.50.0' : undefined),
    });
    service.onChange = () => {
      const s = service.status();
      const running = s.vendors.find((v) => v.running)?.vendor;
      if (running !== undefined && order.at(-1) !== running) order.push(running);
      // Never two at once.
      expect(s.vendors.filter((v) => v.running).length).toBeLessThanOrEqual(1);
    };
    const started = service.start(undefined);
    expect(started.running).toBe(true);
    expect(started.vendors.filter((v) => v.running || v.queued).map((v) => v.vendor)).toEqual([
      'claude',
      'codex',
    ]);
    await service.settled();
    expect(order).toEqual(['claude', 'codex']);
    expect(Object.keys(service.results()).sort()).toEqual(['claude', 'codex']);
    expect(service.results().codex?.cli_version).toBe('0.50.0');
    expect(service.status().running).toBe(false);
    // A restart reads them back.
    expect(new VendorCheckService({ home }).load().results()).toEqual(service.results());
    await expect(service.run('gemini')).rejects.toThrow('not on PATH');
  }, 60_000);

  test('the automatic trigger: once per new CLI version, never when manual', async () => {
    const store = fakeStore(undefined);
    const service = new VendorCheckService({
      home,
      store,
      vendors: ['claude', 'codex'],
      missing: () => undefined,
      provider: (v) => fakeProvider(v, { steps: [{ type: 'end_turn' }] }),
      cliVersion: () => '2.3.1',
    });
    expect(service.noteVersions([{ vendor: 'claude', version: '2.3.1' }], 'new_version')).toEqual([
      'claude',
    ]);
    // Seen again while it runs, and after: no second check for that version.
    expect(service.noteVersions([{ vendor: 'claude', version: '2.3.1' }], 'new_version')).toEqual(
      [],
    );
    await service.settled();
    expect(service.results().claude).toMatchObject({
      cli_version: '2.3.1',
      reason: 'new_version',
      by: 'daemon',
    });
    expect(service.noteVersions([{ vendor: 'claude', version: '2.3.1' }], 'update')).toEqual([]);
    // A restarted daemon with that version's check on file doesn't check it again either.
    const restarted = new VendorCheckService({
      home,
      store,
      missing: () => undefined,
      provider: (v) => fakeProvider(v, { steps: [{ type: 'end_turn' }] }),
    }).load();
    expect(restarted.noteVersions([{ vendor: 'claude', version: '2.3.1' }], 'new_version')).toEqual(
      [],
    );
    // Manual: nothing runs on its own.
    await service.setMode('manual');
    expect(service.status().mode).toBe('manual');
    expect(service.noteVersions([{ vendor: 'codex', version: '0.51.0' }], 'update')).toEqual([]);
    expect(service.status().running).toBe(false);
    // Auto again: a new version after an update is checked, with the reason.
    await service.setMode('auto');
    expect(service.noteVersions([{ vendor: 'codex', version: '0.51.0' }], 'update')).toEqual([
      'codex',
    ]);
    await service.settled();
    expect(service.results().codex?.reason).toBe('update');
  }, 60_000);
});

describe('VendorCheckService.stop (T489)', () => {
  test('the daemon stopping stops the running vendor and nothing queued starts', async () => {
    const service = new VendorCheckService({
      home,
      vendors: ['claude', 'codex'],
      missing: () => undefined,
      provider: (v) => fakeProvider(v, { steps: [{ type: 'hang' }] }),
      promptTimeoutMs: 20_000,
    });
    const run = service.run(undefined);
    const outcome = run.then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    // Wait until Claude's prompt is in flight.
    for (let i = 0; i < 200 && service.status().vendors[0]?.running !== true; i++) {
      await Bun.sleep(20);
    }
    await Bun.sleep(300);
    service.stop();
    expect(await outcome).toBe('the daemon is stopping: the check did not run');
    const claude = service.results().claude;
    expect(claude?.prompt.outcome).toBe('failed');
    expect(service.results().codex).toBeUndefined();
  }, 30_000);
});

describe('vendorCapabilities (T489)', () => {
  test('the latest per vendor; Choose leaves out one that kept its own model, not one that refused the pick', () => {
    const caps = vendorCapabilities([
      result('cursor', '2026-09-30T08:00:00.000Z'),
      result('cursor', '2026-09-30T09:00:00.000Z', { model: { outcome: 'kept' } }),
      result('grok', '2026-09-30T09:00:00.000Z', { model: { outcome: 'refused' } }),
      result('codex', '2026-09-30T09:00:00.000Z'),
      result('gemini', '2026-09-30T09:00:00.000Z', { model: { outcome: 'not_applicable' } }),
    ]);
    expect(caps.cursor?.model).toBe('kept');
    expect([...vendorsLeftOut(caps)]).toEqual([
      ['cursor', 'left out Cursor: its last check kept its own model'],
    ]);
    expect(caps.grok?.model).toBe('refused');
    expect(vendorsLeftOut({}).size).toBe(0);
  });
});
