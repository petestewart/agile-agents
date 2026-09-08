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
import { validateHalt } from './halt';
import { validateKbFact } from './kb';
import { validateLedgerLine } from './ledger';
import { validateMessage } from './message';
import { validateOracleEntry } from './oracle';
import { validatePolicy } from './policy';
import { validateSprint } from './sprint';
import { validateStanza } from './stanza';
import { validateTicket } from './ticket';
import { validateToolDefinition } from './tool';
import { validateQuota, validateVendorsConfig } from './vendors';

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__');

function loadYaml(name: string): unknown {
  return parseYaml(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

describe('design doc fixtures parse (§4–§5)', () => {
  test('OracleEntry — §4 Oracle', () => {
    expect(() => validateOracleEntry(loadYaml('oracle-entry.yaml'))).not.toThrow();
  });

  test('KbFact — §4 Knowledge store', () => {
    expect(() => validateKbFact(loadYaml('kb-fact.yaml'))).not.toThrow();
  });

  test('Ticket — §4 Ticket', () => {
    expect(() => validateTicket(loadYaml('ticket.yaml'))).not.toThrow();
  });

  // stanza.json is verbatim from §4 "Board" except `kind` and
  // `discovery.tier`, whose design values are pipe-separated enum
  // illustrations; substituted with one concrete legal value each (kept
  // consistent: kind "discovery" pairs with a discovery block). JSON has no
  // comment syntax, so — unlike the yaml fixtures — that note lives here
  // rather than in the fixture file.
  test('Stanza — §4 Board', () => {
    expect(() => validateStanza(loadJson('stanza.json'))).not.toThrow();
  });

  test('Halt — §4 Halts (constructed from prose, no literal block)', () => {
    expect(() => validateHalt(loadYaml('halt.yaml'))).not.toThrow();
  });

  test('Sprint — §4 Sprint', () => {
    expect(() => validateSprint(loadYaml('sprint.yaml'))).not.toThrow();
  });

  test('Sprint — §15/§16 team + gates override', () => {
    expect(() => validateSprint(loadYaml('sprint-with-team-and-gates.yaml'))).not.toThrow();
  });

  test('Policy — §16 HIL gates policy', () => {
    expect(() => validatePolicy(loadYaml('policy.yaml'))).not.toThrow();
  });

  test('VendorsConfig — §8 Adapter contract / Auth', () => {
    expect(() => validateVendorsConfig(loadYaml('vendors.yaml'))).not.toThrow();
  });

  test('Quota — §4 Quota', () => {
    expect(() => validateQuota(loadYaml('quota.yaml'))).not.toThrow();
  });

  test('ToolDefinition — §7 Tool framework', () => {
    expect(() => validateToolDefinition(loadYaml('tool.yaml'))).not.toThrow();
  });

  // ledger-line.json is verbatim from §4 "Ledger" except `kind` (a
  // pipe-separated enum illustration there too), substituted with one
  // concrete legal value. Same JSON-has-no-comments note as stanza.json above.
  test('LedgerLine — §4 Ledger', () => {
    expect(() => validateLedgerLine(loadJson('ledger-line.json'))).not.toThrow();
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
