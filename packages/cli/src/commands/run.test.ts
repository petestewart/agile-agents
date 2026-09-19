/**
 * `agile run`'s pure helpers. The full loop is covered by
 * `../run.e2e.test.ts` (offline, fake ACP); this file is for the small
 * decisions around it that deserve their own cases.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT_MD_STUB } from '@agile-agents/daemon';
import { resolveSprintGoal } from './run';

describe('resolveSprintGoal (T046 defect 2)', () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), 'agile-run-goal-'));
    mkdirSync(join(stateRoot, 'oracle'), { recursive: true });
  });
  afterEach(() => rmSync(stateRoot, { recursive: true, force: true }));

  const writeBrief = (markdown: string) =>
    writeFileSync(join(stateRoot, 'oracle', 'product.md'), markdown);

  test("the seed's own sprintGoal wins", () => {
    writeBrief('# Ledger Lite\n\nA tiny ledger.\n');
    expect(resolveSprintGoal({ sprintGoal: 'Demo epic layer 1' }, stateRoot)).toBe(
      'Demo epic layer 1',
    );
  });

  test("falls back to the seed's product brief first heading", () => {
    expect(resolveSprintGoal({ productMd: '# Ledger Lite\n\nA tiny ledger.\n' }, stateRoot)).toBe(
      'Ledger Lite',
    );
  });

  test('falls back to the on-disk product brief when the seed has no brief', () => {
    writeBrief('# Ledger Lite\n\nA tiny double-entry ledger.\n');
    expect(resolveSprintGoal({}, stateRoot)).toBe('Ledger Lite');
  });

  test("the untouched `agile init` stub is not a goal — never announces '# Product'", () => {
    writeBrief(PRODUCT_MD_STUB);
    expect(resolveSprintGoal({}, stateRoot)).toBeUndefined();
    expect(resolveSprintGoal({ productMd: PRODUCT_MD_STUB }, stateRoot)).toBeUndefined();
  });

  test('no brief at all resolves to nothing (planSprint names it after the sprint id)', () => {
    expect(resolveSprintGoal({}, stateRoot)).toBeUndefined();
  });

  test('a brief with no heading resolves to nothing', () => {
    writeBrief('Just prose, no heading.\n');
    expect(resolveSprintGoal({}, stateRoot)).toBeUndefined();
  });

  test('leading blank lines and a deeper heading level still resolve', () => {
    writeBrief('\n\n## Ledger Lite — v0\n\nbody\n');
    expect(resolveSprintGoal({}, stateRoot)).toBe('Ledger Lite — v0');
  });
});
