import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ticket } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import {
  INTEGRATION_BRANCH,
  ensureIntegrationBranch,
  ensureQaClone,
  ensureTicketWorktree,
  slugify,
  ticketBranch,
  ticketBranchName,
} from './worktrees';

let repo: string;

function git(args: string[], cwd = repo): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return validateTicket({
    id: 'TKT-0231',
    title: 'Agent runner and worktree manager',
    status: 'assigned',
    contract: {},
    history: [],
    ...overrides,
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-runner-worktrees-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('slugify / ticketBranchName', () => {
  test('kebab-cases and caps at 40 chars', () => {
    expect(slugify('Agent runner and worktree manager')).toBe('agent-runner-and-worktree-manager');
    expect(slugify('A'.repeat(60)).length).toBeLessThanOrEqual(40);
  });

  test('branch name is tkt/<digits>-<slug>', () => {
    expect(ticketBranchName(makeTicket())).toBe('tkt/0231-agent-runner-and-worktree-manager');
  });
});

describe('ensureIntegrationBranch', () => {
  test('creates integration off the current branch when missing', () => {
    const before = Bun.spawnSync(
      ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${INTEGRATION_BRANCH}`],
      { cwd: repo },
    );
    expect(before.exitCode).not.toBe(0);
    ensureIntegrationBranch(repo);
    const head = git(['rev-parse', INTEGRATION_BRANCH]);
    expect(head).toBe(git(['rev-parse', 'HEAD']));
  });

  test('is a no-op when integration already exists', () => {
    ensureIntegrationBranch(repo);
    const before = git(['rev-parse', INTEGRATION_BRANCH]);
    writeFileSync(join(repo, 'b.txt'), 'x');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'second']);
    ensureIntegrationBranch(repo);
    expect(git(['rev-parse', INTEGRATION_BRANCH])).toBe(before);
  });
});

describe('ensureTicketWorktree', () => {
  test('creates .worktrees/<TKT-id> on tkt/<digits>-<slug> off integration', () => {
    const ticket = makeTicket();
    const result = ensureTicketWorktree(repo, ticket);
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(repo, '.worktrees', 'TKT-0231'));
    expect(result.branch).toBe('tkt/0231-agent-runner-and-worktree-manager');
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(join(result.path, 'README.md'))).toBe(true);
  });

  test('reuses an existing worktree on a second call (fix cycle)', () => {
    const ticket = makeTicket();
    const first = ensureTicketWorktree(repo, ticket);
    writeFileSync(join(first.path, 'work-in-progress.txt'), 'wip');
    const second = ensureTicketWorktree(repo, ticket);
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    expect(existsSync(join(second.path, 'work-in-progress.txt'))).toBe(true);
  });
});

describe('a title edit after the worktree exists (architect re-refine)', () => {
  test('ensureTicketWorktree, ticketBranch and ensureQaClone all keep the branch the worktree is on', () => {
    const first = ensureTicketWorktree(repo, makeTicket());
    const renamed = makeTicket({ title: 'Agent runner and worktree manager (stable on ties)' });
    // The pure name moved...
    expect(ticketBranchName(renamed)).not.toBe(first.branch);
    // ...but nothing that operates on the existing worktree may follow it.
    const second = ensureTicketWorktree(repo, renamed);
    expect(second.created).toBe(false);
    expect(second.branch).toBe(first.branch);
    expect(ticketBranch(repo, renamed)).toBe(first.branch);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], second.path)).toBe(first.branch);
    const qa = ensureQaClone(repo, renamed);
    expect(qa.branch).toBe(first.branch);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], qa.path)).toBe(first.branch);
  });

  test('ticketBranch falls back to the creation name when there is no worktree yet', () => {
    const ticket = makeTicket();
    expect(ticketBranch(repo, ticket)).toBe(ticketBranchName(ticket));
  });
});

describe('ensureQaClone', () => {
  test('clones a fresh checkout at .worktrees/<TKT-id>-qa off the ticket branch', () => {
    const ticket = makeTicket();
    ensureTicketWorktree(repo, ticket); // engineer already ran
    const result = ensureQaClone(repo, ticket);
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(repo, '.worktrees', 'TKT-0231-qa'));
    expect(existsSync(join(result.path, 'README.md'))).toBe(true);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], result.path)).toBe(result.branch);
  });

  test('creates the ticket branch off integration when no engineer has run yet', () => {
    const ticket = makeTicket();
    const result = ensureQaClone(repo, ticket);
    expect(existsSync(result.path)).toBe(true);
  });

  test('reuses an existing clone on a second call', () => {
    const ticket = makeTicket();
    const first = ensureQaClone(repo, ticket);
    const second = ensureQaClone(repo, ticket);
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
  });
});

describe('T034: git spawns in this module are sandboxed, never the real $HOME', () => {
  test('ensureIntegrationBranch creates a sandboxed HOME under <repoRoot>/.agile-daemon-cache/git/', () => {
    ensureIntegrationBranch(repo);
    expect(existsSync(join(repo, '.agile-daemon-cache', 'git', 'home'))).toBe(true);
  });

  test('ensureTicketWorktree and ensureQaClone sandbox HOME under the repo root, not inside the worktree/clone', () => {
    const ticket = makeTicket();
    const worktree = ensureTicketWorktree(repo, ticket);
    const qa = ensureQaClone(repo, ticket);

    expect(existsSync(join(repo, '.agile-daemon-cache', 'git', 'home'))).toBe(true);
    expect(existsSync(join(worktree.path, '.agile-daemon-cache'))).toBe(false);
    expect(existsSync(join(qa.path, '.agile-daemon-cache'))).toBe(false);
  });
});
