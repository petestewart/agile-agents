/**
 * T467 (D46): the per-vendor model catalog, built from the sessions'
 * `session-state.json` files and kept in memory, and Refresh (a vendor
 * spawned with no prompt) against the real `fake-agent.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, type AcpProviderConfig } from '@agile-agents/acp-client';
import { type SessionVendor, ulid } from '@agile-agents/shared';
import type { FakeAgentScript } from './fake-agent';
import { ModelCatalog, sessionVendorIndex } from './model-catalog';
import { SESSION_STATE_FILE } from './session';
import { vendorModelOption } from './vendor-models';

const FAKE_AGENT_PATH = join(import.meta.dir, 'fake-agent.ts');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-models-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A session dir with a session-state file, `ms` after the epoch (its ULID sorts by it). */
function writeState(ms: number, state: Record<string, unknown>): string {
  const id = ulid(ms);
  mkdirSync(join(home, 'sessions', id), { recursive: true });
  writeFileSync(join(home, 'sessions', id, SESSION_STATE_FILE), JSON.stringify(state));
  return id;
}

function modelOption(current: string, values: Array<[string, string]>): Record<string, unknown> {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: current,
    options: values.map(([value, name]) => ({ value, name })),
  };
}

/** Grok's reply as measured (LIVE-CHECKLIST §12): the current model is not in its list. */
const GROK_STATE = {
  at: '2026-09-29T10:50:49.514Z',
  modes: null,
  configOptions: [modelOption('grok-4.5', [['grok-4.7', 'Grok 4.7']])],
  models: {
    currentModelId: 'grok-4.5',
    availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }],
  },
};

describe('vendorModelOption', () => {
  test("configOptions' model entry wins over ACP's models (Codex lists model × effort pairs there)", () => {
    const option = vendorModelOption({
      configOptions: [
        modelOption('agent', [['agent', 'Approve for me']]),
        modelOption('gpt-6-astra', [
          ['gpt-6-astra', 'GPT-6-Astra'],
          ['gpt-5.5', 'GPT-5.5'],
        ]),
      ].map((o, i) => (i === 0 ? { ...o, id: 'mode', category: 'mode' } : o)),
      models: {
        currentModelId: 'gpt-6-astra[low]',
        availableModels: [{ modelId: 'gpt-6-astra[low]', name: 'GPT-6-Astra (low)' }],
      },
    });
    expect(option).toEqual({
      configId: 'model',
      current: 'gpt-6-astra',
      options: [
        { value: 'gpt-6-astra', name: 'GPT-6-Astra' },
        { value: 'gpt-5.5', name: 'GPT-5.5' },
      ],
    });
  });

  test("ACP's models is the fallback, with no option id to set it through", () => {
    expect(
      vendorModelOption({
        configOptions: null,
        models: {
          currentModelId: 'm1',
          availableModels: [{ modelId: 'm1', name: 'Model one', description: 'fast' }],
        },
      }),
    ).toEqual({
      current: 'm1',
      options: [{ value: 'm1', name: 'Model one', description: 'fast' }],
    });
  });

  test('grouped options are flattened; an entry with no name reads as its value', () => {
    const option = vendorModelOption({
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'a',
          options: [
            { group: 'g', name: 'Group', options: [{ value: 'a' }, { value: 'b', name: 'B' }] },
          ],
        },
      ],
    });
    expect(option?.options).toEqual([
      { value: 'a', name: 'a' },
      { value: 'b', name: 'B' },
    ]);
  });

  test('none: no model entry, or one with no options (the old fake agent), or no list at all', () => {
    expect(vendorModelOption({ configOptions: null, models: null })).toBeUndefined();
    expect(
      vendorModelOption({ configOptions: [{ id: 'model', currentValue: 'fake/model-1' }] }),
    ).toBeUndefined();
    expect(vendorModelOption(null)).toBeUndefined();
  });
});

describe('ModelCatalog.load', () => {
  test("each vendor's list is its newest session's; a reply with none falls back to an older one", () => {
    writeState(1_000, {
      at: '2026-09-28T10:00:00.000Z',
      vendor: 'cursor',
      configOptions: [modelOption('default[]', [['default[]', 'Auto']])],
    });
    const newest = writeState(3_000, {
      at: '2026-09-29T10:00:00.000Z',
      vendor: 'cursor',
      configOptions: [
        modelOption('default[]', [
          ['default[]', 'Auto'],
          ['grok-4.7[fast=true]', 'grok-4.7'],
        ]),
      ],
    });
    // Newer still, but its reply named no models: it doesn't erase the list.
    writeState(4_000, { at: '2026-09-29T11:00:00.000Z', vendor: 'cursor', configOptions: null });
    const grok = writeState(2_000, { ...GROK_STATE, vendor: 'grok' });
    // A corrupt file is skipped, not fatal.
    const bad = ulid(5_000);
    mkdirSync(join(home, 'sessions', bad), { recursive: true });
    writeFileSync(join(home, 'sessions', bad, SESSION_STATE_FILE), '{not json');

    const catalog = new ModelCatalog({ home }).load();
    expect(catalog.get('cursor')).toEqual({
      options: [
        { value: 'default[]', name: 'Auto' },
        { value: 'grok-4.7[fast=true]', name: 'grok-4.7' },
      ],
      current: 'default[]',
      at: '2026-09-29T10:00:00.000Z',
      session: newest,
    });
    // Grok's current model stays on record, though its list lacks it.
    expect(catalog.get('grok')).toMatchObject({
      current: 'grok-4.5',
      options: [{ value: 'grok-4.7', name: 'Grok 4.7' }],
      session: grok,
    });
    expect(Object.keys(catalog.all()).sort()).toEqual(['cursor', 'grok']);
  });

  test('a file from before files named their vendor is mapped through the session records', () => {
    const id = writeState(1_000, {
      at: '2026-09-29T10:49:32.639Z',
      configOptions: [
        modelOption('claude-sonnet-4-6', [
          ['default', 'Default (recommended)'],
          ['opus[1m]', 'Opus 5.5'],
          ['sonnet', 'Sonnet'],
        ]),
      ],
      models: null,
    });
    const orphan = writeState(2_000, GROK_STATE);
    const vendorOfSession = sessionVendorIndex({
      list: () => [{ sessions: [{ id, vendor: 'claude' }] }],
    });
    const catalog = new ModelCatalog({ home, vendorOfSession }).load();
    expect(catalog.get('claude')?.options.map((o) => o.name)).toEqual([
      'Default (recommended)',
      'Opus 5.5',
      'Sonnet',
    ]);
    // No vendor in the file and no record: nobody's list.
    expect(catalog.get('grok')).toBeUndefined();
    expect(orphan).toBeString();
  });

  test('an empty home, or none at all, is an empty catalog', () => {
    expect(new ModelCatalog({ home }).load().all()).toEqual({});
    expect(new ModelCatalog({ home: join(home, 'missing') }).load().all()).toEqual({});
  });

  test('record: a session that just opened replaces the list in memory', () => {
    const catalog = new ModelCatalog({ home }).load();
    catalog.record('grok', { ...GROK_STATE, vendor: 'grok' }, 's1');
    catalog.record('nope', GROK_STATE);
    catalog.record('grok', { configOptions: null }, 's2');
    expect(catalog.get('grok')?.session).toBe('s1');
    expect(Object.keys(catalog.all())).toEqual(['grok']);
  });
});

describe('ModelCatalog.refresh (T467)', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'agile-models-scratch-'));
  });
  afterEach(() => {
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

  test('opens a session with no prompt (authenticating first), keeps its reply, stops the vendor', async () => {
    const log = join(scratch, 'refresh.jsonl');
    const catalog = new ModelCatalog({
      home,
      provider: (vendor) =>
        fakeProvider(vendor, {
          steps: [{ type: 'end_turn' }],
          logFile: log,
          requireAuthMethod: 'cursor_login',
          modelOption: {
            current: 'default[]',
            options: [
              { value: 'default[]', name: 'Auto' },
              { value: 'gpt-5.5[context=272k]', name: 'gpt-5.5' },
            ],
          },
        }),
    });
    const listed = await catalog.refresh('cursor');
    expect(listed?.options.map((o) => o.name)).toEqual(['Auto', 'gpt-5.5']);
    expect(catalog.get('cursor')).toEqual(listed);
    // Its reply is in a session dir of its own, naming its vendor, so a restart reads it back.
    const file = join(home, 'sessions', listed?.session as string, SESSION_STATE_FILE);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      vendor: 'cursor',
      source: 'session/new',
    });
    expect(new ModelCatalog({ home }).load().get('cursor')?.options).toEqual(listed?.options);
    // Authenticated, never prompted.
    const methods = readFileSync(log, 'utf8')
      .split('\n')
      .slice(0, -1)
      .map((l) => (JSON.parse(l) as { method: string }).method);
    expect(methods).toEqual(['authenticate']);
  }, 20_000);

  test('a vendor whose reply names no models: resolves undefined, the catalog unchanged', async () => {
    const catalog = new ModelCatalog({
      home,
      provider: (vendor) => fakeProvider(vendor, { steps: [], bareSessionNew: true }),
    });
    expect(await catalog.refresh('gemini')).toBeUndefined();
    expect(catalog.all()).toEqual({});
  }, 20_000);

  test('a vendor that cannot open a session: rejects with why, in words', async () => {
    const catalog = new ModelCatalog({
      home,
      provider: (vendor) => ({
        ...fakeProvider(vendor, { steps: [], requireAuthMethod: 'someone-else' }),
        authMethods: ['grok.com'],
      }),
    });
    await expect(catalog.refresh('grok')).rejects.toThrow('Grok CLI did not open a session');
    expect(existsSync(join(home, 'sessions'))).toBe(true);
  }, 20_000);
});
