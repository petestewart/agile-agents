/**
 * `QuestionService` — the Questions store (design/agile-agents-design.md §17
 * "Control room v2" → "Questions vs Decisions"): "A Question is unresolved:
 * an architect at a fork, an engineer who thinks the ticket is wrong (the
 * missing `escalate` handler lands here), the EM flagging a gap, or the
 * operator. Answering one records a Decision, edits a ticket or rule, or is
 * just a reply."
 *
 * Shaped after `gates/service.ts` (its sibling in every respect — same
 * `board/` file home, same `StateStore` generic-entity trio, same
 * write-into-the-inbox delivery, same "read fresh from disk every call"
 * listing): `Question` is a shared zod schema
 * (`packages/shared/src/question.ts`), this module owns only the
 * raise/answer/persist/notify logic over it.
 *
 * Producers (all four the design names):
 *  - the engineer `escalate` verb — `runner/pipeline-glue.ts`'s
 *    `advanceEngineerEscalations`, the handler that was missing;
 *  - the architect at a planning fork and the EM flagging a gap — the
 *    `question.raise` RPC (`rpc.ts`);
 *  - the operator — `POST /api/questions` (`http.ts`).
 */

import {
  type AgentId,
  AgentIdSchema,
  type DecisionId,
  MESSAGE_BODY_MAX_CHARS,
  type Message,
  type OracleEntry,
  type OracleId,
  type Question,
  type QuestionId,
  type QuestionResolvedAs,
  type Ticket,
  type TicketId,
  ulid,
  validateMessage,
  validateQuestion,
} from '@agile-agents/shared';
import { publishDecision } from '../architect/decision';
import type { OracleWriteResult } from '../oracle';
import { NotFoundError, type StateStore, buildEvent } from '../store';

export const QUESTIONS_DIR = 'board/questions';

function questionPath(id: QuestionId): string {
  return `${QUESTIONS_DIR}/${id}.yaml`;
}

function newQuestionId(): QuestionId {
  return `Q-${ulid()}` as QuestionId;
}

function inboxPath(agent: string, messageId: string): string {
  return `bus/inbox/${agent}/${messageId}.yaml`;
}

/** Trims and caps at the shared message-body cap — the one place free text is normalized before it touches the schema (mirrors `gates/service.ts`'s `normalizeNote`). */
function normalizeText(value: string): string {
  return value.trim().slice(0, MESSAGE_BODY_MAX_CHARS);
}

export class QuestionNotFoundError extends Error {
  constructor(id: string) {
    super(`question not found: ${id}`);
    this.name = 'QuestionNotFoundError';
  }
}

export class QuestionAlreadyAnsweredError extends Error {
  constructor(id: string) {
    super(`question ${id} is already answered`);
    this.name = 'QuestionAlreadyAnsweredError';
  }
}

export class EmptyQuestionTextError extends Error {
  constructor(what: 'text' | 'answer') {
    super(`question ${what} must not be empty`);
    this.name = 'EmptyQuestionTextError';
  }
}

export class TicketEditRefusedError extends Error {
  constructor(reason: string) {
    super(`ticket edit refused: ${reason}`);
    this.name = 'TicketEditRefusedError';
  }
}

export interface RaiseQuestionInput {
  /** Who is asking (§17 v2: an engineer, the architect, the EM, or `human`). */
  raised_by: AgentId;
  text: string;
  ticket?: TicketId;
  options?: string[];
}

/**
 * How an answer is applied (§17 v2: "Answering one records a Decision, edits
 * a ticket or rule, or is just a reply"). The stored `resolved_as` is the
 * *outcome*: the `DEC-####` id, the edited `TKT-####` id, or `reply`.
 */
export type AnswerResolution =
  | { resolved_as: 'reply' }
  | { resolved_as: 'decision'; title?: string }
  | {
      resolved_as: 'ticket';
      /** Defaults to the question's own `ticket`. */
      ticket?: TicketId;
      /** Fields merged onto the ticket; `id`, `status` and `history` are refused (see `applyTicketEdit`). */
      edit: Record<string, unknown>;
    };

export type AnswerQuestionInput = AnswerResolution & {
  answer: string;
  /** Free string on the wire (`--by pete`, `human` from the browser), same as a gate decision's `by`. */
  by: string;
};

export interface AnswerQuestionResult {
  question: Question;
  /** Set when the answer was recorded as a decision. */
  decision?: OracleWriteResult;
  /** Set when the answer was applied as a ticket edit. */
  ticket?: Ticket;
}

export interface QuestionServiceOptions {
  clock?: () => Date;
}

export class QuestionService {
  private readonly clock: () => Date;

  constructor(
    private readonly store: StateStore,
    options: QuestionServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  /** Opens a question: one `board/questions/Q-<ulid>.yaml` plus a `question_raised` event. */
  async raise(input: RaiseQuestionInput): Promise<Question> {
    const text = normalizeText(input.text);
    if (text.length === 0) throw new EmptyQuestionTextError('text');
    const record: Question = {
      id: newQuestionId(),
      raised_by: input.raised_by,
      ...(input.ticket !== undefined ? { ticket: input.ticket } : {}),
      text,
      ...(input.options !== undefined && input.options.length > 0
        ? { options: input.options }
        : {}),
      status: 'open',
      raised_at: this.clock().toISOString(),
    };
    const saved = await this.persist(record);
    await this.store.appendEvent(
      buildEvent('question_raised', {
        ...(saved.ticket !== undefined ? { ticket: saved.ticket } : {}),
        agent: saved.raised_by,
        data: { id: saved.id, text: saved.text },
      }),
    );
    return saved;
  }

  /**
   * Answers an open question. Whatever the resolution, the answer is stored,
   * the question flips to `answered`, a `question_answered` event is logged,
   * and the answer is delivered to the raiser's inbox as an `answer`-kind
   * bus message (§5 "Questions": "Every `answer` carries `promote_to: none |
   * kb | decision` so it gets written down once" — `decision` when this
   * answer published one).
   */
  async answer(id: QuestionId, input: AnswerQuestionInput): Promise<AnswerQuestionResult> {
    const current = this.get(id);
    if (current.status !== 'open') throw new QuestionAlreadyAnsweredError(id);
    const answer = normalizeText(input.answer);
    if (answer.length === 0) throw new EmptyQuestionTextError('answer');

    let decision: OracleWriteResult | undefined;
    let ticket: Ticket | undefined;
    let resolvedAs: QuestionResolvedAs;

    if (input.resolved_as === 'decision') {
      decision = await this.recordAsDecision(current, answer, input.by, input.title);
      resolvedAs = decision.entry.id as DecisionId;
    } else if (input.resolved_as === 'ticket') {
      ticket = await this.applyTicketEdit(current, input.ticket, input.edit, input.by);
      resolvedAs = ticket.id;
    } else {
      resolvedAs = 'reply';
    }

    const now = this.clock();
    const saved = await this.persist({
      ...current,
      status: 'answered',
      answer,
      resolved_as: resolvedAs,
      answered_by: input.by,
      answered_at: now.toISOString(),
    });

    await this.store.appendEvent(
      buildEvent('question_answered', {
        ...(saved.ticket !== undefined ? { ticket: saved.ticket } : {}),
        agent: input.by,
        data: { id: saved.id, resolved_as: saved.resolved_as, answer: saved.answer },
      }),
    );

    await this.deliverAnswer(saved, decision?.entry.id);
    return {
      question: saved,
      ...(decision !== undefined ? { decision } : {}),
      ...(ticket !== undefined ? { ticket } : {}),
    };
  }

  get(id: QuestionId): Question {
    try {
      return this.store.getEntity(questionPath(id), validateQuestion);
    } catch (err) {
      if (err instanceof NotFoundError) throw new QuestionNotFoundError(id);
      throw err;
    }
  }

  /** Durable: reads `board/questions/**` fresh from disk every call (same as `GateService.list`). */
  list(): Question[] {
    return this.store.listEntities(QUESTIONS_DIR, validateQuestion);
  }

  /** The attention-queue slice: every question still waiting on an answer. */
  listOpen(): Question[] {
    return this.list().filter((q) => q.status === 'open');
  }

  private async persist(record: Question): Promise<Question> {
    return this.store.putEntity(questionPath(record.id), validateQuestion, record);
  }

  /**
   * "Answering one records a Decision" — through the *existing* write guard
   * (`architect/decision.ts`'s `publishDecision`, a thin wrapper over T007's
   * `oracleWrite`), so graph validation and the ripple walk run exactly as
   * they do for an architect-published decision. `oracleWrite`'s actor is
   * therefore `architect` (it accepts no other writer, §4 "Oracle": "Writer:
   * architect only"); the entry's own `by` field records who actually
   * decided — `human` for an operator answering a card, `architect`
   * otherwise. Never a direct `.agile/oracle` write.
   */
  private async recordAsDecision(
    question: Question,
    answer: string,
    by: string,
    title?: string,
  ): Promise<OracleWriteResult> {
    const entry: OracleEntry = {
      id: this.nextDecisionId(),
      title: normalizeText(title ?? `Answer to ${question.id}: ${question.text}`).slice(0, 120),
      status: 'active',
      supersedes: [],
      depends: [],
      affects: [],
      decided: this.clock().toISOString(),
      by: by === 'human' ? 'human' : 'architect',
      rationale: answer,
    };
    const body = [
      `# ${entry.title}`,
      '',
      `Recorded from question ${question.id} (raised by ${question.raised_by}${question.ticket ? ` on ${question.ticket}` : ''}).`,
      '',
      '## Question',
      '',
      question.text,
      '',
      '## Answer',
      '',
      answer,
      '',
    ].join('\n');
    return publishDecision(this.store, entry, body);
  }

  /**
   * Next `DEC-####`. The oracle index holds active entries only (§4:
   * "Superseded files ... drop out of index.yaml"), so the index maximum
   * alone could re-issue the id of a superseded decision still on disk —
   * step past any id that already has a file.
   */
  private nextDecisionId(): DecisionId {
    const index = this.store.listOracleIndex();
    let next =
      Object.keys(index).reduce((acc, id) => {
        const n = Number(/^DEC-(\d+)$/.exec(id)?.[1] ?? '0');
        return Number.isFinite(n) ? Math.max(acc, n) : acc;
      }, 0) + 1;
    while (this.oracleEntryExists(`DEC-${String(next).padStart(4, '0')}` as OracleId)) next++;
    return `DEC-${String(next).padStart(4, '0')}` as DecisionId;
  }

  private oracleEntryExists(id: OracleId): boolean {
    try {
      this.store.getOracleEntry(id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * "…edits a ticket or rule": the answer is applied as a ticket change
   * through the store's own validating `putTicket`. `id`/`history` are
   * refused (they are the record's identity and audit trail) and so is
   * `status` — a status change is a `transitionTicket` with its own legality
   * check, never a field merge.
   */
  private async applyTicketEdit(
    question: Question,
    explicit: TicketId | undefined,
    edit: Record<string, unknown>,
    by: string,
  ): Promise<Ticket> {
    const id = explicit ?? question.ticket;
    if (id === undefined) {
      throw new TicketEditRefusedError(
        `question ${question.id} names no ticket — pass one with the answer`,
      );
    }
    const forbidden = ['id', 'status', 'history'].filter((key) => key in edit);
    if (forbidden.length > 0) {
      throw new TicketEditRefusedError(
        `${forbidden.join(', ')} may not be edited through a question answer`,
      );
    }
    let current: Ticket;
    try {
      current = this.store.getTicket(id);
    } catch (err) {
      if (err instanceof NotFoundError) throw new TicketEditRefusedError(`no such ticket: ${id}`);
      throw err;
    }
    return this.store.putTicket({ ...current, ...edit } as Ticket, { by });
  }

  /**
   * Writes the answer into the raiser's inbox as a normal-priority `answer`
   * message (§5 "Questions"). Same direct-to-inbox write
   * `gates/service.ts`'s `deliverNote`/`notifyPending` use — no bus routing
   * rule is involved, so an operator can answer an engineer without
   * `routing.ts` having to allow `human -> eng-N`.
   */
  private async deliverAnswer(question: Question, decisionId?: OracleId): Promise<void> {
    if (question.answer === undefined) return;
    const from: AgentId = AgentIdSchema.safeParse(question.answered_by).success
      ? (question.answered_by as AgentId)
      : 'human';
    const message: Message = {
      id: ulid(),
      ts: question.answered_at ?? this.clock().toISOString(),
      from,
      to: [question.raised_by],
      kind: 'answer',
      priority: 'normal',
      ...(question.ticket !== undefined ? { ticket: question.ticket } : {}),
      body: `answer to ${question.id} ("${question.text}") from ${question.answered_by ?? from}: ${question.answer}`.slice(
        0,
        MESSAGE_BODY_MAX_CHARS,
      ),
      refs: [questionPath(question.id), ...(decisionId !== undefined ? [decisionId] : [])],
      requires_ack: false,
      promote_to: decisionId !== undefined ? 'decision' : 'none',
    };
    const validated = validateMessage(message);
    await this.store.putEntity(
      inboxPath(question.raised_by, validated.id),
      validateMessage,
      validated,
    );
  }
}
