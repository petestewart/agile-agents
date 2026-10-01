/**
 * T363: the node page's chat rules. Plain `bun test`, no DOM.
 */

import { describe, expect, test } from 'bun:test';
import type { InboxItem, SessionRef, ThreadEntry } from '@agile-agents/shared';
import {
  THREAD_WINDOW,
  agentFailed,
  agentLabel,
  agentName,
  agentStateText,
  agentWords,
  chatAuthor,
  chatRows,
  chatVariant,
  contextMeter,
  dayLabel,
  deliveryBadge,
  deliveryStateWords,
  detailsOpenFrom,
  diffTotals,
  endedReasonText,
  headerActions,
  isNearBottom,
  listWords,
  liveAgentOf,
  modelLabel,
  noEffortLine,
  nodeTabs,
  openQuestions,
  parseDiff,
  proposedNext,
  questionIdOfRef,
  refusalWords,
  sendIntent,
  sessionIdText,
  sessionLabel,
  sessionLabelLong,
  sessionRoleWord,
  sessionStatusWord,
  showGoalCard,
  systemLine,
  tidyIds,
  tokensText,
  vendorLabel,
  wakeWords,
  windowRows,
  withQuestion,
  workingAs,
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
    // T467: a vendor's settings in brackets are left off the words.
    expect(modelLabel('cursor', 'grok-4.7[context=256k,fast=true]')).toBe('grok-4.7');
    expect(modelLabel('cursor', 'default[]')).toBe('Cursor default model');
    expect(modelLabel('claude', 'opus[1m]')).toBe('Claude Opus');
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
    // T401: effort only where the vendor uses it.
    expect(agentLabel({ vendor: 'gemini', effort: 'high' })).toBe('Gemini default model');
    expect(agentLabel({ vendor: 'gemini', model: 'gemini-2.5-pro', effort: 'low' })).toBe(
      'gemini-2.5-pro',
    );
    expect(agentLabel({ vendor: 'cursor', model: 'gpt-9', effort: 'max' })).toBe('Cursor · gpt-9');
    expect(sessionIdText({ vendor: 'cursor', model: 'gpt-9', effort: 'max' })).toBe(
      'cursor/gpt-9 · max effort (ignored)',
    );
    // T488: Codex takes effort through its own ACP option.
    expect(agentLabel({ vendor: 'codex', model: 'gpt-9', effort: 'max' })).toBe(
      'Codex · gpt-9 · max',
    );
    expect(sessionIdText({ vendor: 'codex', model: 'gpt-9', effort: 'max' })).toBe(
      'codex/gpt-9 · max effort',
    );
    // T488: why a vendor offers no level, in words.
    expect(noEffortLine('cursor')).toBe(
      'Cursor sets effort as part of each model: pick the model with the effort you want',
    );
    expect(noEffortLine('gemini')).toBe('Gemini has no effort setting');
    expect(sessionIdText({ vendor: 'claude', model: 'opus', effort: 'max' })).toBe(
      'claude/opus · max effort',
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
    // T413: the node's own agent goes untagged; a reviewer says so.
    expect(chatAuthor(`agent:${SESSION}`, sessions)).toEqual({ name: 'Claude', vendor: 'claude' });
    expect(
      chatAuthor(`agent:${SESSION}`, [session({ role: 'reviewer', vendor: 'codex' })]),
    ).toEqual({ name: 'Codex', role: 'reviewer', vendor: 'codex' });
    expect(chatAuthor('agent:01ARZ3NDEKTSV4RRFFQ69G5FAW', sessions)).toEqual({ name: 'Agent' });
    expect(agentName([session({ role: 'reviewer', vendor: 'gemini' }), session()])).toBe('Claude');
    expect(agentName([])).toBe('The agent');
  });

  test('T400: the live block names a running reviewer when the worker is idle', () => {
    const idle = session({ status: 'idle' });
    const reviewer = session({ role: 'reviewer', vendor: 'codex', status: 'running' });
    expect(workingAs([idle, reviewer])).toEqual({ name: 'Codex', doing: 'reviewing' });
    // Both running: the node's own agent.
    expect(workingAs([session(), reviewer])).toEqual({ name: 'Claude', doing: 'working' });
    expect(workingAs([session()])).toEqual({ name: 'Claude', doing: 'working' });
    // A stopped reviewer is not the one working.
    expect(workingAs([idle, { ...reviewer, status: 'stopped' }])).toEqual({
      name: 'Claude',
      doing: 'working',
    });
  });
});

describe('chat rows', () => {
  test('your lines are bubbles, the daemon and your events are system rows, agent-only lines hide', () => {
    expect(chatVariant(entry())).toBe('you');
    expect(chatVariant(entry({ kind: 'answer' }))).toBe('you');
    expect(chatVariant(entry({ kind: 'event', body: 'stream created: x' }))).toBe('system');
    expect(chatVariant(entry({ by: 'daemon', kind: 'event' }))).toBe('system');
    expect(chatVariant(entry({ by: `agent:${SESSION}` }))).toBe('agent');
    // T446 (audit r7 #6): a daemon proposal (a contract proposal) is a row, not a message.
    expect(chatVariant(entry({ by: 'daemon', kind: 'proposal' }))).toBe('system');
    // T446: what a coordinator or the Director did itself is a row too; its words stay a message.
    expect(chatVariant(entry({ by: 'coordinator', kind: 'event' }))).toBe('system');
    expect(chatVariant(entry({ by: 'director', kind: 'proposal' }))).toBe('system');
    expect(chatVariant(entry({ by: 'director', kind: 'line' }))).toBe('agent');
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

  test('system rows: the noisy lines tidied, the rest verbatim with an icon and a tone', () => {
    expect(systemLine('stream created: Ledger export')).toEqual({
      icon: 'plus',
      text: 'Node created',
      tone: 'muted',
    });
    expect(
      systemLine('worker attached: claude/claude-opus-5-5 effort=low in /tmp/x/.worktrees/abc'),
    ).toEqual({
      icon: 'play',
      text: 'Agent started · Claude Opus 5.5 · low effort',
      tone: 'muted',
    });
    // T401: no effort for a vendor that has none.
    expect(systemLine('reviewer attached: gemini/default effort=low').text).toBe(
      'Reviewer started · Gemini default model',
    );
    expect(systemLine('session ended: its turn finished').text).toBe('Agent finished its turn');
    // T465 (D48): a finished turn's session stays; it ends after its idle time, or resumes.
    expect(systemLine('turn finished').text).toBe('Agent finished its turn');
    expect(systemLine('resumed its earlier session').text).toBe('Resumed its earlier session');
    expect(
      systemLine('session ended: it sat idle for 30 minutes after its turn finished').text,
    ).toBe('Session closed after 30 minutes idle');
    const held = systemLine('delivery held: waits on Blog note');
    expect(held.text).toBe('delivery held: waits on Blog note');
    expect(held.tone).toBe('warn');
    expect(held.icon).toBe('clock');
    expect(systemLine('opened PR #3 into main: https://x').icon).toBe('git-pull-request');
    expect(systemLine('landed stream/abc into main (1234567)').icon).toBe('git-merge');
    expect(systemLine('landed stream/abc into main (1234567)').text).toBe(
      'landed stream/abc into main (1234567)',
    );
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

describe("T435: a conversation's question in its thread", () => {
  const created = entry({ kind: 'event', body: 'stream created: Why buffer?' });
  const started = entry({
    by: 'daemon',
    kind: 'event',
    body: 'worker attached: claude/x effort=low',
  });
  const reply = entry({ by: `agent:${SESSION}`, body: 'It streams.' });
  const question = entry({ body: 'Why buffer the file?' });

  test('after "Node created", in one list: one day divider over both', () => {
    const { entries, at, threadIndex, listIndex } = withQuestion(
      [created, started, reply],
      question,
    );
    expect(entries).toEqual([created, question, started, reply]);
    expect(at).toBe(1);
    expect([0, 1, 2, 3].map(threadIndex)).toEqual([0, undefined, 1, 2]);
    expect([0, 1, 2].map(listIndex)).toEqual([0, 2, 3]);
    expect(chatRows(entries).filter((r) => r.day !== undefined)).toHaveLength(1);
  });

  test('first when "Node created" is not loaded; nothing to add without a question', () => {
    expect(withQuestion([reply], question).entries).toEqual([question, reply]);
    expect(withQuestion([], question).entries).toEqual([question]);
    const none = withQuestion([created, reply], undefined);
    expect(none.entries).toEqual([created, reply]);
    expect(none.at).toBe(-1);
    expect(none.threadIndex(1)).toBe(1);
    expect(none.listIndex(1)).toBe(1);
  });
});

describe('T413: system rows in words', () => {
  const BRANCH = 'stream/01m3fh6grhqp0ygwcpk6zep3en-migrate-docs-to-astro';

  test('what woke the agent, in words', () => {
    expect(systemLine('woken by knowledge accepted, overlap, ship findings')).toEqual({
      icon: 'play',
      text: 'Woke up for new knowledge, overlapping changes and ship check findings',
      tone: 'muted',
    });
    expect(wakeWords('human line')).toBe('Woke up for your message');
    expect(wakeWords('something new')).toBe('Woke up for something new');
    expect(wakeWords('')).toBe('Woke up');
  });

  test('a wait that is over says what happened, not "satisfied"', () => {
    expect(systemLine('waits on Update README badges satisfied').text).toBe(
      'Update README badges merged, so this no longer waits on it',
    );
    expect(systemLine('waits on A, B satisfied').text).toBe(
      'A, B merged, so this no longer waits on them',
    );
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c');
  });

  test('no node branch or id in the text; the tooltip keeps the raw line', () => {
    expect(systemLine(`synced main into ${BRANCH}`)).toEqual({
      icon: 'refresh',
      text: 'Synced main into this branch',
      tone: 'muted',
    });
    expect(systemLine(`synced main into ${BRANCH} and pushed`).text).toBe(
      'Synced main into this branch and pushed it',
    );
    expect(systemLine(`marked landed: ${BRANCH} was already merged into main`).text).toBe(
      'Marked as merged: migrate-docs-to-astro was already in main',
    );
    expect(systemLine('worker detached by human').text).toBe('You stopped the agent');
    expect(tidyIds(`push of ${BRANCH} after sync failed: no remote`)).toBe(
      'push of migrate-docs-to-astro after sync failed: no remote',
    );
    expect(tidyIds('moved away: Ledger (01ARZ3NDEKTSV4RRFFQ69G5FAV) is now under Shop')).toBe(
      'moved away: Ledger is now under Shop',
    );
    expect(tidyIds('land gate raised (G-01ARZ3NDEKTSV4RRFFQ69G5FAV) for x into main')).toBe(
      'land gate raised for x into main',
    );
  });

  test('a session in words: its role, its state, the effort as "low effort"', () => {
    expect(sessionRoleWord('worker')).toBe('Agent');
    expect(sessionRoleWord('reviewer')).toBe('Reviewer');
    expect(sessionRoleWord('helper')).toBe('Helper');
    expect(sessionStatusWord('running')).toBe('Working');
    expect(sessionStatusWord('idle')).toBe('Waiting for you');
    expect(sessionStatusWord('stopped')).toBe('Ended');
    expect(sessionLabelLong({ vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' })).toBe(
      'Claude Opus 5.5 · low effort',
    );
    expect(sessionLabelLong({ vendor: 'gemini', effort: 'low' })).toBe('Gemini default model');
  });

  test('delivery state in words', () => {
    expect(deliveryStateWords({ mode: 'direct', status: 'held' })).toBe('Direct merge · held');
    expect(deliveryStateWords({ mode: 'pr', status: 'pr_open' })).toBe('Pull request · PR open');
    expect(deliveryStateWords({ mode: 'pr', status: 'closed_unmerged' })).toBe(
      'Pull request · closed without merging',
    );
  });
});

describe('T413: the Goal card', () => {
  test('shows a goal that says more than the title', () => {
    expect(showGoalCard({ goal: 'import CSV', title: 'csv thing', projectRoot: false })).toBe(true);
    expect(
      showGoalCard({
        goal: 'Add CSV import\nWith a header row.',
        title: 'Add CSV import',
        projectRoot: false,
      }),
    ).toBe(true);
  });
  test("hides one that repeats the title, an empty one, and a project root's", () => {
    expect(
      showGoalCard({ goal: 'Add CSV import', title: 'Add CSV import', projectRoot: false }),
    ).toBe(false);
    expect(
      showGoalCard({ goal: ' add csv  import. ', title: 'Add CSV import', projectRoot: false }),
    ).toBe(false);
    expect(showGoalCard({ goal: '  ', title: 'x', projectRoot: false })).toBe(false);
    expect(showGoalCard({ goal: 'Project Blog', title: 'Blog', projectRoot: true })).toBe(false);
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

  test("this node's open questions, oldest first", () => {
    const items = [
      q('Q-2', '2026-09-26T10:02:00.000Z'),
      q('Q-1', '2026-09-26T10:01:00.000Z'),
      q('Q-3', '2026-09-26T10:00:00.000Z', 'OTHER'),
    ];
    expect(openQuestions(items, 'N').map((i) => i.id)).toEqual(['Q-1', 'Q-2']);
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
    // T423: another model picked for a live agent: Send restarts it with that model.
    expect(
      sendIntent({
        ...base,
        live: { name: 'Claude', working: false },
        restartWith: 'Claude Sonnet 4.6 · high',
      }),
    ).toMatchObject({
      action: 'restart',
      hint: 'Restarts the agent with Claude Sonnet 4.6 · high, then sends this.',
    });
    expect(
      sendIntent({
        ...base,
        live: { name: 'Claude', working: true },
        restartWith: 'Gemini default model',
      }).hint,
    ).toBe(
      'Stops Claude’s current step, restarts the agent with Gemini default model, then sends this.',
    );
    expect(sendIntent({ ...base, live: { name: 'Claude', working: false } }).hint).toBe(
      'Sends it to Claude now.',
    );
  });

  test('a merged node sends nothing; a closed one reopens', () => {
    expect(sendIntent({ ...base, open: false, merged: true })).toMatchObject({ action: 'none' });
    // T471: closed is inactive, not read-only: Send reopens it and wakes the agent.
    expect(sendIntent({ ...base, open: false })).toMatchObject({ action: 'start' });
    expect(sendIntent({ ...base, open: false }).hint).toContain('Reopens this node');
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

  test('T436: with a decision card open (a plan to approve), Start is plain: the card leads', () => {
    const base = {
      open: true,
      liveAgent: false,
      anyLive: false,
      canStart: true,
      mergeable: false,
      landReady: false,
    };
    expect(headerActions({ ...base, decisionOpen: true })).toEqual({
      agent: 'start',
      merge: false,
    });
    expect(headerActions({ ...base, decisionOpen: false })).toEqual({
      agent: 'start',
      merge: false,
      primary: 'agent',
    });
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
  expect(deliveryBadge({ ...none, landed: true, ready: true })).toEqual({
    label: 'Merged',
    tone: 'purple',
  });
  expect(deliveryBadge({ ...none, conflict: true, ready: true })).toEqual({
    label: 'Conflict',
    tone: 'red',
  });
  expect(deliveryBadge({ ...none, prOpen: true })).toEqual({ label: 'PR open', tone: 'blue' });
  expect(deliveryBadge({ ...none, held: true, ready: true }).label).toBe('Held');
  // T436: commits on a node still going: it can merge, but that is no status of its own.
  expect(deliveryBadge({ ...none, ready: true })).toEqual({ label: 'Can merge', tone: 'gray' });
  expect(deliveryBadge({ ...none, mergedOutside: true })).toEqual({
    label: 'Already merged',
    tone: 'amber',
  });
  expect(deliveryBadge(none)).toEqual({ label: 'Not ready', tone: 'gray' });
});

test('T436: the Delivery badge says the node’s status in its word and tone, as the header’s pill', () => {
  const none = {
    landed: false,
    conflict: false,
    prOpen: false,
    held: false,
    ready: true,
    mergedOutside: false,
  };
  // The header says "Ready to merge" in amber: so does Delivery (it said "Can merge" in green).
  expect(deliveryBadge({ ...none, status: 'ready' })).toEqual({
    label: 'Ready to merge',
    tone: 'amber',
  });
  expect(deliveryBadge({ ...none, ready: false, status: 'no_changes' })).toEqual({
    label: 'No changes',
    tone: 'amber',
  });
  // A status that isn't about delivery leaves the badge to what the branch can do.
  expect(deliveryBadge({ ...none, status: 'working' })).toEqual({
    label: 'Can merge',
    tone: 'gray',
  });
  // A conflict or a hold says more than the status.
  expect(deliveryBadge({ ...none, conflict: true, status: 'ready' }).label).toBe('Conflict');
  expect(deliveryBadge({ ...none, held: true, status: 'ready' }).label).toBe('Held');
  expect(deliveryBadge({ ...none, landed: true, status: 'merged' }).label).toBe('Merged');
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

describe('T411: how full the context is', () => {
  test('token counts a glance reads', () => {
    expect(tokensText(950)).toBe('950');
    expect(tokensText(46_406)).toBe('46k');
    expect(tokensText(200_000)).toBe('200k');
    expect(tokensText(1_000_000)).toBe('1M');
    expect(tokensText(1_250_000)).toBe('1.3M');
  });

  test('the share used, a level, and the numbers in words', () => {
    expect(contextMeter({ used: 46_406, size: 200_000 })).toEqual({
      percent: 23,
      level: 'ok',
      title: 'Context: 46k of 200k tokens used (23%)',
    });
    expect(contextMeter({ used: 150_000, size: 200_000 }).level).toBe('high');
    expect(contextMeter({ used: 181_000, size: 200_000 }).level).toBe('full');
    expect(contextMeter({ used: 250_000, size: 200_000 }).percent).toBe(100);
  });
});

describe('T421: a conclusion sent up reads in words', () => {
  test('"sent to X: …" is a system row with the send icon', () => {
    expect(systemLine('sent to Add CSV import: Stream it.')).toEqual({
      icon: 'send',
      text: 'Sent to Add CSV import: Stream it.',
      tone: 'muted',
    });
  });
});

describe('proposedNext (T427)', () => {
  const line = (body: string, by = 'agent:01J0000000000000000000000A', kind = 'proposal') =>
    ({ by, kind, body }) as Parameters<typeof proposedNext>[0];
  test("a worker's propose_next line is the node it proposes", () => {
    expect(
      proposedNext(line('next: Add CSV export — Export the ledger as CSV, with a test.')),
    ).toEqual({
      title: 'Add CSV export',
      goal: 'Export the ledger as CSV, with a test.',
    });
  });
  test('anything else proposes no node', () => {
    expect(proposedNext(line('next: this needs a change in web too; add it?'))).toBeUndefined();
    expect(proposedNext(line('next: A — B', 'human'))).toBeUndefined();
    expect(
      proposedNext(line('next: A — B', 'agent:01J0000000000000000000000A', 'line')),
    ).toBeUndefined();
  });
});

describe('a vendor that exits (T432)', () => {
  test('non-zero is a failure with its reason and what to do; zero is a quiet end', () => {
    const failed = systemLine(
      'session ended: process exited (code 1): Invalid API key · Please run /login',
    );
    expect(failed.tone).toBe('warn');
    expect(failed.text).toBe(
      'The agent stopped with an error: Invalid API key · Please run /login. Check its vendor is installed and logged in, then send a message to start it again.',
    );
    expect(systemLine('session ended: process exited (code 2)').text).toContain('(exit code 2)');
    expect(systemLine('session ended: process exited (code 0)')).toEqual({
      icon: 'square',
      text: 'The agent’s process ended',
      tone: 'muted',
    });
  });
});

describe('an agent that failed (T438)', () => {
  const daemon = (body: string) => ({ by: 'daemon', kind: 'event' as const, body });
  test('a start that failed reads in words, with what to do', () => {
    const line = systemLine(
      "could not start the agent: Claude Code can't start: `claude` is not on the daemon's PATH.",
    );
    expect(line.tone).toBe('warn');
    expect(line.icon).toBe('alert-triangle');
    expect(line.text).toBe(
      "The agent couldn’t start: Claude Code can't start: `claude` is not on the daemon's PATH. Fix its install or login, then send a message to start it again.",
    );
  });
  test('a failed start or a non-zero exit is a failure; a clean end or other lines are not', () => {
    expect(agentFailed([daemon('could not start the agent: no vendor')])).toBe(true);
    expect(agentFailed([daemon('session ended: process exited (code 1): Invalid API key')])).toBe(
      true,
    );
    expect(agentFailed([daemon('session ended: process exited (code 0)')])).toBe(false);
    expect(agentFailed([daemon('session ended: its turn finished')])).toBe(false);
    expect(agentFailed([])).toBe(false);
    // A line you wrote that says the same is yours, not the daemon's.
    expect(
      agentFailed([{ by: 'human', kind: 'line', body: 'could not start the agent: typo' }]),
    ).toBe(false);
  });
});

describe('a turn the vendor failed (T460)', () => {
  const how =
    'Claude Code isn’t logged in. Log in from a terminal (run `claude` and type /login), then send a message to start it again.';
  test('reads as the daemon wrote it, a warning; the chat counts it as a failure', () => {
    expect(systemLine(`session ended: turn failed: ${how}`)).toEqual({
      icon: 'alert-triangle',
      text: how,
      tone: 'warn',
    });
    expect(
      agentFailed([{ by: 'daemon', kind: 'event', body: `session ended: turn failed: ${how}` }]),
    ).toBe(true);
  });
  test('Details shows the words alone, as an error', () => {
    expect(endedReasonText({ status: 'error', ended_reason: `turn failed: ${how}` })).toEqual({
      text: how,
      tone: 'error',
    });
  });
  test('a gate id in parentheses is left out, like a node id', () => {
    expect(tidyIds('held for you (HIL-01M3K1XQG8KQWQ5YK53X063ECE)')).toBe('held for you');
  });
});

describe('an agent that echoed a verb in its text (T466)', () => {
  test('a leading "progress —" is dropped; the word elsewhere stays', () => {
    expect(agentWords('progress — I’ll count the files.')).toBe('I’ll count the files.');
    expect(agentWords('Progress: done')).toBe('done');
    expect(agentWords('progress - x')).toBe('x');
    expect(agentWords('Making progress — nearly there')).toBe('Making progress — nearly there');
    expect(agentWords('progressive enhancement')).toBe('progressive enhancement');
  });
});

describe('a call the hook refused or held (T462)', () => {
  test("in words, without the daemon's role names", () => {
    expect(
      systemLine(
        'hook_deny: denied `for t in 1 2; do date -r $t; done` — for is not an allowed command for the engineer role',
      ),
    ).toEqual({
      icon: 'lock',
      text: 'Refused: `for t in 1 2; do date -r $t; done` — for is not an allowed command',
      tone: 'muted',
    });
    expect(
      systemLine(
        'hook_deny: routed to the human `rm -rf ../a` — rm -rf outside the worktree is never automatic',
      ),
    ).toEqual({
      icon: 'clock',
      text: 'Held for your approval: `rm -rf ../a` — rm -rf outside the worktree is never automatic',
      tone: 'warn',
    });
    expect(
      refusalWords(
        'reviewer role denies all exec except read-only tools (git diff/log/show, grep, …)',
      ),
    ).toBe('a reviewer runs only read-only tools (git diff/log/show, grep, …)');
  });
});

describe('why a session ended, in Details (T438)', () => {
  test("a non-zero exit is an error with the vendor's line, never the exit code's words", () => {
    expect(
      endedReasonText({
        status: 'error',
        ended_reason: 'process exited (code 1): Invalid API key · Please run /login',
      }),
    ).toEqual({
      text: 'Stopped with an error: Invalid API key · Please run /login',
      tone: 'error',
    });
    expect(endedReasonText({ status: 'error', ended_reason: 'process exited (code 137)' })).toEqual(
      { text: 'Stopped with an error (exit code 137)', tone: 'error' },
    );
  });
  test('a clean end, a finished turn and a stop are quiet', () => {
    expect(endedReasonText({ status: 'stopped', ended_reason: 'process exited (code 0)' })).toEqual(
      { text: 'The process ended', tone: 'muted' },
    );
    expect(endedReasonText({ status: 'stopped', ended_reason: 'its turn finished' })).toEqual({
      text: 'Finished its turn',
      tone: 'muted',
    });
    expect(endedReasonText({ status: 'stopped', ended_reason: 'stopped: reshape' })).toEqual({
      text: 'Stopped: reshape',
      tone: 'muted',
    });
    expect(endedReasonText({ status: 'stopped' })).toBeUndefined();
  });
  test('any other failure keeps its words, capitalised, as an error', () => {
    expect(
      endedReasonText({ status: 'error', ended_reason: 'transport error: pipe closed' }),
    ).toEqual({ text: 'Transport error: pipe closed', tone: 'error' });
  });
});

describe('T446: what an agent did on its own, as rows', () => {
  const NODE = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
  const known = (id: string) => id === NODE;

  test('an applied change is a row with its actor’s icon, the title bold and linked', () => {
    expect(
      systemLine('Added a part: "Add an RSS field" (web)', { by: 'coordinator', ref: NODE, known }),
    ).toEqual({ icon: 'bot', text: `Added a part: **${NODE}** (web)`, tone: 'muted' });
    // A node the cockpit no longer knows keeps its title, unlinked.
    expect(
      systemLine('Added a part: "Add an RSS field" (web)', {
        by: 'coordinator',
        ref: NODE,
        known: () => false,
      }).text,
    ).toBe('Added a part: **Add an RSS field** (web)');
    expect(
      systemLine('Created "Newsletter signup" in Blog with 2 parts', {
        by: 'director',
        ref: NODE,
        known,
      }),
    ).toEqual({
      icon: 'sparkles',
      text: `Created **${NODE}** in Blog with 2 parts`,
      tone: 'muted',
    });
    expect(systemLine('You added a node: "Docs"', { by: 'human', ref: NODE, known }).text).toBe(
      `You added a node: **${NODE}**`,
    );
    expect(systemLine('Linked web to wait on api', { by: 'coordinator' })).toEqual({
      icon: 'bot',
      text: 'Linked web to wait on api',
      tone: 'muted',
    });
  });

  test('"stream created:" is "Node created" whoever wrote it', () => {
    for (const by of ['human', 'daemon', 'coordinator', 'director']) {
      expect(systemLine('stream created: Gift cards', { by }).text).toBe('Node created');
    }
  });

  test('lines written before T446 read in words', () => {
    expect(
      systemLine('coordinator (organise) applied: web waits on api', { by: 'coordinator' }),
    ).toMatchObject({ icon: 'bot', text: 'Applied: web waits on api' });
    expect(systemLine('plan v1 approved by human').text).toBe('You approved plan v1');
    expect(systemLine('plan drafted (2 children, 0 contracts); waiting for approval').text).toBe(
      'Plan drafted for 2 parts; waiting for approval',
    );
    expect(
      systemLine(
        'api part, web part wait for the plan: write it with plan_write (who owns which paths); each part starts once the plan is approved',
      ).text,
    ).toBe('api part, web part wait for the plan; each starts once the plan is approved');
    expect(
      systemLine(
        'contract Key file: 1 child(ren) propose (CP-01ARZ3NDEKTSV4RRFFQ69G5FAV): keys move.. Reason: additive',
      ).text,
    ).toBe('A part proposes a change to Key file: keys move. Why: additive');
  });

  test('a contract proposal is a row', () => {
    const line = entry({
      by: 'daemon',
      kind: 'proposal',
      body: 'api proposes a change to Key file: keys move. Why: additive',
    });
    expect(chatVariant(line)).toBe('system');
    expect(systemLine(line.body).icon).toBe('file-text');
  });
});

describe('T446: a coordinator’s routine wake folds into its reply', () => {
  const COORD = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
  const agent = `agent:${COORD}`;
  const wake = (types: string, at: string) =>
    entry({ by: 'daemon', kind: 'event', body: `woken by ${types}`, ts: at });
  const attached = (at: string) =>
    entry({
      by: 'daemon',
      kind: 'event',
      body: 'coordinator attached: claude/claude-opus-5-5 effort=low',
      ref: COORD,
      ts: at,
    });
  const ended = (at: string, why = 'its turn finished') =>
    entry({ by: 'daemon', kind: 'event', body: `session ended: ${why}`, ref: COORD, ts: at });

  test('woken, started, the reply, finished: one reply headed "Woke for a merge"', () => {
    const rows = chatRows([
      wake('pr merged', '2026-09-26T01:14:00'),
      attached('2026-09-26T01:14:01'),
      entry({ by: agent, body: 'api merged; web goes next.', ts: '2026-09-26T01:14:30' }),
      ended('2026-09-26T01:14:40'),
    ]);
    expect(rows.map((r) => r.index)).toEqual([2]);
    expect(rows[0]?.wake).toEqual({ text: 'Woke for a merge', ts: '2026-09-26T01:14:00' });
    expect(rows[0]?.continued).toBe(false);
  });

  test('a turn with no reply is one muted row', () => {
    const rows = chatRows([
      wake('child status, overlap', '2026-09-26T01:14:00'),
      attached('2026-09-26T01:14:01'),
      ended('2026-09-26T01:14:40'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.system).toEqual({
      icon: 'check',
      text: 'Woke for news from a part and overlapping changes · nothing new',
      tone: 'muted',
    });
  });

  test('your line’s wake, a running turn and a failed one keep their rows', () => {
    const yours = chatRows([
      wake('human line', '2026-09-26T01:14:00'),
      attached('2026-09-26T01:14:01'),
      ended('2026-09-26T01:14:40'),
    ]);
    expect(yours).toHaveLength(3);
    const running = chatRows([
      wake('pr merged', '2026-09-26T01:14:00'),
      attached('2026-09-26T01:14:01'),
    ]);
    expect(running).toHaveLength(2);
    const failed = chatRows([
      wake('pr merged', '2026-09-26T01:14:00'),
      attached('2026-09-26T01:14:01'),
      ended('2026-09-26T01:14:40', 'process exited (code 1)'),
    ]);
    expect(failed).toHaveLength(3);
  });

  test('T465: woken in its resting session, the reply, turn finished: one reply headed "Woke for a merge"', () => {
    const woken = (types: string, at: string) =>
      entry({ by: 'daemon', kind: 'event', body: `woken by ${types}`, ref: COORD, ts: at });
    const finished = (at: string) =>
      entry({ by: 'daemon', kind: 'event', body: 'turn finished', ref: COORD, ts: at });
    const rows = chatRows([
      attached('2026-09-26T01:00:00'),
      entry({ by: agent, body: 'plan written.', ts: '2026-09-26T01:00:30' }),
      finished('2026-09-26T01:00:40'),
      woken('pr merged', '2026-09-26T01:14:00'),
      entry({ by: agent, body: 'api merged; web goes next.', ts: '2026-09-26T01:14:30' }),
      finished('2026-09-26T01:14:40'),
    ]);
    const reply = rows.find((r) => r.index === 4);
    expect(reply?.wake).toEqual({ text: 'Woke for a merge', ts: '2026-09-26T01:14:00' });
    expect(rows.some((r) => r.index === 3 || r.index === 5)).toBe(false);
    // A resumed session's row folds with the rest.
    const resumed = chatRows([
      wake('pr merged', '2026-09-26T01:14:00'),
      attached('2026-09-26T01:14:01'),
      entry({
        by: 'daemon',
        kind: 'event',
        body: 'resumed its earlier session',
        ref: COORD,
        ts: '2026-09-26T01:14:02',
      }),
      entry({ by: agent, body: 'api merged; web goes next.', ts: '2026-09-26T01:14:30' }),
      finished('2026-09-26T01:14:40'),
    ]);
    expect(resumed.map((r) => r.index)).toEqual([3]);
  });

  test('a worker’s wake is not folded', () => {
    const rows = chatRows([
      wake('ci failed', '2026-09-26T01:14:00'),
      entry({
        by: 'daemon',
        kind: 'event',
        body: 'worker attached: claude/claude-opus-5-5 effort=low',
        ref: COORD,
        ts: '2026-09-26T01:14:01',
      }),
      ended('2026-09-26T01:14:40'),
    ]);
    expect(rows).toHaveLength(3);
  });
});

describe('windowRows (T447, audit r7 #15)', () => {
  const line = (i: number, by = 'human'): ThreadEntry => ({
    ts: `2026-09-2${i < 50 ? 5 : 6}T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
    by,
    kind: 'line',
    body: `line ${i}`,
  });

  test('a short thread is shown whole', () => {
    const rows = chatRows([line(1), line(2)]);
    expect(windowRows(rows, THREAD_WINDOW)).toEqual({ rows, hidden: 0 });
  });

  test("a long one shows its newest rows; the first keeps its day and author's head and its index", () => {
    const entries = Array.from({ length: 120 }, (_, i) => line(i, i < 60 ? 'human' : 'agent:s'));
    const rows = chatRows(entries);
    const { rows: shown, hidden } = windowRows(rows, 30);
    expect(hidden).toBe(90);
    expect(shown).toHaveLength(30);
    expect(shown[0]?.index).toBe(90);
    expect(shown[0]?.continued).toBe(false);
    const days = rows.slice(0, 91).filter((r) => r.day !== undefined);
    expect(shown[0]?.day).toBe(days[days.length - 1]?.day);
    expect(shown.slice(1)).toEqual(rows.slice(91));
    // More shown: fewer hidden.
    expect(windowRows(rows, 30 + THREAD_WINDOW).hidden).toBe(10);
    expect(windowRows(rows, Number.MAX_SAFE_INTEGER).hidden).toBe(0);
  });
});
