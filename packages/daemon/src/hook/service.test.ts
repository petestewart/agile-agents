import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, AgentRecord } from '@agile-agents/shared';
import { ulid } from '@agile-agents/shared';
import { Bus } from '../bus';
import { GateService } from '../gates';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { HookService } from './service';

const WORKER = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
const REVIEWER = '01ARZ3NDEKTSV4RRFFQ69G5FA2';
const QA_WORKER = '01ARZ3NDEKTSV4RRFFQ69G5FA3';

let repo: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;
let gates: GateService;
let worktree: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-hook-service-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
  bus = new Bus(store, stateRoot);
  gates = new GateService(store);

  worktree = join(repo, '.worktrees', 'TKT-0001');
  mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function service(
  overrides: Partial<ConstructorParameters<typeof HookService>[2]> = {},
): HookService {
  return new HookService(store, bus, { repoRoot: repo, ...overrides });
}

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    vendor: 'claude',
    model: 'claude-sonnet-4-5',
    stream: '01J9BBBBBBBBBBBBBBBBBBBBBB',
    pid: 4242,
    // Fresh by default — real "now" at fixture-construction time, not a
    // hardcoded past timestamp — so every existing test here stays "live"
    // under review round 3's staleness check (`resolveAgentByCwd` ignores a
    // registry entry whose `last_seen` is older than the bus's liveness
    // timeout) without having to inject a matching clock into every
    // `service()` call. Tests that need a genuinely stale record pass their
    // own `last_seen` override.
    last_seen: new Date().toISOString(),
    ...overrides,
  };
}

// T012 QA/review round: resolution rewritten to go through the agent
// registry (`AgentRecord.worktree`/`.role`) first, not just `Ticket.worktree`
// — see `service.ts`'s file header and `resolveAgentByCwd`.

// Round 4 (QA round 3 REJECT — a real regression, not a test-harness
// artifact): `buildContext`'s own `store.heartbeat` call was silently
// dropping `role`/`worktree`/`session_id` from the registry once
// `HEARTBEAT_COALESCE_MS` elapsed, decaying a reviewer to the engineer's
// permissive policy (and stranding QA with no resolvable identity) after
// roughly 30+ seconds of normal tool-call traffic. Fixed at the store level
// (`StateStore.heartbeat` now only ever touches `last_seen`/`stream`).
describe('HookService — heartbeat preserves agent identity across the coalescing window (T012 review round 4)', () => {
  test('role/worktree/session_id survive a hook heartbeat past the coalescing window, byte-for-byte', async () => {
    let now = new Date('2026-09-09T00:00:00.000Z');
    await store.putAgent(
      REVIEWER,
      agentRecord({
        role: 'reviewer',
        worktree,
        session_id: 'sess-reviewer',
        // Registered well before the simulated clock's start — otherwise
        // the coalescing check (`now - last_seen < 30s`) sees a *negative*
        // gap against the fixture's real-wall-clock default `last_seen`
        // and treats the first heartbeat below as still "recent", never
        // writing at all.
        last_seen: new Date(now.getTime() - 60_000).toISOString(),
      }),
    );
    const svc = service({ now: () => now });

    await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
      agile_agent: REVIEWER,
    });
    const before = store.getAgent(REVIEWER as never);
    expect(before.role).toBe('reviewer');
    expect(before.worktree).toBe(worktree);
    expect(before.session_id).toBe('sess-reviewer');

    // Past the 30s heartbeat-coalescing window — this is exactly the write
    // QA round 3 caught dropping role/worktree/session_id.
    now = new Date(now.getTime() + 31_000);
    await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: 'x.txt' },
      agile_agent: REVIEWER,
    });
    const after = store.getAgent(REVIEWER as never);
    expect(after.role).toBe(before.role);
    expect(after.worktree).toBe(before.worktree);
    expect(after.session_id).toBe(before.session_id);
    expect(after.vendor).toBe(before.vendor);
    expect(after.model).toBe(before.model);
    expect(after.pid).toBe(before.pid);
    expect(after.last_seen).not.toBe(before.last_seen);
  });

  test('reviewer Edit is still denied after 3 simulated heartbeat windows (injectable clock)', async () => {
    await store.putAgent(REVIEWER, agentRecord({ role: 'reviewer', worktree }));
    let now = new Date('2026-09-09T00:00:00.000Z');
    const svc = service({ now: () => now });

    // Three tool calls, each one heartbeat-coalescing window (30s) apart —
    // simulates a real reviewer session idling between tool calls at a
    // normal cadence, well past the point QA round 3 found the role gate
    // silently disappearing.
    for (let window = 0; window < 3; window++) {
      now = new Date(now.getTime() + 31_000);
      const result = await svc.preToolUse({
        cwd: worktree,
        tool_name: 'Edit',
        tool_input: { file_path: join(worktree, 'a.ts') },
        agile_agent: REVIEWER,
      });
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(
        /reviewer role denies all writes/,
      );
    }
    const record = store.getAgent(REVIEWER as never);
    expect(record.role).toBe('reviewer');
    expect(record.worktree).toBe(worktree);
  });

  test('a worker keeps resolvable identity (worktree) after 3 simulated heartbeat windows', async () => {
    const qaWorktree = join(repo, '.worktrees', 'TKT-0001-qa');
    mkdirSync(qaWorktree, { recursive: true });
    await store.putAgent(QA_WORKER, agentRecord({ role: 'worker', worktree: qaWorktree }));
    let now = new Date('2026-09-09T00:00:00.000Z');
    const svc = service({ now: () => now });

    for (let window = 0; window < 3; window++) {
      now = new Date(now.getTime() + 31_000);
      const result = await svc.preToolUse({
        cwd: qaWorktree,
        tool_name: 'Bash',
        tool_input: { command: 'bun test' },
        agile_agent: QA_WORKER,
      });
      // A worker may run the repo's own test command — the regression QA
      // round 3 found made this DENY with "cwd is not a
      // registered stream worktree" once `worktree` was dropped.
      expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
    }
    expect(store.getAgent(QA_WORKER as never).worktree).toBe(qaWorktree);
  });
});

// T017 review round (opus blocker 2): end-to-end through the real
// HookService.preToolUse — not just decide.ts's pure function — proving
// `buildContext` actually resolves and forwards `ctx.denyReadPaths` for a
// QA session, and that a Claude ABSOLUTE `file_path` under the clone is
// correctly matched against the ticket's repo-relative contract globs.

// T125: the daemon no longer derives a repo root from its own cwd
// (`config.ts`), so `HookService` may be built without one. A *relative*
// `worktree` on an agent record then has nothing to resolve against, and the
// hook path's first rule applies — "unresolvable ⇒ DENY" (cockpit design
// §8.1, fail closed). The alternative, resolving it against whatever
// directory `agiled` happened to be started in, would authorize a tool call
// from a directory nobody registered.
describe('HookService without a repoRoot (T125)', () => {
  test('a relative worktree is unresolvable and denies, rather than resolving against the daemon cwd', async () => {
    await store.putAgent(WORKER, agentRecord({ role: 'worker', worktree: '.worktrees/TKT-0001' }));
    const svc = new HookService(store, bus, {});

    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: join(worktree, 'README.md') },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(
      /not a registered stream worktree/,
    );
  });

  test('an absolute worktree still resolves without a repoRoot', async () => {
    await store.putAgent(WORKER, agentRecord({ role: 'worker', worktree }));
    const svc = new HookService(store, bus, {});

    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: join(worktree, 'README.md') },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

// T229: a corrupt repos.yaml fails the visibility check closed, naming the file.
describe('HookService — unreadable repos.yaml (T229)', () => {
  test('a read outside the worktree is denied with the repos.yaml error', async () => {
    await store.putAgent(WORKER, agentRecord({ role: 'worker', worktree }));
    writeFileSync(join(stateRoot, 'repos.yaml'), 'repos: [::not yaml\n');
    const svc = service();

    const outside = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: join(repo, 'README.md') },
    });
    expect(outside.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(outside.hookSpecificOutput.permissionDecisionReason).toContain('repos.yaml');

    const inside = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Read',
      tool_input: { file_path: join(worktree, 'x.ts') },
    });
    expect(inside.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

describe('HookService read scope (T213)', () => {
  test('Bash reads reach a registered public repo but not a private one', async () => {
    const other = mkdtempSync(join(tmpdir(), 'agile-hook-other-'));
    const secret = mkdtempSync(join(tmpdir(), 'agile-hook-secret-'));
    try {
      await store.putRepos({
        other: { path: other, protected_branches: ['main'] },
        secret: {
          path: secret,
          protected_branches: ['main'],
          visibility: { mode: 'private', projects: [`P-${ulid()}`] },
        },
      });
      await store.putAgent(WORKER, agentRecord({ role: 'worker', worktree }));
      const bash = (command: string) =>
        service().preToolUse({ cwd: worktree, tool_name: 'Bash', tool_input: { command } });

      expect((await bash(`ls -la ${other}`)).hookSpecificOutput.permissionDecision).toBe('allow');
      expect((await bash(`cat ${secret}/a.ts`)).hookSpecificOutput.permissionDecision).toBe('deny');
      expect((await bash(`touch ${other}/x`)).hookSpecificOutput.permissionDecision).toBe('deny');
    } finally {
      rmSync(other, { recursive: true, force: true });
      rmSync(secret, { recursive: true, force: true });
    }
  });
});

describe('HookService read scope for a conversation node (T330)', () => {
  test('from its session dir: registered repos yes, the agile home and an unlisted private repo no', async () => {
    const other = mkdtempSync(join(tmpdir(), 'agile-hook-other-'));
    const secret = mkdtempSync(join(tmpdir(), 'agile-hook-secret-'));
    const shared = mkdtempSync(join(tmpdir(), 'agile-hook-shared-'));
    try {
      const streams = new StreamService(store);
      const project = await new ProjectService(store, streams).create({ name: 'Shop' });
      const node = await streams.create('human', { title: 'Plan', goal: 'g', project: project.id });
      await store.putRepos({
        'ledger-lite': { path: other, protected_branches: ['main'] },
        secret: {
          path: secret,
          protected_branches: ['main'],
          visibility: { mode: 'private', projects: [`P-${ulid()}`] },
        },
        shared: {
          path: shared,
          protected_branches: ['main'],
          visibility: { mode: 'private', projects: [project.id] },
        },
      });
      // A conversation runs in its session dir under the home (attach/service.ts).
      const sessionDir = join(stateRoot, 'sessions', WORKER);
      mkdirSync(sessionDir, { recursive: true });
      await store.putAgent(
        WORKER,
        agentRecord({ role: 'worker', stream: node.id, worktree: sessionDir }),
      );
      const hook = service({ agileHome: stateRoot });
      const read = async (file_path: string) =>
        (await hook.preToolUse({ cwd: sessionDir, tool_name: 'Read', tool_input: { file_path } }))
          .hookSpecificOutput.permissionDecision;
      const bash = async (command: string) =>
        (await hook.preToolUse({ cwd: sessionDir, tool_name: 'Bash', tool_input: { command } }))
          .hookSpecificOutput.permissionDecision;

      expect(await read(join(other, 'README.md'))).toBe('allow');
      expect(await read(join(shared, 'a.ts'))).toBe('allow');
      expect(await bash(`ls ${other}`)).toBe('allow');
      expect(await read(join(sessionDir, 'notes.md'))).toBe('allow');
      expect(await read(join(stateRoot, 'config.yaml'))).toBe('deny');
      expect(await bash(`cat ${stateRoot}/config.yaml`)).toBe('deny');
      expect(await read(join(secret, 'a.ts'))).toBe('deny');
      // Writes stay in the session dir.
      expect(await bash(`touch ${other}/x`)).toBe('deny');
    } finally {
      for (const dir of [other, secret, shared]) rmSync(dir, { recursive: true, force: true });
    }
  });
});
