import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type KnowledgeItem,
  type RulePattern,
  ulid,
  validateKnowledgeItem,
} from '@agile-agents/shared';
import { GateService } from '../gates';
import { acpHilRouter } from '../hook/route-band';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import {
  type PermissionResponderContext,
  type PermissionResponderSession,
  type RoutedVerdict,
  buildPermissionResponder,
} from './responder';
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

  test('T305: a coordinator read scope reaches decidePermission', async () => {
    const responder = buildPermissionResponder(store, {
      role: 'coordinator',
      agent: WORKER,
      worktreePath: '/home/u/.agile/sessions/s1',
      session: fakeSession(),
      readRoots: ['/repos/shop'],
      hiddenRoots: ['/home/u/.agile'],
    });
    expect(
      (await responder.handleRequest(1, request('read', { file_path: '/repos/shop/a.ts' }))).kind,
    ).toBe('allow');
    expect(
      (
        await responder.handleRequest(
          2,
          request('read', { file_path: '/home/u/.agile/config.yaml' }),
        )
      ).kind,
    ).toBe('deny');
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

  test('T524: a held call with no route is refused, never parked', async () => {
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
    expect(decision.kind).toBe('deny');
    expect(session.calls).toEqual([
      { id: 42, result: { outcome: { outcome: 'selected', optionId: 'reject' } } },
    ]);
    expect(responder.cancelPending()).toBe(0);
    const events = store.listEvents().filter((e) => e.kind === 'hook_decision');
    expect(events[0]?.data.decision).toBe('deny');
    expect(String(events[0]?.data.reason)).toContain('nothing here can hold it for the human');
    // The old parked record is gone with the parking.
    expect(existsSync(join(stateRoot, 'bus', 'inbox', 'human'))).toBe(false);
  });
});

/**
 * T524: a vendor without a pre-tool hook (Cursor, Gemini, Grok) has only
 * this tier, and a call it holds for the human was parked: the ACP request
 * left pending, a `hil_request` nobody read, the node `working` forever.
 * Now it is the hook's route band: one Needs me card per call, a refusal
 * now, the retry let through once on approval, refused on denial.
 */
describe('T524: a held ACP call raises a Needs me card instead of parking the turn', () => {
  const HOOKLESS_OPTIONS = [
    { optionId: 'yes', name: 'Allow', kind: 'allow_once' as const },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' as const },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
  ];
  const ALLOW = { outcome: { outcome: 'selected', optionId: 'yes' } };
  const REJECT = { outcome: { outcome: 'selected', optionId: 'no' } };
  const CANCELLED = { outcome: { outcome: 'cancelled' } };

  let gates: GateService;
  let stream: string;

  beforeEach(async () => {
    gates = new GateService(store);
    stream = (await new StreamService(store).create('human', { title: 'n', goal: 'g' })).id;
  });

  function held(
    toolCall: AcpPermissionRequestParams['toolCall'],
    options: AcpPermissionRequestParams['options'] = HOOKLESS_OPTIONS,
  ): AcpPermissionRequestParams {
    return { sessionId: 's1', toolCall, options };
  }

  function hookless(
    session: PermissionResponderSession,
    routeHil: PermissionResponderContext['routeHil'] = acpHilRouter({
      gates,
      store,
      session: WORKER,
      stream,
      worktreePath: repo,
    }),
  ) {
    return buildPermissionResponder(store, {
      role: 'engineer',
      agent: WORKER,
      worktreePath: repo,
      session,
      hooked: false,
      ...(routeHil !== undefined ? { routeHil } : {}),
    });
  }

  function answers(session: ReturnType<typeof fakeSession>): unknown[] {
    return session.calls.map((call) => call.result);
  }

  function noParkedRecord(): void {
    expect(existsSync(join(stateRoot, 'bus', 'inbox', 'human'))).toBe(false);
  }

  const HELD_CALLS: Array<[string, () => AcpPermissionRequestParams['toolCall'], object]> = [
    [
      'an exec the daemon cannot read',
      () => ({ toolCallId: 'tc', kind: 'execute', title: 'Terminal', rawInput: {} }),
      { tool: 'Bash' },
    ],
    [
      'a sudo',
      () => ({ toolCallId: 'tc', kind: 'execute', rawInput: { command: 'sudo whoami' } }),
      { tool: 'Bash', command: 'sudo whoami' },
    ],
    [
      'a package.json edit',
      () => ({
        toolCallId: 'tc',
        kind: 'edit',
        rawInput: { file_path: join(repo, 'package.json') },
      }),
      { tool: 'Edit' },
    ],
  ];

  for (const [name, toolCall, shown] of HELD_CALLS) {
    test(`${name}: one card however often it is asked; approved, the retry goes through once`, async () => {
      const session = fakeSession();
      const responder = hookless(session);

      // Refused now with a card, and the same call again while it waits reuses that card.
      expect((await responder.handleRequest(1, held(toolCall()))).kind).toBe('deny');
      expect((await responder.handleRequest(2, held(toolCall()))).kind).toBe('deny');
      expect(answers(session)).toEqual([REJECT, REJECT]);
      const cards = gates.list();
      expect(cards).toHaveLength(1);
      const card = cards[0];
      if (card === undefined) throw new Error('no card');
      expect(card).toMatchObject({
        gate: 'classifier_review',
        status: 'pending',
        stream,
        session: WORKER,
        requested_by: WORKER,
      });
      expect(card.call).toMatchObject(shown);
      expect(card.summary?.length).toBeGreaterThan(0);

      // Approved: that call goes through once (allow_once, never allow_always), then is held again.
      await gates.respond(card.id, 'approve', 'pete');
      expect((await responder.handleRequest(3, held(toolCall()))).kind).toBe('allow');
      expect(session.calls.at(-1)).toEqual({ id: 3, result: ALLOW });
      expect(gates.get(card.id).consumed_at).toBeDefined();
      const allowed = store
        .listEvents()
        .filter((e) => e.kind === 'hook_decision' && e.data.decision === 'allow');
      expect(allowed.map((e) => e.data.allowed_by)).toEqual([card.id]);
      expect((await responder.handleRequest(4, held(toolCall()))).kind).toBe('deny');
      expect(session.calls.at(-1)).toEqual({ id: 4, result: REJECT });
      expect(answers(session)).not.toContainEqual({
        outcome: { outcome: 'selected', optionId: 'always' },
      });
      // Every request answered, none left waiting, nothing parked.
      expect(session.calls.map((c) => c.id)).toEqual([1, 2, 3, 4]);
      expect(responder.cancelPending()).toBe(0);
      noParkedRecord();
    });

    test(`${name}: denied, the retry is refused and raises no second card`, async () => {
      const session = fakeSession();
      const responder = hookless(session);
      await responder.handleRequest(1, held(toolCall()));
      const card = gates.list()[0];
      if (card === undefined) throw new Error('no card');
      await gates.respond(card.id, 'deny', 'pete', 'not on this machine');

      const retry = await responder.handleRequest(2, held(toolCall()));
      expect(retry.kind).toBe('deny');
      if (retry.kind !== 'deny') throw new Error('expected a deny');
      expect(retry.reason).toContain('not on this machine');
      expect(answers(session)).toEqual([REJECT, REJECT]);
      expect(gates.list()).toHaveLength(1);
      noParkedRecord();
    });
  }

  test('an exec it cannot read is keyed by its title: yes to one is not yes to another', async () => {
    const session = fakeSession();
    const responder = hookless(session);
    const blind = (title: string) =>
      held({ toolCallId: 'tc', kind: 'execute', title, rawInput: {} });
    await responder.handleRequest(1, blind('Terminal'));
    const card = gates.list()[0];
    if (card === undefined) throw new Error('no card');
    await gates.respond(card.id, 'approve', 'pete');

    expect((await responder.handleRequest(2, blind('Shell'))).kind).toBe('deny');
    expect(gates.list().filter((g) => g.status === 'pending')).toHaveLength(1);
    expect((await responder.handleRequest(3, blind('Terminal'))).kind).toBe('allow');
  });

  test('two identical held calls in flight at once raise one card', async () => {
    const session = fakeSession();
    const responder = hookless(session);
    const sudo = () =>
      held({ toolCallId: 'tc', kind: 'execute', rawInput: { command: 'sudo id' } });
    await Promise.all([responder.handleRequest(1, sudo()), responder.handleRequest(2, sudo())]);
    expect(gates.list()).toHaveLength(1);
    expect(answers(session)).toEqual([REJECT, REJECT]);
  });

  test('stopping answers a held call still being routed, once, and routes nothing after', async () => {
    const session = fakeSession();
    let release!: (verdict: RoutedVerdict) => void;
    let routed = 0;
    const responder = hookless(session, () => {
      routed += 1;
      return new Promise<RoutedVerdict>((resolve) => {
        release = resolve;
      });
    });
    const sudo = () =>
      held({ toolCallId: 'tc', kind: 'execute', rawInput: { command: 'sudo id' } });

    const inFlight = responder.handleRequest(7, sudo());
    await Bun.sleep(0);
    expect(routed).toBe(1);
    expect(session.calls).toEqual([]);

    expect(responder.cancelPending()).toBe(1);
    expect(session.calls).toEqual([{ id: 7, result: CANCELLED }]);
    // The route's late answer is dropped: the request was already answered.
    release({ decision: 'allow' });
    expect((await inFlight).kind).toBe('hil');
    expect(session.calls).toHaveLength(1);

    // A held call that arrives after the stop is cancelled with no card.
    expect((await responder.handleRequest(8, sudo())).kind).toBe('hil');
    expect(session.calls.at(-1)).toEqual({ id: 8, result: CANCELLED });
    expect(routed).toBe(1);
    const logged = store.listEvents().filter((e) => e.kind === 'hook_decision');
    expect(logged.map((e) => e.data.outcome)).toEqual(['cancelled', 'cancelled']);
  });

  test('a route that fails refuses the call rather than leaving it waiting', async () => {
    const session = fakeSession();
    const responder = hookless(session, async () => {
      throw new Error('disk full');
    });
    const decision = await responder.handleRequest(
      1,
      held({ toolCallId: 'tc', kind: 'execute', rawInput: { command: 'sudo id' } }),
    );
    expect(decision.kind).toBe('deny');
    if (decision.kind !== 'deny') throw new Error('expected a deny');
    expect(decision.reason).toContain('disk full');
    expect(answers(session)).toEqual([REJECT]);
  });

  test('a throw before the answer still answers: the request is refused, not left waiting', async () => {
    const session = fakeSession();
    const responder = buildPermissionResponder(store, {
      role: 'engineer',
      agent: WORKER,
      worktreePath: repo,
      session,
      patternRules: {
        rules: () => {
          throw new Error('rules unreadable');
        },
        protectedBranches: () => ['main'],
        record: async () => {},
      },
    });
    await expect(
      responder.handleRequest(
        1,
        held({ toolCallId: 'tc', kind: 'execute', rawInput: { command: 'ls' } }),
      ),
    ).rejects.toThrow('rules unreadable');
    expect(session.calls).toEqual([{ id: 1, result: REJECT }]);
    expect(responder.cancelPending()).toBe(0);
  });

  test('no allow_once offered: refused with no card, never allow_always', async () => {
    const session = fakeSession();
    const responder = hookless(session);
    const options = HOOKLESS_OPTIONS.filter((o) => o.kind !== 'allow_once');
    const decision = await responder.handleRequest(
      1,
      held({ toolCallId: 'tc', kind: 'execute', rawInput: { command: 'sudo id' } }, options),
    );
    expect(decision.kind).toBe('deny');
    expect(answers(session)).toEqual([REJECT]);
    expect(gates.list()).toHaveLength(0);
  });

  test('no reject_once offered: the card is raised and the refusal is a cancel', async () => {
    const session = fakeSession();
    const responder = hookless(session);
    const options = HOOKLESS_OPTIONS.filter((o) => o.kind === 'allow_once');
    const sudo = () =>
      held({ toolCallId: 'tc', kind: 'execute', rawInput: { command: 'sudo id' } }, options);
    expect((await responder.handleRequest(1, sudo())).kind).toBe('hil');
    expect(answers(session)).toEqual([CANCELLED]);
    const card = gates.list()[0];
    if (card === undefined) throw new Error('no card');
    await gates.respond(card.id, 'approve', 'pete');
    expect((await responder.handleRequest(2, sudo())).kind).toBe('allow');
    expect(answers(session)).toEqual([CANCELLED, ALLOW]);
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
