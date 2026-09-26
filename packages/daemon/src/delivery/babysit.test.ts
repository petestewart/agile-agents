/**
 * T246 (projects-design §4.1): PR babysitting, end to end on the fake
 * GitHub with a scripted fake agent. A failing check wakes the work node's
 * agent with a CI log excerpt; its fix goes out through the `deliver` verb
 * (T224's update path); the check goes green; an approval with auto-merge
 * on is merged by the fake; the node shows merged with no human click.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentId,
  type RoutedEvent,
  type Stream,
  liveChildrenOf,
  nodeRole,
  ulid,
} from '@agile-agents/shared';
import { VerbService } from '../attach/verbs';
import { SessionDelivery } from '../events/delivery';
import { makeEmitter, summarize } from '../events/producers';
import { RoutedEventService } from '../events/service';
import { wakeVerdict } from '../events/wake';
import { type FakeGitHub, startFakeGitHub } from '../github/fake-server';
import { PrPoller } from '../github/poller';
import { createGitHubRest } from '../github/rest';
import { runInit } from '../init';
import { QuestionService } from '../questions/service';
import { buildBrief } from '../runner/brief';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { DeliveryService, LandRefusedError } from './service';

const TOKEN = 'ghs_T246sentinelTOKENvalue0123456789';

let home: string;
let repo: string;
let gh: FakeGitHub;
let store: StateStore;
let streams: StreamService;

function mustGit(args: string[], cwd = repo): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function commitIn(cwd: string, file: string, text: string) {
  writeFileSync(join(cwd, file), text);
  mustGit(['add', '-A'], cwd);
  mustGit(['commit', '-q', '-m', `edit ${file}`], cwd);
}
const port = () =>
  createGitHubRest({
    apiUrl: gh.apiUrl,
    repo: { owner: 'acme', repo: 'shop' },
    staticToken: TOKEN,
  });

beforeEach(async () => {
  gh = await startFakeGitHub({ owner: 'acme', repo: 'shop', token: TOKEN });
  home = mkdtempSync(join(tmpdir(), 'agile-babysit-home-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-babysit-repo-'));
  mustGit(['init', '-q', '-b', 'main']);
  mustGit(['config', 'user.email', 'test@example.com']);
  mustGit(['config', 'user.name', 'Test']);
  commitIn(repo, 'README.md', '# shop\n');
  mustGit(['remote', 'add', 'origin', gh.remoteUrl]);
  mustGit(['push', '-q', 'origin', 'main']);
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  await store.putRepos({
    demo: {
      path: repo,
      protected_branches: ['main'],
      delivery: 'pr',
      auto_merge: true,
      github: { owner: 'acme', repo: 'shop' },
    },
  });
});

afterEach(async () => {
  await store.flush();
  store.close();
  await gh.stop();
  for (const dir of [home, repo]) rmSync(dir, { recursive: true, force: true });
});

/** A work node (a parent and a repo) with an exited worker session and a commit. */
async function workNode(): Promise<{ node: Stream; worktree: string; session: string }> {
  const parent = await streams.create('human', { title: 'Shop', goal: 'sale prices' });
  const worktree = join(repo, '.worktrees', 's-pr');
  mustGit(['worktree', 'add', '-q', '-b', 'stream/s-pr', worktree, 'main']);
  commitIn(worktree, 'price.ts', 'export const price = 1.005;\n');
  const created = await streams.create('human', {
    title: 'api: add salePrice',
    goal: 'add salePrice',
    repo: 'demo',
    parent: parent.id,
  });
  const session = ulid();
  const at = new Date().toISOString();
  await store.putAgent(session as AgentId, {
    vendor: 'fake',
    model: 'fake',
    stream: created.id,
    role: 'worker',
    worktree,
    last_seen: at,
  });
  await streams.update('daemon', created.id, {
    branch: 'stream/s-pr',
    worktree,
    agent: { status: 'done', progress: 'salePrice added', updated_at: at },
  });
  const node = await store.updateStream('daemon', created.id, (before) => ({
    ...before,
    sessions: [{ id: session, vendor: 'fake', model: 'fake', role: 'worker', status: 'stopped' }],
  }));
  return { node, worktree, session };
}

describe('PR babysitting (T246)', () => {
  test('failing check wakes the agent, its fix is delivered, green + approval auto-merges', async () => {
    const { node, worktree, session } = await workNode();
    const delivery = new DeliveryService({ store, streams, github: () => port() });
    const events = new RoutedEventService(store);
    const emit = makeEmitter(events, streams);
    const poller = new PrPoller({
      streams,
      repos: () => store.getRepos(),
      github: () => port(),
      afterTick: () => delivery.settle(),
      emit,
      home,
    });
    const questions = new QuestionService(store, streams);
    const verbs = new VerbService({ store, streams, questions, delivery, events });

    // The human's one click: the first deliver opens PR #1 (auto-merge enabled by settle).
    const first = await delivery.land(node.id);
    expect(first.status).toBe('pr_open');
    expect(streams.get(node.id).delivery_state?.pr?.auto_merge).toBe('enabled');
    // The brief a woken session gets carries the babysit section.
    const brief = buildBrief({
      role: 'worker',
      stream: streams.get(node.id),
      ancestors: [],
      thread: [],
      docs: [],
      rules: [],
    });
    expect(brief).toContain('## Your PR');
    expect(brief).toContain('never skipped');

    // The scripted fake agent: woken by the policy, reads the excerpt, fixes, delivers.
    const woken: string[] = [];
    let wakeRun: Promise<void> = Promise.resolve();
    const wake = (id: string, pending: readonly RoutedEvent[]) => {
      const s = streams.get(id);
      const role = nodeRole(s, liveChildrenOf(s.id, streams.list()));
      if (wakeVerdict(s, role, pending) !== 'wake') return;
      wakeRun = (async () => {
        woken.push(...pending.map((e) => e.type));
        const ci = pending.find((e) => e.type === 'ci_failed');
        if (ci === undefined) return;
        expect(summarize(ci, id)).toContain(String(ci.ref));
        const log = readFileSync(String(ci.ref), 'utf8');
        expect(log).toContain('price.ts:1 rounding');
        commitIn(worktree, 'price.ts', 'export const price = 1.01;\n');
        await events.mark(
          id,
          pending.map((e) => e.id),
          'delivered',
          { session, digest: `D-${ulid()}` },
        );
        const pushed = (await verbs.deliver({ session })) as { status: string };
        expect(pushed.status).toBe('pr_open');
      })();
    };
    const sessions = new SessionDelivery({ events, target: () => undefined, wake, delayMs: 1 });

    try {
      // CI fails on the first push, with a log.
      gh.setCheck('stream/s-pr', 'test', 'failure', 'bun test\nprice.ts:1 rounding: expected 1.01');
      await poller.tick();
      expect(streams.get(node.id).delivery_state?.pr?.checks).toBe('failing');
      const [ciEvent] = events.pendingFor(node.id).map((p) => p.event);
      expect(ciEvent?.type).toBe('ci_failed');
      expect(ciEvent?.ref).toStartWith(join(home, 'sessions', session));
      expect(existsSync(String(ciEvent?.ref))).toBe(true);

      await sessions.flush(node.id);
      await wakeRun;
      expect(woken).toEqual(['ci_failed']);
      // The fix reached the fake remote on the same PR.
      const head = mustGit(['rev-parse', 'HEAD'], worktree);
      expect(mustGit(['rev-parse', 'stream/s-pr'], gh.bareDir)).toBe(head);
      expect(streams.get(node.id).delivery_state?.pr?.number).toBe(1);

      // CI goes green on the new head; a teammate approves; the fake auto-merges.
      gh.setCheck('stream/s-pr', 'test', 'success');
      poller.flag(node.id); // mid-babysit: due now
      await poller.tick();
      expect(streams.get(node.id).delivery_state?.pr?.checks).toBe('passing');
      gh.addReview(1, { state: 'APPROVED', user: 'teammate' });
      poller.flag(node.id);
      await poller.tick();

      const after = streams.get(node.id);
      expect(after.delivery_state?.status).toBe('merged');
      expect(after.delivery_state?.pr?.state).toBe('merged');
      expect(after.human.status).toBe('landed');
    } finally {
      sessions.stop();
    }
  });

  test('deliver refuses before a PR is open, and from a reviewer', async () => {
    const { node, session } = await workNode();
    const delivery = new DeliveryService({ store, streams, github: () => port() });
    await expect(delivery.push(node.id)).rejects.toBeInstanceOf(LandRefusedError);

    const reviewer = ulid();
    await store.putAgent(reviewer as AgentId, {
      vendor: 'fake',
      model: 'fake',
      stream: node.id,
      role: 'reviewer',
      last_seen: new Date().toISOString(),
    });
    const questions = new QuestionService(store, streams);
    const verbs = new VerbService({ store, streams, questions, delivery });
    await expect(verbs.deliver({ session: reviewer })).rejects.toThrow('reviewer');
    await expect(verbs.deliver({ session })).rejects.toThrow('no open PR');
  });
});
