/**
 * T363: the node page's chat rules. Plain `bun test`, no DOM.
 */

import { describe, expect, test } from 'bun:test';
import type { InboxItem, SessionRef, ThreadEntry } from '@agile-agents/shared';
import {
  agentLabel,
  agentName,
  agentStateText,
  answerTarget,
  chatAuthor,
  chatRows,
  chatVariant,
  dayLabel,
  deliveryBadge,
  detailsOpenFrom,
  diffTotals,
  headerActions,
  isNearBottom,
  liveAgentOf,
  modelLabel,
  nodeTabs,
  oneLine,
  openQuestions,
  parseDiff,
  questionIdOfRef,
  sendIntent,
  sessionIdText,
  sessionLabel,
  systemLine,
  vendorLabel,
} from './chat';

const SESSION = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const RULE = 'K-01ARZ3NDEKTSV4RRFFQ69G5FAV';

function entry(extra: Partial<ThreadEntry> = {}): ThreadEntry {
  return { ts: '2026-09-26T10:00:00.000Z', by: 'human', kind: 'line', body: 'hi', ...extra };
}

function session(extra: Partial<SessionRef> = {}): SessionRef {
  return {
    id: SESSION,
    vendor: 'claude',
    model: 'claude-opus-5-5',
    role: 'worker',
    status: 'running',
    ...extra,
  };
}

describe('names', () => {
  test('vendors and models read as words', () => {
    expect(vendorLabel('claude')).toBe('Claude');
    expect(vendorLabel('acme')).toBe('Acme');
    expect(modelLabel('claude', 'claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(modelLabel('claude', 'claude-sonnet-4-6')).toBe('Claude Sonnet 4.6');
    expect(modelLabel('claude', 'sonnet')).toBe('Claude Sonnet');
    expect(modelLabel('gemini', undefined)).toBe('Gemini default model');
    expect(modelLabel('gemini', 'default')).toBe('Gemini default model');
    expect(modelLabel('codex', 'gpt-9')).toBe('gpt-9');
    expect(sessionLabel({ vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' })).toBe(
      'Claude Opus 5.5 · low',
    );
  });

  test('T382: agentLabel names the agent only when the model does not', () => {
    expect(agentLabel({ vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' })).toBe(
      'Claude Opus 5.5 · low',
    );
    expect(agentLabel({ vendor: 'claude', model: 'default' })).toBe('Claude default model');
    expect(agentLabel({ vendor: 'gemini', effort: 'high' })).toBe('Gemini default model · high');
    expect(agentLabel({ vendor: 'gemini', model: 'gemini-2.5-pro', effort: 'low' })).toBe(
      'gemini-2.5-pro · low',
    );
    expect(agentLabel({ vendor: 'codex', model: 'gpt-9', effort: 'max' })).toBe(
      'Codex · gpt-9 · max',
    );
    // A vendor inside a longer word is not a mention of it.
    expect(agentLabel({ vendor: 'pi', model: 'gpt-pilot' })).toBe('Pi · gpt-pilot');
    expect(agentLabel({ vendor: 'claude', model: 'my-custom-model', effort: 'low' })).toBe(
      'Claude · my-custom-model · low',
    );
  });

  test('T382: sessionIdText is the raw ids, for a tooltip', () => {
    expect(sessionIdText({ vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' })).toBe(
      'claude/claude-opus-5-5 · low effort',
    );
    expect(sessionIdText({ vendor: 'gemini' })).toBe('gemini/default');
    expect(sessionIdText({ vendor: 'codex', model: 'gpt-9' })).toBe('codex/gpt-9');
  });

  test('a line is written by you, the agent (by its session), or the daemon', () => {
    const sessions = [session({ role: 'coordinator' })];
    expect(chatAuthor('human', sessions)).toEqual({ name: 'You' });
    expect(chatAuthor('daemon', sessions)).toEqual({ name: 'agile' });
    expect(chatAuthor(`agent:${SESSION}`, sessions)).toEqual({
      name: 'Claude',
      role: 'coordinator',
      vendor: 'claude',
    });
    expect(chatAuthor('agent:01ARZ3NDEKTSV4RRFFQ69G5FAW', sessions)).toEqual({ name: 'Agent' });
    expect(agentName([session({ role: 'reviewer', vendor: 'gemini' }), session()])).toBe('Claude');
    expect(agentName([])).toBe('The agent');
  });
});

describe('chat rows', () => {
  test('your lines are bubbles, the daemon and your events are system rows, agent-only lines hide', () => {
    expect(chatVariant(entry())).toBe('you');
    expect(chatVariant(entry({ kind: 'answer' }))).toBe('you');
    expect(chatVariant(entry({ kind: 'event', body: 'stream created: x' }))).toBe('system');
    expect(chatVariant(entry({ by: 'daemon', kind: 'event' }))).toBe('system');
    expect(chatVariant(entry({ by: `agent:${SESSION}` }))).toBe('agent');
    expect(chatVariant(entry({ by: 'daemon', kind: 'proposal' }))).toBe('agent');
    expect(chatVariant(entry({ by: 'daemon', kind: 'event', agent_only: true }))).toBeUndefined();
    expect(
      chatVariant(
        entry({ by: 'daemon', kind: 'event', body: `rule_hit: ${RULE} denied`, ref: RULE }),
      ),
    ).toBe('rule_hit');
  });

  test('runs by one author continue; a system row or a new day breaks the run', () => {
    const agent = `agent:${SESSION}`;
    const now = new Date('2026-09-26T12:00:00').getTime();
    const rows = chatRows(
      [
        entry({ by: agent, ts: '2026-09-25T09:00:00' }),
        entry({ by: agent, ts: '2026-09-25T09:01:00' }),
        entry({ by: agent, ts: '2026-09-26T09:00:00' }),
        entry({ by: 'daemon', kind: 'event', ts: '2026-09-26T09:01:00' }),
        entry({ by: agent, ts: '2026-09-26T09:02:00' }),
        entry({ by: 'daemon', kind: 'event', agent_only: true, ts: '2026-09-26T09:03:00' }),
        entry({ ts: '2026-09-26T09:04:00' }),
      ],
      now,
    );
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 6]);
    expect(rows.map((r) => r.continued)).toEqual([false, true, false, false, false, false]);
    expect(rows.map((r) => r.day)).toEqual([
      'Yesterday',
      undefined,
      'Today',
      undefined,
      undefined,
      undefined,
    ]);
  });

  test('day labels', () => {
    const now = new Date('2026-09-26T12:00:00').getTime();
    expect(dayLabel('2026-09-26T01:00:00', now)).toBe('Today');
    expect(dayLabel('2026-09-25T23:00:00', now)).toBe('Yesterday');
    expect(dayLabel('2026-09-20T10:00:00', now)).not.toBe('');
    expect(dayLabel('garbage', now)).toBe('');
  });

  test('system rows: three noisy lines tidied, the rest verbatim with an icon and a tone', () => {
    expect(systemLine('stream created: Ledger export')).toEqual({
      icon: 'plus',
      text: 'Node created',
      tone: 'muted',
    });
    expect(
      systemLine('worker attached: claude/claude-opus-5-5 effort=low in /tmp/x/.worktrees/abc'),
    ).toEqual({ icon: 'play', text: 'Worker started · Claude Opus 5.5 · low', tone: 'muted' });
    expect(systemLine('session ended: its turn finished').text).toBe('Turn finished');
    const held = systemLine('delivery held: waits on Blog note');
    expect(held.text).toBe('delivery held: waits on Blog note');
    expect(held.tone).toBe('warn');
    expect(held.icon).toBe('clock');
    expect(systemLine('opened PR #3 into main: https://x').icon).toBe('git-pull-request');
    expect(systemLine('landed stream/abc into main (1234567)').icon).toBe('git-merge');
    expect(systemLine('could not start the agent: no vendor').icon).toBe('alert-triangle');
    expect(systemLine('something else').icon).toBe('info');
    // T385: an edited goal.
    expect(systemLine('goal changed: Import CSV and TSV')).toEqual({
      icon: 'pencil',
      text: 'Goal changed: Import CSV and TSV',
      tone: 'muted',
    });
  });
});

test('a rule hit reads without its prefix or the rule id', async () => {
  const { ruleHitText } = await import('./chat');
  expect(ruleHitText(`rule_hit: ${RULE} denied \`rm -rf dist\` — rule: never wipe`)).toBe(
    'denied `rm -rf dist` — rule: never wipe',
  );
});

describe('questions', () => {
  const q = (id: string, ts: string, stream = 'N'): InboxItem =>
    ({
      kind: 'question',
      id,
      stream,
      stream_path: ['n'],
      ts,
      context: 'which?',
    }) as InboxItem;

  test('the oldest open question on this node is answered unless you pick another or a message', () => {
    const items = [
      q('Q-2', '2026-09-26T10:02:00.000Z'),
      q('Q-1', '2026-09-26T10:01:00.000Z'),
      q('Q-3', '2026-09-26T10:00:00.000Z', 'OTHER'),
    ];
    const open = openQuestions(items, 'N');
    expect(open.map((i) => i.id)).toEqual(['Q-1', 'Q-2']);
    expect(answerTarget(open, undefined)).toBe('Q-1');
    expect(answerTarget(open, 'Q-2')).toBe('Q-2');
    expect(answerTarget(open, 'Q-9')).toBe('Q-1');
    expect(answerTarget(open, 'message')).toBeUndefined();
    expect(answerTarget([], undefined)).toBeUndefined();
  });

  test('oneLine keeps the first non-empty line, clipped', () => {
    expect(oneLine('\n  Pretty   or\none line?')).toBe('Pretty or');
    expect(oneLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('what Send does', () => {
  const base = { open: true, canStart: true, hasRun: false, startWith: 'Claude Opus 5.5 · low' };

  test('a node nobody started: Send starts its agent, and says with what', () => {
    const intent = sendIntent(base);
    expect(intent.action).toBe('start');
    expect(intent.hint).toBe('Starts the agent with Claude Opus 5.5 · low.');
  });

  test('stopped and ended agents restart or wake; a part waiting for its plan never starts', () => {
    expect(sendIntent({ ...base, hasRun: true, stopped: true }).hint).toMatch(
      /^Restarts the agent/,
    );
    expect(sendIntent({ ...base, hasRun: true }).hint).toMatch(/^Wakes the agent/);
    const waiting = sendIntent({ ...base, waitingForPlan: true });
    expect(waiting.action).toBe('say');
    expect(waiting.hint).toContain('starts when its plan is approved');
    expect(sendIntent({ ...base, canStart: false }).action).toBe('say');
  });

  test('a live agent: queued mid-turn, straight through when idle', () => {
    expect(sendIntent({ ...base, live: { name: 'Claude', working: true } })).toMatchObject({
      action: 'say',
      hint: 'Queued — Claude reads it after its current step.',
      placeholder: 'Message Claude…',
    });
    expect(sendIntent({ ...base, live: { name: 'Claude', working: false } }).hint).toBe(
      'Sends it to Claude now.',
    );
  });

  test('an open question wins; a merged or closed node sends nothing', () => {
    expect(
      sendIntent({ ...base, answering: 'Q-1', live: { name: 'Claude', working: false } }),
    ).toMatchObject({ action: 'answer', hint: expect.stringContaining('Answers the question') });
    expect(sendIntent({ ...base, open: false, merged: true })).toMatchObject({ action: 'none' });
    expect(sendIntent({ ...base, open: false }).hint).toContain('closed');
  });
});

describe('the header', () => {
  test('agent state in words', () => {
    const s = { agent_status: 'idle', human_status: 'open' } as const;
    expect(agentStateText({ ...s, agent_status: 'done' })).toBe('Agent finished');
    expect(agentStateText({ ...s, human_status: 'landed', agent_status: 'done' })).toBe('Merged');
    expect(agentStateText({ ...s, human_status: 'closed' })).toBe('Closed');
    expect(agentStateText({ ...s, waiting_for_plan: true })).toBe('Waiting for the plan');
    expect(agentStateText({ ...s, never_started: true })).toBe('Agent not started');
    expect(agentStateText({ ...s, stopped: true })).toBe('Agent stopped');
    expect(agentStateText({ ...s, live: true, never_started: true })).toBe('Agent idle');
    expect(agentStateText({ ...s, agent_status: 'working' })).toBe('Agent working');
  });

  test('one primary: Start when nothing runs, Merge when it is ready, Stop is never filled', () => {
    const base = {
      open: true,
      liveAgent: false,
      anyLive: false,
      canStart: true,
      mergeable: false,
      landReady: false,
    };
    expect(headerActions(base)).toEqual({ agent: 'start', merge: false, primary: 'agent' });
    expect(headerActions({ ...base, mergeable: true, landReady: true })).toEqual({
      agent: 'start',
      merge: true,
      primary: 'merge',
    });
    expect(headerActions({ ...base, mergeable: true })).toEqual({
      agent: 'start',
      merge: true,
      primary: 'agent',
    });
    expect(headerActions({ ...base, liveAgent: true, anyLive: true })).toEqual({
      agent: 'stop',
      merge: false,
    });
    expect(
      headerActions({ ...base, liveAgent: true, anyLive: true, mergeable: true, landReady: true }),
    ).toEqual({ agent: 'stop', merge: true, primary: 'merge' });
    expect(headerActions({ ...base, startIsNext: false })).toEqual({
      agent: 'start',
      merge: false,
    });
    expect(headerActions({ ...base, canStart: false })).toEqual({ merge: false });
    // T384: an idle live agent waits on you: no Stop button (it's in the menu), no Start.
    expect(headerActions({ ...base, liveAgent: true, anyLive: true, anyBusy: false })).toEqual({
      merge: false,
    });
    expect(headerActions({ ...base, liveAgent: true, anyLive: true, anyBusy: true })).toEqual({
      agent: 'stop',
      merge: false,
    });
    expect(headerActions({ ...base, open: false })).toEqual({ merge: false });
  });

  test('tabs that do not apply are left out', () => {
    expect(nodeTabs({ role: 'conversation', hasRepo: false, knowledge: 0, docs: 0 })).toEqual([
      'thread',
      'activity',
    ]);
    expect(nodeTabs({ role: 'work', hasRepo: true, knowledge: 2, docs: 1 })).toEqual([
      'thread',
      'diff',
      'activity',
      'rules',
      'docs',
    ]);
    expect(nodeTabs({ role: 'coordinating', hasRepo: false, knowledge: 0, docs: 0 })).toContain(
      'plan',
    );
    expect(
      nodeTabs({ role: 'conversation', hasRepo: false, hasPlanItem: true, knowledge: 0, docs: 0 }),
    ).toContain('plan');
    expect(
      nodeTabs({ role: 'conversation', hasRepo: false, hasChildren: true, knowledge: 0, docs: 0 }),
    ).toContain('plan');
  });

  test('T387: a project root opens on its Overview, the chat one tab away', () => {
    expect(
      nodeTabs({ role: 'project', projectRoot: true, hasRepo: false, knowledge: 0, docs: 0 }),
    ).toEqual(['overview', 'thread', 'plan', 'activity']);
    expect(
      nodeTabs({ role: 'project', projectRoot: true, hasRepo: false, knowledge: 1, docs: 2 }),
    ).toEqual(['overview', 'thread', 'plan', 'activity', 'rules', 'docs']);
    // A top-level node that is no project's root (no project record) has no Overview.
    expect(nodeTabs({ role: 'project', hasRepo: false, knowledge: 0, docs: 0 })[0]).toBe('thread');
    // Any other node opens on its chat.
    for (const role of ['coordinating', 'work', 'conversation'] as const) {
      const tabs = nodeTabs({ role, hasRepo: role === 'work', knowledge: 0, docs: 0 });
      expect(tabs[0]).toBe('thread');
      expect(tabs).not.toContain('overview');
    }
  });

  test('the details panel: the stored choice, else open on a wide window', () => {
    expect(detailsOpenFrom(null, 1400)).toBe(true);
    expect(detailsOpenFrom(null, 1000)).toBe(false);
    expect(detailsOpenFrom('closed', 1400)).toBe(false);
    expect(detailsOpenFrom('open', 390)).toBe(true);
    expect(detailsOpenFrom('junk', 1300)).toBe(true);
  });

  test('near the bottom', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 380 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 380 })).toBe(false);
  });

  test('the live agent is a worker or coordinator that is starting, running or idle', () => {
    expect(liveAgentOf([session({ role: 'reviewer' })])).toBeUndefined();
    expect(liveAgentOf([session({ status: 'stopped' })])).toBeUndefined();
    expect(liveAgentOf([session({ role: 'coordinator', status: 'idle' })])?.role).toBe(
      'coordinator',
    );
  });
});

test('the Delivery badge: merged, conflict, PR, held, then whether a merge would go through', () => {
  const none = {
    landed: false,
    conflict: false,
    prOpen: false,
    held: false,
    ready: false,
    mergedOutside: false,
  };
  expect(deliveryBadge({ ...none, landed: true, ready: true }).label).toBe('Merged');
  expect(deliveryBadge({ ...none, conflict: true, ready: true })).toEqual({
    label: 'Conflict',
    tone: 'red',
  });
  expect(deliveryBadge({ ...none, prOpen: true }).label).toBe('PR open');
  expect(deliveryBadge({ ...none, held: true, ready: true }).label).toBe('Held');
  expect(deliveryBadge({ ...none, ready: true })).toEqual({ label: 'Can merge', tone: 'green' });
  expect(deliveryBadge({ ...none, mergedOutside: true }).label).toBe('Merged outside');
  expect(deliveryBadge(none)).toEqual({ label: 'Not ready', tone: 'gray' });
});

describe('parseDiff', () => {
  const patch = [
    'diff --git a/added.txt b/added.txt',
    'new file mode 100644',
    'index 0000000..975fbec',
    '--- /dev/null',
    '+++ b/added.txt',
    '@@ -0,0 +1 @@',
    '+y',
    'diff --git a/f.txt b/f.txt',
    'index de98044..a7bc997 100644',
    '--- a/f.txt',
    '+++ b/f.txt',
    '@@ -1,3 +1,4 @@',
    ' a',
    '-b',
    '+B',
    ' c',
    '+d',
    'diff --git a/old.txt b/new.txt',
    'similarity index 100%',
    'rename from old.txt',
    'rename to new.txt',
    '',
  ].join('\n');

  test('files, their status, counts and numbered lines', () => {
    const files = parseDiff(patch);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['added.txt', 'added', 1, 0],
      ['f.txt', 'modified', 2, 1],
      ['new.txt', 'renamed', 0, 0],
    ]);
    expect(files[2]?.from).toBe('old.txt');
    const f = files[1];
    expect(f?.rows.map((r) => [r.kind, r.old, r.new])).toEqual([
      ['hunk', undefined, undefined],
      ['ctx', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['ctx', 3, 3],
      ['add', undefined, 4],
    ]);
    expect(diffTotals(files)).toEqual({ additions: 3, deletions: 1 });
  });

  test('an empty patch has no files', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('questionIdOfRef (T376)', () => {
  test('reads the question id from a thread line ref', () => {
    expect(questionIdOfRef('questions/Q-01ARZ3NDEKTSV4RRFFQ69G5FAV.yaml')).toBe(
      'Q-01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
    expect(questionIdOfRef('Q-01ARZ3NDEKTSV4RRFFQ69G5FAV.yaml')).toBe(
      'Q-01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
    expect(questionIdOfRef('gates/HIL-01ARZ3NDEKTSV4RRFFQ69G5FAV.yaml')).toBeUndefined();
    expect(questionIdOfRef(undefined)).toBeUndefined();
  });
});
