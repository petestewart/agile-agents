/**
 * `QuestionService` — the question half of the inbox
 * (design/cockpit-design.md §1.4 "The question flow", §2.3, §3).
 *
 * T121 re-keyed the whole module to streams:
 *  - a question is raised **on a stream**, never on a ticket;
 *  - the records live in the state home at `questions/Q-<ulid>.yaml`,
 *    beside `streams/` and `threads/` (§7.2), written through the store;
 *  - raising one appends a `question` thread entry and flips the stream to
 *    `agent.status: question` / `human.status: waiting_on_you`;
 *  - answering appends an `answer` entry, flips it back to
 *    `agent.status: working` / `human.status: open`, and delivers the
 *    answer to the waiting session — T137: delivery is a **prompt** into
 *    that live session (`deliver`, wired to `AttachService.deliverAnswer`
 *    in `daemon.ts`), not a bus mailbox file nothing ever read;
 *  - `resolved_as` is `reply` and nothing else. Recording a decision
 *    (`recordAsDecision`) and editing a ticket (`applyTicketEdit`) went
 *    with the oracle and the ticket model.
 *
 * "Questions are records with a status, not mail" (§1.4): this module
 * does not touch the bus at all, so a leftover message from a previous
 * daemon run can never surface as a question or an inbox item.
 */

import {
  type AgentId,
  MESSAGE_BODY_MAX_CHARS,
  type Question,
  type QuestionId,
  ulid,
  validateQuestion,
} from '@agile-agents/shared';
import { NotFoundError, type StateStore, buildEvent } from '../store';
import type { StreamService } from '../streams/service';

/** Session statuses that mean "there is still a process to answer to" (§2.3). */
const LIVE_SESSION_STATUSES: readonly string[] = ['starting', 'running', 'idle'];

/** `questions/` in the state home — a sibling of `streams/` and `threads/` (§7.2). */
export const QUESTIONS_DIR = 'questions';

function questionPath(id: QuestionId): string {
  return `${QUESTIONS_DIR}/${id}.yaml`;
}

function newQuestionId(): QuestionId {
  return `Q-${ulid()}` as QuestionId;
}

/** Trims and caps at the shared body cap — the one place free text is normalized before it touches the schema. */
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

export interface RaiseQuestionInput {
  /** The stream the fork is on (§1.4). Required. */
  stream: string;
  /** Who is asking: an agent role id, or `human` when the operator raises one from the UI. */
  raised_by: AgentId;
  /** The vendor session blocked on the answer, when there is one. */
  session?: string;
  text: string;
  options?: string[];
}

export interface AnswerQuestionInput {
  answer: string;
  /** Free string on the wire (`--by pete`, `human` from the browser), same as a gate decision's `by`. */
  by: string;
  /** Only one resolution survives (§3.1): the answer is a reply. */
  resolved_as?: 'reply';
}

export interface AnswerQuestionResult {
  question: Question;
}

/**
 * How an answer reaches the session that asked (T137). `daemon.ts` wires
 * this to `AttachService.deliverAnswer`, which prompts the live handle.
 * Left unset (tests of the record alone) the answer stays on the thread,
 * which is exactly what happens when the session is already gone.
 */
export type AnswerDelivery = (sessionId: string, question: Question) => Promise<void> | void;

export interface QuestionServiceOptions {
  clock?: () => Date;
  deliver?: AnswerDelivery;
}

export class QuestionService {
  private readonly clock: () => Date;
  private readonly deliver: AnswerDelivery | undefined;

  constructor(
    private readonly store: StateStore,
    private readonly streams: StreamService,
    options: QuestionServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.deliver = options.deliver;
  }

  /**
   * §1.4/§2.3: the record, the `question` thread entry, the two status
   * flips, and the `question_raised` event. The stream write goes in as
   * principal `daemon` — it touches both halves of the record at once
   * (agent says "I am stuck", human says "this is on you"), which is
   * exactly what §2.2 reserves for the daemon's own lifecycle writes.
   *
   * The stream must exist: `getStream` throws `NotFoundError` before
   * anything is persisted, so a question never outlives its stream.
   */
  async raise(input: RaiseQuestionInput): Promise<Question> {
    const text = normalizeText(input.text);
    if (text.length === 0) throw new EmptyQuestionTextError('text');
    this.streams.get(input.stream);

    const record: Question = {
      id: newQuestionId(),
      stream: input.stream,
      raised_by: input.raised_by,
      ...(input.session !== undefined ? { session: input.session } : {}),
      text,
      ...(input.options !== undefined && input.options.length > 0
        ? { options: input.options }
        : {}),
      status: 'open',
      raised_at: this.clock().toISOString(),
    };
    const saved = await this.persist(record);

    // `by: agent:<session>` when an agent asked from a live session, else
    // `human` — the operator raising one from the UI (§3.1's `question`
    // row names both producers).
    if (input.raised_by === 'human' || input.session === undefined) {
      await this.streams.appendThread(
        input.raised_by === 'human' ? 'human' : 'daemon',
        saved.stream,
        {
          kind: 'question',
          body: saved.text,
          ref: questionPath(saved.id),
        },
      );
    } else {
      await this.streams.appendThread(
        'agent',
        saved.stream,
        { kind: 'question', body: saved.text, ref: questionPath(saved.id) },
        input.session,
      );
    }

    await this.streams.update('daemon', saved.stream, {
      agent: { status: 'question' },
      human: { status: 'waiting_on_you' },
    });

    await this.store.appendEvent(
      buildEvent('question_raised', {
        stream: saved.stream,
        agent: saved.raised_by,
        ...(input.session !== undefined ? { session: input.session } : {}),
        data: { id: saved.id, text: saved.text },
      }),
    );
    return saved;
  }

  /**
   * Answers an open question: the answer is stored, the question flips to
   * `answered`, an `answer` thread entry goes on the stream `by: human`,
   * the stream goes back to `agent.status: working` / `human.status: open`
   * (§2.3), a `question_answered` event is logged, and the answer is
   * delivered to the session that is waiting on it.
   */
  async answer(id: QuestionId, input: AnswerQuestionInput): Promise<AnswerQuestionResult> {
    const current = this.get(id);
    if (current.status !== 'open') throw new QuestionAlreadyAnsweredError(id);
    const answer = normalizeText(input.answer);
    if (answer.length === 0) throw new EmptyQuestionTextError('answer');

    const now = this.clock();
    const saved = await this.persist({
      ...current,
      status: 'answered',
      answer,
      resolved_as: 'reply',
      answered_by: input.by,
      answered_at: now.toISOString(),
    });

    await this.streams.appendThread('human', saved.stream, {
      kind: 'answer',
      body: answer,
      ref: questionPath(saved.id),
    });
    // T130 (Phase 2 Discovered Issues): back to `working` only if there is
    // still a live session to go back to work. A question answered after
    // the session exited (or on a stream that was never attached) leaves
    // the stream `idle` — claiming an agent is working when no process
    // exists is exactly the kind of lie the two-writer split exists to stop.
    const liveSession = this.streams
      .get(saved.stream)
      .sessions.some((session) => LIVE_SESSION_STATUSES.includes(session.status));
    await this.streams.update('daemon', saved.stream, {
      agent: { status: liveSession ? 'working' : 'idle' },
      human: { status: 'open' },
    });

    await this.store.appendEvent(
      buildEvent('question_answered', {
        stream: saved.stream,
        agent: input.by,
        data: { id: saved.id, answer: saved.answer },
      }),
    );

    await this.deliverAnswer(saved);
    return { question: saved };
  }

  get(id: QuestionId): Question {
    try {
      return this.store.getEntity(questionPath(id), validateQuestion);
    } catch (err) {
      if (err instanceof NotFoundError) throw new QuestionNotFoundError(id);
      throw err;
    }
  }

  /** Durable: reads `questions/**` fresh from disk every call (same as `GateService.list`). */
  list(): Question[] {
    return this.store.listEntities(QUESTIONS_DIR, validateQuestion);
  }

  /** The inbox slice: every question still waiting on an answer. */
  listOpen(): Question[] {
    return this.list().filter((q) => q.status === 'open');
  }

  private async persist(record: Question): Promise<Question> {
    return this.store.putEntity(questionPath(record.id), validateQuestion, record);
  }

  /**
   * Hands the answer to the session that asked (T137). The record is the
   * yaml file and the thread entry; this is only the nudge that wakes the
   * waiting process, and it is a prompt — the live run proved a mailbox
   * file nothing reads leaves the session idle forever. A question raised
   * by the operator (no `session`) has nobody to wake.
   */
  private async deliverAnswer(question: Question): Promise<void> {
    if (question.answer === undefined || question.session === undefined) return;
    if (this.deliver === undefined) return;
    await this.deliver(question.session, question);
  }
}
