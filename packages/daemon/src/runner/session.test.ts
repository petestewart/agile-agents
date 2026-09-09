import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACP_PROVIDERS,
  type AcpProviderConfig,
  type SpawnSessionOptions,
  spawnSession as realSpawnSession,
} from '@agile-agents/acp-client';
import type { Ticket } from '@agile-agents/shared';
import { validateSprint, validateTicket } from '@agile-agents/shared';
import { Bus } from '../bus';
import { runInit } from '../init';
import { ForeignPiExtensionError } from '../pi';
import { StateStore } from '../store';
import type { FakeAgentScript } from './fake-agent';
import { type AgentSessionHandle, startAgentSession } from './session';

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

describe('startAgentSession', () => {
  // Consolidated into one spawned session (registration, ledger, tool_call
  // event, and permission forwarding) — real-subprocess tests are the
  // heaviest in this suite (each spawns a real `bun` process), so this
  // covers the wiring end to end without multiplying spawns per assertion.
  // Role-specific *policy* differences (allow vs. deny, by role) are T010's
  // own exhaustive test surface (`permissions/responder.test.ts`); this only
  // needs to prove the forwarding wiring works, once.
  //
  // Timeout justification: 90s bounds one real `bun <fake-agent.ts>` spawn
  // plus the handshake/prompt/permission round trip and the final teardown
  // wait — generous headroom for this sandbox's measured worst-case
  // subprocess-start/exit latency under full-suite CPU contention (a clean,
  // idle run finishes in ~1-2s).
  test('registers the agent, ledgers a usage_update, logs a tool_call, forwards a permission request, and cleans up on stop', async () => {
    // `done` — a non-live status, so the exit-handling path below must NOT
    // ripple the ticket back to `ready` (see the next test for that path).
    await store.putTicket(makeTicket({ status: 'done' }), { by: 'test' });
    const resultFile = join(scratch, 'perm-result.json');

    const handle = startTrackedSession({
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
    // Event-driven: the fake agent writes `resultFile` only after it has
    // received the daemon's actual permission answer (see fake-agent.ts's
    // `request_permission` step) — polling for that file is polling for the
    // real side effect the test cares about, not a guessed settle time.
    await waitFor(() => existsSync(resultFile));
    const outcome = JSON.parse(readFileSync(resultFile, 'utf8'));
    // Engineer editing inside its own worktree — allow_once (T010 policy).
    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });

    await store.flush();
    const agent = store.getAgent('eng-0231');
    expect(agent.role).toBe('engineer');
    expect(agent.worktree).toBe(worktree);
    expect(agent.vendor).toBe('claude');
    // T012 QA round fix: the recorded pid is the fake agent's own OS pid,
    // not the daemon's/test's own — see `session.ts`'s registration and
    // `@agile-agents/acp-client`'s `SpawnedSession.pid`.
    expect(handle.session.pid).not.toBeNull();
    expect(agent.pid).toBe(handle.session.pid as number);
    expect(agent.pid).not.toBe(process.pid);

    const ledger = store.listLedger('S-01');
    expect(ledger.some((l) => l.kind === 'engineer' && l.in_tokens === 120)).toBe(true);

    const events = store.listEvents();
    // T012 QA round fix: a dedicated `tool_call` EventKind, not the earlier
    // round's `entity_put` stand-in.
    expect(
      events.some(
        (e) =>
          e.kind === 'tool_call' &&
          e.ticket === 'TKT-0231' &&
          e.agent === 'eng-0231' &&
          (e.data as Record<string, unknown>).toolCallId === 't1',
      ),
    ).toBe(true);

    handle.stop();
    const info = await handle.exited;
    expect(info.ticketReadied).toBe(false); // ticket already had no live-status-losing condition to flip — see next test for the readied path
    expect(() => store.getAgent('eng-0231')).toThrow();
  }, 90000);

  test('a graceful stop while the ticket is in_progress transitions it back to ready and escalates to em', async () => {
    await store.putTicket(makeTicket({ status: 'in_progress' }), { by: 'test' });

    const handle = startTrackedSession({
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
    // Event-driven: wait for registration to actually land (the real
    // precondition for "the agent is up") instead of a blind settle sleep.
    await waitFor(() => {
      try {
        store.getAgent('eng-0231');
        return true;
      } catch {
        return false;
      }
    });

    handle.stop();
    const info = await handle.exited;
    expect(info.ticketReadied).toBe(true);
    expect(store.getTicket('TKT-0231').status).toBe('ready');

    const inbox = bus.poll('em');
    expect(inbox.some((m) => m.kind === 'escalate' && m.ticket === 'TKT-0231')).toBe(true);
  }, 90000);

  // T012 QA round finding: a usage_update before any sprint exists used to
  // be silently dropped (no ledger line, no log).
  test('a usage_update with no resolvable sprint files the ledger line under `nosprint` and logs `ledger_no_sprint`', async () => {
    await store.putTicket(makeTicket({ status: 'done' }), { by: 'test' });

    const handle = startTrackedSession({
      store,
      bus,
      role: 'engineer',
      agentId: 'eng-0231',
      ticket: 'TKT-0231',
      worktreePath: worktree,
      brief: 'do the ticket',
      currentSprintId: () => undefined, // no sprint resolvable, regardless of the seeded S-01
      provider: fakeProvider({
        steps: [{ type: 'usage_update', used: 42 }, { type: 'end_turn' }],
      }),
    });

    await handle.session.initialized;
    await waitFor(() => store.listLedger('nosprint' as never).length > 0);
    await store.flush();

    const ledger = store.listLedger('nosprint' as never);
    expect(ledger.some((l) => l.sprint === 'nosprint' && l.in_tokens === 42)).toBe(true);

    const events = store.listEvents();
    expect(
      events.some(
        (e) => e.kind === 'ledger_no_sprint' && e.ticket === 'TKT-0231' && e.agent === 'eng-0231',
      ),
    ).toBe(true);

    handle.stop();
    await handle.exited;
  }, 90000);

  // T022: Pi has no ACP-level hook, so `startAgentSession` installs the
  // `agile` Pi extension and sets its gate env var itself, only for a
  // `provider.id === 'pi'` session — this proves the branch fires (and
  // fires with the right args) without touching the real `~/.pi/agent`
  // (the `installPiExtension`/`piAgentDir` test seams) or needing a real
  // `pi`/`pi-acp` process (the fake-agent ACP harness stands in, same as
  // every other test in this file).
  test('a pi-provider session installs the agile extension', async () => {
    await store.putTicket(makeTicket({ status: 'done' }), { by: 'test' });

    const calls: unknown[] = [];
    const provider = fakeProvider({ steps: [{ type: 'end_turn' }] });
    const piProvider = { ...provider, id: 'pi' as const };

    const handle = startTrackedSession({
      store,
      bus,
      role: 'engineer',
      agentId: 'eng-0231',
      ticket: 'TKT-0231',
      worktreePath: worktree,
      brief: 'do the ticket',
      currentSprintId: () => 'S-01',
      provider: piProvider,
      piAgentDir: join(scratch, 'pi-agent-dir'),
      installPiExtension: (opts) => {
        calls.push(opts);
        return {
          extensionPath: join(opts.agentDir, 'extensions', 'agile.ts'),
          settingsPath: join(opts.agentDir, 'settings.json'),
          extensionWritten: true,
          settingsWritten: true,
        };
      },
    });

    await handle.session.initialized;
    expect(calls).toHaveLength(1);
    expect((calls[0] as { agentDir: string }).agentDir).toBe(join(scratch, 'pi-agent-dir'));
    expect((calls[0] as { extensionSource: string }).extensionSource).toContain(
      'createAgileExtension',
    );
    // Real filesystem untouched — the fake `installPiExtension` above never
    // wrote anything under `piAgentDir`.
    expect(existsSync(join(scratch, 'pi-agent-dir'))).toBe(false);

    handle.stop();
    await handle.exited;
  }, 90000);

  // Round 2 review fix (B2/B3): a foreign extension file is the one
  // install failure that's load-bearing enough to still block the spawn —
  // proven here at the `startAgentSession` call site, not just inside
  // `install.ts` (session.test.ts:317's happy path already covers the fake
  // install being called with the right args).
  test('a ForeignPiExtensionError from installPiExtension blocks the spawn (fatal, not swallowed)', async () => {
    await store.putTicket(makeTicket({ status: 'done' }), { by: 'test' });
    const provider = { ...fakeProvider({ steps: [{ type: 'end_turn' }] }), id: 'pi' as const };

    expect(() =>
      startAgentSession({
        store,
        bus,
        role: 'engineer',
        agentId: 'eng-0231',
        ticket: 'TKT-0231',
        worktreePath: worktree,
        brief: 'do the ticket',
        currentSprintId: () => 'S-01',
        provider,
        piAgentDir: join(scratch, 'pi-agent-dir'),
        installPiExtension: () => {
          throw new ForeignPiExtensionError(
            join(scratch, 'pi-agent-dir', 'extensions', 'agile.ts'),
          );
        },
      }),
    ).toThrow(ForeignPiExtensionError);
  });

  // A non-Foreign install failure is also surfaced (not silently
  // swallowed) — session.ts's B3 try/catch only exists to add context, not
  // to hide a real failure of the load-bearing extension write.
  test('a non-Foreign installPiExtension failure still blocks the spawn, wrapped with context', async () => {
    await store.putTicket(makeTicket({ status: 'done' }), { by: 'test' });
    const provider = { ...fakeProvider({ steps: [{ type: 'end_turn' }] }), id: 'pi' as const };

    expect(() =>
      startAgentSession({
        store,
        bus,
        role: 'engineer',
        agentId: 'eng-0231',
        ticket: 'TKT-0231',
        worktreePath: worktree,
        brief: 'do the ticket',
        currentSprintId: () => 'S-01',
        provider,
        piAgentDir: join(scratch, 'pi-agent-dir'),
        installPiExtension: () => {
          throw new Error('disk full');
        },
      }),
    ).toThrow(/eng-0231.*disk full|disk full.*eng-0231/s);
  });
});

describe('T027: per-vendor session wiring (Cursor ask mode, Grok client-fs gate, Cursor/Grok authenticate retry)', () => {
  /** Wraps the real `spawnSession` so a test can inspect the exact `SpawnSessionOptions` `startAgentSession` built, while still exercising a real subprocess/handshake underneath (never a hand-rolled `SpawnedSession` stub). */
  function capturingSpawn(sink: { options?: SpawnSessionOptions }): typeof realSpawnSession {
    return (options: SpawnSessionOptions) => {
      sink.options = options;
      return realSpawnSession(options);
    };
  }

  // T027 round 2: `validModes` on the script makes the fake agent reject
  // any mode id outside Cursor's real advertised set (§C2 `agent | plan |
  // ask`) exactly like `cursor-agent acp` would — this is the harness the
  // round 1 reviewer used to catch `modeId: 'default'` going out to every
  // vendor. `fakeProviderFor(ACP_PROVIDERS.cursor, ...)` asserts against
  // the actually-registered Cursor provider, not a value this test invents.
  test('a Cursor reviewer gets modeId "ask" and no fsImpl; a Cursor engineer gets its own "agent" default, not Claude\'s "default"', async () => {
    await store.putTicket(makeTicket({ status: 'done' }), { by: 'test' });
    const cursorValidModes = ['agent', 'plan', 'ask'];
    const reviewerSink: { options?: SpawnSessionOptions } = {};
    const reviewerHandle = startTrackedSession({
      store,
      bus,
      role: 'reviewer',
      agentId: 'reviewer-0231',
      ticket: 'TKT-0231',
      worktreePath: worktree,
      brief: 'review it',
      currentSprintId: () => 'S-01',
      provider: fakeProviderFor(ACP_PROVIDERS.cursor, {
        validModes: cursorValidModes,
        steps: [{ type: 'end_turn' }],
      }),
      spawn: capturingSpawn(reviewerSink),
    });
    await reviewerHandle.session.initialized;
    expect(reviewerSink.options?.modeId).toBe('ask');
    expect(reviewerSink.options?.fsImpl).toBeUndefined();
    reviewerHandle.stop();
    await reviewerHandle.exited;

    const engineerSink: { options?: SpawnSessionOptions } = {};
    const engineerHandle = startTrackedSession({
      store,
      bus,
      role: 'engineer',
      agentId: 'eng-0231',
      ticket: 'TKT-0231',
      worktreePath: worktree,
      brief: 'do it',
      currentSprintId: () => 'S-01',
      provider: fakeProviderFor(ACP_PROVIDERS.cursor, {
        validModes: cursorValidModes,
        steps: [{ type: 'usage_update', used: 3 }, { type: 'end_turn' }],
      }),
      spawn: capturingSpawn(engineerSink),
    });
    await engineerHandle.session.initialized;
    expect(engineerSink.options?.modeId).toBe('agent');
    expect(engineerSink.options?.fsImpl).toBeUndefined();
    // The prompt actually succeeded against the mode-validating fake (a
    // rejected `session/set_mode` would never reach this usage_update).
    await waitFor(() => store.listLedger('S-01').some((l) => l.in_tokens === 3));
    engineerHandle.stop();
    await engineerHandle.exited;
  }, 90000);

  // T027 round 2: Grok's `validModes` is left unset — deliberately, since
  // Grok has no modes at all (§C2) — so if `session.ts` ever sent a
  // `modeId` for Grok again, this would only catch it via the `logFile`
  // assertion below (a mode-less fake accepts anything), which is why the
  // logFile check is the one doing the real work here.
  test("a Grok reviewer gets an fsImpl whose writeFile refuses with a reasoned AGILE-GATE message; a Grok engineer's fsImpl.writeFile still writes; neither sends session/set_mode", async () => {
    await store.putTicket(makeTicket({ status: 'done' }), { by: 'test' });
    const reviewerLogFile = join(scratch, 'grok-reviewer-log.jsonl');
    const reviewerSink: { options?: SpawnSessionOptions } = {};
    const reviewerHandle = startTrackedSession({
      store,
      bus,
      role: 'reviewer',
      agentId: 'reviewer-0231',
      ticket: 'TKT-0231',
      worktreePath: worktree,
      brief: 'review it',
      currentSprintId: () => 'S-01',
      provider: fakeProviderFor(ACP_PROVIDERS.grok, {
        logFile: reviewerLogFile,
        steps: [{ type: 'end_turn' }],
      }),
      spawn: capturingSpawn(reviewerSink),
    });
    await reviewerHandle.session.initialized;
    expect(reviewerSink.options?.modeId).toBeUndefined();
    expect(reviewerSink.options?.fsImpl).toBeDefined();
    await expect(
      reviewerSink.options?.fsImpl?.writeFile(join(worktree, 'notes.md'), 'x', 'utf8'),
    ).rejects.toThrow(/AGILE-GATE: reviewer may not write files/);
    reviewerHandle.stop();
    await reviewerHandle.exited;
    // `appendLog` only creates the file when it's actually called — its
    // absence here is the proof no `session/set_mode` (or `authenticate`)
    // request was ever sent for Grok.
    expect(existsSync(reviewerLogFile)).toBe(false);

    const engineerSink: { options?: SpawnSessionOptions } = {};
    const engineerHandle = startTrackedSession({
      store,
      bus,
      role: 'engineer',
      agentId: 'eng-0231',
      ticket: 'TKT-0231',
      worktreePath: worktree,
      brief: 'do it',
      currentSprintId: () => 'S-01',
      provider: fakeProviderFor(ACP_PROVIDERS.grok, { steps: [{ type: 'end_turn' }] }),
      spawn: capturingSpawn(engineerSink),
    });
    await engineerHandle.session.initialized;
    expect(engineerSink.options?.modeId).toBeUndefined();
    const path = join(worktree, 'a.ts');
    await engineerSink.options?.fsImpl?.writeFile(path, 'content', 'utf8');
    expect(readFileSync(path, 'utf8')).toBe('content');
    engineerHandle.stop();
    await engineerHandle.exited;
  }, 90000);

  // T027 round 2 (review round 1 B1): the fix's other half — a mode
  // rejection (or any first-prompt failure) must fail the spawn loudly
  // rather than stranding an `in_progress` ticket with a live-but-idle
  // subprocess. Deliberately sends an unsupported mode id
  // (`fakeProviderFor`'s Cursor entry with a `validModes` set that excludes
  // its own `defaultModeId`) to simulate the exact regression round 1
  // found, and asserts the daemon recovers: ticket back to `ready`, an
  // `escalate` to em, and the subprocess actually stopped (not left
  // running with a never-delivered brief).
  test('a rejected session/set_mode fails the spawn loudly: ticket readied, em escalated, subprocess stopped', async () => {
    await store.putTicket(makeTicket({ status: 'in_progress' }), { by: 'test' });

    const handle = startTrackedSession({
      store,
      bus,
      role: 'engineer',
      agentId: 'eng-0231',
      ticket: 'TKT-0231',
      worktreePath: worktree,
      brief: 'do the ticket',
      currentSprintId: () => 'S-01',
      provider: fakeProviderFor(
        { ...ACP_PROVIDERS.cursor, defaultModeId: 'default' }, // wrong on purpose
        { validModes: ['agent', 'plan', 'ask'], steps: [{ type: 'end_turn' }] },
      ),
    });

    const info = await handle.exited;
    expect(info.ticketReadied).toBe(true);
    expect(info.reason).toContain('first prompt failed');
    expect(store.getTicket('TKT-0231').status).toBe('ready');

    const inbox = await bus.poll('em' as never);
    expect(
      inbox.some(
        (m) =>
          m.kind === 'escalate' && m.ticket === 'TKT-0231' && /first prompt failed/.test(m.body),
      ),
    ).toBe(true);

    const events = store.listEvents();
    expect(
      events.some(
        (e) =>
          e.kind === 'agent_put' &&
          e.agent === 'eng-0231' &&
          /first prompt failed/.test(String((e.data as Record<string, unknown>).warning ?? '')),
      ),
    ).toBe(true);
  }, 90000);

  // T027: exercises the real production path — a real subprocess whose
  // `session/new` fails with the -32000 `AuthRequiredError` shape until
  // `authenticate(methodId)` runs (design/spike-findings.md §C2/§D), proving
  // `promptWithAuthRetry` actually calls `session.authenticate` for every
  // `provider.authMethods` id and retries the same brief, rather than just
  // asserting the helper's shape in isolation.
  test('AuthRequiredError from session/new triggers authenticate(methodId) then a successful retried prompt', async () => {
    await store.putTicket(makeTicket({ status: 'done' }), { by: 'test' });
    const logFile = join(scratch, 'auth-log.jsonl');
    const provider: AcpProviderConfig = {
      ...fakeProvider({
        requireAuthMethod: 'cursor_login',
        logFile,
        steps: [{ type: 'usage_update', used: 7 }, { type: 'end_turn' }],
      }),
      id: 'cursor',
      authMethods: ['cursor_login'],
    };

    const handle = startTrackedSession({
      store,
      bus,
      role: 'engineer',
      agentId: 'eng-0231',
      ticket: 'TKT-0231',
      worktreePath: worktree,
      brief: 'do the ticket',
      currentSprintId: () => 'S-01',
      provider,
    });

    await handle.session.initialized;
    // The retried prompt's usage_update landing in the ledger is the real
    // side effect that proves the whole retry round trip worked, not just
    // that `authenticate` was called.
    await waitFor(() => store.listLedger('S-01').some((l) => l.in_tokens === 7));
    await waitFor(() => existsSync(logFile));
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('"method":"authenticate"');
    expect(log).toContain('cursor_login');

    handle.stop();
    await handle.exited;
  }, 90000);
});

describe('T034: vendor ACP session spawns keep the operator\'s real HOME (never the daemon\'s sandboxed one)', () => {
  test('startAgentSession never sets an env/envOverrides.HOME for the vendor spawn', async () => {
    await store.putTicket(makeTicket({ status: 'done' }), { by: 'test' });
    const sink: { options?: SpawnSessionOptions } = {};

    const handle = startTrackedSession({
      store,
      bus,
      role: 'engineer',
      agentId: 'eng-0231',
      ticket: 'TKT-0231',
      worktreePath: worktree,
      brief: 'do it',
      currentSprintId: () => 'S-01',
      provider: fakeProvider({ steps: [{ type: 'end_turn' }] }),
      spawn: (options: SpawnSessionOptions) => {
        sink.options = options;
        return realSpawnSession(options);
      },
    });
    await handle.session.initialized;

    // No override at all — `resolveAgentEnv` (acp-client) then defaults to
    // this process's own `process.env`, which is the daemon operator's
    // real `HOME`. T034 sandboxes every *other* daemon subprocess (test
    // runners, git, the docker probe); a vendor CLI needs its own real
    // login/session store, so this is the one spawn site that must keep
    // it — see `resolveAgentEnv`'s own doc comment in
    // `packages/acp-client/src/session.ts`.
    expect(sink.options?.env).toBeUndefined();
    expect(sink.options?.envOverrides?.HOME).toBeUndefined();
    expect(sink.options?.envOverrides?.XDG_CACHE_HOME).toBeUndefined();

    handle.stop();
    await handle.exited;
  }, 90000);
});
