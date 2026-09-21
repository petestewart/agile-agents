/**
 * Plan screen back end (T042). Covers the three living-plan rules, the
 * sprint projection, Start Sprint N, the post-decision re-examination pass,
 * and the first-goal routing — all offline, no vendor.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OracleId, TicketId } from '@agile-agents/shared';
import { Bus } from '../bus';
import { EmLoop } from '../em/loop';
import { type Fixture, fakeRunner, makeFixture, makeTicket } from '../em/test-helpers';
import { GateService } from '../gates';
import { PRODUCT_MD_STUB } from '../init';
import { QuestionService } from '../questions';
import { StreamService } from '../streams';
import { editModeFor } from './living';
import { isFirstGoal, startPlanningTurn } from './planning-turn';
import { buildSprintBoard, projectLayers } from './projection';
import { PlanService } from './service';
import { isStub } from './stub';

let fx: Fixture;
let bus: Bus;

beforeEach(() => {
  fx = makeFixture();
  bus = new Bus(fx.store, fx.stateRoot);
});

afterEach(() => {
  fx.cleanup();
});

function service(overrides: Partial<ConstructorParameters<typeof PlanService>[0]> = {}) {
  return new PlanService({
    store: fx.store,
    bus,
    gates: new GateService(fx.store),
    questions: new QuestionService(fx.store, new StreamService(fx.store)),
    ...overrides,
  });
}

describe('brief pane', () => {
  test('reads the init stub as a stub and writes through the store (event + commit)', async () => {
    const plan = service();
    expect(plan.brief().stub).toBe(true);
    expect(plan.brief().body).toBe(PRODUCT_MD_STUB);

    await plan.putBrief('# Product\n\nA tiny ledger.\n\n## Current goal\n\nAdd transfers.\n');
    const after = plan.brief();
    expect(after.stub).toBe(false);
    expect(after.body).toContain('A tiny ledger');
    const events = fx.store.listEvents();
    expect(
      events.some((e) => e.kind === 'entity_put' && e.data.relPath === 'oracle/product.md'),
    ).toBe(true);
  });
});

describe('rules pane', () => {
  test('a new rule is written through the oracle write guard', async () => {
    const plan = service();
    const result = await plan.putRule({
      title: 'Code quality baseline',
      body: 'Money is integer cents; no floating point on amounts.',
    });
    expect(result.proposed).toBe(false);
    expect(result.entry?.id).toMatch(/^SPEC-code-quality-001$/);
    expect(plan.listRules()).toHaveLength(1);
    expect(fx.store.listEvents().some((e) => e.kind === 'oracle_put')).toBe(true);
  });

  test('editing a rule a not-done ticket already cites becomes a proposed decision, never a rewrite', async () => {
    const plan = service();
    const created = await plan.putRule({ title: 'Ledger rules', body: 'Original wording.' });
    const id = created.entry?.id as OracleId;
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId, { oracle_refs: [id] }));

    const edited = await plan.putRule({ id, title: 'Ledger rules', body: 'New wording.' });
    expect(edited.proposed).toBe(true);
    expect(edited.cited_by).toEqual(['TKT-0001']);
    // Untouched on disk.
    expect(fx.store.getOracleEntry(id).body).toContain('Original wording.');
    const inbox = bus.poll('architect');
    expect(inbox.some((m) => m.kind === 'decision' && m.body.includes('New wording.'))).toBe(true);
  });
});

describe('living-plan ticket edits', () => {
  test('a not-started ticket is edited in place', async () => {
    const plan = service();
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId));
    const result = await plan.editTicket('TKT-0001' as TicketId, { title: 'New title' });
    expect(result.mode).toBe('free');
    expect(fx.store.getTicket('TKT-0001' as TicketId).title).toBe('New title');
    expect(result.message).toBeUndefined();
  });

  test('an in-flight ticket edit produces a contract-change message to its engineer', async () => {
    const plan = service();
    await fx.store.putTicket(
      makeTicket('TKT-0001' as TicketId, { status: 'in_progress', assignee: 'eng-1' }),
    );
    const result = await plan.editTicket('TKT-0001' as TicketId, {
      contract: { acceptance: ['transfers reject the same account'] },
    });
    expect(result.mode).toBe('contract_change');
    const inbox = bus.poll('eng-1');
    const delivered = inbox.find((m) => m.body.includes('Contract change on TKT-0001'));
    expect(delivered?.from).toBe('human');
    expect(delivered?.kind).toBe('assign');
    // Not a silent rewrite: the ticket carries the new contract *and* the
    // engineer was told.
    expect(fx.store.getTicket('TKT-0001' as TicketId).contract.acceptance).toEqual([
      'transfers reject the same account',
    ]);
    expect(fx.store.listEvents().some((e) => e.kind === 'message')).toBe(true);
  });

  test('a done ticket edit becomes a follow-up ticket that depends on it', async () => {
    const plan = service();
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId, { status: 'done' }));
    const result = await plan.editTicket('TKT-0001' as TicketId, { title: 'Also handle refunds' });
    expect(result.mode).toBe('follow_up');
    expect(result.followUp?.depends).toEqual(['TKT-0001']);
    expect(result.followUp?.status).toBe('draft');
    // The done ticket itself is untouched.
    expect(fx.store.getTicket('TKT-0001' as TicketId).title).toBe('Ticket TKT-0001');
  });

  test('editModeFor: an unassigned in-flight-status ticket is still free to edit', async () => {
    expect(editModeFor(makeTicket('TKT-0009' as TicketId, { status: 'in_progress' }))).toBe('free');
  });
});

describe('sprints pane', () => {
  test('projects later layers from the dependency graph without writing anything', async () => {
    const tickets = [
      makeTicket('TKT-0001' as TicketId),
      makeTicket('TKT-0002' as TicketId),
      makeTicket('TKT-0003' as TicketId, {
        status: 'draft',
        depends: ['TKT-0001' as TicketId, 'TKT-0002' as TicketId],
      }),
    ];
    for (const t of tickets) await fx.store.putTicket(t);
    const before = fx.store.listEvents().length;

    const board = service().sprints();
    expect(board.next?.tickets).toEqual(['TKT-0001', 'TKT-0002']);
    const projected = board.rows.filter((r) => r.state === 'projected');
    expect(projected).toHaveLength(1);
    expect(projected[0]?.tickets.map((t) => t.id)).toEqual(['TKT-0003']);
    expect(projected[0]?.tickets[0]?.blocked_by).toEqual(['TKT-0001', 'TKT-0002']);
    expect(projected[0]?.tickets[0]?.stub).toBe(true);
    // The settled row carries the blocker pill's data.
    const next = board.rows.find((r) => r.state === 'next');
    expect(next?.tickets[0]?.blocks).toEqual(['TKT-0003']);
    // Read-only: no new events.
    expect(fx.store.listEvents().length).toBe(before);
  });

  test('projectLayers stops instead of looping on a dependency cycle', () => {
    const a = makeTicket('TKT-0001' as TicketId, {
      status: 'draft',
      depends: ['TKT-0002' as TicketId],
    });
    const b = makeTicket('TKT-0002' as TicketId, {
      status: 'draft',
      depends: ['TKT-0001' as TicketId],
    });
    expect(projectLayers([a, b], [])).toEqual([['TKT-0001', 'TKT-0002']]);
  });

  test('a finished sprint keeps its row with a report link', async () => {
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId, { status: 'done', sprint: 'S-1' }));
    await fx.store.putSprint({
      id: 'S-1',
      goal: 'first layer',
      tickets: ['TKT-0001' as TicketId],
      budget_tokens: 1000,
      started: new Date().toISOString(),
      carried_over: [],
    });
    const board = buildSprintBoard(fx.store.listTickets(), fx.store.listSprints());
    const finished = board.rows.find((r) => r.state === 'finished');
    expect(finished?.id).toBe('S-1');
    expect(finished && 'report' in finished ? finished.report : undefined).toBe('runs/S-1.md');
    expect(board.running).toBeUndefined();
  });

  test('move later drops a ticket off the frontier; move next puts it back', async () => {
    const plan = service();
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId));
    await plan.moveTicket('TKT-0001' as TicketId, 'later');
    expect(plan.sprints().next).toBeUndefined();
    await plan.moveTicket('TKT-0001' as TicketId, 'next');
    expect(plan.sprints().next?.tickets).toEqual(['TKT-0001']);
  });
});

describe('Start Sprint N', () => {
  // T121: the `approve_plan` gate is deleted (cockpit design §3.1 — "there
  // is no planning turn that needs approving ... the human writes the goal
  // themselves"). The click is the approval, no HIL request is opened, and
  // the delegate/pickup/denial paths this block used to cover are gone with
  // it. T122 deletes this module.
  test('plans the frontier and starts it — the click is the approval, and no gate is opened', async () => {
    const gates = new GateService(fx.store);
    const plan = service({ gates });
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId));
    await fx.store.putTicket(makeTicket('TKT-0002' as TicketId, { status: 'draft' }));

    const result = await plan.startSprint({ by: 'pete' });
    expect(result.started).toBe(true);
    expect(result.sprint?.id).toBe('S-1');
    expect(result.sprint?.tickets).toEqual(['TKT-0001']);
    expect(result.gate.status).toBe('resolved');
    expect(result.gate.decision).toBe('approve');
    expect(gates.list()).toEqual([]);
    expect(fx.store.listEvents().some((e) => e.kind === 'gate_raised')).toBe(false);
    expect(fx.store.listEvents().some((e) => e.kind === 'sprint_put')).toBe(true);
    expect(fx.store.getTicket('TKT-0001' as TicketId).sprint).toBe('S-1');
    expect(plan.pendingApprovePlan()).toBeUndefined();
    expect(await plan.startApprovedSprint()).toBeUndefined();
  });

  test('refuses while a sprint is still running', async () => {
    const plan = service();
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId));
    await plan.startSprint();
    await fx.store.putTicket(makeTicket('TKT-0002' as TicketId));
    await expect(plan.startSprint()).rejects.toThrow(/still running/);
  });

  test('takes its goal from the brief when the architect has written one', async () => {
    const plan = service();
    await plan.putBrief('# Product\n\n## Current goal\n\nAdd transfers and reversals.\n');
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId));
    const result = await plan.startSprint();
    expect(result.sprint?.goal).toBe('Add transfers and reversals.');
  });
});

describe('decision re-examination pass', () => {
  test('a decision no ticket cites still records a verdict for every not-done ticket and updates a stub', async () => {
    const seen: string[] = [];
    const plan = service({
      reexaminer: ({ ticket }) => {
        seen.push(ticket.id);
        return isStub(ticket)
          ? {
              verdict: 'updated',
              note: 'stub now names the decision',
              patch: { description: 'Refined by the decision' },
            }
          : { verdict: 'unchanged', note: 'unaffected' };
      },
    });
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId));
    await fx.store.putTicket(makeTicket('TKT-0002' as TicketId, { status: 'draft' }));
    await fx.store.putTicket(makeTicket('TKT-0003' as TicketId, { status: 'done' }));

    const published = await plan.publishDecision({
      title: 'Money is integer cents',
      body: 'Integers everywhere; no float arithmetic on amounts.',
    });
    expect(published.stale).toEqual([]);
    // Every not-done ticket, and only those.
    expect(seen).toEqual(['TKT-0001', 'TKT-0002']);
    expect(published.reexamined.map((r) => `${r.ticket}:${r.verdict}`)).toEqual([
      'TKT-0001:unchanged',
      'TKT-0002:updated',
    ]);
    const records = fx.store.listEvents().filter((e) => e.kind === 'ticket_reexamined');
    expect(records).toHaveLength(2);
    expect(records.every((e) => e.data.decision === published.entry.id)).toBe(true);
    expect(fx.store.getTicket('TKT-0002' as TicketId).description).toBe('Refined by the decision');
  });

  test('without an architect adapter every not-done ticket is still recorded, with the reason', async () => {
    const plan = service();
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId));
    const published = await plan.publishDecision({ title: 'A call', body: 'Body.' });
    expect(published.reexamined).toHaveLength(1);
    expect(published.reexamined[0]?.verdict).toBe('unchanged');
    expect(published.reexamined[0]?.note).toContain('no architect');
  });

  test('a split verdict creates child stubs and makes the parent wait on them', async () => {
    const plan = service({
      reexaminer: ({ ticket }) =>
        ticket.id === 'TKT-0001'
          ? { verdict: 'split', children: [{ title: 'Half A' }, { title: 'Half B' }] }
          : { verdict: 'unchanged' },
    });
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId));
    const published = await plan.publishDecision({ title: 'Split it', body: 'Body.' });
    const record = published.reexamined.find((r) => r.ticket === 'TKT-0001');
    expect(record?.verdict).toBe('split');
    expect(record?.children).toHaveLength(2);
    const parent = fx.store.getTicket('TKT-0001' as TicketId);
    expect(parent.depends).toEqual(record?.children ?? []);
    for (const child of record?.children ?? []) {
      expect(isStub(fx.store.getTicket(child))).toBe(true);
    }
  });

  test('an in-flight ticket the pass updates gets the contract-change message, via the em', async () => {
    const plan = service({
      reexaminer: () => ({ verdict: 'updated', patch: { title: 'Reworded by the architect' } }),
    });
    await fx.store.putTicket(
      makeTicket('TKT-0001' as TicketId, { status: 'in_progress', assignee: 'eng-1' }),
    );
    await plan.publishDecision({ title: 'A call', body: 'Body.' });
    const em = bus.poll('em');
    expect(em.some((m) => m.from === 'architect' && m.body.includes('Contract change'))).toBe(true);
  });
});

describe('first goal routing', () => {
  test('a repo with no tickets and the init brief routes the first line to the architect', async () => {
    const plan = service();
    expect(isFirstGoal(fx.store, plan.brief().stub)).toBe(true);
    const prompts: string[] = [];
    const started = await startPlanningTurn(
      { store: fx.store, bus, planner: async ({ prompt }) => void prompts.push(prompt) },
      'Add transfers and reversals',
      fx.repo,
    );
    expect(started.started).toBe(true);
    expect(bus.poll('architect').some((m) => m.body.includes('Add transfers'))).toBe(true);
    await Bun.sleep(10);
    expect(prompts[0]).toContain('product_brief_write');
  });

  test('once a ticket exists the chat is no longer the goal', async () => {
    const plan = service();
    await fx.store.putTicket(makeTicket('TKT-0001' as TicketId));
    expect(isFirstGoal(fx.store, plan.brief().stub)).toBe(false);
  });

  test('a written brief also ends first-goal routing', async () => {
    const plan = service();
    await plan.putBrief('# Product\n\nReal brief.\n');
    expect(isFirstGoal(fx.store, plan.brief().stub)).toBe(false);
  });
});

describe('tickets and knowledge panes', () => {
  test('add ticket creates a stub; add fact writes a KB entry', async () => {
    const plan = service();
    const ticket = await plan.createTicket({
      title: 'Reverse a transfer',
      description: 'Both legs.',
    });
    expect(isStub(ticket)).toBe(true);
    expect(plan.listTickets()[0]?.stub).toBe(true);

    const fact = await plan.putKnowledge({ body: 'Tests run with bun test.' });
    expect(fact.id).toBe('KB-0001');
    expect(plan.listKnowledge()[0]?.body).toContain('bun test');
    expect(fx.store.listEvents().some((e) => e.kind === 'kb_put')).toBe(true);
  });

  test('overview carries every pane in one payload', async () => {
    const plan = service();
    const overview = plan.overview();
    expect(Object.keys(overview).sort()).toEqual([
      'brief',
      'decisions',
      'knowledge',
      'policy',
      'questions',
      'rules',
      'sprints',
      'tickets',
    ]);
    expect(overview.policy?.gates).toBeDefined();
  });
});
