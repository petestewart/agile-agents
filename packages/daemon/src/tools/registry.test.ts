import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init';
import { ToolRegistryError, loadToolRegistry } from './registry';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-tool-registry-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('loadToolRegistry', () => {
  test('returns [] when .agile/tools does not exist', () => {
    expect(loadToolRegistry(join(repo, '.agile'))).toEqual([]);
  });

  test('loads the two seeded starter tools from a real `agile init`', () => {
    const init = runInit(repo);
    const tools = loadToolRegistry(init.stateRoot);
    const names = tools.map((t) => t.definition.name).sort();
    expect(names).toEqual(['read_summary', 'test_run']);

    const readSummary = tools.find((t) => t.definition.name === 'read_summary');
    expect(readSummary?.definition.ledger_kind).toBe('reader');
    expect(readSummary?.definition.cache?.key).toEqual(['file_hash', 'question']);
    expect(readSummary?.prompt.length).toBeGreaterThan(0);

    const testRun = tools.find((t) => t.definition.name === 'test_run');
    expect(testRun?.definition.ledger_kind).toBe('reader');
    expect(testRun?.definition.runner.tier).toBe('trivial');
  });

  test('a directory with no tool.yaml is skipped, not an error', () => {
    const init = runInit(repo);
    mkdirSync(join(init.stateRoot, 'tools', 'empty-dir'), { recursive: true });
    const tools = loadToolRegistry(init.stateRoot);
    expect(tools.map((t) => t.definition.name).sort()).toEqual(['read_summary', 'test_run']);
  });

  test('rejects an invalid tool.yaml (fails schema validation)', () => {
    const init = runInit(repo);
    const dir = join(init.stateRoot, 'tools', 'broken');
    mkdirSync(dir, { recursive: true });
    // Missing required fields (`runner`, `ledger_kind`, ...) — invalid ToolDefinition.
    writeFileSync(join(dir, 'tool.yaml'), 'name: broken\nkind: reader\n');
    expect(() => loadToolRegistry(init.stateRoot)).toThrow(ToolRegistryError);
  });

  test('rejects a tool.yaml with malformed YAML', () => {
    const init = runInit(repo);
    const dir = join(init.stateRoot, 'tools', 'badyaml');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tool.yaml'), 'name: [unterminated\n');
    expect(() => loadToolRegistry(init.stateRoot)).toThrow(ToolRegistryError);
  });

  test('rejects a tool.yaml whose name does not match its directory', () => {
    const init = runInit(repo);
    const dir = join(init.stateRoot, 'tools', 'mismatched');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'tool.yaml'),
      [
        'name: something_else',
        'kind: reader',
        'trigger:',
        '  hook: pre-tool-use',
        '  match: "true"',
        'action: redirect',
        'runner:',
        '  tier: trivial',
        '  max_output_tokens: 100',
        'ledger_kind: reader',
      ].join('\n'),
    );
    expect(() => loadToolRegistry(init.stateRoot)).toThrow(ToolRegistryError);
  });
});
