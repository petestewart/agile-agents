import { describe, expect, test } from 'bun:test';
import {
  type Stream,
  THREAD_BODY_MAX_CHARS,
  assertNoStreamCycle,
  assertStreamWrite,
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
