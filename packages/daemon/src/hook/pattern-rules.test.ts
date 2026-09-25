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
import { type AgentRecord, type KnowledgeItem, patternOf } from '@agile-agents/shared';
import { Bus } from '../bus';
import { runInit } from '../init';
import { ensureBuiltinKnowledge } from '../knowledge/builtins';
import { KnowledgeService } from '../knowledge/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { HookService } from './service';

const BRANCH = 'T143-x';

let repo: string;
let store: StateStore;
let bus: Bus;
let rules: KnowledgeService;
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
  // No flush timer: these tests own the flush point.
  rules = new KnowledgeService({ store, streams, statsFlushMs: 0 });

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
  await ensureBuiltinKnowledge(store);
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

function ruleOfKind(kind: string): KnowledgeItem {
  const found = store.listKnowledge().find((rule) => patternOf(rule)?.kind === kind);
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

  // Counters are coalesced (§5.7 is telemetry, not a decision): the read
  // side of `KnowledgeService` merges what is still pending, and a flush is
  // what puts it on disk.
  const pending = rules.get(before.id);
  expect(pending.stats.fired).toBe(1);
  expect(pending.stats.violated).toBe(1);
  expect(pending.stats.last_fired_at).toBeString();
  await rules.flushStats();
  expect(store.getKnowledge(before.id).stats).toMatchObject({ fired: 1, violated: 1 });

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

  await rules.flushStats();
  const evaluated = store.listKnowledge().filter((rule) => rule.status === 'accepted');
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

test('the review evasions, at the hook tier: HEAD, an alias, and the push plumbing', async () => {
  // On `T143-x`, `HEAD` is the ticket branch — ordinary work.
  expect((await decide('git push origin HEAD')).decision).toBe('allow');
  // On a protected branch it is a push to that branch, resolved through the
  // worktree's real `git rev-parse --abbrev-ref HEAD`.
  git(['checkout', '-q', 'main']);
  const onMain = await decide('git push origin HEAD');
  expect(onMain.decision).toBe('deny');
  expect(onMain.reason).toContain('main');
  git(['checkout', '-q', BRANCH]);

  for (const command of [
    'git -c alias.p=push p origin main',
    'git -c alias.p=push p origin T143-x',
    'git send-pack origin refs/heads/x:refs/heads/main',
    'git http-push https://x refs/heads/main',
    'git remote-ext origin',
  ]) {
    const { decision, reason } = await decide(command);
    expect(decision).toBe('deny');
    expect(reason).toContain(ruleOfKind('no_push_protected').id);
  }

  // Not an allow-list of git: an unnamed subcommand still passes.
  expect((await decide('git remote -v')).decision).toBe('allow');
  expect((await decide('git bisect start')).decision).toBe('allow');
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

test('T336: a read-only git -C into another readable repo is not an escape (a write still is)', async () => {
  // A sibling repo the node may read (T213). Claude's Bash payload shape.
  const sibling = mkdtempSync(join(tmpdir(), 'agile-sibling-'));
  try {
    await store.putRepos({
      demo: { path: repo, protected_branches: ['main'] },
      sibling: { path: sibling, protected_branches: ['main'] },
    });
    for (const command of [
      `git -C ${sibling} log --oneline -5`,
      `git -C ${sibling} status`,
      `git -C ${sibling} diff main`,
      `git -C ${sibling} show HEAD:README.md`,
    ]) {
      expect(await decide(command)).toEqual({ decision: 'allow', reason: '' });
    }
    for (const command of [
      `git -C ${sibling} commit -m x`,
      `git -C ${sibling} checkout -b y`,
      `git -C ${sibling} log --output=${sibling}/x`,
      // `~` is the home directory, never a `~` folder inside the worktree.
      'git -C ~/elsewhere commit -m x',
      'git -C $HOME/elsewhere commit -m x',
    ]) {
      expect((await decide(command)).decision).toBe('deny');
    }
  } finally {
    rmSync(sibling, { recursive: true, force: true });
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

test('T169: a command_deny hit on `rm -rf dist` writes one thread entry naming the rule', async () => {
  const created = await rules.create('human', {
    text: 'never wipe build output',
    enforcement: 'action',
    check: { by: 'pattern', pattern: { kind: 'command_deny', args: { patterns: ['rm -rf'] } } },
    scope: { kind: 'global' },
  });
  await rules.accept(created.id, 'human');
  const before = store.readThread(stream).length;

  const { decision } = await decide('rm -rf dist');
  expect(decision).toBe('deny');

  const added = store.readThread(stream).slice(before);
  expect(added).toHaveLength(1);
  const [entry] = added;
  expect(entry?.kind).toBe('event');
  expect(entry?.by).toBe('daemon');
  expect(entry?.ref).toBe(created.id);
  expect(entry?.body).toContain(created.id);
  expect(entry?.body).toContain('never wipe build output');
  expect(entry?.body).toContain('rm -rf dist');
  expect(entry?.body).toContain('denied');

  // An allowed call writes nothing.
  await decide('ls dist');
  expect(store.readThread(stream).length).toBe(before + 1);
});

test('T169: three identical denied retries leave one thread entry; a new target or rule adds one', async () => {
  const wipe = await rules.create('human', {
    text: 'never wipe build output',
    enforcement: 'action',
    check: { by: 'pattern', pattern: { kind: 'command_deny', args: { patterns: ['rm -rf'] } } },
    scope: { kind: 'global' },
  });
  await rules.accept(wipe.id, 'human');
  const curl = await rules.create('human', {
    text: 'no network fetches',
    enforcement: 'action',
    check: { by: 'pattern', pattern: { kind: 'command_deny', args: { patterns: ['curl'] } } },
    scope: { kind: 'global' },
  });
  await rules.accept(curl.id, 'human');
  const before = store.readThread(stream).length;
  const hits = () => store.readThread(stream).slice(before);

  for (let i = 0; i < 3; i++) expect((await decide('rm -rf dist')).decision).toBe('deny');
  expect(hits()).toHaveLength(1);
  // The repeats are counted in the log instead.
  const repeats = store
    .listEvents()
    .filter((e) => e.kind === 'hook_decision' && e.data?.thread_repeat === true);
  expect(repeats).toHaveLength(2);

  expect((await decide('rm -rf build')).decision).toBe('deny');
  expect(hits()).toHaveLength(2);
  expect((await decide('curl https://example.com')).decision).toBe('deny');
  expect(hits()).toHaveLength(3);
  expect(hits().map((e) => e.ref)).toEqual([wipe.id, wipe.id, curl.id]);
});
