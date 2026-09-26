import { describe, expect, test } from 'bun:test';
import type { Event } from '@agile-agents/shared';
import {
  type AgentStep,
  STEP_TITLE_MAX,
  applyStep,
  groupSteps,
  liveWindow,
  stepState,
  stepUpdateOf,
  stepView,
  stepsFromPage,
  stepsSummary,
} from './steps';

const NODE = '01ARZ3NDEKTSV4RRFFQ69GE001';
const at = (s: number) => new Date(Date.UTC(2026, 8, 26, 12, 0, s)).toISOString();

function step(id: string, s: number, fields: Partial<AgentStep> = {}): AgentStep {
  return {
    id,
    session: 'S-1',
    ts: at(s),
    kind: 'read',
    title: `Read ${id}`,
    status: 'completed',
    ...fields,
  };
}

function toolEvent(data: Record<string, unknown>, s = 1, extra: Partial<Event> = {}): Event {
  return { ts: at(s), kind: 'tool_call', agent: 'S-1', data: { stream: NODE, ...data }, ...extra };
}

const text = (v: ReturnType<typeof stepView>) => v.parts.map((p) => p.text).join('');
const code = (v: ReturnType<typeof stepView>) => v.parts.filter((p) => p.code).map((p) => p.text);

describe('stepUpdateOf', () => {
  test("reads a node's tool_call event; ignores other kinds and other nodes", () => {
    expect(
      stepUpdateOf(
        toolEvent({ toolCallId: 't1', kind: 'read', title: 'Read a', status: 'pending' }),
        NODE,
      ),
    ).toEqual({
      id: 't1',
      session: 'S-1',
      ts: at(1),
      kind: 'read',
      title: 'Read a',
      status: 'pending',
    });
    // An update carries only what changed.
    expect(stepUpdateOf(toolEvent({ toolCallId: 't1', status: 'completed' }), NODE)).toEqual({
      id: 't1',
      session: 'S-1',
      ts: at(1),
      status: 'completed',
    });
    expect(stepUpdateOf(toolEvent({ toolCallId: 't1' }), 'other')).toBeUndefined();
    expect(stepUpdateOf(toolEvent({ status: 'completed' }), NODE)).toBeUndefined();
    expect(
      stepUpdateOf({ ts: at(1), kind: 'thread_appended', stream: NODE, data: {} }, NODE),
    ).toBeUndefined();
    // The event's own `stream`, when it has one, names the node too.
    expect(
      stepUpdateOf(
        {
          ts: at(1),
          kind: 'tool_call',
          stream: NODE,
          session: 'S-9',
          data: { toolCallId: 'x', kind: 'edit' },
        },
        NODE,
      ),
    ).toMatchObject({ id: 'x', session: 'S-9', kind: 'edit' });
  });
});

describe('applyStep', () => {
  test('adds a new call and folds updates into it', () => {
    let steps: AgentStep[] = [];
    steps = applyStep(steps, {
      id: 't1',
      session: 'S-1',
      ts: at(1),
      kind: 'execute',
      title: 'Terminal',
      status: 'pending',
    });
    steps = applyStep(steps, { id: 't1', session: 'S-1', ts: at(2), status: 'in_progress' });
    steps = applyStep(steps, {
      id: 't1',
      session: 'S-1',
      ts: at(3),
      title: '`bun test`',
      status: 'failed',
    });
    expect(steps).toEqual([
      {
        id: 't1',
        session: 'S-1',
        ts: at(1),
        kind: 'execute',
        title: '`bun test`',
        status: 'failed',
      },
    ]);
  });

  test('a status never moves back; nothing changed returns the same list', () => {
    const done = [step('t1', 1, { status: 'completed' })];
    expect(applyStep(done, { id: 't1', session: 'S-1', ts: at(2), status: 'in_progress' })).toBe(
      done,
    );
    expect(applyStep(done, { id: 't1', session: 'S-1', ts: at(2), status: 'completed' })).toBe(
      done,
    );
  });

  test('an update to an unknown call is dropped; the same id in another session is another call', () => {
    const one = [step('t1', 1)];
    expect(applyStep(one, { id: 'ghost', ts: at(2), status: 'completed' })).toBe(one);
    expect(
      applyStep(one, { id: 't1', session: 'S-2', ts: at(2), kind: 'edit', title: 'Edit b' }).map(
        (s) => s.session,
      ),
    ).toEqual(['S-1', 'S-2']);
  });

  test('keeps the newest max', () => {
    let steps: AgentStep[] = [];
    for (let i = 0; i < 6; i++)
      steps = applyStep(steps, { id: `t${i}`, ts: at(i), kind: 'read', title: 'r' }, 4);
    expect(steps.map((s) => s.id)).toEqual(['t2', 't3', 't4', 't5']);
  });

  test("the route's page reads oldest first, with the events read while it loaded", () => {
    const steps = stepsFromPage(
      { steps: [step('t2', 2, { status: 'in_progress' }), step('t1', 1)], total: 2 },
      [
        { id: 't2', session: 'S-1', ts: at(3), status: 'completed' },
        { id: 't1', session: 'S-1', ts: at(1), status: 'pending' },
      ],
    );
    expect(steps.map((s) => [s.id, s.status])).toEqual([
      ['t1', 'completed'],
      ['t2', 'completed'],
    ]);
  });
});

describe('groupSteps', () => {
  const you = (s: number, body = 'do it') => ({
    ts: at(s),
    by: 'human',
    kind: 'line' as const,
    body,
  });
  const agent = (s: number, body = 'done') => ({
    ts: at(s),
    by: 'agent:S-1',
    kind: 'line' as const,
    body,
  });
  const daemon = (s: number) => ({
    ts: at(s),
    by: 'daemon',
    kind: 'event' as const,
    body: 'Worker attached',
  });
  const ids = (list: readonly AgentStep[] | undefined) => (list ?? []).map((s) => s.id);

  test('a step belongs to the reply that follows it; after the last reply, the running turn', () => {
    const entries = [daemon(0), you(1), agent(5, 'first'), you(10), agent(20, 'second')];
    const steps = [step('a', 2), step('b', 3), step('c', 11), step('d', 12), step('e', 21)];
    const { before, current } = groupSteps(steps, entries);
    expect([...before.keys()]).toEqual([2, 4]);
    expect(ids(before.get(2))).toEqual(['a', 'b']);
    expect(ids(before.get(4))).toEqual(['c', 'd']);
    expect(ids(current)).toEqual(['e']);
  });

  test('turns with no steps have no group; the same millisecond counts the reply first', () => {
    const entries = [you(1), agent(3, 'let me look'), agent(6, 'found it'), you(8), agent(9)];
    // The runner writes "let me look" before the tool call that follows it.
    const { before, current } = groupSteps([step('a', 3), step('b', 4)], entries);
    expect([...before.keys()]).toEqual([2]);
    expect(ids(before.get(2))).toEqual(['a', 'b']);
    expect(current).toEqual([]);
  });

  test('a turn stopped without a reply folds before your next line', () => {
    const entries = [you(1), daemon(4), you(6), agent(9)];
    const { before } = groupSteps([step('a', 2), step('b', 7)], entries);
    expect(ids(before.get(2))).toEqual(['a']);
    expect(ids(before.get(3))).toEqual(['b']);
  });

  test("live: a line you send mid-turn doesn't cut the running list", () => {
    const entries = [you(1), agent(2, 'on it'), you(5, 'also this')];
    const steps = [step('a', 3), step('b', 4), step('c', 6)];
    const live = groupSteps(steps, entries, { live: true });
    expect(live.before.size).toBe(0);
    expect(ids(live.current)).toEqual(['a', 'b', 'c']);
    // Once the turn is over, the timeline decides.
    const after = groupSteps(steps, entries);
    expect(ids(after.before.get(2))).toEqual(['a', 'b']);
    expect(ids(after.current)).toEqual(['c']);
  });

  test('steps from before a truncated thread are dropped; a partial oldest group shows none', () => {
    const entries = [agent(5, 'x'), you(6), agent(9, 'y'), you(10), agent(12, 'z')];
    const steps = [step('old', 1), step('a', 7), step('b', 8), step('c', 11)];
    const truncated = groupSteps(steps, entries, { truncated: true });
    expect(ids(truncated.before.get(0))).toEqual([]);
    expect(ids(truncated.before.get(2))).toEqual(['a', 'b']);
    const partial = groupSteps(steps.slice(1), entries, { partial: true });
    expect(partial.before.has(2)).toBe(false);
    expect(ids(partial.before.get(4))).toEqual(['c']);
    // The running turn is never dropped for being partial.
    const running = groupSteps([step('r', 13)], entries, { partial: true, live: true });
    expect(ids(running.current)).toEqual(['r']);
  });

  test("lines written for the agent aren't anchors; the order of the steps given doesn't matter", () => {
    const entries = [you(1), { ...agent(3, 'hidden'), agent_only: true as const }, agent(6)];
    const { before } = groupSteps([step('b', 4), step('a', 2)], entries);
    expect(ids(before.get(2))).toEqual(['a', 'b']);
  });
});

describe('how steps read', () => {
  test('state: running only while the turn runs; a call left open reads as not finished', () => {
    expect(stepState('pending', true)).toBe('running');
    expect(stepState('in_progress', true)).toBe('running');
    expect(stepState('in_progress', false)).toBe('stopped');
    expect(stepState('completed', true)).toBe('done');
    expect(stepState('failed', false)).toBe('failed');
  });

  test('summary: the count and the failures', () => {
    expect(stepsSummary([step('a', 1)])).toEqual({ label: 'Worked through 1 step', failed: 0 });
    expect(stepsSummary([step('a', 1), step('b', 2, { status: 'failed' }), step('c', 3)])).toEqual({
      label: 'Worked through 3 steps',
      failed: 1,
    });
  });

  test('the live window shows the newest five, never hiding a lone step', () => {
    const n = (count: number) => Array.from({ length: count }, (_, i) => i);
    expect(liveWindow(n(3), false)).toEqual({ shown: [0, 1, 2], earlier: 0 });
    expect(liveWindow(n(6), false)).toEqual({ shown: n(6), earlier: 0 });
    expect(liveWindow(n(9), false)).toEqual({ shown: [4, 5, 6, 7, 8], earlier: 4 });
    expect(liveWindow(n(9), true)).toEqual({ shown: n(9), earlier: 0 });
  });

  test('icon per kind; an unknown kind reads as a tool', () => {
    const icon = (kind: string) => stepView({ kind, title: 'x' }).icon;
    expect(
      [
        'read',
        'edit',
        'delete',
        'move',
        'search',
        'execute',
        'think',
        'fetch',
        'other',
        'nope',
      ].map(icon),
    ).toEqual([
      'file-text',
      'pencil',
      'trash',
      'arrow-right',
      'search',
      'terminal',
      'lightbulb',
      'globe',
      'zap',
      'zap',
    ]);
  });

  test('a command reads as code, its first line only', () => {
    const cmd = stepView({ kind: 'execute', title: '`bun test packages/ui`' });
    expect(cmd.parts).toEqual([{ text: 'bun test packages/ui', code: true }]);
    expect(stepView({ kind: 'execute', title: 'cd pkg &&\n  bun run build' }).parts).toEqual([
      { text: 'cd pkg && …', code: true },
    ]);
    expect(stepView({ kind: 'search', title: 'grep -n "foo" src' }).parts).toEqual([
      { text: 'grep -n "foo" src', code: true },
    ]);
  });

  test('a path reads as code, from the worktree root; the words around it stay plain', () => {
    const read = stepView({
      kind: 'read',
      title: 'Read /home/me/shop/.worktrees/01ABC-csv/src/parser.ts (1 - 80)',
    });
    expect(read.parts).toEqual([
      { text: 'Read ' },
      { text: 'src/parser.ts', code: true },
      { text: ' (1 - 80)' },
    ]);
    const edit = stepView({ kind: 'edit', title: 'Edit `src/lib/steps.ts`' });
    expect(edit.parts).toEqual([{ text: 'Edit ' }, { text: 'src/lib/steps.ts', code: true }]);
    expect(code(stepView({ kind: 'fetch', title: 'Fetch https://example.com/a' }))).toEqual([
      'https://example.com/a',
    ]);
    expect(stepView({ kind: 'think', title: 'Plan the parser change' }).parts).toEqual([
      { text: 'Plan the parser change' },
    ]);
  });

  test('titles are clipped: a long path loses its start, anything else its end', () => {
    const long = `/very/long/${'nested/'.repeat(12)}deep/file.ts`;
    const path = stepView({ kind: 'read', title: `Read ${long}` });
    expect(text(path).length).toBeLessThanOrEqual(STEP_TITLE_MAX);
    expect(code(path)[0]?.startsWith('…')).toBe(true);
    expect(code(path)[0]?.endsWith('deep/file.ts')).toBe(true);
    const cmd = stepView({ kind: 'execute', title: `echo ${'word '.repeat(40)}` });
    expect(text(cmd).length).toBeLessThanOrEqual(STEP_TITLE_MAX);
    expect(text(cmd).endsWith('…')).toBe(true);
    // The tooltip has the whole title, without backticks.
    expect(stepView({ kind: 'edit', title: 'Edit `a.ts`' }).full).toBe('Edit a.ts');
  });

  test('nothing raw: an empty title says what kind of step it was; a tool id reads as words', () => {
    expect(stepView({ kind: 'execute', title: '' }).parts).toEqual([{ text: 'Run a command' }]);
    expect(stepView({ kind: 'other', title: '  ' }).parts).toEqual([{ text: 'Use a tool' }]);
    expect(text(stepView({ kind: 'other', title: 'mcp__agile__ask_human' }))).toBe(
      'ask human · agile',
    );
  });
});
