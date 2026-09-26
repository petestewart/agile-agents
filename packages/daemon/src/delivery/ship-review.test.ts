/**
 * T262: the ship check at delivery (projects-design §6). Real git, real
 * `DeliveryService`, `KnowledgeService`, `GateService` and routed events;
 * the `FakeClassifier` and a fake reviewer only. The last block runs the
 * session reviewer over a real `AttachService` and the fake ACP agent, to
 * show the checklist in the reviewer's `brief.md`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, type AcpProviderConfig } from '@agile-agents/acp-client';
import type { KnowledgeItem, RoutedEvent, Stream, StreamFinding } from '@agile-agents/shared';
import { AttachService } from '../attach/service';
import { FakeClassifier } from '../classifier';
import { makeEmitter, summarize } from '../events/producers';
import { RoutedEventService } from '../events/service';
import { wakesRole } from '../events/wake';
import { GateService } from '../gates/service';
import { runInit } from '../init';
import { KnowledgeService } from '../knowledge/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { ClassifierDiffRules } from './diff-rules';
import { DeliveryService, wireLandGateResolution } from './service';
import {
  SessionShipReviewer,
  ShipChecks,
  type ShipReviewResult,
  type ShipReviewer,
  renderChecklist,
} from './ship-review';

const ENV = { TYPESAFE_API_KEY: 'test-key' };

let home: string;
let repo: string;
let store: StateStore;
let streams: StreamService;
let rules: KnowledgeService;
let gates: GateService;
let events: RoutedEventService;
let emitted: RoutedEvent[];

function git(args: string[], cwd = repo): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function commit(worktree: string, file: string, contents: string): void {
  writeFileSync(join(worktree, file), contents);
  git(['add', '-A'], worktree);
  git(['commit', '-q', '-m', `edit ${file}`], worktree);
}

async function workStream(name: string, file: string, contents: string): Promise<Stream> {
  const worktree = join(repo, '.worktrees', name);
  git(['worktree', 'add', '-q', '-b', name, worktree, 'main']);
  commit(worktree, file, contents);
  const created = await streams.create('human', { title: 'Prices', goal: 'ship', repo: 'demo' });
  return streams.update('daemon', created.id, { branch: name, worktree });
}

async function accept(
  text: string,
  enforcement: 'ship' | 'review',
  paths?: string[],
): Promise<KnowledgeItem> {
  const proposed = await rules.create('human', {
    text,
    enforcement,
    ...(paths ? { paths } : {}),
    ...(enforcement === 'ship'
      ? {
          check: {
            by: 'classifier',
            examples: [
              { action: 'a violating change', violates: true },
              { action: 'an innocent change', violates: false },
            ],
          },
        }
      : {}),
  });
  return rules.accept(proposed.id, 'pete');
}

/** Scripted per call; records the checklist it was handed. */
class FakeReviewer implements ShipReviewer {
  readonly checklists: string[][] = [];
  constructor(public next: ShipReviewResult) {}
  async review(_ctx: unknown, checklist: KnowledgeItem[]): Promise<ShipReviewResult> {
    this.checklists.push(checklist.map((item) => item.text));
    return this.next;
  }
}

function build(classifier: FakeClassifier, reviewer?: ShipReviewer): DeliveryService {
  const diffRules = new ShipChecks({
    classifier: new ClassifierDiffRules({
      rules,
      classifier,
      config: {
        provider: 'jev',
        base_url: 'https://api.typesafe.ai',
        timeout_ms: 25_000,
        state_max_chars: 60_000,
        bands: { deny_at: 0.8, allow_below: 0.4 },
      },
      streams,
      policy: () => store.getPolicy(),
      repos: () => store.getRepos(),
      gates,
      env: ENV,
    }),
    rules,
    gates,
    policy: () => store.getPolicy(),
    emit: makeEmitter(events, streams),
    ...(reviewer ? { reviewer } : {}),
  });
  const landing = new DeliveryService({ store, streams, diffRules, gates });
  wireLandGateResolution(gates, landing);
  return landing;
}

const allowAll = () =>
  new FakeClassifier((_s, qs) => qs.map((q) => ({ id: q.id, probability: 0 })));

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-ship-home-'));
  repo = mkdtempSync(join(tmpdir(), 'agile-ship-repo-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  rules = new KnowledgeService({ store, streams, statsFlushMs: 0 });
  gates = new GateService(store);
  events = new RoutedEventService(store);
  emitted = [];
  events.onEmitted((event) => emitted.push(event));
  await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
});

afterEach(async () => {
  await rules.flushStats();
  await store.flush();
  store.close();
  for (const dir of [home, repo]) rmSync(dir, { recursive: true, force: true });
});

describe('the classifier step (ship items)', () => {
  test('a violation holds delivery and goes back to the worker; a fix passes', async () => {
    await accept('Every change to prices.ts has a test', 'ship');
    const stream = await workStream('s-prices', 'prices.ts', 'export const p = 1;\n');
    // Violates until a test file is in the diff.
    const classifier = new FakeClassifier((state, qs) =>
      qs.map((q) => ({ id: q.id, probability: state.includes('prices.test.ts') ? 0 : 1 })),
    );
    const landing = build(classifier);

    const held = await landing.land(stream.id);
    expect(held.status).toBe('refused');
    expect(streams.get(stream.id).delivery_state?.status).toBe('held');
    const event = emitted.find((e) => e.type === 'ship_findings');
    expect(event?.routing).toEqual([{ node: stream.id, because: 'self' }]);
    expect(event?.payload.source).toBe('classifier');
    expect(summarize(event as RoutedEvent, stream.id)).toContain('Every change to prices.ts');
    expect(summarize(event as RoutedEvent, stream.id)).toContain('`ask`');

    commit(stream.worktree as string, 'prices.test.ts', 'test\n');
    const passed = await landing.land(stream.id);
    expect(passed.status).toBe('landed');
  });

  test('an unsure classifier answer reaches the inbox, not the worker', async () => {
    await accept('Prices are in cents', 'ship');
    const stream = await workStream('s-route', 'prices.ts', 'x\n');
    const landing = build(
      new FakeClassifier((_s, qs) => qs.map((q) => ({ id: q.id, probability: 0.5 }))),
    );
    const outcome = await landing.land(stream.id);
    expect(outcome.status).toBe('gated');
    expect(gates.list().filter((g) => g.status === 'pending')).toHaveLength(1);
    expect(emitted.filter((e) => e.type === 'ship_findings')).toHaveLength(0);
  });
});

describe('the reviewer step (review items)', () => {
  test('findings hold delivery and wake the worker; a fix passes', async () => {
    await accept('Money goes through the Money type', 'review');
    await accept('Blog posts have a slug', 'review', ['blog/**']);
    const stream = await workStream('s-review', 'prices.ts', 'export const p = 1.5;\n');
    const finding: StreamFinding = {
      severity: 'major',
      file: 'prices.ts',
      line: 1,
      text: 'a float price, not Money',
    };
    const reviewer = new FakeReviewer({ status: 'findings', findings: [finding] });
    const landing = build(allowAll(), reviewer);

    expect((await landing.land(stream.id)).status).toBe('refused');
    // Only the item in scope for the changed files is on the checklist.
    expect(reviewer.checklists[0]).toEqual(['Money goes through the Money type']);
    expect(streams.get(stream.id).delivery_state?.held_by?.[0]?.reason).toBe('ship_check');
    const event = emitted.find((e) => e.type === 'ship_findings');
    expect(event?.payload).toEqual({
      source: 'reviewer',
      findings: ['major prices.ts:1: a float price, not Money'],
    });
    expect(wakesRole('work', 'ship_findings')).toBe(true);

    commit(stream.worktree as string, 'prices.ts', 'export const p = money(150);\n');
    reviewer.next = { status: 'pass' };
    expect((await landing.land(stream.id)).status).toBe('landed');
  });

  test('a running review holds delivery until it finishes', async () => {
    await accept('Money goes through the Money type', 'review');
    const stream = await workStream('s-running', 'prices.ts', 'x\n');
    const reviewer = new FakeReviewer({ status: 'running' });
    const landing = build(allowAll(), reviewer);
    const outcome = await landing.land(stream.id);
    expect(outcome.status).toBe('refused');
    expect(streams.get(stream.id).delivery_state?.status).toBe('held');
    expect(emitted.filter((e) => e.type === 'ship_findings')).toHaveLength(0);
  });

  test('an unsure review goes to the inbox; approving it lands', async () => {
    await accept('Money goes through the Money type', 'review');
    const stream = await workStream('s-unsure', 'prices.ts', 'x\n');
    const reviewer = new FakeReviewer({ status: 'unsure', reason: 'reviewer crashed' });
    const landing = build(allowAll(), reviewer);
    const outcome = await landing.land(stream.id);
    expect(outcome.status).toBe('gated');
    const gate = gates.list().find((g) => g.status === 'pending');
    expect(gate?.summary).toContain('reviewer crashed');
    await gates.respond(gate?.id as never, 'approve', 'human');
    expect(streams.get(stream.id).delivery_state?.status).toBe('merged');
  });

  test('no review items in scope: the reviewer is never asked', async () => {
    const stream = await workStream('s-none', 'prices.ts', 'x\n');
    const reviewer = new FakeReviewer({ status: 'findings', findings: [] });
    const landing = build(allowAll(), reviewer);
    expect((await landing.land(stream.id)).status).toBe('landed');
    expect(reviewer.checklists).toHaveLength(0);
  });
});

describe('the session reviewer', () => {
  test('the checklist is in the reviewer brief.md; a clean exit is a pass', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'agile-ship-scratch-'));
    try {
      const item = await accept('Money goes through the Money type', 'review');
      const script = join(scratch, 'script.json');
      writeFileSync(
        script,
        JSON.stringify({
          steps: [{ type: 'agent_text', text: 'checked' }, { type: 'end_turn' }],
        }),
      );
      const provider: AcpProviderConfig = {
        ...ACP_PROVIDERS.claude,
        command: 'bun',
        args: [join(import.meta.dir, '..', 'runner', 'fake-agent.ts')],
        envOverrides: { AGILE_FAKE_AGENT_SCRIPT: script },
      };
      const attach = new AttachService({ store, streams, home, provider: () => provider });
      const finished: string[] = [];
      const reviewer = new SessionShipReviewer({
        attach,
        streams,
        onFinished: (id) => finished.push(id),
      });
      const stream = await streams.create('human', { title: 'Prices', goal: 'ship' });
      const diff = 'diff --git a/prices.ts b/prices.ts\n+x\n';
      const ctx = { stream, repoRoot: repo, branch: 'b', target: 'main', diff: () => diff };

      expect((await reviewer.review(ctx, [item], 'k1')).status).toBe('running');
      expect((await reviewer.review(ctx, [item], 'k1')).status).toBe('running');
      const deadline = Date.now() + 20_000;
      while (finished.length === 0 && Date.now() < deadline) await Bun.sleep(20);
      expect(finished).toEqual([stream.id]);
      expect((await reviewer.review(ctx, [item], 'k1')).status).toBe('pass');

      const session = streams.get(stream.id).sessions.find((s) => s.role === 'reviewer');
      const brief = join(home, 'sessions', session?.id as string, 'brief.md');
      expect(existsSync(brief)).toBe(true);
      const text = readFileSync(brief, 'utf8');
      expect(text).toContain('## Ship review checklist');
      expect(text).toContain('- [ ] Money goes through the Money type');
      expect(renderChecklist([item], ['prices.ts'])).toContain('1 changed file)');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
