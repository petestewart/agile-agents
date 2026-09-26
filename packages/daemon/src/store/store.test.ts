import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type KnowledgeItemInput, ulid } from '@agile-agents/shared';
import { runInit } from '../init';
import { NotFoundError, StateStore } from './store';

let repo: string;
let stateRoot: string;

/**
 * T111: the state home is a plain directory, not a git worktree, so the
 * audit trail `git log` used to provide is `log/events.jsonl` alone. Every
 * assertion that used to read a commit subject now reads the last event kind
 * through this helper.
 */
function lastEventKind(): string | undefined {
  return StateStore.open(stateRoot).listEvents().at(-1)?.kind;
}

beforeEach(() => {
  // A temp *home* (`AGILE_HOME`-shaped), never a `.agile/` inside a repo.
  repo = mkdtempSync(join(tmpdir(), 'agile-store-'));
  const init = runInit(join(repo, 'home'));
  stateRoot = init.stateRoot;
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('Repo registry (T111): repos.yaml in the state home', () => {
  test('an untouched home lists no repos', () => {
    expect(StateStore.open(stateRoot).getRepos()).toEqual({});
  });

  test('addRepo defaults protected_branches to main + master (D8) and mints repos_put', async () => {
    const store = StateStore.open(stateRoot);
    await store.addRepo('ledger-lite', { path: '/tmp/ledger-lite' });
    expect(store.getRepos()).toEqual({
      'ledger-lite': {
        path: '/tmp/ledger-lite',
        protected_branches: ['main', 'master'],
        delivery: 'direct',
        visibility: { mode: 'public' },
      },
    });
    expect(lastEventKind()).toBe('repos_put');
  });

  test('addRepo is additive across repos and replaces an entry re-added by the same name', async () => {
    const store = StateStore.open(stateRoot);
    await store.addRepo('a', { path: '/tmp/a' });
    await store.addRepo('b', { path: '/tmp/b', target_branch: 'integration', vendor: 'claude' });
    await store.addRepo('a', { path: '/tmp/a', protected_branches: ['trunk'] });

    const repos = store.getRepos();
    expect(Object.keys(repos).sort()).toEqual(['a', 'b']);
    expect(repos.a?.protected_branches).toEqual(['trunk']);
    expect(repos.b?.target_branch).toBe('integration');
    expect(repos.b?.vendor).toBe('claude');
  });

  test('an unknown field is rejected (.strict) and nothing is written', async () => {
    const store = StateStore.open(stateRoot);
    await expect(store.addRepo('a', { path: '/tmp/a', nope: 1 })).rejects.toThrow(/repo entry/);
    expect(store.getRepos()).toEqual({});
  });

  test('survives a restart — a fresh store over the same home reads it back', async () => {
    await StateStore.open(stateRoot).addRepo('a', { path: '/tmp/a' });
    expect(StateStore.open(stateRoot).getRepos().a?.path).toBe('/tmp/a');
  });
});

// T025 review round 1 blocker 1: an unvalidated id string reaching a
// schema-typed method (the shape an HTTP route that skips `HaltIdSchema.
// safeParse` would produce, e.g. `../../victim`) must not escape the state
// root. This exercises `StateStore.abs()`'s own containment guard directly
// through a public method, rather than trusting every call site to have
// validated first — the guard is the backstop for every current and future
// caller of `abs()`, not just `deleteHalt`.

// T032: the lexical guard above stops `..` traversal but `resolve()` never
// touches the filesystem, so a symlink *planted inside* the state root that
// points outside it slips past a purely lexical check — only a real fs call
// (read/write/unlink) would follow the link and actually escape. `abs()`
// must catch this too by walking every path component with `lstatSync`
// (which reports a symlink whether or not its target exists) and checking
// each hop's `readlinkSync` target for containment.

// Round 2 review (opus) B1: a leaf symlink whose target string is lexically
// inside the root passed the round-2 guard even when the target's *own
// parent directory* was itself an escaping symlink — resuming the walk with
// a bare `lstatSync(nextTarget)` only re-checks `nextTarget`'s leaf, since
// `lstat` refuses to follow just the final path component; the kernel still
// resolves every intermediate one. `resolvePathSafely`/`resolveComponentSymlink`
// close this by always re-decomposing a hop's target and re-walking it
// component by component from `root`, however many nested hops it takes.

// Round 3 review (opus) B1: a hop's target was computed as
// `normalize(rawTarget)`, which collapses `..` *lexically* before the
// containment check and before the target is split into components to
// walk. `.agile/esc -> <outside>` plus a leaf `-> "<stateRoot>/esc/../pwned.jsonl"`
// normalizes straight to `<stateRoot>/pwned.jsonl` — the `esc` segment (the
// actual escaping symlink) is erased before ever being `lstat`ed, so the
// escape goes undetected. The kernel resolves `esc` *first*, then applies
// `..` from wherever `esc` actually points. Every target string below is
// built with template-literal concatenation, never `join()` — `join()`
// itself would strip the `..` and silently defeat the point of these tests.

// Round 4 review (opus) B1: an absolute symlink target was walked from the
// filesystem root and its fully-resolved hop compared against the state
// root's *literal, unresolved* text — so when the state root is itself
// reached through a symlinked ancestor directory (macOS `tmpdir()` under
// `/var -> /private/var`, or any operator layout with a linked parent), a
// plainly inside-root absolute link legitimately resolves through that
// ancestor to the *real* directory, which no longer shares the literal
// prefix, and was false-refused. Simulated here with our own repo layout
// (a real directory plus a *separate* directory that only holds a symlink
// to it) rather than relying on the host's own `tmpdir()` happening to
// involve a link, so this reproduces on Linux too, not just on a machine
// where it already does.

describe('AgentRecord: putAgent / getAgent / listAgents / deleteAgent', () => {
  function makeRecord(overrides: Record<string, unknown> = {}) {
    return {
      vendor: 'claude',
      model: 'sonnet',
      pid: 123,
      last_seen: '2026-09-08T00:00:00Z',
      ...overrides,
    };
  }

  test('putAgent/getAgent round-trip, mints agent_put', async () => {
    const store = StateStore.open(stateRoot);
    await store.putAgent('01ARZ3NDEKTSV4RRFFQ69GE001' as never, makeRecord() as never);
    expect(store.getAgent('01ARZ3NDEKTSV4RRFFQ69GE001' as never).model).toBe('sonnet');
    const events = store.listEvents();
    expect(events[0]?.kind).toBe('agent_put');
    expect(events[0]?.agent).toBe('01ARZ3NDEKTSV4RRFFQ69GE001');
  });

  test('listAgents returns every agent record', async () => {
    const store = StateStore.open(stateRoot);
    await store.putAgent('01ARZ3NDEKTSV4RRFFQ69GE001' as never, makeRecord() as never);
    await store.putAgent('01ARZ3NDEKTSV4RRFFQ69GE002' as never, makeRecord() as never);
    expect(
      store
        .listAgents()
        .map((a) => a.id)
        .sort(),
    ).toEqual(['01ARZ3NDEKTSV4RRFFQ69GE001', '01ARZ3NDEKTSV4RRFFQ69GE002']);
  });

  test('deleteAgent removes the record and mints agent_deleted', async () => {
    const store = StateStore.open(stateRoot);
    await store.putAgent('01ARZ3NDEKTSV4RRFFQ69GE001' as never, makeRecord() as never);
    await store.deleteAgent('01ARZ3NDEKTSV4RRFFQ69GE001' as never);
    expect(() => store.getAgent('01ARZ3NDEKTSV4RRFFQ69GE001' as never)).toThrow(NotFoundError);
    expect(store.listEvents().map((e) => e.kind)).toEqual(['agent_put', 'agent_deleted']);
  });
});

describe('Policy singleton', () => {
  test('getPolicy reads what agile init wrote', () => {
    const store = StateStore.open(stateRoot);
    expect(store.getPolicy().gates.land).toBe('human');
  });

  test('putPolicy overwrites it and mints policy_put', async () => {
    const store = StateStore.open(stateRoot);
    await store.putPolicy({
      gates: { land: 'human_timeout:1h' },
      breaker_signals: [],
    });
    expect(store.getPolicy().gates.land).toBe('human_timeout:1h');
    expect(store.listEvents()[0]?.kind).toBe('policy_put');
  });
});

/**
 * T140/T260: `knowledge/K-<ulid>.yaml`, and the two structural checks the
 * store is the one place to apply — the principal split (**D4**) and the
 * check invariants (projects-design §14.3, cockpit §5.6).
 */
describe('Knowledge (T260): knowledge/K-<ulid>.yaml in the state home', () => {
  function ruleInput(over: Partial<KnowledgeItemInput> = {}): KnowledgeItemInput {
    return {
      id: `K-${ulid()}`,
      kind: 'standard',
      text: 'prefer the repo scripts over a second toolchain',
      scope: { kind: 'global' },
      status: 'proposed',
      enforcement: 'tell',
      critical: false,
      source: { by: 'human' },
      stats: {},
      created_at: '2026-09-22T00:00:00.000Z',
      ...over,
    };
  }

  test('an untouched home lists no knowledge', () => {
    expect(StateStore.open(stateRoot).listKnowledge()).toEqual([]);
  });

  test('createKnowledge writes the record, mints knowledge_put and is readable back', async () => {
    const store = StateStore.open(stateRoot);
    const created = await store.createKnowledge('human', ruleInput());
    expect(existsSync(join(stateRoot, 'knowledge', `${created.id}.yaml`))).toBe(true);
    expect(store.getKnowledge(created.id).text).toBe(
      'prefer the repo scripts over a second toolchain',
    );
    expect(store.hasKnowledge(created.id)).toBe(true);
    expect(lastEventKind()).toBe('knowledge_put');
    const event = StateStore.open(stateRoot).listEvents().at(-1);
    expect(event?.data).toEqual({
      id: created.id,
      status: 'proposed',
      enforcement: 'tell',
      scope: 'global',
      principal: 'human',
    });
  });

  test('a subtree-scoped item event carries the stream scope', async () => {
    const store = StateStore.open(stateRoot);
    const stream = ulid();
    await store.createKnowledge('human', ruleInput({ scope: { kind: 'subtree', node: stream } }));
    expect(StateStore.open(stateRoot).listEvents().at(-1)?.stream).toBe(stream);
  });

  test('listKnowledge sorts by id (ULIDs sort by time)', async () => {
    const store = StateStore.open(stateRoot);
    const first = await store.createKnowledge('human', ruleInput());
    const second = await store.createKnowledge('human', ruleInput());
    expect(store.listKnowledge().map((r) => r.id)).toEqual([first.id, second.id].sort());
  });

  test('an unknown rule is a NotFoundError; a bad id never reaches a path', () => {
    const store = StateStore.open(stateRoot);
    expect(() => store.getKnowledge(`K-${ulid()}`)).toThrow(NotFoundError);
    expect(() => store.getKnowledge('../../etc/passwd')).toThrow(/must look like K-<ulid>/);
    expect(() => store.getKnowledge('RULE-012')).toThrow(/must look like K-<ulid>/);
  });

  test('a duplicate id is refused', async () => {
    const store = StateStore.open(stateRoot);
    const input = ruleInput();
    await store.createKnowledge('human', input);
    await expect(store.createKnowledge('human', input)).rejects.toThrow(/already exists/);
  });

  // The acceptance criterion: an agent principal setting `status: accepted`
  // is rejected, in both directions (on create and on update).
  test('an agent principal may create only a proposed rule', async () => {
    const store = StateStore.open(stateRoot);
    await expect(store.createKnowledge('agent', ruleInput({ status: 'accepted' }))).rejects.toThrow(
      /may only create a proposed item/,
    );
    const proposed = await store.createKnowledge('agent', ruleInput());
    expect(proposed.status).toBe('proposed');
  });

  test('an agent principal setting status: accepted on an existing rule is rejected', async () => {
    const store = StateStore.open(stateRoot);
    const rule = await store.createKnowledge('agent', ruleInput());
    await expect(
      store.updateKnowledge('agent', rule.id, (before) => ({ ...before, status: 'accepted' })),
    ).rejects.toThrow(/may not change status/);
    // and nothing was written
    expect(store.getKnowledge(rule.id).status).toBe('proposed');
  });

  test('a human accept mints knowledge_decided and lands on disk', async () => {
    const store = StateStore.open(stateRoot);
    const rule = await store.createKnowledge('agent', ruleInput());
    const accepted = await store.updateKnowledge(
      'human',
      rule.id,
      (before) => ({
        ...before,
        status: 'accepted',
        decided_at: '2026-09-22T01:00:00.000Z',
        decided_by: 'pete',
      }),
      { kind: 'knowledge_decided' },
    );
    expect(accepted.status).toBe('accepted');
    expect(StateStore.open(stateRoot).getKnowledge(rule.id).decided_by).toBe('pete');
    expect(lastEventKind()).toBe('knowledge_decided');
  });

  test('the tier invariants are refused at the store, not only at the edge', async () => {
    const store = StateStore.open(stateRoot);
    await expect(
      store.createKnowledge('human', ruleInput({ enforcement: 'action' })),
    ).rejects.toThrow(/needs a check/);
    const classifier = await store.createKnowledge(
      'human',
      ruleInput({
        enforcement: 'ship',
        check: { by: 'classifier', examples: [{ action: 'a', violates: true }] },
      }),
    );
    await expect(
      store.updateKnowledge('human', classifier.id, (before) => ({
        ...before,
        status: 'accepted',
      })),
    ).rejects.toThrow(/at least 2 examples/);
  });

  test('a corrupt knowledge file is refused with its path', async () => {
    const store = StateStore.open(stateRoot);
    const rule = await store.createKnowledge('human', ruleInput());
    writeFileSync(join(stateRoot, 'knowledge', `${rule.id}.yaml`), 'status: nonsense\n');
    expect(() => StateStore.open(stateRoot).getKnowledge(rule.id)).toThrow(
      /corrupt knowledge item file/,
    );
  });

  test('legacy rules/ files are read, never written, and a corrupt one is refused', () => {
    const store = StateStore.open(stateRoot);
    expect(store.listLegacyRules()).toEqual([]);
    mkdirSync(join(stateRoot, 'rules'), { recursive: true });
    writeFileSync(join(stateRoot, 'rules', `R-${ulid()}.yaml`), 'status: nonsense\n');
    expect(() => store.listLegacyRules()).toThrow(/corrupt rule file/);
  });
});

describe('threadUpdatedAt (T395)', () => {
  test("a thread's last line time, from this process's append, else the file's mtime", async () => {
    const { StreamService } = await import('../streams');
    const store = StateStore.open(stateRoot);
    const streams = new StreamService(store);
    const node = await streams.create('human', { title: 'n', goal: 'g' });
    const entry = await streams.appendThread('human', node.id, { kind: 'line', body: 'hi' });
    expect(store.threadUpdatedAt(node.id)).toBe(entry.ts);

    // A fresh process reads the file's mtime once; a node with no thread file has none.
    const reopened = StateStore.open(stateRoot);
    const at = reopened.threadUpdatedAt(node.id);
    expect(at).toBeDefined();
    expect(Number.isNaN(Date.parse(at ?? ''))).toBe(false);
    expect(reopened.threadUpdatedAt('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeUndefined();
  });
});
