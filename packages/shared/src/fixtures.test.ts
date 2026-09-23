/**
 * Loads every fixture under __fixtures__/ — copied (with the noted, minimal
 * substitutions for the design doc's inline pipe-union enum illustrations)
 * from design/agile-agents-design.md §4–§5 — and asserts it parses against
 * its schema. Acceptance criterion: "every example YAML/JSON block in the
 * design doc parses."
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateAgentRecord } from './agents';
import { validatePolicy } from './policy';
import { validateVendorsConfig } from './vendors';

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__');

function loadYaml(name: string): unknown {
  return parseYaml(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

describe('design doc fixtures parse (§4–§5)', () => {
  test('Policy — §16 HIL gates policy', () => {
    expect(() => validatePolicy(loadYaml('policy.yaml'))).not.toThrow();
  });

  test('VendorsConfig — §8 Adapter contract / Auth', () => {
    expect(() => validateVendorsConfig(loadYaml('vendors.yaml'))).not.toThrow();
  });

  test('AgentRecord — §5 Storage (constructed from prose, no literal block)', () => {
    expect(() => validateAgentRecord(loadYaml('agent-record.yaml'))).not.toThrow();
  });
});
