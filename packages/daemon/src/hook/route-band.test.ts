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
import { AttachService } from '../attach/service';
import { Bus } from '../bus';
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
 * The live run's shape: the worker makes the call the hook refuses, asks
 * the operator about it, and ends its turn — which leaves the session live
 * and idle (T137: a turn that ends on an open question ends nothing).
 * `sentinel` is how the test decides when that turn ends; turn two is the
 * retry the gate's decision prompts, and it hangs so the session stays live
 * for the rest of the test.
 *
 * Turns are serialized by the ACP client, so this is also the only state in
 * which a second prompt is deliverable at all — a session mid-turn queues
 * it behind the turn it is already running.
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
      [{ type: 'agent_text', text: 'retrying the edit' }, { type: 'hang' }],
    ],
    steps: [{ type: 'hang' }],
  };
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 20_000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
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

async function liveSession(): Promise<{ stream: Stream; session: string; worktree: string }> {
  await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
  const stream = await streams.create('human', {
    title: 'ledger-lite',
    goal: 'add the dependency',
    repo: 'demo',
  });
  const attached = await attachService.attach(stream.id);
  await waitFor(() => store.listAgents().some((a) => a.id === attached.session.id));
  const worktree = attached.session.worktree;
  if (worktree === undefined) throw new Error('expected a worktree');
  return { stream: attached.stream, session: attached.session.id, worktree };
}

/**
 * Ends the worker's first turn the way the live run did — it asks about the
 * refused call, so the session stays live and idle instead of being stopped
 * by the turn-end rule — and waits until it really is idle.
 */
async function endFirstTurnHolding(streamId: string, session: string): Promise<void> {
  await questions.raise({
    stream: streamId,
    raised_by: session,
    session,
    text: 'the manifest edit is blocked — can I add the dependency?',
  });
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

function openGates(): HilRequest[] {
  return gates.list().filter((g) => g.status === 'pending');
}

describe('T138 route band — a routed manifest edit, approved, retried once', () => {
  test('denied → gate in the inbox → approved → the same edit allowed once, a different edit still denied', async () => {
    const { stream, session, worktree } = await liveSession();

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

    // 4. The worker holds: it asks about the blocked call and ends its turn,
    //    live and idle. Then the human approves, and the session is prompted
    //    to retry.
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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);
});
