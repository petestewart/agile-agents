import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACP_PROVIDERS,
  type AcpProviderConfig,
  type SpawnSessionOptions,
  spawnSession as realSpawnSession,
} from '@agile-agents/acp-client';
import type { Ticket } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { GateService } from '../gates';
import { runInit } from '../init';
import { ForeignPiExtensionError } from '../pi';
import { StateStore } from '../store';
import type { FakeAgentScript } from './fake-agent';
import { type AgentSessionHandle, openStderrLog, startAgentSession } from './session';

const FAKE_AGENT_PATH = join(import.meta.dir, 'fake-agent.ts');

let repo: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;
let worktree: string;
let scratch: string;
// T012 QA round fix: one fake agent per test, always killed in afterEach —
// even if the test body throws before reaching its own `handle.stop()`, so
// a failing assertion can never leak a live subprocess into later tests
// (a leaked `bun fake-agent.ts` process was the root cause of a real,
// reproduced full-suite slowdown; see the pipeline report).
let activeHandles: AgentSessionHandle[] = [];

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

/**
 * T027 round 2: like `fakeProvider`, but carries a *real* `ACP_PROVIDERS`
 * entry's non-transport fields (`defaultModeId`, `authMethods`,
 * `requiresSandbox`, ...) over the fake transport (command/args/env) — so a
 * test asserting "Cursor gets mode X" is asserting against the actual
 * registered Cursor config, not a value the test made up, which is exactly
 * what let `modeId: 'default'` (a Claude-only mode) ship for every vendor
 * in round 1 undetected.
 */
function fakeProviderFor(
  vendor: AcpProviderConfig,
  script: FakeAgentScript,
  pidFile?: string,
): AcpProviderConfig {
  const scriptPath = join(scratch, `${Bun.hash(JSON.stringify(script)).toString(36)}.json`);
  writeFileSync(scriptPath, JSON.stringify(script));
  return {
    ...vendor,
    command: 'bun',
    args: [FAKE_AGENT_PATH],
    envOverrides: {
      AGILE_FAKE_AGENT_SCRIPT: scriptPath,
      ...(pidFile ? { AGILE_FAKE_AGENT_PIDFILE: pidFile } : {}),
    },
  };
}

/** Wraps `startAgentSession` and registers the handle for forced teardown in `afterEach` — see `activeHandles`. */
function startTrackedSession(opts: Parameters<typeof startAgentSession>[0]): AgentSessionHandle {
  const handle = startAgentSession(opts);
  activeHandles.push(handle);
  return handle;
}

/**
 * Polls a real, checkable condition instead of a blind `Bun.sleep(N)` — the
 * event-driven alternative CLAUDE.md/QA round asked for wherever there's no
 * cheaper synchronous signal (an ACP notification, a resolved promise) to
 * await directly. Still bounded, so a genuinely broken condition fails
 * fast-ish rather than hanging to the outer test timeout.
 */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 20_000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await Bun.sleep(intervalMs);
  }
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
  activeHandles = [];
});

afterEach(async () => {
  // Force-kill anything still alive, regardless of whether the test's own
  // body reached its own `handle.stop()` — see `activeHandles`'s doc
  // comment. `exited` never rejects (session.ts's own contract), so this
  // can't itself hang; bound it anyway in case a future change breaks that.
  await Promise.all(
    activeHandles.map(async (handle) => {
      handle.stop();
      await Promise.race([handle.exited, Bun.sleep(15_000)]);
    }),
  );
  // Drain any pending deferred-commit writes (heartbeat/ledger/tool_call
  // events — see store.ts's "Deferred-commit batching" header) before the
  // repo is deleted; otherwise the background flush timer can fire a `git`
  // command against a directory that no longer exists.
  await store.flush();
  store.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});
