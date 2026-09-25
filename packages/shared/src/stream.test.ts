import { describe, expect, test } from 'bun:test';
import {
  AGENT_LINE_MAX_CHARS,
  type Stream,
  StreamAttachRequestSchema,
  StreamSayInputSchema,
  THREAD_BODY_MAX_CHARS,
  assertNoStreamCycle,
  assertNoWaitsOnCycle,
  assertStreamWrite,
  liveChildrenOf,
  nodeRole,
  quoteThreadBody,
  ulid,
  validateSessionRef,
  validateStream,
  validateStreamFinding,
  validateThreadEntry,
} from './index';

const ROOT = ulid(1);
const CHILD = ulid(2);
const GRANDCHILD = ulid(3);
const SESSION = ulid(4);

function stream(overrides: Partial<Stream> = {}): Stream {
  return validateStream({
    id: ROOT,
    title: 'Ledger rounding',
    goal: 'Fix the rounding drift in the ledger export',
    created_at: '2026-09-19T10:00:00Z',
    agent: { status: 'working', updated_at: '2026-09-19T10:05:00Z' },
    human: { status: 'open' },
    sessions: [],
    ...overrides,
  });
}

describe('StreamSchema', () => {
  test('accepts a minimal stream and defaults sessions', () => {
    const parsed = validateStream({
      id: ROOT,
      title: 't',
      goal: 'g',
      created_at: '2026-09-19T10:00:00Z',
      agent: { status: 'idle', updated_at: '2026-09-19T10:00:00Z' },
      human: { status: 'open' },
    });
    expect(parsed.sessions).toEqual([]);
  });

  test('.strict() rejects an unknown top-level key', () => {
    expect(() => stream({ sprint: 'S-07' } as unknown as Partial<Stream>)).toThrow(/unrecognized/i);
  });

  test('.strict() rejects an unknown key inside agent and human', () => {
    expect(() =>
      validateStream({
        ...stream(),
        agent: { status: 'idle', updated_at: 'now', points: 3 },
      }),
    ).toThrow(/unrecognized/i);
    expect(() =>
      validateStream({
        ...stream(),
        human: { status: 'open', verdict: 'pass' },
      }),
    ).toThrow(/unrecognized/i);
  });

  test('rejects a non-ULID id and an unknown status', () => {
    expect(() => validateStream({ ...stream(), id: 'TKT-0231' })).toThrow(/ULID/);
    expect(() => validateStream({ ...stream(), human: { status: 'in_review' } })).toThrow(/human/);
  });
});

describe('StreamFindingSchema', () => {
  const finding = {
    severity: 'blocker',
    file: 'packages/daemon/src/store/store.ts',
    line: 42,
    text: 'writes the record without validating it first',
  };

  test('accepts a finding, with and without a line', () => {
    expect(validateStreamFinding(finding).severity).toBe('blocker');
    const { line: _line, ...fileScoped } = finding;
    expect(validateStreamFinding(fileScoped).line).toBeUndefined();
  });

  test('.strict() rejects an unknown key', () => {
    expect(() => validateStreamFinding({ ...finding, rule: 'RULE-012' })).toThrow(/unrecognized/i);
  });

  test('rejects an unknown severity and an over-long text', () => {
    expect(() => validateStreamFinding({ ...finding, severity: 'blocking' })).toThrow(/severity/);
    expect(() =>
      validateStreamFinding({ ...finding, text: 'x'.repeat(THREAD_BODY_MAX_CHARS + 1) }),
    ).toThrow(/800/);
  });

  test('a stream accepts arrays of findings and proposed next steps', () => {
    const parsed = stream({
      agent: {
        status: 'working',
        updated_at: '2026-09-19T10:05:00Z',
        findings: [finding, { severity: 'nit', file: 'README.md', text: 'stale command' }],
        proposed_next: ['add the store test', 'rerun the suite'],
      },
    } as never);
    expect(parsed.agent.findings).toHaveLength(2);
    expect(parsed.agent.proposed_next).toEqual(['add the store test', 'rerun the suite']);
  });

  test('a stream rejects a bare string where findings must be items', () => {
    expect(() =>
      validateStream({
        ...stream(),
        agent: { status: 'working', updated_at: 'now', findings: 'looks fine' },
      }),
    ).toThrow(/findings/);
  });
});

describe('SessionRefSchema', () => {
  test('accepts a worker session and rejects unknown keys', () => {
    const ref = validateSessionRef({
      id: SESSION,
      vendor: 'claude',
      model: 'opus',
      role: 'worker',
      status: 'running',
      worktree: '/repo/.worktrees/x',
    });
    expect(ref.role).toBe('worker');
    expect(() =>
      validateSessionRef({
        id: SESSION,
        vendor: 'claude',
        model: 'opus',
        role: 'worker',
        status: 'running',
        pid: 42,
      }),
    ).toThrow(/unrecognized/i);
  });

  test('rejects a deleted role', () => {
    expect(() =>
      validateSessionRef({
        id: SESSION,
        vendor: 'claude',
        model: 'opus',
        role: 'architect',
        status: 'running',
      }),
    ).toThrow(/role/);
  });
});

describe('ThreadEntrySchema', () => {
  test('accepts human, daemon and agent:<ulid> authors', () => {
    for (const by of ['human', 'daemon', `agent:${SESSION}`]) {
      expect(
        validateThreadEntry({ ts: '2026-09-19T10:00:00Z', by, kind: 'line', body: 'hi' }).by,
      ).toBe(by);
    }
  });

  test('rejects a malformed author', () => {
    expect(() =>
      validateThreadEntry({ ts: 'now', by: 'agent:eng-1', kind: 'line', body: 'hi' }),
    ).toThrow(/agent:/);
  });

  test('caps the body at the shared 800-char message cap', () => {
    expect(THREAD_BODY_MAX_CHARS).toBe(800);
    expect(() =>
      validateThreadEntry({
        ts: 'now',
        by: 'human',
        kind: 'line',
        body: 'x'.repeat(THREAD_BODY_MAX_CHARS + 1),
      }),
    ).toThrow(/800/);
  });

  test('T330: an agent line may run to AGENT_LINE_MAX_CHARS; other entries keep the 800 cap', () => {
    const agent = `agent:${SESSION}`;
    const entry = (by: string, kind: string, length: number) => ({
      ts: 'now',
      by,
      kind,
      body: 'x'.repeat(length),
    });
    expect(validateThreadEntry(entry(agent, 'line', 3000)).body).toHaveLength(3000);
    expect(validateThreadEntry(entry(agent, 'line', AGENT_LINE_MAX_CHARS)).body).toHaveLength(
      AGENT_LINE_MAX_CHARS,
    );
    expect(() => validateThreadEntry(entry(agent, 'line', AGENT_LINE_MAX_CHARS + 1))).toThrow(
      /16000/,
    );
    expect(() => validateThreadEntry(entry(agent, 'finding', 801))).toThrow(/800/);
    expect(() => validateThreadEntry(entry('daemon', 'line', 801))).toThrow(/800/);
    // The Director's own message is an agent message too.
    expect(validateThreadEntry(entry('director', 'line', 3000)).body).toHaveLength(3000);
    expect(() => validateThreadEntry(entry('director', 'event', 801))).toThrow(/800/);
  });

  test('quoteThreadBody cuts a long body with an ellipsis', () => {
    expect(quoteThreadBody('short')).toBe('short');
    const quoted = quoteThreadBody('y'.repeat(5000));
    expect(quoted).toHaveLength(THREAD_BODY_MAX_CHARS);
    expect(quoted.endsWith('…')).toBe(true);
  });

  test('.strict() rejects an unknown key', () => {
    expect(() =>
      validateThreadEntry({ ts: 'now', by: 'human', kind: 'line', body: 'hi', priority: 'high' }),
    ).toThrow(/unrecognized/i);
  });
});

describe('assertStreamWrite', () => {
  const before = stream();

  test('an agent principal may not change human.*', () => {
    const after = { ...before, human: { ...before.human, status: 'landed' as const } };
    expect(() => assertStreamWrite('agent', before, after)).toThrow(/agent principal/);
  });

  test('an agent principal may change agent.*', () => {
    const after = { ...before, agent: { ...before.agent, status: 'done' as const } };
    expect(assertStreamWrite('agent', before, after).agent.status).toBe('done');
  });

  test('a human principal may not change agent.*', () => {
    const after = { ...before, agent: { ...before.agent, status: 'done' as const } };
    expect(() => assertStreamWrite('human', before, after)).toThrow(/human principal/);
  });

  test('a human principal may change human.*', () => {
    const after = { ...before, human: { ...before.human, note: 'ship it' } };
    expect(assertStreamWrite('human', before, after).human.note).toBe('ship it');
  });

  test('the daemon principal may write both halves', () => {
    const after = {
      ...before,
      agent: { ...before.agent, status: 'done' as const },
      human: { ...before.human, status: 'landed' as const },
    };
    expect(assertStreamWrite('daemon', before, after)).toBe(after);
  });

  test('an unchanged other half is not an attempted write', () => {
    const after = { ...before, title: 'renamed', human: { ...before.human } };
    expect(assertStreamWrite('agent', before, after).title).toBe('renamed');
  });
});

describe('assertNoStreamCycle', () => {
  const parents = new Map<string, string>([
    [CHILD, ROOT],
    [GRANDCHILD, CHILD],
  ]);
  const lookup = (id: string) => parents.get(id);

  test('accepts a root stream with no parent', () => {
    expect(() => assertNoStreamCycle(ROOT, undefined, lookup)).not.toThrow();
  });

  test('accepts unlimited nesting depth', () => {
    const deep = new Map<string, string>();
    const ids: string[] = Array.from({ length: 200 }, (_, i) => ulid(1000 + i));
    let previous = ids[0] as string;
    for (const id of ids.slice(1)) {
      deep.set(id, previous);
      previous = id;
    }
    const leaf = ulid(5000);
    expect(() => assertNoStreamCycle(leaf, previous, (id) => deep.get(id))).not.toThrow();
  });

  test('rejects a self parent', () => {
    expect(() => assertNoStreamCycle(ROOT, ROOT, lookup)).toThrow(/own parent/);
  });

  test('rejects a cycle through an ancestor chain', () => {
    // ROOT's parent set to GRANDCHILD closes the loop ROOT → GRANDCHILD → CHILD → ROOT.
    expect(() => assertNoStreamCycle(ROOT, GRANDCHILD, lookup)).toThrow(/cycle/);
  });
});

describe('classifier opt-out (T150, cockpit design §6.4)', () => {
  test("a stream may carry the tier's opt-out", () => {
    expect(validateStream(stream({ classifier: 'off' })).classifier).toBe('off');
  });

  test('absent means "no opt-out here" — there is no stream-level "on"', () => {
    expect(validateStream(stream()).classifier).toBeUndefined();
    expect(() => validateStream({ ...stream(), classifier: 'on' })).toThrow();
  });
});

describe('T161 cockpit write bodies', () => {
  test('say takes one capped body and nothing else — no principal on the wire', () => {
    expect(StreamSayInputSchema.parse({ body: '  hi  ' }).body).toBe('hi');
    expect(StreamSayInputSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(
      StreamSayInputSchema.safeParse({ body: 'x'.repeat(THREAD_BODY_MAX_CHARS + 1) }).success,
    ).toBe(false);
    expect(StreamSayInputSchema.safeParse({ body: 'hi', by: 'daemon' }).success).toBe(false);
  });

  test('attach takes the two attachable roles only', () => {
    expect(StreamAttachRequestSchema.safeParse({}).success).toBe(true);
    expect(StreamAttachRequestSchema.safeParse({ role: 'reviewer', vendor: 'codex' }).success).toBe(
      true,
    );
    expect(StreamAttachRequestSchema.safeParse({ role: 'lessons' }).success).toBe(false);
    expect(
      StreamAttachRequestSchema.safeParse({ role: 'worker', principal: 'agent' }).success,
    ).toBe(false);
  });
});

describe('node fields (T201, §14.2)', () => {
  test('a record with every new field validates', () => {
    const s = stream({
      parent: CHILD,
      project: `P-${ulid(9)}`,
      labels: ['epic'],
      waits_on: [{ node: GRANDCHILD, added_by: 'coordinator', added_at: 't' }],
      autonomy: 'organise',
      delivery: { mode: 'pr', auto_merge: true },
      merge_together: `MT-${ulid(8)}`,
      helper_of: CHILD,
      delivery_state: {
        mode: 'pr',
        status: 'held',
        held_by: [{ reason: 'waits_on', detail: 'x' }],
        at: 't',
      },
      touched: { files: ['a.ts'], base: 'abc', at: 't' },
      external_link: {
        system: 'jira',
        key: 'SHOP-11',
        url: 'https://x',
        synced: { title: 't', description_hash: 'h', at: 't' },
      },
    });
    expect(s.labels).toEqual(['epic']);
  });

  test('a bad project id is refused', () => {
    expect(() => stream({ project: 'shop' })).toThrow(/project/);
  });
});

describe('nodeRole (P1)', () => {
  const node = { id: CHILD, parent: ROOT };
  const cases: Array<
    [string, Parameters<typeof nodeRole>[0], Parameters<typeof nodeRole>[1], string]
  > = [
    ['no parent is a project', { id: ROOT }, [], 'project'],
    ['a project root with children is still a project', { id: ROOT }, [{ id: CHILD }], 'project'],
    [
      'a live child makes it coordinating',
      { ...node, repo: 'shop' },
      [{ id: GRANDCHILD }],
      'coordinating',
    ],
    [
      'a helper of another node still counts',
      node,
      [{ id: GRANDCHILD, helper_of: GRANDCHILD, repo: 'shop' }],
      'coordinating',
    ],
    ['a repo and no children is work', { ...node, repo: 'shop' }, [], 'work'],
    [
      'a same-repo helper does not make it coordinating',
      { ...node, repo: 'shop' },
      [{ id: GRANDCHILD, helper_of: CHILD, repo: 'shop' }],
      'work',
    ],
    ['no repo and no children is a conversation', node, [], 'conversation'],
    // D33: tangents.
    [
      'a conversation whose children are conversations stays a conversation',
      node,
      [{ id: GRANDCHILD }, { id: ulid(8) }],
      'conversation',
    ],
    [
      'a conversation becomes coordinating once a child has a repo',
      node,
      [{ id: GRANDCHILD }, { id: ulid(8), repo: 'shop' }],
      'coordinating',
    ],
  ];
  for (const [name, n, children, role] of cases) {
    test(name, () => expect(nodeRole(n, children)).toBe(role as ReturnType<typeof nodeRole>));
  }

  test('D33: a repo-less child that is itself coordinating makes its parent coordinating', () => {
    const parent = stream({ id: CHILD, parent: ROOT });
    const tangent = stream({ id: GRANDCHILD, parent: CHILD });
    const work = stream({ id: ulid(9), parent: GRANDCHILD, repo: 'shop' });
    const all = [parent, tangent, work];
    expect(nodeRole(parent, liveChildrenOf(CHILD, all), all)).toBe('coordinating');
    expect(nodeRole(tangent, liveChildrenOf(GRANDCHILD, all), all)).toBe('coordinating');
    // A tangent of a tangent keeps both conversations.
    const deep = [parent, tangent, stream({ id: ulid(9), parent: GRANDCHILD })];
    expect(nodeRole(parent, liveChildrenOf(CHILD, deep), deep)).toBe('conversation');
    // A closed work grandchild no longer counts.
    const closed = [parent, tangent, { ...work, human: { status: 'closed' as const } }];
    expect(nodeRole(parent, liveChildrenOf(CHILD, closed), closed)).toBe('conversation');
  });

  test('liveChildrenOf drops closed and archived children', () => {
    const open = stream({ id: GRANDCHILD, parent: CHILD });
    const closed = stream({ id: ulid(5), parent: CHILD, human: { status: 'closed' } });
    const archived = stream({ id: ulid(6), parent: CHILD, archived: true });
    const other = stream({ id: ulid(7), parent: ROOT });
    expect(liveChildrenOf(CHILD, [open, closed, archived, other]).map((s) => s.id)).toEqual([
      GRANDCHILD,
    ]);
  });
});

describe('assertNoWaitsOnCycle (P8)', () => {
  const edges: Record<string, string[]> = { [CHILD]: [GRANDCHILD], [GRANDCHILD]: [] };
  const lookup = (id: string) => edges[id] ?? [];
  test('an acyclic edge passes', () => {
    expect(() => assertNoWaitsOnCycle(ROOT, [CHILD], lookup)).not.toThrow();
  });
  test('waiting on itself is refused', () => {
    expect(() => assertNoWaitsOnCycle(ROOT, [ROOT], lookup)).toThrow(/cycle/);
  });
  test('a transitive cycle is refused and names the path', () => {
    edges[GRANDCHILD] = [ROOT];
    expect(() => assertNoWaitsOnCycle(ROOT, [CHILD], lookup)).toThrow(
      `${ROOT} -> ${CHILD} -> ${GRANDCHILD} -> ${ROOT}`,
    );
    edges[GRANDCHILD] = [];
  });
});

describe('principals (§14.12)', () => {
  for (const principal of ['coordinator', 'director'] as const) {
    test(`${principal} may not change human.*`, () => {
      const before = stream();
      const after = stream({ human: { status: 'closed' } });
      expect(() => assertStreamWrite(principal, before, after)).toThrow(
        new RegExp(`${principal} principal may not change human`),
      );
    });
    test(`${principal} may change agent.* and structure`, () => {
      const before = stream();
      const after = stream({ labels: ['epic'], agent: { status: 'done', updated_at: 't' } });
      expect(assertStreamWrite(principal, before, after)).toBe(after);
    });
  }

  test('only the daemon writes delivery_state and touched', () => {
    const before = stream();
    const after = stream({ touched: { files: [], base: 'b', at: 't' } });
    for (const p of ['agent', 'human', 'coordinator', 'director'] as const) {
      expect(() => assertStreamWrite(p, before, after)).toThrow(
        /only the daemon may change touched/,
      );
    }
    expect(assertStreamWrite('daemon', before, after)).toBe(after);
  });
});
