/**
 * T140: the `propose_knowledge` verb (T264) (cockpit design §4.1, §5.1, **D4**). An
 * agent proposes; the record lands with `status: 'proposed'`, provenance
 * pointing back at the stream and session, and a thread entry `ref`'d to
 * the rule's file. Nothing here can accept a rule — the store's principal
 * split is asserted in `store.test.ts` and `rules/service.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentId,
  DIRECTOR_NODE,
  type QuestionId,
  type SessionRole,
  type Stream,
  type ThreadEntry,
  repoProposalRef,
  ulid,
} from '@agile-agents/shared';
import { runInit } from '../init';
import { KnowledgeService } from '../knowledge/service';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { HELD_CALL_ASK_REFUSAL, UnknownSessionError, VerbService, lookupPath } from './verbs';

let home: string;
let store: StateStore;
let streams: StreamService;
let rules: KnowledgeService;
let verbs: VerbService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-verbs-'));
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  rules = new KnowledgeService({ store, streams });
  verbs = new VerbService({
    store,
    streams,
    questions: new QuestionService(store, streams),
    rules,
  });
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

/** A live session on a fresh stream, as `runner/session.ts` registers one. */
async function attach(repo?: string): Promise<{ session: string; stream: Stream }> {
  const stream = await streams.create('human', {
    title: 'CSV parser',
    goal: 'decide the dialect',
    ...(repo !== undefined ? { repo } : {}),
  });
  const session = ulid();
  await store.putAgent(session as AgentId, {
    vendor: 'claude',
    model: 'sonnet',
    stream: stream.id,
    last_seen: new Date().toISOString(),
    role: 'worker',
  });
  return { session, stream };
}

describe('ask (T361)', () => {
  test('carries its choices onto the question; out-of-bounds choices are refused', async () => {
    const questions = new QuestionService(store, streams);
    verbs = new VerbService({ store, streams, questions, rules });
    const { session, stream } = await attach();
    const { id } = await verbs.ask({
      session,
      text: 'which dialect?',
      options: ['RFC 4180', 'Excel'],
    });
    const question = questions.get(id as QuestionId);
    expect(question.stream).toBe(stream.id);
    expect(question.options).toEqual(['RFC 4180', 'Excel']);
    const plain = await verbs.ask({ session, text: 'anything else?' });
    expect(questions.get(plain.id as QuestionId).options).toBeUndefined();
    await expect(verbs.ask({ session, text: 'which?', options: ['only one'] })).rejects.toThrow(
      /ask/,
    );
    expect(questions.listOpen()).toHaveLength(2);
  });
});

describe('ask while a call is held (T510)', () => {
  test('refused while the session has a call held this turn; allowed otherwise', async () => {
    const questions = new QuestionService(store, streams);
    const state: { held?: unknown } = {};
    const asked: string[] = [];
    verbs = new VerbService({
      store,
      streams,
      questions,
      rules,
      heldCalls: {
        heldCallThisTurn: (session) => {
          asked.push(session);
          return state.held;
        },
      },
    });
    const { session } = await attach();
    await verbs.ask({ session, text: 'which dialect?' });
    state.held = { id: 'HIL-1' };
    await expect(verbs.ask({ session, text: 'Create package.json?' })).rejects.toThrow(
      HELD_CALL_ASK_REFUSAL,
    );
    expect(HELD_CALL_ASK_REFUSAL).toBe(
      "Your call is already waiting for the operator's approval (a card in their Needs me). Don't ask about it; wait for the answer, then retry the call.",
    );
    expect(asked).toEqual([session, session]);
    expect(questions.listOpen()).toHaveLength(1);
  });

  test('the briefs say the same', () => {
    for (const name of ['worker.md', 'coordinator.md']) {
      const brief = readFileSync(join(import.meta.dir, '..', '..', 'briefs', name), 'utf8');
      expect(brief.replace(/\s+/g, ' ')).toContain(
        "A call held for the operator's approval is already a card in their Needs me: don't `ask` about it",
      );
    }
  });
});

describe('goal_met (T478)', () => {
  test('records the session and summary on agent.goal_met and says it on the thread', async () => {
    const { session, stream } = await attach();
    const entry = await verbs.goalMet({ session, summary: 'RFC 4180, with tests' });
    expect(entry.body).toBe('goal met: RFC 4180, with tests');
    const met = streams.get(stream.id).agent.goal_met;
    expect(met?.session).toBe(session);
    expect(met?.summary).toBe('RFC 4180, with tests');
    await expect(verbs.goalMet({ session, summary: '' })).rejects.toThrow(/goal_met/);
  });

  test('a node with no goal yet has nothing to meet', async () => {
    const { session, stream } = await attach();
    const bare = await streams.create('human', { title: 'talk first' });
    await store.putAgent(session as AgentId, {
      vendor: 'claude',
      model: 'sonnet',
      stream: bare.id,
      last_seen: new Date().toISOString(),
      role: 'worker',
    });
    await expect(verbs.goalMet({ session, summary: 'x' })).rejects.toThrow('no goal yet');
    expect(streams.get(bare.id).agent.goal_met).toBeUndefined();
    expect(stream.id).not.toBe(bare.id);
  });
});

describe('propose_knowledge', () => {
  test('writes a proposed rule with provenance and a thread entry that points at it', async () => {
    const { session, stream } = await attach();
    const entry: ThreadEntry = await verbs.proposeKnowledge({
      session,
      text: 'always run the integration suite before pushing',
    });

    const [rule] = rules.listProposed();
    expect(rule?.status).toBe('proposed');
    expect(rule?.text).toBe('always run the integration suite before pushing');
    expect(rule?.enforcement).toBe('tell');
    expect(rule?.source).toEqual({ by: 'agent', node: stream.id, session });
    expect(rule?.decided_at).toBeUndefined();
    expect(rule?.decided_by).toBeUndefined();
    expect(entry.kind).toBe('proposal');
    expect(entry.by).toBe(`agent:${session}`);
    expect(entry.ref).toBe(`knowledge/${rule?.id}.yaml`);
  });

  test('the scope defaults to the node’s subtree, even with a repo (T264)', async () => {
    await store.addRepo('alpha', { path: join(home, 'alpha') });
    const { session, stream } = await attach('alpha');
    await verbs.proposeKnowledge({ session, text: 'x' });
    expect(rules.listProposed()[0]?.scope).toEqual({ kind: 'subtree', node: stream.id });
  });

  test('the agent picks the kind; omitted, it is standard', async () => {
    const { session } = await attach();
    await verbs.proposeKnowledge({ session, text: 'a', kind: 'decision' });
    await verbs.proposeKnowledge({ session, text: 'b' });
    expect(rules.listProposed().map((r) => [r.text, r.kind])).toEqual([
      ['a', 'decision'],
      ['b', 'standard'],
    ]);
  });

  test('the scope grammar: global, the bare words, and explicit refs', async () => {
    await store.addRepo('alpha', { path: join(home, 'alpha') });
    const { session, stream } = await attach('alpha');
    await verbs.proposeKnowledge({ session, text: 'a', scope: 'global' });
    await verbs.proposeKnowledge({ session, text: 'b', scope: 'repo' });
    await verbs.proposeKnowledge({ session, text: 'c', scope: 'stream' });
    await verbs.proposeKnowledge({ session, text: 'd', scope: `stream:${stream.id}` });
    expect(rules.listProposed().map((r) => [r.text, r.scope])).toEqual([
      ['a', { kind: 'global' }],
      ['b', { kind: 'repo', repo: 'alpha' }],
      ['c', { kind: 'subtree', node: stream.id }],
      ['d', { kind: 'subtree', node: stream.id }],
    ]);
  });

  test('an unparseable scope is refused, and nothing is written', async () => {
    const { session } = await attach();
    await expect(
      verbs.proposeKnowledge({ session, text: 'x', scope: 'everything' }),
    ).rejects.toThrow(/invalid knowledge scope/);
    expect(rules.list()).toEqual([]);
  });

  test('a scope of "repo" on a repo-less stream is refused', async () => {
    const { session } = await attach();
    await expect(verbs.proposeKnowledge({ session, text: 'x', scope: 'repo' })).rejects.toThrow(
      /needs a node with a repo/,
    );
  });

  test('examples proposed with a tell item are kept visible in source.finding', async () => {
    const { session } = await attach();
    await verbs.proposeKnowledge({
      session,
      text: 'say which dialect you picked',
      enforcement: 'tell',
      examples: [
        { action: 'reply without naming the dialect', violates: true },
        { action: 'reply: using RFC 4180', violates: false },
      ],
    });
    const [rule] = rules.listProposed();
    expect(rule?.enforcement).toBe('tell');
    expect(rule?.check).toBeUndefined();
    expect(rule?.source.finding).toBe(
      'proposed examples: violates: reply without naming the dialect | allowed: reply: using RFC 4180',
    );
  });

  test('an action item gets a classifier check with its examples', async () => {
    const { session } = await attach();
    await verbs.proposeKnowledge({
      session,
      text: 'no new dependencies',
      enforcement: 'action',
      examples: [
        { action: 'bun add lodash', violates: true },
        { action: 'bun test', violates: false },
      ],
    });
    const [rule] = rules.listProposed();
    expect(rule?.enforcement).toBe('action');
    expect(rule?.check).toEqual({
      by: 'classifier',
      examples: [
        { action: 'bun add lodash', violates: true },
        { action: 'bun test', violates: false },
      ],
    });
  });

  test('a session that is no longer attached cannot propose anything', async () => {
    await expect(verbs.proposeKnowledge({ session: ulid(), text: 'x' })).rejects.toThrow(
      UnknownSessionError,
    );
  });
});

describe('propose_repo (T455)', () => {
  /** A repo with one commit, so a work node can be made on it. */
  function gitRepo(name: string): string {
    const path = join(home, 'src', name);
    mkdirSync(path, { recursive: true });
    const run = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: path });
    run('init', '-q', '-b', 'main');
    writeFileSync(join(path, 'README.md'), `# ${name}\n`);
    run('add', '-A');
    run('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'init');
    return path;
  }

  async function registerAs(node: string, role: SessionRole = 'worker'): Promise<string> {
    const session = ulid();
    await store.putAgent(session as AgentId, {
      vendor: 'claude',
      model: 'sonnet',
      stream: node,
      last_seen: new Date().toISOString(),
      role,
    });
    return session;
  }

  /** Shop (with api and web public, vault private to another project) and a conversation in it. */
  async function shop() {
    await store.addRepo('api', { path: gitRepo('api') });
    await store.addRepo('web', { path: gitRepo('web') });
    const projects = new ProjectService(store, streams);
    const other = await projects.create({ name: 'Other' });
    await store.addRepo('vault', {
      path: gitRepo('vault'),
      visibility: { mode: 'private', projects: [other.id] },
    });
    const project = await projects.create({ name: 'Shop' });
    const convo = await streams.create('human', {
      title: 'Sale prices',
      goal: 'can we show sale prices?',
      project: project.id,
    });
    return { project, convo, session: await registerAs(convo.id) };
  }

  const proposals = (node: string) =>
    store.readThread(node).filter((e) => e.kind === 'proposal' && e.ref?.startsWith('repo:'));

  test("a conversation's agent writes one proposal line naming the repo, in words; nothing is reshaped", async () => {
    const { convo, session } = await shop();
    const entry = await verbs.proposeRepo({
      session,
      repo: 'web',
      why: 'the price badge is rendered in the web app',
    });
    expect(entry.kind).toBe('proposal');
    expect(entry.by).toBe(`agent:${session}`);
    expect(entry.ref).toBe(repoProposalRef('web'));
    expect(entry.body).toBe('Proposes adding **web**: the price badge is rendered in the web app');
    expect(proposals(convo.id)).toHaveLength(1);
    // Only the human's Add click reshapes: the node is still a repo-less conversation.
    const after = streams.get(convo.id);
    expect(after.repo).toBeUndefined();
    expect(after.branch).toBeUndefined();
    expect(after.worktree).toBeUndefined();
    expect(streams.list().filter((s) => s.parent === convo.id)).toEqual([]);
  });

  test("a work node's worker proposes a second repo; its own repo is refused", async () => {
    const { project } = await shop();
    const work = await streams.create('human', {
      title: 'Price badge',
      goal: 'show the sale price',
      project: project.id,
      repo: 'api',
    });
    const session = await registerAs(work.id);
    await expect(verbs.proposeRepo({ session, repo: 'api', why: 'x' })).rejects.toThrow(
      'this node already works in api',
    );
    const entry = await verbs.proposeRepo({ session, repo: 'web', why: 'the badge is in web' });
    expect(entry.ref).toBe('repo:web');
    expect(streams.get(work.id).repo).toBe('api');
  });

  test('the same repo twice on one node is refused; another repo is not', async () => {
    const { convo, session } = await shop();
    await verbs.proposeRepo({ session, repo: 'web', why: 'the badge' });
    await expect(verbs.proposeRepo({ session, repo: 'web', why: 'again' })).rejects.toThrow(
      'you already proposed web on this node',
    );
    // A second agent on the node (a restart) doesn't get round it either.
    const next = await registerAs(convo.id);
    await expect(verbs.proposeRepo({ session: next, repo: 'web', why: 'x' })).rejects.toThrow(
      'already proposed',
    );
    await verbs.proposeRepo({ session, repo: 'api', why: 'the price field' });
    expect(proposals(convo.id).map((e) => e.ref)).toEqual(['repo:web', 'repo:api']);
  });

  test('an unregistered repo and one the project cannot read are refused alike, naming only readable ones', async () => {
    const { convo, session } = await shop();
    let unknown = '';
    let hidden = '';
    await verbs.proposeRepo({ session, repo: 'nope', why: 'x' }).catch((err: Error) => {
      unknown = err.message;
    });
    await verbs.proposeRepo({ session, repo: 'vault', why: 'x' }).catch((err: Error) => {
      hidden = err.message;
    });
    expect(unknown).toBe(
      'propose_repo: no registered repo named nope that this node can read; it can read api, web',
    );
    expect(hidden).toBe(unknown.replace('nope', 'vault'));
    expect(hidden).not.toContain('private');
    // A name that is an Object property is not a repo.
    await expect(verbs.proposeRepo({ session, repo: 'constructor', why: 'x' })).rejects.toThrow(
      'no registered repo named constructor',
    );
    expect(proposals(convo.id)).toEqual([]);
  });

  test('a project root, a coordinating node, a closed, merged or archived node are refused', async () => {
    const { project, convo } = await shop();
    const root = await registerAs(project.root);
    await expect(verbs.proposeRepo({ session: root, repo: 'web', why: 'x' })).rejects.toThrow(
      "this is a project's root",
    );

    const coordinating = await streams.create('human', {
      title: 'Checkout',
      goal: 'split',
      project: project.id,
    });
    await streams.create('human', {
      title: 'api part',
      goal: 'g',
      parent: coordinating.id,
      repo: 'api',
    });
    const stale = await registerAs(coordinating.id);
    await expect(verbs.proposeRepo({ session: stale, repo: 'web', why: 'x' })).rejects.toThrow(
      'this node coordinates parts',
    );

    const closing = await registerAs(convo.id);
    await streams.close('human', convo.id, 'done');
    await expect(verbs.proposeRepo({ session: closing, repo: 'web', why: 'x' })).rejects.toThrow(
      'this node is closed',
    );

    const merged = await streams.create('human', { title: 'M', goal: 'g', project: project.id });
    const mergedSession = await registerAs(merged.id);
    await store.updateStream('daemon', merged.id, (before) => ({
      ...before,
      human: { ...before.human, status: 'landed' },
    }));
    await expect(
      verbs.proposeRepo({ session: mergedSession, repo: 'web', why: 'x' }),
    ).rejects.toThrow('this node is merged');

    const archived = await streams.create('human', { title: 'A', goal: 'g', project: project.id });
    const archivedSession = await registerAs(archived.id);
    await streams.archive('human', archived.id);
    await expect(
      verbs.proposeRepo({ session: archivedSession, repo: 'web', why: 'x' }),
    ).rejects.toThrow('this node is closed');
    for (const node of [project.root, coordinating.id, convo.id, merged.id, archived.id]) {
      expect(proposals(node)).toEqual([]);
    }
  });

  test('a reviewer, a coordinator, a lessons session and the Director are refused', async () => {
    const { convo } = await shop();
    for (const role of ['reviewer', 'lessons'] as const) {
      const session = await registerAs(convo.id, role);
      await expect(verbs.proposeRepo({ session, repo: 'web', why: 'x' })).rejects.toThrow(
        `a ${role} session cannot propose a repo`,
      );
    }
    const coordinator = await registerAs(convo.id, 'coordinator');
    await expect(
      verbs.proposeRepo({ session: coordinator, repo: 'web', why: 'x' }),
    ).rejects.toThrow('a coordinator adds a part on another repo with add_child');

    const director = ulid();
    await store.putAgent(director as AgentId, {
      vendor: 'claude',
      model: 'sonnet',
      last_seen: new Date().toISOString(),
      role: 'coordinator',
    });
    await store.putDirector({
      thread: DIRECTOR_NODE,
      created_at: new Date().toISOString(),
      session: {
        id: director,
        vendor: 'claude',
        model: 'sonnet',
        role: 'coordinator',
        status: 'running',
      },
    });
    await expect(verbs.proposeRepo({ session: director, repo: 'web', why: 'x' })).rejects.toThrow(
      'the Director has no node',
    );
    await expect(verbs.proposeRepo({ session: ulid(), repo: 'web', why: 'x' })).rejects.toThrow(
      UnknownSessionError,
    );
    expect(proposals(convo.id)).toEqual([]);
  });

  test("the worker's brief (a conversation's and a work node's) tells of it; the reviewer's and coordinator's don't", () => {
    const brief = (role: string) =>
      readFileSync(join(import.meta.dir, '..', '..', 'briefs', `${role}.md`), 'utf8');
    expect(brief('worker')).toContain('`propose_repo`');
    expect(brief('reviewer')).not.toContain('propose_repo');
    expect(brief('coordinator')).not.toContain('propose_repo');
  });

  test('the why is a capped body, and the line stays within the thread cap', async () => {
    const { session } = await shop();
    await expect(verbs.proposeRepo({ session, repo: 'web', why: 'x'.repeat(801) })).rejects.toThrow(
      'propose_repo',
    );
    const entry = await verbs.proposeRepo({ session, repo: 'web', why: 'x'.repeat(800) });
    expect(entry.body.length).toBe(800);
    expect(entry.body.startsWith('Proposes adding **web**: xxx')).toBe(true);
  });
});

describe('lookup_knowledge on the repo root (T466)', () => {
  test('`.` returns every item in scope, path-limited ones too', async () => {
    const { session } = await attach();
    const everywhere = await rules.create('human', {
      text: 'small commits',
      scope: { kind: 'global' },
    });
    await rules.accept(everywhere.id, 'human');
    const pathed = await rules.create('human', {
      text: 'prices are integer cents',
      scope: { kind: 'global' },
      paths: ['api/**'],
    });
    await rules.accept(pathed.id, 'human');
    const root = verbs.lookupKnowledge({ session, path: '.' });
    expect(root.path).toBe('.');
    expect(root.items.map((i) => i.text)).toEqual(
      expect.arrayContaining(['small commits', 'prices are integer cents']),
    );
    const ui = verbs.lookupKnowledge({ session, path: 'ui/app.ts' });
    expect(ui.items.map((i) => i.text)).not.toContain('prices are integer cents');
  });
});

describe('lookupPath (T263)', () => {
  const wt = '/srv/repo/.worktrees/s1';
  test('absolute, ./ and .. paths become repo-relative', () => {
    expect(lookupPath(`${wt}/api/orders.ts`, wt)).toBe('api/orders.ts');
    expect(lookupPath('./api/orders.ts', wt)).toBe('api/orders.ts');
    expect(lookupPath('ui/../api/x.ts', wt)).toBe('api/x.ts');
    expect(lookupPath('api/x.ts', undefined)).toBe('api/x.ts');
  });
  test('a path outside the worktree is refused', () => {
    expect(() => lookupPath('/etc/passwd', wt)).toThrow('not a path inside');
    expect(() => lookupPath('../other/x.ts', wt)).toThrow('not a path inside');
    // T466: the repo root asks about the whole repo (Codex passed `.`).
    expect(lookupPath(wt, wt)).toBe('.');
    expect(lookupPath('.', wt)).toBe('.');
    expect(lookupPath('./', undefined)).toBe('.');
  });
});

describe('escalate (T484, D56)', () => {
  test('only a node’s own agent may ask; it says why, never which model; without the watcher it refuses', async () => {
    const asked: Array<{ node: string; session: string; why: string }> = [];
    const progressed: string[] = [];
    verbs = new VerbService({
      store,
      streams,
      questions: new QuestionService(store, streams),
      rules,
      escalation: {
        asked: async (node, session, why) => {
          asked.push({ node, session, why });
          return 'Recorded.';
        },
        progressed: async (node) => {
          progressed.push(node);
        },
      },
    });
    const { session, stream } = await attach();
    expect(await verbs.escalate({ session, why: 'the tests still fail' })).toEqual({
      result: 'Recorded.',
    });
    expect(asked).toEqual([{ node: stream.id, session, why: 'the tests still fail' }]);
    expect(streams.readThread(stream.id, { limit: 10 }).entries.at(-1)?.body).toBe(
      'asks for a stronger model: the tests still fail',
    );
    // The verb takes `why` alone: a model (or vendor, or effort) is refused before anything runs.
    await expect(verbs.escalate({ session, why: 'x', model: 'claude-opus-5-5' })).rejects.toThrow(
      /escalate/,
    );
    await expect(verbs.escalate({ session, why: 'x'.repeat(401) })).rejects.toThrow(/escalate/);
    expect(asked).toHaveLength(1);
    // A progress call is counted (a turn with one isn't quiet).
    await verbs.progress({ session, text: 'parser done' });
    expect(progressed).toEqual([stream.id]);

    // A reviewer can't ask.
    const reviewer = ulid();
    await store.putAgent(reviewer as AgentId, {
      vendor: 'claude',
      model: 'sonnet',
      stream: stream.id,
      last_seen: new Date().toISOString(),
      role: 'reviewer',
    });
    await expect(verbs.escalate({ session: reviewer, why: 'x' })).rejects.toThrow(
      'a reviewer session cannot ask for a stronger model',
    );
    // Nor the Director: it has no node.
    const director = ulid();
    await store.putAgent(director as AgentId, {
      vendor: 'claude',
      model: 'sonnet',
      last_seen: new Date().toISOString(),
      role: 'coordinator',
    });
    await store.putDirector({
      thread: DIRECTOR_NODE,
      created_at: new Date().toISOString(),
      session: {
        id: director,
        vendor: 'claude',
        model: 'sonnet',
        role: 'coordinator',
        status: 'running',
      },
    });
    await expect(verbs.escalate({ session: director, why: 'x' })).rejects.toThrow(
      'the Director has no node',
    );
    expect(asked).toHaveLength(1);

    // With no watcher wired, it says so.
    verbs = new VerbService({
      store,
      streams,
      questions: new QuestionService(store, streams),
      rules,
    });
    await expect(verbs.escalate({ session, why: 'x' })).rejects.toThrow('not available');
  });

  test('the worker’s brief tells of it', () => {
    const brief = readFileSync(join(import.meta.dir, '..', '..', 'briefs', 'worker.md'), 'utf8');
    expect(brief).toContain('`escalate`');
    expect(brief).toContain('you never pick the model');
  });
});

describe('settle_question (T502, D62)', () => {
  test('a node’s own agent settles its open question with what was decided; anyone else is refused', async () => {
    const questions = new QuestionService(store, streams);
    verbs = new VerbService({ store, streams, questions, rules });
    const { session, stream } = await attach();
    const { id } = await verbs.ask({
      session,
      text: 'Store amounts how?',
      options: ['Integer cents', 'Floats'],
    });
    await questions.reply(id as QuestionId, { text: 'what does Stripe use?', by: 'human' });
    expect(questions.get(id as QuestionId).status).toBe('open');

    // A reviewer on the node can't settle it.
    const reviewer = ulid();
    await store.putAgent(reviewer as AgentId, {
      vendor: 'claude',
      model: 'sonnet',
      stream: stream.id,
      last_seen: new Date().toISOString(),
      role: 'reviewer',
    });
    await expect(
      verbs.settleQuestion({ session: reviewer, question: id, answer: 'cents' }),
    ).rejects.toThrow("only a node's own agent settles one");
    // Nor another node's agent.
    const other = await attach();
    await expect(
      verbs.settleQuestion({ session: other.session, question: id, answer: 'cents' }),
    ).rejects.toThrow('was not asked on your node');
    // Only `{question, answer}`: a resolution of its own is refused at the edge.
    await expect(
      verbs.settleQuestion({ session, question: id, answer: 'cents', resolved_as: 'reply' }),
    ).rejects.toThrow(/settle_question/);

    expect(await verbs.settleQuestion({ session, question: id, answer: 'Integer cents' })).toEqual({
      id,
      resolved_as: 'settled',
    });
    expect(questions.get(id as QuestionId)).toMatchObject({
      status: 'answered',
      answer: 'Integer cents',
      resolved_as: 'settled',
      answered_by: `agent:${session}`,
    });
    // Twice is refused, and says how it ended.
    await expect(verbs.settleQuestion({ session, question: id, answer: 'Floats' })).rejects.toThrow(
      'is already settled',
    );
  });
});

describe('thread on progress and ask (T503, design/chat-threads.md §4.2)', () => {
  test('the agent answers in a thread on its node; a thread not there is refused before anything is written', async () => {
    const questions = new QuestionService(store, streams);
    verbs = new VerbService({ store, streams, questions, rules });
    const { session, stream } = await attach();
    const turn = await verbs.progress({ session, text: 'rounding and sheets' });
    const first = await streams.appendThread('human', stream.id, {
      kind: 'line',
      body: 'why that rounding?',
      anchor: { entry: turn.ts, start: 0, end: 8, quote: 'rounding' },
    });
    const said = await verbs.progress({ session, text: 'it avoids drift', thread: first.ts });
    expect(said.thread).toBe(first.ts);
    const { id } = await verbs.ask({ session, text: 'half up or half even?', thread: first.ts });
    const asked = streams
      .readThread(stream.id)
      .entries.find((e) => e.kind === 'question' && e.ref === `questions/${id}.yaml`);
    expect(asked?.thread).toBe(first.ts);

    const before = questions.list().length;
    const nowhere = '2020-01-01T00:00:00.000Z';
    await expect(verbs.ask({ session, text: 'lost?', thread: nowhere })).rejects.toThrow(
      /no thread/,
    );
    expect(questions.list()).toHaveLength(before);
    await expect(verbs.progress({ session, text: 'lost', thread: nowhere })).rejects.toThrow(
      /no thread/,
    );
    // Another node's thread is not this agent's to answer in.
    const other = await attach();
    await expect(
      verbs.progress({ session: other.session, text: 'x', thread: first.ts }),
    ).rejects.toThrow(/no thread/);
  });
});
