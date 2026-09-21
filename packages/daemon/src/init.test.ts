import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePolicy, validateReposConfig, validateVendorsConfig } from '@agile-agents/shared';
import { parse as parseYaml } from 'yaml';
import { recommendedVendorEntries, runInit } from './init';

let home: string;
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'agile-init-'));
  // A path that does not exist yet: `agile init` is "create the home if missing".
  home = join(scratch, 'home');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('runInit', () => {
  test('creates the state home at the given path', () => {
    const result = runInit(home);
    expect(result.home).toBe(home);
    expect(result.stateRoot).toBe(home);
    expect(existsSync(home)).toBe(true);
    expect(result.filesWritten.length).toBeGreaterThan(0);
  });

  test('never creates a .agile/ directory inside a repo (T111)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'agile-init-repo-'));
    try {
      Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
      runInit(home);
      expect(existsSync(join(repo, '.agile'))).toBe(false);
      // and no orphan state branch either
      const branches = Bun.spawnSync(['git', 'branch', '--list'], { cwd: repo, stdout: 'pipe' });
      expect(new TextDecoder().decode(branches.stdout)).not.toContain('agile-state');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('is idempotent: a second init writes nothing new', () => {
    runInit(home);
    expect(runInit(home).filesWritten).toEqual([]);
  });

  test('produces the home layout: dirs, empty indexes, policy.yaml, vendors.yaml, repos.yaml', () => {
    runInit(home);

    for (const relative of [
      'gates',
      'streams',
      'threads',
      'questions',
      'policy.yaml',
      'vendors.yaml',
      'repos.yaml',
      'tools',
      'rules',
      'log/events.jsonl',
      'bus/inbox',
      'bus/threads',
      'bus/agents',
    ]) {
      expect(existsSync(join(home, relative))).toBe(true);
    }

    const oracleIndex = parseYaml(readFileSync(join(home, 'oracle/index.yaml'), 'utf8'));
    expect(oracleIndex).toEqual({});
  });

  test('policy.yaml, vendors.yaml and repos.yaml validate against the shared schemas', () => {
    runInit(home);
    expect(() =>
      validatePolicy(parseYaml(readFileSync(join(home, 'policy.yaml'), 'utf8'))),
    ).not.toThrow();
    expect(() =>
      validateVendorsConfig(parseYaml(readFileSync(join(home, 'vendors.yaml'), 'utf8'))),
    ).not.toThrow();
    expect(validateReposConfig(parseYaml(readFileSync(join(home, 'repos.yaml'), 'utf8')))).toEqual(
      {},
    );
  });

  test('the shipped vendors.yaml default stays claude-only (T027)', () => {
    runInit(home);
    const vendors = validateVendorsConfig(
      parseYaml(readFileSync(join(home, 'vendors.yaml'), 'utf8')),
    );
    expect(Object.keys(vendors)).toEqual(['claude']);
  });

  test('recommendedVendorEntries (T027): cursor/grok/codex, keyed by ACP_PROVIDERS id, requires_sandbox on the ungated-exec vendors only', () => {
    const vendors = recommendedVendorEntries();

    expect(vendors.cursor?.accounts).toEqual([{ id: 'default', auth: 'subscription' }]);
    expect(vendors.cursor?.requires_sandbox).toBe(false);
    expect(vendors.grok?.accounts).toEqual([{ id: 'default', auth: 'subscription' }]);
    expect(vendors.grok?.requires_sandbox).toBe(true);
    expect(vendors.codex?.accounts).toEqual([{ id: 'default', auth: 'subscription' }]);
    expect(vendors.codex?.requires_sandbox).toBe(true);
    // Not the design §8 example's company-name key — `Runner.vendorConfigFor`
    // looks entries up by `ACP_PROVIDERS` id (`codex`), which `openai`
    // would never match.
    expect(vendors.openai).toBeUndefined();
    // Merging these into a running vendors.yaml alongside claude must still
    // validate as one VendorsConfig.
    expect(() =>
      validateVendorsConfig({
        claude: { accounts: [{ id: 'default', auth: 'subscription' }] },
        ...vendors,
      }),
    ).not.toThrow();
  });
});
