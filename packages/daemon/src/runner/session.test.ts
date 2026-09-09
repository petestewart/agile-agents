import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcpProviderConfig } from '@agile-agents/acp-client';
import type { Ticket } from '@agile-agents/shared';
import { validateSprint, validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { runInit } from '../init';
import { StateStore } from '../store';
import type { FakeAgentScript } from './fake-agent';
import { startAgentSession } from './session';

const FAKE_AGENT_PATH = join(import.meta.dir, 'fake-agent.ts');

let repo: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;
let worktree: string;
let scratch: string;

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return validateTicket({
    id: 'TKT-0231',
    title: 'Agent runner and worktree manager',
    status: 'in_progress',
    contract: {},
    history: [],
    assignee: 'eng-0231',
    worktree: '.worktrees/TKT-0231',
    ...overrides,
  });
}

/** A `fake-agent.ts` provider, scripted per test via a JSON file dropped in `scratch`. */
function fakeProvider(script: FakeAgentScript, pidFile?: string): AcpProviderConfig {
  const scriptPath = join(scratch, `${Bun.hash(JSON.stringify(script)).toString(36)}.json`);
  writeFileSync(scriptPath, JSON.stringify(script));
  return {
    id: 'claude',
    label: 'fake',
    command: 'bun',
    args: [FAKE_AGENT_PATH],
    envOverrides: {
      AGILE_FAKE_AGENT_SCRIPT: scriptPath,
      ...(pidFile ? { AGILE_FAKE_AGENT_PIDFILE: pidFile } : {}),
    },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    loadSession: true,
    authMethods: [],
  };
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-runner-session-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
  bus = new Bus(store, stateRoot);

  worktree = join(repo, '.worktrees', 'TKT-0231');
  scratch = mkdtempSync(join(tmpdir(), 'agile-runner-scratch-'));

  await store.putSprint(
    validateSprint({
      id: 'S-01',
      goal: 'ship T012',
      tickets: ['TKT-0231'],
      budget_tokens: 100_000,
      started: '2026-09-07T00:00:00Z',
    }),
  );
});

afterEach(async () => {
  // Drain any pending deferred-commit writes (heartbeat/ledger/tool_call
  // events — see store.ts's "Deferred-commit batching" header) before the
  // repo is deleted; otherwise the background flush timer can fire a `git`
  // command against a directory that no longer exists.
  await store.flush();
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe('startAgentSession', () => {
  // Consolidated into one spawned session (registration, ledger, tool_call
  // event, and permission forwarding) — real-subprocess tests are the
  // heaviest in this suite (each spawns a real `bun` process), so this
  // covers the wiring end to end without multiplying spawns per assertion.
  // Role-specific *policy* differences (allow vs. deny, by role) are T010's
  // own exhaustive test surface (`permissions/responder.test.ts`); this only
  // needs to prove the forwarding wiring works, once.
  test('registers the agent, ledgers a usage_update, logs a tool_call, forwards a permission request, and cleans up on stop', async () => {
    // `done` — a non-live status, so the exit-handling path below must NOT
    // ripple the ticket back to `ready` (see the next test for that path).
    await store.putTicket(makeTicket({ status: 'done' }), { by: 'test' });
    const resultFile = join(scratch, 'perm-result.json');

    const handle = startAgentSession({
      store,
      bus,
      role: 'engineer',
      agentId: 'eng-0231',
      ticket: 'TKT-0231',
      worktreePath: worktree,
      brief: 'do the ticket',
      currentSprintId: () => 'S-01',
      provider: fakeProvider({
        steps: [
          { type: 'usage_update', used: 120 },
          { type: 'tool_call', toolCallId: 't1', kind: 'edit', title: 'Edit foo.ts' },
          { type: 'tool_call_update', toolCallId: 't1', status: 'completed' },
          {
            type: 'request_permission',
            toolCall: {
              toolCallId: 't2',
              kind: 'edit',
              rawInput: { file_path: join(worktree, 'foo.ts') },
            },
            options: [
              { optionId: 'allow-once', kind: 'allow_once' },
              { optionId: 'reject-once', kind: 'reject_once' },
            ],
            resultFile,
          },
          { type: 'end_turn' },
        ],
      }),
    });

    await handle.session.initialized;
    for (let i = 0; i < 500 && !existsSync(resultFile); i++) {
      await Bun.sleep(20);
    }
    const outcome = JSON.parse(readFileSync(resultFile, 'utf8'));
    // Engineer editing inside its own worktree — allow_once (T010 policy).
    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });

    await store.flush();
    const agent = store.getAgent('eng-0231');
    expect(agent.role).toBe('engineer');
    expect(agent.worktree).toBe(worktree);
    expect(agent.vendor).toBe('claude');

    const ledger = store.listLedger('S-01');
    expect(ledger.some((l) => l.kind === 'engineer' && l.in_tokens === 120)).toBe(true);

    const events = store.listEvents();
    expect(
      events.some(
        (e) =>
          e.kind === 'entity_put' &&
          (e.data as Record<string, unknown>).observation === 'tool_call',
      ),
    ).toBe(true);

    handle.stop();
    const info = await handle.exited;
    expect(info.ticketReadied).toBe(false); // ticket already had no live-status-losing condition to flip — see next test for the readied path
    expect(() => store.getAgent('eng-0231')).toThrow();
  }, 90000);

  test('a graceful stop while the ticket is in_progress transitions it back to ready and escalates to em', async () => {
    await store.putTicket(makeTicket({ status: 'in_progress' }), { by: 'test' });

    const handle = startAgentSession({
      store,
      bus,
      role: 'engineer',
      agentId: 'eng-0231',
      ticket: 'TKT-0231',
      worktreePath: worktree,
      brief: 'do the ticket',
      currentSprintId: () => 'S-01',
      provider: fakeProvider({ steps: [{ type: 'hang' }] }),
    });
    await handle.session.initialized;
    await Bun.sleep(100);

    handle.stop();
    const info = await handle.exited;
    expect(info.ticketReadied).toBe(true);
    expect(store.getTicket('TKT-0231').status).toBe('ready');

    const inbox = bus.poll('em');
    expect(inbox.some((m) => m.kind === 'escalate' && m.ticket === 'TKT-0231')).toBe(true);
  }, 90000);
});
