/**
 * T151 — the classifier tier in the hook path (cockpit design §6, §8.1
 * step 3), end to end through `HookService.preToolUse` against a real temp
 * state home.
 *
 * `FakeClassifier` is the only classifier here, as §6.2 requires: there is
 * no network in `bun test` and nothing ever reaches `api.typesafe.ai`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentRecord,
  type ClassifierConfig,
  type HilId,
  type Rule,
  type RuleInput,
  type Stream,
  ulid,
  validateClassifierConfig,
  validateRule,
} from '@agile-agents/shared';
import { Bus } from '../bus';
import { type Answer, ClassifierUnavailableError, FakeClassifier } from '../classifier';
import { GateService } from '../gates';
import { runInit } from '../init';
import type { RuleStatsOutcome } from '../rules/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { wireClassifierRouteStats } from './route-band';
import { HookService } from './service';

let home: string;
let stateRoot: string;
let store: StateStore;
let bus: Bus;
let gates: GateService;
let streams: StreamService;
let stream: Stream;
let worktree: string;

const CONFIG: ClassifierConfig = validateClassifierConfig({ api_key: 'test-key' });

/** A rules service double — the hook only ever needs the scope read and the counter write. */
interface StatCall {
  id: string;
  outcome: RuleStatsOutcome;
}
let ruleSet: Rule[];
let stats: StatCall[];
const rulesDouble = {
  inScope: () => ruleSet,
  recordFired: async (id: string, outcome: 'fired' | 'violated' | 'routed') => {
    stats.push({ id, outcome });
  },
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-hook-classifier-'));
  const init = runInit(home);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
  bus = new Bus(store, init.stateRoot);
  gates = new GateService(store);
  streams = new StreamService(store);
  stream = await streams.create('human', { title: 'stream', goal: 'goal' });
  worktree = join(home, 'wt');
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, 'a.ts'), 'const a = 1;\n');
  ruleSet = [];
  stats = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function classifierRule(over: Partial<RuleInput> = {}): Rule {
  return validateRule({
    id: `R-${ulid()}`,
    text: 'do not add a dependency without asking',
    scope: { kind: 'global' },
    status: 'accepted',
    enforcement: 'classifier',
    critical: false,
    examples: [
      { action: 'npm i left-pad', violates: true },
      { action: 'bun test', violates: false },
    ],
    provenance: { by: 'human' },
    stats: {},
    created_at: new Date().toISOString(),
    ...over,
  });
}

function agentRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    vendor: 'claude',
    model: 'claude-sonnet-4-5',
    stream: stream.id,
    pid: 1,
    role: 'worker',
    worktree,
    last_seen: new Date().toISOString(),
    ...over,
  };
}

async function svc(classifier: FakeClassifier | undefined): Promise<HookService> {
  await store.putAgent('eng-1', agentRecord());
  return new HookService(store, bus, {
    repoRoot: home,
    gates,
    rules: rulesDouble,
    ...(classifier !== undefined ? { classifier: { ask: classifier, config: CONFIG } } : {}),
  });
}

/** A `Bash` call the tiers above the classifier all allow. */
const CALL = { cwd: '', tool_name: 'Bash', tool_input: { command: 'git status' } };

function call(): Record<string, unknown> {
  return { ...CALL, cwd: worktree };
}

function answer(id: string, probability: number, confidence: number): Answer {
  return { id, probability, confidence };
}

describe('§6.3 bands', () => {
  test('probability ≥ deny_at denies, and the reason names the rule', async () => {
    const rule = classifierRule({ name: 'no_new_deps' });
    ruleSet = [rule];
    const fake = new FakeClassifier([answer(rule.id, 0.91, 0.9)]);
    const out = await (await svc(fake)).preToolUse(call());

    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    // The deny reason reaches the model verbatim through the existing
    // `permissionDecisionReason` path (§8.1).
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('no_new_deps');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain(rule.id);
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain(rule.text);
    expect(stats).toContainEqual({ id: rule.id, outcome: 'violated' });
  });

  test('probability < allow_below allows, and the rule only fires', async () => {
    const rule = classifierRule();
    ruleSet = [rule];
    const fake = new FakeClassifier([answer(rule.id, 0.05, 0.99)]);
    const out = await (await svc(fake)).preToolUse(call());

    expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(stats).toEqual([{ id: rule.id, outcome: 'fired' }]);
  });

  test('the middle band routes: a classifier_review gate, and the session blocked until answered', async () => {
    const rule = classifierRule();
    ruleSet = [rule];
    const fake = new FakeClassifier([answer(rule.id, 0.6, 0.9)]);
    const out = await (await svc(fake)).preToolUse(call());

    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('routed to your inbox');
    const raised = gates.list().filter((g) => g.gate === 'classifier_review');
    expect(raised).toHaveLength(1);
    expect(raised[0]?.rule).toBe(rule.id);
    expect(raised[0]?.status).toBe('pending');
    expect(stats).toContainEqual({ id: rule.id, outcome: 'routed' });
  });

  test('confidence < the floor routes whatever the probability — a 0.95 shrug is not a deny', async () => {
    const rule = classifierRule();
    ruleSet = [rule];
    const fake = new FakeClassifier([answer(rule.id, 0.95, 0.2)]);
    const out = await (await svc(fake)).preToolUse(call());

    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('routed to your inbox');
    expect(gates.list().some((g) => g.gate === 'classifier_review')).toBe(true);
  });

  test("the human's approval lets exactly that call through once", async () => {
    const rule = classifierRule();
    ruleSet = [rule];
    const fake = new FakeClassifier([answer(rule.id, 0.6, 0.9)]);
    const hook = await svc(fake);
    await hook.preToolUse(call());
    const gate = gates.list().find((g) => g.gate === 'classifier_review');
    await gates.respond(gate?.id as HilId, 'approve', 'human');

    const second = await hook.preToolUse(call());
    expect(second.hookSpecificOutput?.permissionDecision).toBe('allow');
    const third = await hook.preToolUse(call());
    expect(third.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  /**
   * T153: the deny is recorded as `resolved_violation`, not `violated`.
   * The hook already counted this call as a firing when it routed it, so
   * an ordinary `violated` here counted one logical action twice — the
   * rule read `fired: 2, routed: 1, violated: 1`, which is the number
   * §5.7's pruning report divides by.
   */
  test("the human's deny on a routed call bumps violated without a second firing", async () => {
    const rule = classifierRule();
    ruleSet = [rule];
    wireClassifierRouteStats(gates, rulesDouble);
    const fake = new FakeClassifier([answer(rule.id, 0.6, 0.9)]);
    await (await svc(fake)).preToolUse(call());
    const gate = gates.list().find((g) => g.gate === 'classifier_review');
    await gates.respond(gate?.id as HilId, 'deny', 'human', 'no');

    expect(stats).toEqual([
      { id: rule.id, outcome: 'routed' },
      { id: rule.id, outcome: 'resolved_violation' },
    ]);
  });
});

describe('§6.2 one call, N questions', () => {
  test('ten rules in scope are one round trip with ten Nouls', async () => {
    ruleSet = Array.from({ length: 10 }, () => classifierRule());
    const fake = new FakeClassifier((_state, questions) =>
      questions.map((q) => answer(q.id, 0.1, 0.9)),
    );
    await (await svc(fake)).preToolUse(call());

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.questions).toHaveLength(10);
  });

  test('the question defaults to "Does this action violate: <text>?" and `question` overrides it', async () => {
    const plain = classifierRule();
    const asked = classifierRule({ question: 'Is this a dependency change?' });
    ruleSet = [plain, asked];
    const fake = new FakeClassifier((_s, questions) =>
      questions.map((q) => answer(q.id, 0.1, 0.9)),
    );
    await (await svc(fake)).preToolUse(call());

    expect(fake.calls[0]?.questions[0]?.question).toBe(`Does this action violate: ${plain.text}?`);
    expect(fake.calls[0]?.questions[1]?.question).toBe('Is this a dependency change?');
  });

  test('the state carries the tool, the command and the stream line', async () => {
    ruleSet = [classifierRule()];
    const fake = new FakeClassifier((_s, questions) =>
      questions.map((q) => answer(q.id, 0.1, 0.9)),
    );
    await (await svc(fake)).preToolUse(call());

    const state = fake.calls[0]?.state ?? '';
    expect(state).toContain('tool: Bash');
    expect(state).toContain('command: git status');
    expect(state).toContain(`stream: ${stream.id}`);
  });

  test('an edit call carries the path and the diff hunk instead of a command', async () => {
    ruleSet = [classifierRule()];
    const fake = new FakeClassifier((_s, questions) =>
      questions.map((q) => answer(q.id, 0.1, 0.9)),
    );
    await (await svc(fake)).preToolUse({
      cwd: worktree,
      tool_name: 'Edit',
      tool_input: {
        file_path: join(worktree, 'a.ts'),
        old_string: 'const a = 1;',
        new_string: 'const a = 2;',
      },
    });

    const state = fake.calls[0]?.state ?? '';
    expect(state).toContain('path: ');
    expect(state).toContain('-const a = 1;');
    expect(state).toContain('+const a = 2;');
  });

  test('no classifier rule in scope means no call at all', async () => {
    ruleSet = [];
    const fake = new FakeClassifier([]);
    const out = await (await svc(fake)).preToolUse(call());

    expect(fake.calls).toHaveLength(0);
    expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  test('latency is recorded per call as a classifier_call event', async () => {
    const rule = classifierRule();
    ruleSet = [rule];
    const fake = new FakeClassifier([answer(rule.id, 0.1, 0.9)]);
    await (await svc(fake)).preToolUse(call());
    await store.flush();

    const lines = readFileSync(join(stateRoot, 'log', 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { kind: string; data?: Record<string, unknown> });
    const event = lines.find((e) => e.kind === 'classifier_call');
    expect(event).toBeDefined();
    expect(event?.data?.rules).toBe(1);
    expect(event?.data?.questions).toBe(1);
    expect(event?.data?.outcome).toBe('allow');
    expect(typeof event?.data?.latency_ms).toBe('number');
  });
});

describe('§6.4 fail policy', () => {
  const boom = new ClassifierUnavailableError('timeout', 'classifier timed out');

  test('a critical rule denies when the classifier errors', async () => {
    const rule = classifierRule({ critical: true, name: 'no_migrations' });
    ruleSet = [rule];
    const fake = new FakeClassifier([], { throws: boom });
    const out = await (await svc(fake)).preToolUse(call());

    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('no_migrations');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('classifier timed out');
  });

  test('non-critical rules allow, and the stream thread gets a hook_unchecked entry', async () => {
    const rule = classifierRule();
    ruleSet = [rule];
    const fake = new FakeClassifier([], { throws: boom });
    const out = await (await svc(fake)).preToolUse(call());

    expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
    const thread = store.readThread(stream.id);
    const entry = thread.find((e) => e.body.startsWith('hook_unchecked'));
    expect(entry).toBeDefined();
    expect(entry?.body).toContain(rule.id);
    expect(entry?.by).toBe('daemon');
  });

  test('a mixed set splits: the critical rule denies, the others are marked unchecked', async () => {
    const critical = classifierRule({ critical: true });
    const ordinary = classifierRule();
    ruleSet = [critical, ordinary];
    const fake = new FakeClassifier([], { throws: boom });
    const out = await (await svc(fake)).preToolUse(call());

    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    const entry = store.readThread(stream.id).find((e) => e.body.startsWith('hook_unchecked'));
    expect(entry?.body).toContain(ordinary.id);
    expect(entry?.body).not.toContain(critical.id);
  });

  test('a response that leaves a rule unanswered is that rule failing, not the call', async () => {
    const answered = classifierRule();
    const ignored = classifierRule({ critical: true, name: 'critical_rule' });
    ruleSet = [answered, ignored];
    const fake = new FakeClassifier([answer(answered.id, 0.1, 0.9)]);
    const out = await (await svc(fake)).preToolUse(call());

    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('critical_rule');
  });

  test('the opt-out is the same policy: no call is made, critical denies, the rest are unchecked', async () => {
    await store.updateStream('human', stream.id, (before) => ({ ...before, classifier: 'off' }));
    const critical = classifierRule({ critical: true });
    const ordinary = classifierRule();
    ruleSet = [critical, ordinary];
    const fake = new FakeClassifier([answer(critical.id, 0.01, 0.99)]);
    const out = await (await svc(fake)).preToolUse(call());

    expect(fake.calls).toHaveLength(0);
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    const entry = store.readThread(stream.id).find((e) => e.body.startsWith('hook_unchecked'));
    expect(entry?.body).toContain(ordinary.id);
  });

  test('a home with no classifier wired at all falls under the same policy', async () => {
    const ordinary = classifierRule();
    ruleSet = [ordinary];
    const out = await (await svc(undefined)).preToolUse(call());

    expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(store.readThread(stream.id).some((e) => e.body.startsWith('hook_unchecked'))).toBe(true);
  });
});

describe('order (§8.1)', () => {
  test('a call a tier above already denied is never sent to the classifier', async () => {
    ruleSet = [classifierRule()];
    const fake = new FakeClassifier([]);
    const hook = await svc(fake);
    // `git push origin main` is denied by the built-in pattern tier's
    // role policy long before the classifier tier is reached.
    const out = await hook.preToolUse({
      cwd: worktree,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });

    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(fake.calls).toHaveLength(0);
  });
});
