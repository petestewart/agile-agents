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
import { UnknownSessionError, VerbService, lookupPath } from './verbs';

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
    expect(() => lookupPath(wt, wt)).toThrow('not a path inside');
  });
});
