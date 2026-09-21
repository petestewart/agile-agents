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
import { validateMessage } from './message';
import { validatePolicy } from './policy';
import { validateTicket } from './ticket';
import { validateToolDefinition } from './tool';
import { validateVendorsConfig } from './vendors';

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__');

function loadYaml(name: string): unknown {
  return parseYaml(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

describe('design doc fixtures parse (§4–§5)', () => {
  test('Ticket — §4 Ticket', () => {
    expect(() => validateTicket(loadYaml('ticket.yaml'))).not.toThrow();
  });

  test('Policy — §16 HIL gates policy', () => {
    expect(() => validatePolicy(loadYaml('policy.yaml'))).not.toThrow();
  });

  test('VendorsConfig — §8 Adapter contract / Auth', () => {
    expect(() => validateVendorsConfig(loadYaml('vendors.yaml'))).not.toThrow();
  });

  test('ToolDefinition — §7 Tool framework', () => {
    expect(() => validateToolDefinition(loadYaml('tool.yaml'))).not.toThrow();
  });

  test('Message — §5 Comms bus / Message', () => {
    expect(() => validateMessage(loadYaml('message.yaml'))).not.toThrow();
  });

  test('AgentRecord — §5 Storage (constructed from prose, no literal block)', () => {
    expect(() => validateAgentRecord(loadYaml('agent-record.yaml'))).not.toThrow();
  });

  test('Ticket — §13 contract.env compose form, on-disk (quoted, since unquoted "compose: <path>" is not valid yaml)', () => {
    expect(() => validateTicket(loadYaml('ticket-compose-env.yaml'))).not.toThrow();
  });
});
