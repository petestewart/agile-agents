/**
 * T138 acceptance, against the real `fake-agent.ts` over a real ACP
 * transport — no vendor, no login, no network (design/cockpit-design.md
 * §8.1 route band, §3.1 `classifier_review`).
 *
 * The whole loop Pete's live run needed and did not have: a manifest edit
 * is denied and **routed** to the inbox as a `classifier_review` gate keyed
 * to the session and the call; the same call retried while the gate is open
 * reuses that gate rather than raising a second one; an approval prompts
 * the live session to retry and lets exactly that one call through once; a
 * different edit is still denied; a denial reaches the session with the
 * human's note.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, type AcpProviderConfig } from '@agile-agents/acp-client';
import type { HilId, HilRequest, InboxItem, Stream } from '@agile-agents/shared';
import { ulid, validateClassifierConfig, validateRule } from '@agile-agents/shared';
import { AttachService } from '../attach/service';
import { Bus } from '../bus';
import { FakeClassifier } from '../classifier';
import { GateService } from '../gates/service';
import { InboxService } from '../inbox/service';
import { runInit } from '../init';
import { QuestionService } from '../questions/service';
import type { FakeAgentScript } from '../runner/fake-agent';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { wireGateDecisionDelivery } from './route-band';
import { HookService } from './service';

const FAKE_AGENT_PATH = join(import.meta.dir, '..', 'runner', 'fake-agent.ts');

let home: string;
let repo: string;
let scratch: string;
let promptLog: string;
let sentinel: string;
let finishSentinel: string;
let store: StateStore;
let bus: Bus;
let streams: StreamService;
let questions: QuestionService;
let gates: GateService;
let hooks: HookService;
let inbox: InboxService;
let attachService: AttachService;

function git(args: string[], cwd = repo): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function fakeProviderFor(script: FakeAgentScript): AcpProviderConfig {
  const scriptPath = join(scratch, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(script));
  return {
    ...ACP_PROVIDERS.claude,
    command: 'bun',
    args: [FAKE_AGENT_PATH],
    envOverrides: { AGILE_FAKE_AGENT_SCRIPT: scriptPath },
  };
}

/**
 * What a real Claude session does with the deny: it makes the refused call,
 * says it is blocked pending the approval, and **ends its turn**. `sentinel`
 * is how the test decides when that turn ends. Turn two is the retry the
 * gate's decision prompts; it waits on `finishSentinel` so a test can hold
 * the session live for further hook calls, or let the turn end and watch the
 * session finish.
 *
 * Turns are serialized by the ACP client, so an idle session is also the
 * only state in which a second prompt is deliverable at all — a session
 * mid-turn queues it behind the turn it is already running, which is the
 * other half of why the turn-end rule has to keep this session alive.
 */
function workerScript(): FakeAgentScript {
  return {
    logFile: promptLog,
    turns: [
      [
        { type: 'agent_text', text: 'editing the manifest' },
        { type: 'tool_call', toolCallId: 'edit-1', title: 'edit package.json' },
        { type: 'wait_for_file', path: sentinel },
        { type: 'end_turn' },
      ],
      [
        { type: 'agent_text', text: 'retrying the edit' },
        // Long enough that the turn cannot end on its own inside a loaded
        // full-suite run — the test is what ends it, by touching the file.
        { type: 'wait_for_file', path: finishSentinel, timeoutMs: 60_000 },
        { type: 'end_turn' },
      ],
    ],
    steps: [{ type: 'hang' }],
  };
}

async function waitFor(
  predicate: () => boolean,
  // 40 s, not the usual few seconds: a full `bun test` run has a Playwright
  // browser and 100 other files competing for the CPU, and a real vendor
  // turn ending is a subprocess round trip. The test budget below is 90 s.
  { timeoutMs = 40_000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not met in ${timeoutMs}ms`);
    await Bun.sleep(intervalMs);
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-route-home-'));
  scratch = mkdtempSync(join(tmpdir(), 'agile-route-scratch-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-route-repo-'));
  promptLog = join(scratch, 'prompts.jsonl');
  sentinel = join(scratch, 'turn-one-ends.flag');
  finishSentinel = join(scratch, 'turn-two-ends.flag');
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);

  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  bus = new Bus(store, init.stateRoot);
  streams = new StreamService(store);
  gates = new GateService(store);
  questions = new QuestionService(store, streams, {
    deliver: (sessionId, question) => attachService.deliverAnswer(sessionId, question),
  });
  inbox = new InboxService({ streams, questions, gates });
  attachService = new AttachService({
    store,
    streams,
    home,
    provider: () => fakeProviderFor(workerScript()),
    questions: { listOpen: () => questions.listOpen() },
    // T138, as `daemon.ts` wires it: an open routed call is what keeps a
    // denied session alive at turn end.
    gates,
  });
  // Exactly `daemon.ts`'s wiring: the hook raises the gate, resolving it
  // prompts the session that is waiting on it.
  hooks = new HookService(store, bus, { gates });
  wireGateDecisionDelivery(gates, attachService);
});

afterEach(async () => {
  await attachService.stopAll();
  await store.flush();
  store.close();
  for (const dir of [home, repo, scratch]) rmSync(dir, { recursive: true, force: true });
});

/**
 * An attached, live worker session and the directory its hook calls come
 * from. `withRepo` cuts a real worktree (the headline acceptance path runs
 * there); without it the stream is a planning stream whose session runs in
 * `<home>/sessions/<id>/`, which is what the hook resolves `cwd` through
 * either way. The route band cares about neither — and a repo-less stream
 * spawns no `git`, which keeps this file off `runner/worktrees.ts`'s known
 * piped-stdio flake (PLAN-v1 T033's `EBADF epoll_ctl`) more often than not.
 */
async function liveSession({
  withRepo,
}: { withRepo?: boolean } = {}): Promise<{ stream: Stream; session: string; worktree: string }> {
  if (withRepo === true)
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
  const stream = await streams.create('human', {
    title: 'ledger-lite',
    goal: 'add the dependency',
    ...(withRepo === true ? { repo: 'demo' } : {}),
  });
  const attached = await attachService.attach(stream.id);
  await waitFor(() => store.listAgents().some((a) => a.id === attached.session.id));
  const worktree = attached.session.worktree ?? join(home, 'sessions', attached.session.id);
  return { stream: attached.stream, session: attached.session.id, worktree };
}

/**
 * Ends the worker's first turn — nothing is asked, it simply reports itself
 * blocked on the gate — and waits until the session is idle. The turn-end
 * rule keeps it alive because the routed call is still open (T138).
 */
async function endFirstTurnHolding(streamId: string, session: string): Promise<void> {
  writeFileSync(sentinel, '');
  await waitFor(
    () => streams.get(streamId).sessions.find((s) => s.id === session)?.status === 'idle',
  );
}

function editPayload(session: string, worktree: string, file: string) {
  return {
    cwd: worktree,
    session_id: session,
    agile_agent: session,
    tool_name: 'Edit',
    tool_input: { file_path: join(worktree, file) },
  };
}

function reasonOf(output: {
  hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
}): string {
  return output.hookSpecificOutput.permissionDecisionReason ?? '';
}

function prompts(): string[] {
  if (!existsSync(promptLog)) return [];
  return readFileSync(promptLog, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"session/prompt"'));
}

function threadBodies(streamId: string): string[] {
  return streams.readThread(streamId, { limit: 500 }).entries.map((entry) => entry.body);
}

function openGates(): HilRequest[] {
  return gates.list().filter((g) => g.status === 'pending');
}

describe('T138 route band — a routed manifest edit, approved, retried once', () => {
  test('denied → gate in the inbox → approved → the same edit allowed once, a different edit still denied', async () => {
    const { stream, session, worktree } = await liveSession({ withRepo: true });

    // 1. The call Pete's run died on: a dependency-manifest edit.
    const first = await hooks.preToolUse(editPayload(session, worktree, 'package.json'));
    expect(first.hookSpecificOutput.permissionDecision).toBe('deny');
    const raised = openGates();
    expect(raised).toHaveLength(1);
    const gate = raised[0] as HilRequest;
    expect(gate.gate).toBe('classifier_review');
    expect(gate.stream).toBe(stream.id);
    expect(gate.session).toBe(session);
    expect(gate.call?.tool).toBe('Edit');
    expect(gate.call?.path).toBe(join(worktree, 'package.json'));
    // The deny reason is actionable: the id to wait for, why, and what to do.
    expect(reasonOf(first)).toContain(`routed to your inbox as ${gate.id}`);
    expect(reasonOf(first)).toContain('dependency manifest');
    expect(reasonOf(first)).toContain('retry this exact call');
    // The verb that no longer exists is not suggested anywhere.
    expect(reasonOf(first)).not.toContain('hil_request');

    // 2. It shows in the inbox, with the call.
    const items: InboxItem[] = inbox.list();
    const item = items.find((i) => i.id === gate.id);
    expect(item?.kind).toBe('gate');
    expect(item?.stream_path).toEqual(['ledger-lite']);
    expect(item?.context).toContain('package.json');
    expect(item?.context).toContain('edit');

    // 3. Retrying while the gate is open reuses it — one card, not one per
    // attempt (the live run's other failure mode).
    const again = await hooks.preToolUse(editPayload(session, worktree, 'package.json'));
    expect(again.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(reasonOf(again)).toContain(gate.id);
    expect(openGates()).toHaveLength(1);

    // 4. The worker holds: it reports itself blocked and ends its turn,
    //    live and idle (the open gate is what keeps it alive). Then the
    //    human approves, and the session is prompted to retry.
    await endFirstTurnHolding(stream.id, session);
    await gates.respond(gate.id, 'approve', 'pete');
    await waitFor(() => prompts().some((line) => line.includes(gate.id)));
    const approvalPrompt = prompts().find((line) => line.includes(gate.id)) ?? '';
    expect(approvalPrompt).toContain('approved');
    expect(approvalPrompt).toContain('retry');

    // 5. The same call now goes through, once, and the event says who by.
    const allowed = await hooks.preToolUse(editPayload(session, worktree, 'package.json'));
    expect(allowed.hookSpecificOutput.permissionDecision).toBe('allow');
    await store.flush();
    const decisions = store
      .listEvents()
      .filter((e) => e.kind === 'hook_decision' && e.data?.decision === 'allow');
    expect(decisions.some((e) => e.data?.allowed_by === gate.id)).toBe(true);
    expect(gates.get(gate.id).consumed_at).toBeDefined();

    // 6. Once. A third attempt is routed again, as a fresh gate.
    const spent = await hooks.preToolUse(editPayload(session, worktree, 'package.json'));
    expect(spent.hookSpecificOutput.permissionDecision).toBe('deny');
    const reRaised = openGates();
    expect(reRaised).toHaveLength(1);
    expect(reRaised[0]?.id).not.toBe(gate.id);

    // 7. A *different* edit is not covered by that approval at all.
    const other = await hooks.preToolUse(editPayload(session, worktree, 'bun.lock'));
    expect(other.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(reasonOf(other)).not.toContain(gate.id);
    expect(openGates()).toHaveLength(2);
  }, 90_000);

  test('a denied gate reaches the session with the note, and the retry says so', async () => {
    const { stream, session, worktree } = await liveSession();

    const first = await hooks.preToolUse(editPayload(session, worktree, 'package.json'));
    expect(first.hookSpecificOutput.permissionDecision).toBe('deny');
    const gate = openGates()[0] as HilRequest;

    await endFirstTurnHolding(stream.id, session);
    await gates.respond(gate.id, 'deny', 'pete', 'use the version already in the lockfile');
    await waitFor(() => prompts().some((line) => line.includes(gate.id)));
    const denial = prompts().find((line) => line.includes(gate.id)) ?? '';
    expect(denial).toContain('denied');
    expect(denial).toContain('use the version already in the lockfile');

    // A retry after a denial is denied with the human's reason, not routed
    // again — the answer was "no", and the model should hear it.
    const retry = await hooks.preToolUse(editPayload(session, worktree, 'package.json'));
    expect(retry.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(reasonOf(retry)).toContain(`${gate.id} was denied`);
    expect(reasonOf(retry)).toContain('use the version already in the lockfile');
    expect(openGates()).toHaveLength(0);
  }, 90_000);

  test('the deny does not end the session: it holds idle, the approval prompts the retry, then it finishes', async () => {
    const { stream, session, worktree } = await liveSession();

    // The refused call, then the session says it is blocked and ends its
    // turn — what a real Claude session does with this deny.
    const denied = await hooks.preToolUse(editPayload(session, worktree, 'package.json'));
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    const gate = openGates()[0] as HilRequest;

    writeFileSync(sentinel, '');
    await waitFor(
      () => streams.get(stream.id).sessions.find((s) => s.id === session)?.status === 'idle',
    );
    // Alive, not stopped — and the stream says whose move it is. Without
    // this the turn-end rule would have killed the session and the approval
    // could only ever land as a thread line for the next attach.
    expect(store.listAgents().some((a) => a.id === session)).toBe(true);
    expect(streams.get(stream.id).agent.status).toBe('question');
    expect(streams.get(stream.id).human.status).toBe('waiting_on_you');

    // The human answers the card, and the session is prompted to retry.
    await gates.respond(gate.id, 'approve', 'pete');
    // Decided: the human half is done with it and the session is back at
    // work, prompted with the retry.
    expect(streams.get(stream.id).human.status).toBe('open');
    expect(streams.get(stream.id).agent.status).toBe('working');
    await waitFor(() => prompts().some((line) => line.includes(gate.id)));

    // The retry goes through, once.
    const allowed = await hooks.preToolUse(editPayload(session, worktree, 'package.json'));
    expect(allowed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(gates.get(gate.id).consumed_at).toBeDefined();

    // Now the turn ends with nothing open: the normal rule applies again —
    // the session is stopped and the exit path writes `done`.
    writeFileSync(finishSentinel, '');
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    expect(threadBodies(stream.id).some((b) => b.includes('retrying the edit'))).toBe(true);
    expect(store.listAgents().some((a) => a.id === session)).toBe(false);
  }, 90_000);

  test('with no live session the decision stays on the thread and says so', async () => {
    // A planning stream: no repo, so the session runs in its own directory
    // in the state home and that is what the hook resolves `cwd` through.
    const stream = await streams.create('human', { title: 'ledger-lite', goal: 'plan it' });
    const attached = await attachService.attach(stream.id);
    await waitFor(() => store.listAgents().some((a) => a.id === attached.session.id));
    const sessionDir = join(home, 'sessions', attached.session.id);
    await hooks.preToolUse(editPayload(attached.session.id, sessionDir, 'package.json'));
    const gate = openGates()[0] as HilRequest;
    expect(gate.session).toBe(attached.session.id);

    attached.handle.stop();
    await attached.handle.exited;

    await gates.respond(gate.id as HilId, 'approve', 'pete');
    const bodies = streams.readThread(stream.id, { limit: 500 }).entries.map((e) => e.body);
    expect(bodies.some((b) => b.startsWith('gate decision recorded with no live session'))).toBe(
      true,
    );
  }, 90_000);
});

/**
 * T151 (§6, §8.1 step 3): the same route band, reached from the classifier
 * tier instead of the role policy — against the real `fake-agent.ts` over a
 * real ACP transport, with `FakeClassifier` as the only classifier.
 */
describe('T151 classifier tier — a routed classifier answer, through the same band', () => {
  test('a middle-band answer routes, the approval lets that one call through, a deny reaches the model', async () => {
    const { stream, session, worktree } = await liveSession({ withRepo: true });
    const rule = validateRule({
      id: `R-${ulid()}`,
      text: 'do not touch the migration files',
      scope: { kind: 'global' },
      status: 'accepted',
      enforcement: 'classifier',
      critical: false,
      examples: [
        { action: 'edit db/migrations/001.sql', violates: true },
        { action: 'edit src/index.ts', violates: false },
      ],
      provenance: { by: 'human' },
      stats: {},
      created_at: new Date().toISOString(),
    });
    const classifier = new FakeClassifier((_state, questions) =>
      questions.map((q) => ({ id: q.id, probability: 0.6, confidence: 0.9 })),
    );
    const classifierHooks = new HookService(store, bus, {
      gates,
      rules: { inScope: () => [rule], recordFired: async () => undefined },
      classifier: { ask: classifier, config: validateClassifierConfig({ api_key: 'k' }) },
    });

    // An ordinary source edit the role policy allows — the classifier is
    // the only tier with anything to say about it.
    const payload = editPayload(session, worktree, 'src/app.ts');
    const routed = await classifierHooks.preToolUse(payload);
    expect(routed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(reasonOf(routed)).toContain(rule.id);
    expect(classifier.calls).toHaveLength(1);

    const gate = openGates()[0] as HilRequest;
    expect(gate.gate).toBe('classifier_review');
    expect(gate.rule).toBe(rule.id);
    // One card per call, not per attempt: the retry reuses the open gate.
    await classifierHooks.preToolUse(payload);
    expect(openGates()).toHaveLength(1);

    await gates.respond(gate.id, 'approve', 'pete');
    const allowed = await classifierHooks.preToolUse(payload);
    expect(allowed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(gates.get(gate.id).consumed_at).toBeDefined();

    // And the same tier's deny band reaches the model verbatim.
    classifier.setScript((_state, questions) =>
      questions.map((q) => ({ id: q.id, probability: 0.95, confidence: 0.95 })),
    );
    const denied = await classifierHooks.preToolUse(editPayload(session, worktree, 'src/other.ts'));
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(reasonOf(denied)).toContain(rule.text);

    writeFileSync(sentinel, '');
    writeFileSync(finishSentinel, '');
  }, 90_000);
});
