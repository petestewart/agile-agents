import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OracleEntry, Ticket, TicketContract } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { runInit } from '../init';
import { IllegalTransitionError, StateStore } from '../store';
import { RefineValidationError, reRefineStale, refineTicket } from './refine';

let repo: string;
let store: StateStore;

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(r.stderr)}`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-refine-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['commit', '--allow-empty', '-q', '-m', 'init'], repo);
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function contract(overrides: Partial<TicketContract> = {}): TicketContract {
  return {
    inputs: [],
    outputs: [],
    acceptance: ['does the thing'],
    done: [],
    env: 'clone',
    ...overrides,
  };
}

function makeTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return validateTicket({
    id,
    title: `Ticket ${id}`,
    status: 'draft',
    contract: contract({ acceptance: [] }),
    history: [],
    ...overrides,
  });
}

async function seedEntry(id: string, overrides: Partial<OracleEntry> = {}): Promise<void> {
  await store.putOracleEntry(
    {
      id: id as OracleEntry['id'],
      title: id,
      status: 'active',
      supersedes: [],
      depends: [],
      affects: [],
      decided: '2026-09-08',
      by: 'architect',
      rationale: 'seed',
      ...overrides,
    },
    'seed body',
  );
}

describe('refineTicket', () => {
  test('refuses an empty acceptance list', async () => {
    await store.putTicket(makeTicket('TKT-0001'));
    await expect(refineTicket(store, 'TKT-0001', { contract: { acceptance: [] } })).rejects.toThrow(
      RefineValidationError,
    );
  });

  test('refuses a dangling oracle_ref', async () => {
    await store.putTicket(makeTicket('TKT-0001'));
    await expect(
      refineTicket(store, 'TKT-0001', {
        contract: { acceptance: ['x'] },
        oracle_refs: ['DEC-9999'],
      }),
    ).rejects.toThrow(RefineValidationError);
  });

  test('readies a draft ticket once refined with a resolvable oracle_ref', async () => {
    await seedEntry('DEC-0001');
    await store.putTicket(makeTicket('TKT-0001'));
    const result = await refineTicket(store, 'TKT-0001', {
      contract: { acceptance: ['does the thing'] },
      oracle_refs: ['DEC-0001'],
    });
    expect(result.status).toBe('ready');
    expect(result.oracle_refs).toEqual(['DEC-0001']);
  });

  test('a ticket past draft stays at its current status (no forced ready)', async () => {
    await store.putTicket(makeTicket('TKT-0001', { status: 'stale', contract: contract() }));
    const result = await refineTicket(store, 'TKT-0001', { title: 'Renamed' });
    expect(result.status).toBe('stale');
    expect(result.title).toBe('Renamed');
  });
});

describe('reRefineStale — unchanged', () => {
  test('goes straight back to ready', async () => {
    await store.putTicket(makeTicket('TKT-0001', { status: 'stale', contract: contract() }));
    const result = await reRefineStale(store, 'TKT-0001', { kind: 'unchanged' });
    expect(result.parent.status).toBe('ready');
    expect(result.children).toEqual([]);
  });

  test('throws IllegalTransitionError from a non-stale ticket', async () => {
    await store.putTicket(makeTicket('TKT-0001', { status: 'ready', contract: contract() }));
    await expect(reRefineStale(store, 'TKT-0001', { kind: 'unchanged' })).rejects.toThrow(
      IllegalTransitionError,
    );
  });
});

describe('reRefineStale — split', () => {
  test('mints child tickets, parent readied but depends-blocked on them', async () => {
    await store.putTicket(
      makeTicket('TKT-0001', { status: 'stale', contract: contract(), depends: [] }),
    );
    const result = await reRefineStale(store, 'TKT-0001', {
      kind: 'split',
      children: [
        { title: 'Half A', contract: contract({ acceptance: ['a'] }) },
        { title: 'Half B', contract: contract({ acceptance: ['b'] }) },
      ],
    });
    expect(result.children).toHaveLength(2);
    expect(result.children.map((c) => c.status)).toEqual(['ready', 'ready']);
    expect(result.parent.status).toBe('ready');
    expect(result.parent.depends).toEqual(result.children.map((c) => c.id));
    // Minted ids don't collide with the parent's own id.
    expect(new Set(result.children.map((c) => c.id)).has('TKT-0001')).toBe(false);
  });

  test('a child with no acceptance criteria refuses the whole split', async () => {
    await store.putTicket(makeTicket('TKT-0001', { status: 'stale', contract: contract() }));
    await expect(
      reRefineStale(store, 'TKT-0001', {
        kind: 'split',
        children: [{ title: 'Bad half', contract: contract({ acceptance: [] }) }],
      }),
    ).rejects.toThrow(RefineValidationError);
  });
});

describe('reRefineStale — refactor_child', () => {
  test('commits worktree WIP and mints a child ticket pointing at it', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'agile-refine-wip-'));
    git(['init', '-q'], worktree);
    git(['config', 'user.email', 'test@example.com'], worktree);
    git(['config', 'user.name', 'Test'], worktree);
    git(['commit', '--allow-empty', '-q', '-m', 'init'], worktree);
    writeFileSync(join(worktree, 'dirty.txt'), 'wip content\n');

    await store.putTicket(makeTicket('TKT-0001', { status: 'stale', contract: contract() }));
    const result = await reRefineStale(store, 'TKT-0001', {
      kind: 'refactor_child',
      worktreeDir: worktree,
      childTitle: 'Extract the refactor',
      childContract: contract({ acceptance: ['refactor lands'] }),
    });

    expect(result.wipCommit).toBeDefined();
    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.history[0]).toContain(result.wipCommit);
    expect(result.parent.status).toBe('ready');
    expect(result.parent.depends).toEqual(result.children.map((c) => c.id));

    rmSync(worktree, { recursive: true, force: true });
  });

  test('a clean worktree mints the child without a WIP commit', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'agile-refine-clean-'));
    git(['init', '-q'], worktree);
    git(['config', 'user.email', 'test@example.com'], worktree);
    git(['config', 'user.name', 'Test'], worktree);
    git(['commit', '--allow-empty', '-q', '-m', 'init'], worktree);

    await store.putTicket(makeTicket('TKT-0001', { status: 'stale', contract: contract() }));
    const result = await reRefineStale(store, 'TKT-0001', {
      kind: 'refactor_child',
      worktreeDir: worktree,
      childTitle: 'Extract the refactor',
      childContract: contract({ acceptance: ['refactor lands'] }),
    });

    expect(result.wipCommit).toBeUndefined();
    expect(result.children).toHaveLength(1);

    rmSync(worktree, { recursive: true, force: true });
  });
});
