import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTicket } from '@agile-agents/shared';
import { createHalt, releaseHalt } from '../halts';
import { runInit } from '../init';
import { ensureIntegrationBranch, ensureTicketWorktree } from '../runner/worktrees';
import { StateStore } from '../store';
import { checkCommitAllowed, installPreCommitHook } from './precommit';

let repo: string;
let stateRoot: string;
let store: StateStore;

function git(args: string[], cwd: string) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

function runGit(args: string[], cwd: string): string {
  const r = git(args, cwd);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-precommit-'));
  runGit(['init', '-q', '-b', 'main'], repo);
  runGit(['config', 'user.email', 'test@example.com'], repo);
  runGit(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  runGit(['add', '-A'], repo);
  runGit(['commit', '-q', '-m', 'init'], repo);
  ensureIntegrationBranch(repo);

  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const ticket = validateTicket({
  id: 'TKT-0500',
  title: 'Precommit hook fixture',
  status: 'assigned',
  contract: {},
  history: [],
});

describe('checkCommitAllowed', () => {
  test('allowed with no halt', async () => {
    await store.putTicket(ticket);
    expect(checkCommitAllowed(stateRoot, ticket.id)).toEqual({ allowed: true });
  });

  test('refused while a halt covers the ticket, naming the reason', async () => {
    await store.putTicket(ticket);
    await createHalt(store, {
      scope: [ticket.id],
      reason: 'rebase conflict onto integration: shared.txt',
      raised_by: 'daemon',
    });
    const result = checkCommitAllowed(stateRoot, ticket.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('shared.txt');
  });

  test('allowed again once released', async () => {
    await store.putTicket(ticket);
    const halt = await createHalt(store, {
      scope: [ticket.id],
      reason: 'temp halt',
      raised_by: 'daemon',
    });
    expect(checkCommitAllowed(stateRoot, ticket.id).allowed).toBe(false);
    await releaseHalt(store, halt.id);
    expect(checkCommitAllowed(stateRoot, ticket.id).allowed).toBe(true);
  });

  test('a global halt refuses every ticket', async () => {
    await store.putTicket(ticket);
    await createHalt(store, { scope: 'global', reason: 'stop everything', raised_by: 'architect' });
    expect(checkCommitAllowed(stateRoot, ticket.id).allowed).toBe(false);
  });

  test('fails closed for an invalid ticket id', () => {
    const result = checkCommitAllowed(stateRoot, 'not-a-ticket');
    expect(result.allowed).toBe(false);
  });

  test('fails closed when the state root does not exist', () => {
    const result = checkCommitAllowed(join(repo, 'no-such-agile-dir'), ticket.id);
    expect(result.allowed).toBe(false);
  });
});

describe('installPreCommitHook + real git commit', () => {
  test('refuses a commit while a halt covers the ticket, and allows it once released', async () => {
    await store.putTicket(ticket);
    const wt = ensureTicketWorktree(repo, ticket);
    installPreCommitHook(wt.path, ticket);
    // Review round 1: gitCommonDir's bootstrap `git rev-parse` no longer
    // uses `worktreePath` as its sandbox cache root (same class of issue
    // as B2 on config.ts) — nothing should land inside the worktree itself.
    expect(existsSync(join(wt.path, '.agile-daemon-cache'))).toBe(false);

    writeFileSync(join(wt.path, 'work.txt'), 'first change\n');
    runGit(['add', '-A'], wt.path);
    // No halt yet — commit succeeds.
    const before = git(['commit', '-q', '-m', 'work'], wt.path);
    expect(before.exitCode).toBe(0);

    const halt = await createHalt(store, {
      scope: [ticket.id],
      reason: 'blocked for the hook test',
      raised_by: 'daemon',
    });
    writeFileSync(join(wt.path, 'work.txt'), 'second change\n');
    runGit(['add', '-A'], wt.path);
    const duringHalt = git(['commit', '-q', '-m', 'more work'], wt.path);
    expect(duringHalt.exitCode).not.toBe(0);
    expect(duringHalt.stderr).toContain('blocked for the hook test');
    // The commit was actually refused, not merely warned about.
    expect(git(['status', '--porcelain=v1'], wt.path).stdout).not.toBe('');

    await releaseHalt(store, halt.id);
    const afterRelease = git(['commit', '-q', '-m', 'more work'], wt.path);
    expect(afterRelease.exitCode).toBe(0);
  });

  test('never blocks a commit on integration/main', async () => {
    installPreCommitHook(repo, ticket);
    writeFileSync(join(repo, 'unrelated.txt'), 'x\n');
    runGit(['add', '-A'], repo);
    const result = git(['commit', '-q', '-m', 'on main'], repo);
    expect(result.exitCode).toBe(0);
  });

  test('is idempotent — a second install with the same inputs is a byte-identical no-op write', () => {
    const wt = ensureTicketWorktree(repo, ticket);
    const first = installPreCommitHook(wt.path, ticket);
    expect(first.installed).toBe(true);
    const before = readFileSync(first.hookPath, 'utf8');
    const second = installPreCommitHook(wt.path, ticket);
    expect(second.installed).toBe(false);
    expect(second.hookPath).toBe(first.hookPath);
    expect(readFileSync(second.hookPath, 'utf8')).toBe(before);
  });
});
