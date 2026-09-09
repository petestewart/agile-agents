import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_KB_FACT, FIXTURE_ORACLE_ENTRY, FIXTURE_TICKET } from '../briefs/fixtures';
import { runInit } from '../init';
import { StateStore } from '../store';
import { assembleBrief } from './brief';

let repo: string;
let stateRoot: string;
let store: StateStore;

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-runner-brief-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
  await store.putTicket(FIXTURE_TICKET, { by: 'architect' });
  await store.putKbFact(FIXTURE_KB_FACT, 'observed in prod, packages/api env');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('assembleBrief', () => {
  test('engineer brief renders with the repo policy and no rules appendix when none exist', () => {
    const text = assembleBrief({
      store,
      stateRoot,
      role: 'engineer',
      agent: 'eng-231',
      ticket: FIXTURE_TICKET,
    });
    expect(text).toContain('TKT-0231');
    expect(text).toContain('eng-231');
    expect(text).not.toContain('## Rules');
  });

  test('reviewer brief resolves kb_refs to KbFacts', () => {
    const text = assembleBrief({
      store,
      stateRoot,
      role: 'reviewer',
      agent: 'reviewer-231',
      ticket: FIXTURE_TICKET,
    });
    expect(text).toContain('TKT-0231');
    // ReviewerBriefContext's kbFacts don't render inline in reviewer.md
    // today (the template only lists ticket.oracle_refs by id), so this
    // asserts the call succeeds and doesn't throw on the stale/live kb_ref
    // resolution path — see the next test for a ref that doesn't resolve.
  });

  test('qa brief renders without needing policy or kb_refs', () => {
    const text = assembleBrief({
      store,
      stateRoot,
      role: 'qa',
      agent: 'qa-231',
      ticket: FIXTURE_TICKET,
    });
    expect(text).toContain('TKT-0231');
    expect(text).toContain('qa-231');
  });

  test('architect brief renders and resolves oracle_refs to OracleEntry bodies (T031)', async () => {
    await store.putOracleEntry(
      FIXTURE_ORACLE_ENTRY,
      'JWT chosen for statelessness across the edge fleet.',
    );
    const text = assembleBrief({
      store,
      stateRoot,
      role: 'architect',
      agent: 'architect',
      ticket: FIXTURE_TICKET,
    });
    expect(text).toContain('TKT-0231');
    expect(text).toContain('DEC-0042');
    // The stale ref (SPEC-auth-003, never seeded here) is skipped, not fatal.
  });

  test('a stale kb_ref is skipped rather than failing the whole brief', () => {
    const ticketWithBadRef = { ...FIXTURE_TICKET, kb_refs: ['KB-9999'] };
    expect(() =>
      assembleBrief({
        store,
        stateRoot,
        role: 'reviewer',
        agent: 'reviewer-231',
        ticket: ticketWithBadRef,
      }),
    ).not.toThrow();
  });

  test('.agile/rules/*.md are appended, sorted by filename', () => {
    mkdirSync(join(stateRoot, 'rules'), { recursive: true });
    writeFileSync(join(stateRoot, 'rules', 'RULE-002.md'), 'Second rule.');
    writeFileSync(join(stateRoot, 'rules', 'RULE-001.md'), 'First rule.');

    const text = assembleBrief({
      store,
      stateRoot,
      role: 'engineer',
      agent: 'eng-231',
      ticket: FIXTURE_TICKET,
    });
    expect(text).toContain('## Rules');
    expect(text.indexOf('First rule.')).toBeLessThan(text.indexOf('Second rule.'));
  });
});
