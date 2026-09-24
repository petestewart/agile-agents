/**
 * T141 acceptance (§5.5): the retro at stream close and land, against the
 * real `fake-agent.ts` over a real ACP transport — no vendor, no login, no
 * network.
 *
 * Everything the ticket names: two proposals out of one lessons session
 * reach the inbox as `rule_accept` items with provenance pointing at the
 * stream; accepting one puts it in the next brief in scope; a stream that
 * went smoothly starts no session at all; the fourth proposal is refused;
 * and both end paths — `stream.close` and a real `land` — call the retro.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, type AcpProviderConfig } from '@agile-agents/acp-client';
import type { InboxItem, Stream } from '@agile-agents/shared';
import { AttachService } from '../attach/service';
import { VerbService } from '../attach/verbs';
import { DeliveryService } from '../delivery/service';
import { GateService } from '../gates/service';
import { InboxService } from '../inbox/service';
import { runInit } from '../init';
import { QuestionService } from '../questions/service';
import { RulesService } from '../rules/service';
import { buildBrief } from '../runner/brief';
import type { FakeAgentScript } from '../runner/fake-agent';
import { StateStore, buildEvent } from '../store';
import { StreamService } from '../streams/service';
import { LessonQuotaError, LessonsService, MAX_LESSON_PROPOSALS, renderMaterial } from './service';

const FAKE_AGENT_PATH = join(import.meta.dir, '..', 'runner', 'fake-agent.ts');

let home: string;
let repo: string;
let scratch: string;
let store: StateStore;
let streams: StreamService;
let questions: QuestionService;
let rules: RulesService;
let verbs: VerbService;
let attach: AttachService;
let lessons: LessonsService;
let inbox: InboxService;

function git(args: string[], cwd = repo): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/** A provider whose *transport* is the fake agent but whose registry fields are the vendor's. */
function fakeProvider(script: FakeAgentScript): AcpProviderConfig {
  const scriptPath = join(scratch, `${Bun.hash(JSON.stringify(script)).toString(36)}.json`);
  writeFileSync(scriptPath, JSON.stringify(script));
  return {
    ...ACP_PROVIDERS.claude,
    command: 'bun',
    args: [FAKE_AGENT_PATH],
    envOverrides: { AGILE_FAKE_AGENT_SCRIPT: scriptPath },
  };
}

/**
 * Speaks, opens a tool call (which closes the streaming message) and then
 * hangs: the retro's proposals are made *while* the session is live, which
 * is what the verb path needs.
 */
const PROPOSES: FakeAgentScript = {
  steps: [
    { type: 'agent_text', text: 'reading the findings' },
    { type: 'tool_call', toolCallId: 'propose-1', title: 'propose_rule' },
    { type: 'hang' },
  ],
};

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

function threadBodies(streamId: string): string[] {
  return streams.readThread(streamId, { limit: 500 }).entries.map((entry) => entry.body);
}

async function makeStream(repoName?: string): Promise<Stream> {
  return streams.create('human', {
    title: 'CSV parser',
    goal: 'decide the dialect and implement it',
    ...(repoName !== undefined ? { repo: repoName } : {}),
  });
}

/** One finding on the stream, written as a worker session would write it. */
async function seedFinding(stream: Stream): Promise<void> {
  const { session, handle } = await attach.attach(stream.id);
  await waitFor(() => store.listAgents().some((a) => a.id === session.id));
  await verbs.finding({
    session: session.id,
    severity: 'major',
    file: 'src/parse.ts',
    text: 'the dialect sniffer ignores quoted separators',
  });
  handle.stop();
  await handle.exited;
}

/** Starts the retro and returns its live session id. */
async function runRetro(stream: Stream): Promise<string> {
  await lessons.onStreamEnd(stream.id);
  await waitFor(() =>
    streams.get(stream.id).sessions.some((s) => s.role === 'lessons' && s.status === 'running'),
  );
  const session = streams.get(stream.id).sessions.find((s) => s.role === 'lessons');
  if (session === undefined) throw new Error('no lessons session');
  await waitFor(() => store.listAgents().some((a) => a.id === session.id));
  return session.id;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-lessons-home-'));
  scratch = mkdtempSync(join(tmpdir(), 'agile-lessons-scratch-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-lessons-repo-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);

  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  // Wired the way `daemon.ts` wires it: `close` hands the stream to the
  // retro, which is built after the services it drives.
  streams = new StreamService(store, { onStreamEnd: (id) => lessons.onStreamEnd(id) });
  questions = new QuestionService(store, streams, {
    deliver: (sessionId, question) => attach.deliverAnswer(sessionId, question),
  });
  rules = new RulesService({ store, streams });
  attach = new AttachService({
    store,
    streams,
    home,
    provider: () => fakeProvider(PROPOSES),
    questions: { listOpen: () => questions.listOpen() },
    rules,
  });
  lessons = new LessonsService({
    store,
    streams,
    attach,
    rules,
    questions: { list: () => questions.list() },
  });
  verbs = new VerbService({
    store,
    streams,
    questions,
    rules,
    proposalLimit: { assertCanPropose: (caller) => lessons.assertCanPropose(caller) },
  });
  inbox = new InboxService({
    streams,
    questions,
    gates: new GateService(store),
    rules,
  });
});

afterEach(async () => {
  await attach.stopAll();
  await store.flush();
  store.close();
  for (const dir of [home, scratch, repo]) {
    Bun.spawnSync(['rm', '-rf', dir]);
  }
});

describe('T176: rules about what an agent says are guidance', () => {
  test('brief and instruction say pattern/classifier only see tool calls and diffs', async () => {
    const brief = readFileSync(join(import.meta.dir, '../../briefs/lessons.md'), 'utf8');
    expect(brief).toMatch(/only ever see \*\*tool calls and diffs\*\*/);
    expect(brief).toMatch(/must be `guidance`/);
    const stream = await streams.create('human', { title: 't', goal: 'g' });
    const text = renderMaterial(stream, { findings: ['f'], denials: [], questions: [] });
    expect(text).toContain('what an agent says (messages, replies) is `guidance`');
  });
});

describe('what a retro is started over (§5.5)', () => {
  test('a stream with no findings, no denials and no questions starts no session', async () => {
    const stream = await makeStream();
    await lessons.onStreamEnd(stream.id);
    await Bun.sleep(100);
    expect(threadBodies(stream.id)).toContain('no lessons: nothing to learn from');
    expect(streams.get(stream.id).sessions).toHaveLength(0);
    expect(rules.listProposed()).toHaveLength(0);
  }, 20_000);

  test('a hook denial alone is enough material', async () => {
    const stream = await makeStream();
    await store.appendEvent(
      buildEvent('hook_decision', {
        data: {
          stream: stream.id,
          event: 'PreToolUse',
          decision: 'deny',
          reason: 'pushing to main is prohibited',
          command: 'git push origin main',
        },
      }),
    );
    expect(lessons.material(stream.id).denials).toHaveLength(1);
    expect(lessons.material(stream.id).denials[0]).toContain('pushing to main is prohibited');
  });

  test('an answered question alone is enough material', async () => {
    const stream = await makeStream();
    const raised = await questions.raise({
      stream: stream.id,
      raised_by: 'human',
      text: 'comma or semicolon?',
    });
    // An open question is not yet a lesson — it taught nobody anything.
    expect(lessons.material(stream.id).questions).toHaveLength(0);
    await questions.answer(raised.id, { answer: 'semicolon', by: 'human' });
    expect(lessons.material(stream.id).questions[0]).toContain('semicolon');
  });

  test("a finding on the stream's list and its thread entry is one item, not two", async () => {
    const stream = await makeStream();
    await seedFinding(stream);
    expect(lessons.material(stream.id).findings).toHaveLength(1);
  }, 30_000);
});

describe('the proposals (the T141 acceptance criteria)', () => {
  test('two rules reach the inbox with provenance, and accepting one reaches the next brief', async () => {
    const stream = await makeStream();
    await seedFinding(stream);
    const session = await runRetro(stream);
    expect(threadBodies(stream.id)).toContain('lessons: session started');

    // The retro's own verb calls, exactly as the MCP bridge forwards them.
    await verbs.proposeRule({
      session,
      text: 'sniff the dialect on quoted separators before choosing one',
      scope: 'stream',
      examples: [
        { action: 'splitting a quoted line on the raw separator', violates: true },
        { action: 'parsing quotes before splitting', violates: false },
      ],
      enforcement: 'guidance',
    });
    await verbs.proposeRule({
      session,
      text: 'a parser change carries a fixture for the dialect it changes',
      scope: 'stream',
      examples: [
        { action: 'changing the sniffer with no new fixture', violates: true },
        { action: 'adding a semicolon fixture with the change', violates: false },
      ],
    });

    const proposed = rules.listProposed();
    expect(proposed).toHaveLength(2);
    for (const rule of proposed) {
      expect(rule.status).toBe('proposed');
      expect(rule.provenance).toEqual({
        stream: stream.id,
        session,
        by: `agent:${session}`,
      });
      expect(rule.examples).toHaveLength(2);
      expect(rule.scope).toEqual({ kind: 'stream', ref: stream.id });
    }

    // §3.1: each proposal is a `rule_accept` item the human decides.
    const items: InboxItem[] = inbox.list().filter((item) => item.kind === 'rule_accept');
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.id).sort()).toEqual(proposed.map((r) => r.id).sort());
    expect(items.map((item) => item.ref).sort()).toEqual(
      proposed.map((r) => `rules/${r.id}.yaml`).sort(),
    );
    expect(items.every((item) => item.stream === stream.id)).toBe(true);

    // §5.5: "accepting a rule puts it in scope for the next brief in that
    // scope, immediately" — and the one still proposed does not.
    const [first, second] = proposed;
    if (first === undefined || second === undefined) throw new Error('two rules expected');
    await rules.accept(first.id, 'pete');
    expect(rules.inScope(stream.id).map((r) => r.id)).toEqual([first.id]);

    const brief = buildBrief({
      role: 'worker',
      stream: streams.get(stream.id),
      ancestors: [],
      thread: [],
      docs: [],
      rules: store.listRules(),
    });
    expect(brief).toContain(first.text);
    expect(brief).not.toContain(second.text);
  }, 40_000);

  test('the fourth proposal from one retro is refused with a reason', async () => {
    const stream = await makeStream();
    await seedFinding(stream);
    const session = await runRetro(stream);

    for (let i = 0; i < MAX_LESSON_PROPOSALS; i += 1) {
      await verbs.proposeRule({ session, text: `rule number ${i + 1}`, scope: 'stream' });
    }
    expect(rules.listProposed()).toHaveLength(MAX_LESSON_PROPOSALS);

    await expect(
      verbs.proposeRule({ session, text: 'one rule too many', scope: 'stream' }),
    ).rejects.toThrow(LessonQuotaError);
    expect(rules.listProposed()).toHaveLength(MAX_LESSON_PROPOSALS);
    // The cap is the retro's, not every session's: a worker is not capped.
    const worker = streams.get(stream.id).sessions.find((s) => s.role === 'worker');
    expect(worker).toBeDefined();
  }, 40_000);

  test('the retro runs read-only: the lessons role maps to the reviewer policy', async () => {
    const stream = await makeStream();
    await seedFinding(stream);
    const session = await runRetro(stream);
    // The registry entry is what the hook resolves a tool call through.
    expect(store.listAgents().find((a) => a.id === session)?.record.role).toBe('lessons');
  }, 40_000);

  test('the retro never moves agent.status — a landed stream stays landed', async () => {
    const stream = await makeStream();
    await seedFinding(stream);
    await waitFor(() => streams.get(stream.id).agent.status === 'done');
    await streams.update('daemon', stream.id, { human: { status: 'landed' } });
    const session = await runRetro(stream);
    const handle = attach.handleFor(stream.id, 'lessons');
    handle?.stop();
    await handle?.exited;
    await waitFor(() => threadBodies(stream.id).some((b) => b.startsWith('lessons session ended')));
    expect(streams.get(stream.id).human.status).toBe('landed');
    expect(streams.get(stream.id).agent.status).toBe('done');
    expect(streams.get(stream.id).sessions.find((s) => s.id === session)?.status).not.toBe(
      'running',
    );
  }, 40_000);
});

describe('both end paths call the retro (§5.5: "on land or close")', () => {
  test('stream.close starts it', async () => {
    const stream = await makeStream();
    await seedFinding(stream);
    await streams.close('human', stream.id, 'not worth finishing');
    await waitFor(() => threadBodies(stream.id).includes('lessons: session started'));
  }, 40_000);

  test('a real land starts it, in the session dir the removed worktree left behind', async () => {
    await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
    const stream = await makeStream('demo');
    await seedFinding(stream);
    const attached = streams.get(stream.id);
    expect(attached.worktree).toBeDefined();
    // One commit on the stream's branch, so there is something to land.
    writeFileSync(join(attached.worktree ?? '', 'parse.ts'), 'export const sep = ";"\n');
    git(['add', '-A'], attached.worktree);
    git(['commit', '-q', '-m', 'the work'], attached.worktree);

    const landing = new DeliveryService({
      store,
      streams,
      onStreamEnd: (id) => lessons.onStreamEnd(id),
    });
    const outcome = await landing.land(stream.id);
    expect(outcome.status).toBe('landed');

    await waitFor(() => threadBodies(stream.id).includes('lessons: session started'));
    const session = await waitForLessonsSession(stream.id);
    // The worktree is gone, so the retro runs in its own session dir rather
    // than failing to spawn — and it records no worktree of its own.
    expect(session.worktree).toBeUndefined();
  }, 40_000);
});

async function waitForLessonsSession(streamId: string): Promise<{ worktree?: string }> {
  await waitFor(() => streams.get(streamId).sessions.some((s) => s.role === 'lessons'));
  const session = streams.get(streamId).sessions.find((s) => s.role === 'lessons');
  if (session === undefined) throw new Error('no lessons session');
  return session;
}

/** Not part of the acceptance criteria, but the shape the inbox card reads. */
describe('the inbox card', () => {
  test('a rule_accept item carries the rule text and the stream it came from', async () => {
    const stream = await makeStream();
    await seedFinding(stream);
    const session = await runRetro(stream);
    await verbs.proposeRule({
      session,
      text: 'always name the dialect in the fixture file',
      scope: 'stream',
      examples: [
        { action: 'a fixture called data.csv', violates: true },
        { action: 'a fixture called semicolon.csv', violates: false },
      ],
    });
    const item = inbox.list().find((each) => each.kind === 'rule_accept');
    expect(item?.context).toContain('always name the dialect in the fixture file');
    expect(item?.stream).toBe(stream.id);
    expect(item?.stream_path).toEqual(['CSV parser']);
  }, 40_000);
});
