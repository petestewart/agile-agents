import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { runInit } from '../init';
import { ensureIntegrationBranch, ensureTicketWorktree } from '../runner/worktrees';
import { StateStore } from '../store';
import { MergeOwner } from './owner';
import { buildMergeRpcMethods } from './rpc';

let repo: string;
let store: StateStore;
let bus: Bus;
let methods: Record<string, (params: unknown) => unknown>;

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-merge-rpc-'));
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  ensureIntegrationBranch(repo);
  // Leave `main`/`integration` un-checked-out anywhere so MergeOwner's own
  // `.worktrees/_integration`/`_main` can claim them (owner.test.ts's
  // "dev-feature" fixture documents why).
  git(['checkout', '-b', 'dev-feature'], repo);

  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  bus = new Bus(store, init.stateRoot);
  const owner = new MergeOwner(store, bus, repo, {
    runTests: () => ({ ok: true, summary: 'ok' }),
    gateApproved: () => ({ approved: true }),
  });
  methods = buildMergeRpcMethods(owner) as Record<string, (params: unknown) => unknown>;
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('merge.* RPC methods', () => {
  test('merge.status returns null for a ticket never merged', () => {
    expect(methods['merge.status']?.({ ticket: 'TKT-0900' })).toBeNull();
  });

  test('merge.status rejects a malformed ticket id', () => {
    expect(() => methods['merge.status']?.({ ticket: 'nope' })).toThrow(/must look like TKT-0231/);
  });

  test('merge.ticket merges a ready worktree, then merge.status reflects it', async () => {
    const ticket = validateTicket({
      id: 'TKT-0901',
      title: 'RPC fixture',
      status: 'done',
      assignee: 'eng-1',
      contract: {},
      history: [],
    });
    await store.putTicket(ticket);
    const wt = ensureTicketWorktree(repo, ticket);
    writeFileSync(join(wt.path, 'x.txt'), 'x\n');
    git(['add', '-A'], wt.path);
    git(['commit', '-q', '-m', 'work'], wt.path);

    const outcome = (await methods['merge.ticket']?.({ ticket: ticket.id })) as { status: string };
    expect(outcome.status).toBe('merged');

    const status = methods['merge.status']?.({ ticket: ticket.id }) as { status: string };
    expect(status.status).toBe('merged');
  });

  test('merge.integration_to_main merges when the gate is approved', async () => {
    const outcome = (await methods['merge.integration_to_main']?.(undefined)) as { status: string };
    expect(outcome.status).toBe('merged');
  });
});
