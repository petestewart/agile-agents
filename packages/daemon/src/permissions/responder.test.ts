import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type KnowledgeItem,
  type RulePattern,
  ulid,
  validateAgentMessage,
  validateKnowledgeItem,
} from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { type PermissionResponderSession, buildPermissionResponder } from './responder';
import type { AcpPermissionRequestParams } from './types';

const WORKER = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
const REVIEWER = '01ARZ3NDEKTSV4RRFFQ69G5FA2';

let repo: string;
let stateRoot: string;
let store: StateStore;

function git(args: string[], cwd: string): void {
  Bun.spawnSync(['git', ...args], { cwd });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-permissions-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'initial commit'], repo);
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const STANDARD_OPTIONS = [
  { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' as const },
  { optionId: 'allow-with-updates', name: 'Yes, always', kind: 'allow_always' as const },
  { optionId: 'reject', name: 'No', kind: 'reject_once' as const },
];

function request(kind: string, rawInput: Record<string, unknown> = {}): AcpPermissionRequestParams {
  return {
    sessionId: 's1',
    toolCall: { toolCallId: 'tc-1', kind, rawInput },
    options: STANDARD_OPTIONS,
  };
}

function fakeSession(): PermissionResponderSession & {
  calls: Array<{ id: unknown; result: unknown }>;
} {
  const calls: Array<{ id: unknown; result: unknown }> = [];
  return {
    calls,
    respondPermission(id, result) {
      calls.push({ id, result });
      return true;
    },
  };
}

describe('buildPermissionResponder', () => {
  test('allow: answers the ACP request with allow_once and logs a hook_decision event', async () => {
    const session = fakeSession();
    const responder = buildPermissionResponder(store, {
      role: 'engineer',
      agent: WORKER,
      worktreePath: '/work/.worktrees/TKT-0001-x',
      session,
    });

    const decision = await responder.handleRequest(
      7,
      request('edit', { file_path: '/work/.worktrees/TKT-0001-x/src/a.ts' }),
    );

    expect(decision.kind).toBe('allow');
    expect(session.calls).toHaveLength(1);
    expect(session.calls[0]?.id).toBe(7);
    expect(session.calls[0]?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    const events = store.listEvents().filter((e) => e.kind === 'hook_decision');
    expect(events).toHaveLength(1);
    expect(events[0]?.data.decision).toBe('allow');
    expect(events[0]?.data.role).toBe('engineer');
  });

  test('deny: answers with reject_once and logs the reason', async () => {
    const session = fakeSession();
    const responder = buildPermissionResponder(store, {
      role: 'reviewer',
      agent: REVIEWER,
      worktreePath: '/qa/env',
      session,
    });

    await responder.handleRequest(1, request('edit', { file_path: '/qa/env/src/a.ts' }));

    expect(session.calls[0]?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
    const events = store.listEvents().filter((e) => e.kind === 'hook_decision');
    expect(events[0]?.data.decision).toBe('deny');
    expect(typeof events[0]?.data.reason).toBe('string');
  });

  test('hil: writes a hil_request message instead of answering, then resolveHil answers it', async () => {
    const session = fakeSession();
    const responder = buildPermissionResponder(store, {
      role: 'engineer',
      agent: WORKER,
      worktreePath: '/work/.worktrees/TKT-0001-x',
      session,
    });

    const decision = await responder.handleRequest(
      42,
      request('execute', { command: 'git push --force origin main' }),
    );
    expect(decision.kind).toBe('hil');
    expect(session.calls).toHaveLength(0); // still pending
    expect(responder.pendingHilCount()).toBe(1);

    const events = store.listEvents().filter((e) => e.kind === 'hook_decision');
    expect(events[0]?.data.decision).toBe('hil');

    // The message is discoverable through the generic entity trio at the
    // documented path (bus/inbox/human/<id>.yaml).
    if (decision.kind !== 'hil') throw new Error('unreachable');
    // We don't get the message id back from handleRequest directly, so
    // recover it the same way a real consumer would: list the human inbox
    // directory the responder wrote into.
    const files = readdirSync(join(stateRoot, 'bus', 'inbox', 'human'));
    expect(files).toHaveLength(1);
    const id = files[0]?.replace(/\.yaml$/, '') ?? '';
    expect(id).not.toBe('');

    const message = store.getEntity(
      join('bus', 'inbox', 'human', `${id}.yaml`),
      validateAgentMessage,
    );
    expect(message.kind).toBe('hil_request');
    expect(message.hil_kind).toBe('classifier_review');
    expect(message.to).toEqual(['human']);

    const resolved = await responder.resolveHil(id, { optionId: 'allow-once' });
    expect(resolved).toBe(true);
    expect(session.calls).toHaveLength(1);
    expect(session.calls[0]?.id).toBe(42);
    expect(session.calls[0]?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(responder.pendingHilCount()).toBe(0);

    // Review-round fix: resolveHil must not ack/delete the message itself —
    // that lifecycle belongs to T018's GateService (or T006's bus ack), not
    // this module.
    expect(
      store.getEntity(join('bus', 'inbox', 'human', `${id}.yaml`), validateAgentMessage).id,
    ).toBe(id);
  });

  test('resolveHil returns false for an unknown/already-resolved id', async () => {
    const session = fakeSession();
    const responder = buildPermissionResponder(store, {
      role: 'engineer',
      agent: WORKER,
      worktreePath: '/work/.worktrees/TKT-0001-x',
      session,
    });
    expect(await responder.resolveHil('nonexistent', { optionId: 'allow-once' })).toBe(false);
  });

  test('requestHil is injectable, so T018 can own persistence instead of the default store writer', async () => {
    const session = fakeSession();
    const calls: Array<{
      agent: string;
      hilKind: string;
      summary: string;
      deadline: string;
    }> = [];
    const responder = buildPermissionResponder(store, {
      role: 'engineer',
      agent: WORKER,
      worktreePath: '/work/.worktrees/TKT-0001-x',
      session,
      requestHil: async (input) => {
        calls.push(input);
        return { id: 'custom-id-1' };
      },
    });

    const decision = await responder.handleRequest(
      99,
      request('execute', { command: 'git push --force origin main' }),
    );
    expect(decision.kind).toBe('hil');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.agent).toBe(WORKER);
    expect(calls[0]?.hilKind).toBe('classifier_review');

    // No message was written to the default bus path — the injected
    // callback owns persistence entirely.
    expect(() => readdirSync(join(stateRoot, 'bus', 'inbox', 'human'))).toThrow();

    const resolved = await responder.resolveHil('custom-id-1', { optionId: 'allow-once' });
    expect(resolved).toBe(true);
    expect(session.calls[0]?.id).toBe(99);
  });
});

/**
 * T143 (review round): the ACP permission tier is the **only** gate a
 * vendor without a pre-tool-use hook has (Cursor, Codex, Grok —
 * design/cockpit-design.md §4.3). When the protected-branch verdict moved
 * out of `policy-tables.ts` and into the `no_push_protected` rule, this
 * tier had to run the same rule pass rather than lose the gate — these
 * assert it does, with the same deny wording and the same stats bump as
 * `hook/decide.ts`.
 */
describe('buildPermissionResponder — pattern rules at the ACP tier', () => {
  function patternRule(
    kind: RulePattern['kind'],
    args: Record<string, unknown> = {},
  ): KnowledgeItem {
    return validateKnowledgeItem({
      id: `K-${ulid()}`,
      kind: 'standard',
      text: 'never push to a protected branch',
      scope: { kind: 'global' },
      status: 'accepted',
      enforcement: 'action',
      check: { by: 'pattern', pattern: { kind, args } },
      critical: true,
      source: { by: 'builtin' },
      stats: {},
      created_at: new Date().toISOString(),
    });
  }

  function gatedResponder(rules: KnowledgeItem[]) {
    const recorded: Array<{ id: string; outcome: string }> = [];
    const session = fakeSession();
    const responder = buildPermissionResponder(store, {
      role: 'engineer',
      agent: WORKER,
      worktreePath: repo,
      session,
      patternRules: {
        rules: () => rules,
        protectedBranches: () => ['main', 'master'],
        record: async (id, outcome) => {
          recorded.push({ id, outcome });
        },
      },
    });
    return { responder, session, recorded };
  }

  test('git push origin main is denied, the reason names the rule, and stats record the violation', async () => {
    const rule = patternRule('no_push_protected');
    const { responder, session, recorded } = gatedResponder([rule]);

    const decision = await responder.handleRequest(
      1,
      request('execute', { command: 'git push origin main' }),
    );

    expect(decision.kind).toBe('deny');
    if (decision.kind !== 'deny') throw new Error('expected a deny');
    expect(decision.reason).toContain(`rule ${rule.id}`);
    expect(decision.reason).toContain('no_push_protected');
    expect(decision.ruleViolated).toBe(rule.id);
    // The ACP request is answered with reject_once, not left hanging.
    expect(session.calls[0]?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
    expect(recorded).toEqual([{ id: rule.id, outcome: 'violated' }]);

    const event = store
      .listEvents()
      .filter((e) => e.kind === 'hook_decision')
      .at(-1);
    expect(event?.data.rule).toBe(rule.id);
  });

  test('a push to an explicitly named non-protected branch is allowed, and bumps fired only (D7)', async () => {
    const rule = patternRule('no_push_protected');
    const { responder, session, recorded } = gatedResponder([rule]);

    const decision = await responder.handleRequest(
      2,
      request('execute', { command: 'git push origin T143-x' }),
    );

    expect(decision.kind).toBe('allow');
    expect(session.calls[0]?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(recorded).toEqual([{ id: rule.id, outcome: 'fired' }]);
  });

  test('a merge into a protected branch is denied by the same rule at this tier', async () => {
    const rule = patternRule('no_push_protected');
    const { responder } = gatedResponder([rule]);
    const decision = await responder.handleRequest(
      3,
      request('execute', { command: 'git checkout main && git merge T143-x' }),
    );
    expect(decision.kind).toBe('deny');
  });

  test('no_worktree_escape catches a git -C outside the worktree at this tier', async () => {
    const { responder } = gatedResponder([patternRule('path_deny', { globs: [] })]);
    const decision = await responder.handleRequest(
      4,
      request('execute', { command: 'git -C /somewhere/else commit -m x' }),
    );
    expect(decision.kind).toBe('deny');
  });

  test('the review evasions are closed at this tier too: HEAD, an alias, the push plumbing', async () => {
    const rule = patternRule('no_push_protected');
    // `repo`'s checked-out branch is whatever `git init` defaulted to; the
    // responder resolves it through the same lazy `git rev-parse` lookup,
    // so name that branch protected and `HEAD` must resolve onto it.
    const head = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })
      .stdout.toString()
      .trim();
    const session = fakeSession();
    const responder = buildPermissionResponder(store, {
      role: 'engineer',
      agent: WORKER,
      worktreePath: repo,
      session,
      patternRules: {
        rules: () => [rule],
        protectedBranches: () => [head],
        record: async () => {},
      },
    });

    let id = 10;
    for (const command of [
      'git push origin HEAD',
      'git push origin @',
      'git -c alias.p=push p origin whatever',
      'git send-pack origin refs/heads/x:refs/heads/main',
      'git http-push https://x refs/heads/main',
      'git remote-ext origin',
    ]) {
      const decision = await responder.handleRequest(id++, request('execute', { command }));
      expect(decision.kind).toBe('deny');
    }
    // Still not an allow-list of git.
    const ok = await responder.handleRequest(id, request('execute', { command: 'git remote -v' }));
    expect(ok.kind).toBe('allow');
  });

  test('with no rules wired the tier behaves exactly as it did before T143', async () => {
    const { responder, recorded } = gatedResponder([]);
    const decision = await responder.handleRequest(
      5,
      request('execute', { command: 'git push origin main' }),
    );
    expect(decision.kind).toBe('allow');
    expect(recorded).toEqual([]);
  });
});
