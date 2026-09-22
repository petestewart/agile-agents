/**
 * T143 acceptance at the hook level: the built-in pattern rules of §5.4,
 * enforced through `HookService.preToolUse` against a real state home, a
 * real registry entry and a real git worktree — no vendor, no network.
 *
 * What these assert beyond the detector's own table
 * (`permissions/push-detector.test.ts`): the deny **names the rule**, the
 * rule's `stats` are bumped (`fired` always, `violated` on a deny — §5.7's
 * pruning input), the `hook_decision` event records which rule refused,
 * the protected branches come from `repos.yaml` (D8) rather than from the
 * rule, and retiring the rule stops it gating on the very next tool call
 * (§5.3) — which is the whole reason these are rules and not a table.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRecord, Rule } from '@agile-agents/shared';
import { Bus } from '../bus';
import { runInit } from '../init';
import { ensureBuiltinRules } from '../rules/builtins';
import { RulesService } from '../rules/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { HookService } from './service';

const BRANCH = 'T143-x';

let repo: string;
let store: StateStore;
let bus: Bus;
let rules: RulesService;
let hooks: HookService;
let stream: string;
const session = 'worker-1';

function git(args: string[], cwd = repo): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-hook-rules-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  // The session works on its own branch, with no upstream — so a bare
  // `git push` is genuinely unresolvable here, which is a row below.
  git(['checkout', '-q', '-b', BRANCH]);

  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  bus = new Bus(store, init.stateRoot);
  const streams = new StreamService(store);
  rules = new RulesService({ store, streams });

  await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
  const created = await streams.create('human', { title: 'rules', goal: 'gate me', repo: 'demo' });
  stream = created.id;
  const record: AgentRecord = {
    vendor: 'claude',
    model: 'claude-sonnet-4-5',
    stream,
    pid: 4242,
    role: 'worker',
    worktree: repo,
    last_seen: new Date().toISOString(),
  };
  await store.putAgent(session, record);
  await ensureBuiltinRules(store);
  hooks = new HookService(store, bus, { rules });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function bash(command: string) {
  return {
    cwd: repo,
    session_id: session,
    agile_agent: session,
    tool_name: 'Bash',
    tool_input: { command },
  };
}

async function decide(command: string): Promise<{ decision: string; reason: string }> {
  const out = await hooks.preToolUse(bash(command));
  return {
    decision: out.hookSpecificOutput.permissionDecision,
    reason: out.hookSpecificOutput.permissionDecisionReason ?? '',
  };
}

function ruleOfKind(kind: string): Rule {
  const found = store.listRules().find((rule) => rule.pattern?.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} rule`);
  return found;
}

test('a push to a protected branch is denied, the deny names the rule, and stats record it', async () => {
  const before = ruleOfKind('no_push_protected');
  const { decision, reason } = await decide('git push origin main');

  expect(decision).toBe('deny');
  expect(reason).toContain(`rule ${before.id}`);
  expect(reason).toContain('no_push_protected');
  expect(reason).toContain('main');

  const after = store.getRule(before.id);
  expect(after.stats.fired).toBe(1);
  expect(after.stats.violated).toBe(1);
  expect(after.stats.last_fired_at).toBeString();

  // The log answers "why was I denied" on its own (§5.4's built-ins are
  // global and critical, so a post-mortem must not need the transcript).
  const event = store
    .listEvents()
    .filter((e) => e.kind === 'hook_decision')
    .at(-1);
  expect(event?.data?.rule).toBe(before.id);
  expect(event?.data?.decision).toBe('deny');
});

test('an allowed call still bumps fired for every rule that was evaluated, and violated for none', async () => {
  const { decision } = await decide(`git push origin ${BRANCH}`);
  expect(decision).toBe('allow');

  const evaluated = store.listRules().filter((rule) => rule.status === 'accepted');
  expect(evaluated).toHaveLength(2); // no_push_protected + no_worktree_escape; no_push is retired
  for (const rule of evaluated) {
    expect(rule.stats.fired).toBe(1);
    expect(rule.stats.violated).toBe(0);
  }
  // The retired one was never evaluated at all (§5.3).
  expect(ruleOfKind('no_push').stats.fired).toBe(0);
});

test('a bare `git push` with no upstream is denied, not guessed at (§5.4)', async () => {
  const { decision, reason } = await decide('git push');
  expect(decision).toBe('deny');
  expect(reason).toContain('upstream');
});

test('the acceptance criterion: a merge into a protected branch inside the worktree is denied by the same rule', async () => {
  const { decision, reason } = await decide(`git checkout main && git merge ${BRANCH}`);
  expect(decision).toBe('deny');
  expect(reason).toContain(ruleOfKind('no_push_protected').id);
  expect(reason).toContain('merging into main');
});

test('git stash push and git log --grep push are ordinary work', async () => {
  expect((await decide('git stash push')).decision).toBe('allow');
  expect((await decide('git log --grep push')).decision).toBe('allow');
});

test('an obfuscated git invocation fails closed', async () => {
  const { decision, reason } = await decide('$(echo git) push origin main');
  expect(decision).toBe('deny');
  // The role policy's own "unclassifiable" gate gets there first and routes
  // it; either way the call never reaches `allow`, which is the property.
  expect(reason.length).toBeGreaterThan(0);
});

test('no_worktree_escape catches a git -C outside the session worktree', async () => {
  // The engineer role table already denies an out-of-worktree `Edit` before
  // the rule pass is reached — this is the case it did not cover once the
  // hardcoded `git -C` hil was deleted.
  const outside = mkdtempSync(join(tmpdir(), 'agile-elsewhere-'));
  try {
    const { decision, reason } = await decide(`git -C ${outside} commit -m x`);
    expect(decision).toBe('deny');
    expect(reason).toContain(ruleOfKind('path_deny').id);
    expect(reason).toContain(outside);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the protected branches come from repos.yaml, not from the rule (D8)', async () => {
  await store.putRepos({ demo: { path: repo, protected_branches: ['trunk'] } });
  expect((await decide('git push origin main')).decision).toBe('allow');
  expect((await decide('git push origin trunk')).decision).toBe('deny');
});

test('retiring the rule stops it gating on the next tool call, with no restart (§5.3)', async () => {
  expect((await decide('git push origin main')).decision).toBe('deny');
  await rules.retire(ruleOfKind('no_push_protected').id, 'pete');
  expect((await decide('git push origin main')).decision).toBe('allow');
});

test('accepting the retired no_push rule gates every push, including to the ticket branch (D7)', async () => {
  expect((await decide(`git push origin ${BRANCH}`)).decision).toBe('allow');
  await rules.accept(ruleOfKind('no_push').id, 'pete');
  const { decision, reason } = await decide(`git push origin ${BRANCH}`);
  expect(decision).toBe('deny');
  expect(reason).toContain('no_push');
});
