/**
 * Per-ticket stories (T044 — design/agile-agents-design.md §17 "Human UI",
 * and the control-room mockup's Sprint tab: "Each ticket is a story with
 * timestamps, not a card in a column").
 *
 * One `TicketStory` per ticket: the stage it is in, who is on it, and a
 * list of timestamped steps — assigned, built, reviewed (with the verdict
 * quoted), in QA, merged, waiting on you. Nothing here is a new durable
 * artifact: every step is *derived*, on read, from state the daemon already
 * writes —
 *
 *  - `log/events.jsonl` (`state_transition`, `merge_*`, `hil_requested`) via
 *    `StateStore.listEvents()`;
 *  - `board/status/<ticket>.jsonl` stanzas (`StateStore.listStanzas`);
 *  - `board/reviews/<ticket>-r<n>[-security].yaml` review records and
 *    `board/qa/<ticket>-r<n>.yaml` QA reports (the generic entity trio);
 *  - the reviewer's / QA's own words, quoted from the `bus/threads/<ticket>/`
 *    copies of their `review_verdict` / `qa_verdict` messages (§5 "Storage":
 *    "`bus/threads/<ticket>/<ulid>.yaml` — every message touching a ticket"),
 *    matched to a round by the record path each carries in `refs`.
 *
 * Derivation, not a second source of truth, is the point: a story can never
 * disagree with the board, and no agent has to remember to narrate.
 *
 * CLAUDE.md "signal over volume": step text is capped (`STEP_TEXT_MAX_CHARS`)
 * — the full reviewer message stays on the bus, which the ticket detail
 * panel reads through `GET /api/tickets/:id/thread`.
 */

import {
  type Event,
  type Message,
  type QaReport,
  type Stanza,
  type Ticket,
  type TicketId,
  type TicketStatus,
  qaReportRelPath,
  validateMessage,
  validateQaReport,
} from '@agile-agents/shared';
import type { GateService } from '../gates';
import type { QuestionService } from '../questions';
import { type ReviewRecord, reviewRecordRelPath, validateReviewRecord } from '../review/types';
import { NotFoundError, type StateStore } from '../store';

/** Mockup `ul.steps li.good|now|warn` (plus the unmarked default). */
export type StoryTone = 'good' | 'now' | 'warn' | 'plain';

/** One timestamped line of a ticket's story. */
export interface StoryStep {
  /** ISO-8601. Steps are sorted by this; a synthetic "now" step reuses the last real timestamp. */
  ts: string;
  tone: StoryTone;
  /** The bolded lead-in (mockup `<b>Built</b>`), absent for a plain line. */
  headline?: string;
  /** The rest of the line — already capped. */
  text: string;
}

export interface StoryStage {
  label: string;
  tone: 'info' | 'warn' | 'good';
}

export interface TicketStory {
  ticket: TicketId;
  title: string;
  status: TicketStatus;
  stage: StoryStage;
  /** "<agent> · <vendor> / <model>" for whoever holds the ticket now, when an agent does. */
  who?: string;
  steps: StoryStep[];
  /** Open `hil_request`s + open questions naming this ticket — the card's "waiting on you" marker. */
  needs_you: number;
}

/** Per-step cap. The reviewer's full message is one click away on the bus thread. */
export const STEP_TEXT_MAX_CHARS = 240;

/** Review/QA rounds are 1-based and contiguous; this bounds the "walk until NotFound" reads below. */
const MAX_ROUNDS = 20;

function cap(text: string, max = STEP_TEXT_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** What a transition into each status means in plain language (ticket Notes: "legible to someone who does not know the system"). */
function transitionStep(event: Event, to: TicketStatus): StoryStep | undefined {
  const by = event.agent;
  const from = typeof event.data.from === 'string' ? (event.data.from as TicketStatus) : undefined;
  const reason = typeof event.data.reason === 'string' ? event.data.reason : undefined;
  const suffix = reason ? ` — ${reason}` : '';
  switch (to) {
    case 'ready':
      return {
        ts: event.ts,
        tone: 'plain',
        headline: 'Refined',
        text: cap(`ready to pick up${suffix}`),
      };
    case 'assigned':
      return {
        ts: event.ts,
        tone: 'plain',
        headline: 'Assigned',
        text: cap(`${by ? `to ${by}` : 'to an engineer'}${suffix}`),
      };
    case 'in_progress':
      // A ticket comes back to `in_progress` from review or QA as a *fix*
      // round, not a fresh start — the transition's `from` is what tells
      // those two apart, and reading it "Started by reviewer-1001" (which
      // is what the raw `agent` says) is exactly the kind of line the
      // ticket's Note calls illegible.
      if (from === 'in_review' || from === 'in_qa') {
        return {
          ts: event.ts,
          tone: 'warn',
          headline: 'Sent back',
          text: cap(`${by ?? 'the reviewer'} returned it to the engineer to fix${suffix}`),
        };
      }
      return {
        ts: event.ts,
        tone: 'plain',
        headline: 'Started',
        text: cap(`${by ?? 'the engineer'} began work${suffix}`),
      };
    case 'in_review':
      return {
        ts: event.ts,
        tone: 'plain',
        headline: 'In review',
        text: cap(`handed to the reviewer${suffix}`),
      };
    case 'in_qa':
      return {
        ts: event.ts,
        tone: 'plain',
        headline: 'In QA',
        text: cap(`handed to QA in a fresh clone${suffix}`),
      };
    case 'done':
      return { ts: event.ts, tone: 'good', headline: 'Done', text: cap(`QA accepted it${suffix}`) };
    case 'stale':
      return {
        ts: event.ts,
        tone: 'warn',
        headline: 'Staled',
        text: cap(`a decision changed under it${suffix}`),
      };
    case 'blocked':
      return {
        ts: event.ts,
        tone: 'warn',
        headline: 'Blocked',
        text: cap(reason ?? 'the agent declared it blocked'),
      };
    case 'paused':
      return {
        ts: event.ts,
        tone: 'warn',
        headline: 'Paused',
        text: cap(reason ?? 'waiting on quota'),
      };
    default:
      return undefined;
  }
}

/** A board stanza is the agent's own account of what it did — its summary is the story line. */
function stanzaStep(stanza: Stanza): StoryStep {
  switch (stanza.kind) {
    case 'done':
      return {
        ts: stanza.ts,
        tone: 'good',
        headline: 'Built',
        text: cap(`by ${stanza.agent} · ${stanza.summary}`),
      };
    // Both of the engineer's finishing stanzas read as "Built": §4's
    // `review_submitted` is what an engineer actually writes when the work
    // is done (the demo epic's own engineers write only this one), and
    // `done` is the same event for an engineer that closes out without a
    // review hand-off.
    case 'review_submitted':
      return {
        ts: stanza.ts,
        tone: 'good',
        headline: 'Built',
        text: cap(`by ${stanza.agent} · ${stanza.summary}`),
      };
    case 'blocked':
      return { ts: stanza.ts, tone: 'warn', headline: 'Blocked', text: cap(stanza.summary) };
    case 'discovery':
      return {
        ts: stanza.ts,
        tone: 'warn',
        headline: 'Discovery',
        text: cap(`${stanza.agent}: ${stanza.discovery?.proposed ?? stanza.summary}`),
      };
    case 'handoff':
      return { ts: stanza.ts, tone: 'warn', headline: 'Handed off', text: cap(stanza.summary) };
    default:
      return {
        ts: stanza.ts,
        tone: 'plain',
        headline: 'Progress',
        text: cap(`${stanza.agent}: ${stanza.summary}`),
      };
  }
}

function mergeStep(event: Event): StoryStep | undefined {
  const summary = typeof event.data.summary === 'string' ? event.data.summary : undefined;
  switch (event.kind) {
    case 'merge_completed':
      return {
        ts: event.ts,
        tone: 'good',
        headline: 'Merged',
        text: cap(
          `onto integration${typeof event.data.branch === 'string' ? ` from ${event.data.branch}` : ''}`,
        ),
      };
    case 'merge_conflict':
      return {
        ts: event.ts,
        tone: 'warn',
        headline: 'Merge conflict',
        text: cap(summary ?? 'the team halted this ticket'),
      };
    case 'merge_tests_failed':
      return {
        ts: event.ts,
        tone: 'warn',
        headline: 'Tests failed on merge',
        text: cap(summary ?? 'the team halted this ticket'),
      };
    default:
      return undefined;
  }
}

/** Every message filed under this ticket's bus thread, oldest first (ulid order is send order). */
export function readTicketThread(store: StateStore, ticket: TicketId): Message[] {
  return store
    .listEntities(`bus/threads/${ticket}`, validateMessage)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The verdict message for one review/QA record, matched by the record path it carries in `refs`. */
function quoteFor(thread: Message[], relPath: string): string | undefined {
  const message = thread.find((m) => m.refs.includes(relPath));
  return message ? `${message.from}: "${cap(message.body)}"` : undefined;
}

function reviewRecords(store: StateStore, ticket: TicketId): ReviewRecord[] {
  const records: ReviewRecord[] = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let any = false;
    for (const pass of ['primary', 'security'] as const) {
      try {
        records.push(
          store.getEntity(reviewRecordRelPath(ticket, round, pass), validateReviewRecord),
        );
        any = true;
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
      }
    }
    // A gap means the walk is done: rounds are contiguous from 1.
    if (!any) break;
  }
  return records;
}

function qaReports(store: StateStore, ticket: TicketId): QaReport[] {
  const reports: QaReport[] = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    try {
      reports.push(store.getEntity(qaReportRelPath(ticket, round), validateQaReport));
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      break;
    }
  }
  return reports;
}

function reviewStep(record: ReviewRecord, thread: Message[]): StoryStep {
  const quote = quoteFor(thread, reviewRecordRelPath(record.ticket, record.round, record.pass));
  const pass = record.pass === 'security' ? ' (security)' : '';
  const headline =
    record.verdict === 'approve'
      ? 'Review approved'
      : record.verdict === 'request_changes'
        ? 'Review asked for changes'
        : 'Review escalated';
  const detail =
    quote ??
    `${record.agent} · ${record.findings.length} finding${record.findings.length === 1 ? '' : 's'}`;
  return {
    ts: record.ts,
    tone: record.verdict === 'approve' ? 'good' : 'warn',
    headline,
    text: cap(`round ${record.round}${pass} · ${detail}`),
  };
}

function qaStep(report: QaReport, thread: Message[], ts: string): StoryStep {
  const quote = quoteFor(thread, qaReportRelPath(report.ticket, report.round));
  const passed = report.lines.filter((l) => l.status === 'pass').length;
  const detail = quote ?? `${passed}/${report.lines.length} criteria passed`;
  return {
    ts,
    tone: report.verdict === 'accept' ? 'good' : 'warn',
    headline: report.verdict === 'accept' ? 'QA accepted' : 'QA rejected',
    text: cap(`round ${report.round} · ${detail}`),
  };
}

/** The trailing "what is happening right now" line the mockup renders as `li.now`. */
function nowStep(ticket: Ticket, ts: string): StoryStep | undefined {
  switch (ticket.status) {
    case 'in_progress':
      return {
        ts,
        tone: 'now',
        text: `${ticket.assignee ?? 'the engineer'} is working in ${ticket.worktree ?? 'its worktree'}`,
      };
    case 'in_review':
      return { ts, tone: 'now', text: 'Reviewer is reading the diff' };
    case 'in_qa':
      return { ts, tone: 'now', text: 'QA running in a fresh clone' };
    case 'assigned':
      return { ts, tone: 'now', text: 'Assigned, waiting for the engineer to pick it up' };
    default:
      return undefined;
  }
}

function stageFor(ticket: Ticket, needsYou: number): StoryStage {
  const label: Record<TicketStatus, string> = {
    draft: 'Draft',
    ready: 'Ready',
    assigned: 'Assigned',
    in_progress: 'Building',
    in_review: 'In review',
    in_qa: 'In QA',
    done: 'Done',
    blocked: 'Blocked',
    stale: 'Stale',
    paused: 'Paused',
  };
  const base = label[ticket.status] ?? ticket.status;
  if (needsYou > 0) return { label: `${base} · blocked`, tone: 'warn' };
  if (ticket.status === 'done') return { label: base, tone: 'good' };
  if (ticket.status === 'blocked' || ticket.status === 'stale' || ticket.status === 'paused') {
    return { label: base, tone: 'warn' };
  }
  return { label: base, tone: 'info' };
}

export interface StoryInputs {
  gates?: GateService;
  questions?: QuestionService;
}

/**
 * One ticket's story. `events` is passed in so `buildStories` reads
 * `log/events.jsonl` once for the whole board rather than once per ticket.
 */
export function buildStory(
  store: StateStore,
  ticket: Ticket,
  events: Event[],
  inputs: StoryInputs = {},
): TicketStory {
  const steps: StoryStep[] = [];
  const thread = readTicketThread(store, ticket.id);

  for (const event of events) {
    if (event.ticket !== ticket.id) continue;
    if (event.kind === 'state_transition') {
      const to = event.data.to;
      const step = typeof to === 'string' ? transitionStep(event, to as TicketStatus) : undefined;
      if (step) steps.push(step);
      continue;
    }
    const merge = mergeStep(event);
    if (merge) steps.push(merge);
  }

  for (const stanza of store.listStanzas(ticket.id)) steps.push(stanzaStep(stanza));
  for (const record of reviewRecords(store, ticket.id)) steps.push(reviewStep(record, thread));

  // A `QaReport` carries no timestamp of its own (`packages/shared/src/qa.ts`
  // — DESIGN-GAP), so its step is timed off the `qa_verdict` message that
  // announced it, falling back to the ticket's last known step.
  for (const report of qaReports(store, ticket.id)) {
    const message = thread.find((m) => m.refs.includes(qaReportRelPath(ticket.id, report.round)));
    const ts = message?.ts ?? steps[steps.length - 1]?.ts ?? new Date(0).toISOString();
    steps.push(qaStep(report, thread, ts));
  }

  const pendingHil = (inputs.gates?.list() ?? []).filter(
    (r) => r.status === 'pending' && r.ticket === ticket.id,
  );
  for (const request of pendingHil) {
    steps.push({
      ts: request.requested_at,
      tone: 'warn',
      headline: 'Waiting on you:',
      text: cap(request.summary ?? `${request.gate} needs a decision`),
    });
  }
  const openQuestions = (inputs.questions?.listOpen() ?? []).filter((q) => q.ticket === ticket.id);
  for (const question of openQuestions) {
    steps.push({
      ts: question.raised_at,
      tone: 'warn',
      headline: 'Waiting on you:',
      text: cap(question.text),
    });
  }

  steps.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const needsYou = pendingHil.length + openQuestions.length;
  if (needsYou === 0) {
    const now = nowStep(ticket, steps[steps.length - 1]?.ts ?? new Date().toISOString());
    if (now) steps.push(now);
  }

  const holder = store.listAgents().find((a) => a.record.ticket === ticket.id);

  return {
    ticket: ticket.id,
    title: ticket.title,
    status: ticket.status,
    stage: stageFor(ticket, needsYou),
    ...(holder ? { who: `${holder.id} · ${holder.record.vendor} / ${holder.record.model}` } : {}),
    steps,
    needs_you: needsYou,
  };
}

/**
 * Every ticket's story, ticket-id order — what the Sprint tab renders.
 * `events` is optional so a caller that has already read `log/events.jsonl`
 * (`buildSnapshot` does, for the feed) does not read the whole log twice per
 * snapshot.
 */
export function buildStories(
  store: StateStore,
  inputs: StoryInputs = {},
  events: Event[] = store.listEvents(),
): TicketStory[] {
  return store
    .listTickets()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((ticket) => buildStory(store, ticket, events, inputs));
}
