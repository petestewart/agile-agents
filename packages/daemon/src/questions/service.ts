/**
 * `QuestionService`: the question half of the inbox (§1.4, §2.3, §3).
 * A question is raised on a stream and stored at `questions/Q-<ulid>.yaml`.
 * Raising appends a `question` thread entry and flips the stream to
 * `question`/`waiting_on_you`; answering appends an `answer` entry, flips
 * it back and delivers the answer to the waiting session as a prompt.
 * "Questions are records with a status, not mail" (§1.4): no bus here.
 */

import {
  type AgentId,
  MESSAGE_BODY_MAX_CHARS,
  type Question,
  type QuestionId,
  type Stream,
  type ThreadEntry,
  questionIdOfThreadRef,
  ulid,
  validateQuestion,
} from '@agile-agents/shared';
import { NotFoundError, type StateStore, buildEvent } from '../store';
import type { StreamService } from '../streams/service';

/** Session statuses that mean "there is still a process to answer to" (§2.3). */
const LIVE_SESSION_STATUSES: readonly string[] = ['starting', 'running', 'idle'];

/** `questions/` in the state home (§7.2). */
export const QUESTIONS_DIR = 'questions';

function questionPath(id: QuestionId): string {
  return `${QUESTIONS_DIR}/${id}.yaml`;
}

/**
 * T338: a part's question is with its coordinator (not the operator's
 * inbox) until the coordinator passes it up, or has no live session to
 * answer it — so a question can never be stranded behind a stopped agent.
 */
export function withCoordinator(question: Question, coordinator: Stream | undefined): boolean {
  return (
    question.coordinator !== undefined &&
    question.passed_up_at === undefined &&
    coordinator?.sessions.some((s) => LIVE_SESSION_STATUSES.includes(s.status)) === true
  );
}

function newQuestionId(): QuestionId {
  return `Q-${ulid()}` as QuestionId;
}

/** Trims and caps at the shared body cap. */
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
  /** Who is asking: an agent id, or `human` from the UI. */
  raised_by: AgentId;
  /** The vendor session blocked on the answer, when there is one. */
  session?: string;
  text: string;
  options?: string[];
  /** T338: the part's coordinator, when the question goes there first. */
  coordinator?: string;
  /** T503: the chat thread it is asked in (the agent's `ask` named it). */
  thread?: string;
}

export interface AnswerQuestionInput {
  answer: string;
  /** Free string on the wire (`--by pete`, `human` from the browser). */
  by: string;
  /** The only resolution a human answer has (§3.1). */
  resolved_as?: 'reply';
}

export interface AnswerQuestionResult {
  question: Question;
}

/**
 * How an answer reaches the session that asked (`AttachService.deliverAnswer`,
 * a prompt). Unset, the answer stays on the thread, as when the session is gone.
 */
export type AnswerDelivery = (sessionId: string, question: Question) => Promise<void> | void;

/**
 * T502 (D62): how your reply in a choice question's thread reaches its
 * agent (`AttachService.say` with the question): the line on the thread
 * (`ref: questions/<id>.yaml`) and a `human_line` event that names the
 * question. Unset, the line is only written (nobody to tell).
 */
export type ReplyDelivery = (question: Question, text: string) => Promise<ThreadEntry>;

export interface QuestionServiceOptions {
  clock?: () => Date;
  deliver?: AnswerDelivery;
  reply?: ReplyDelivery;
}

/** T502: what a reply did: kept a choice question open (`entry`), or answered one with none. */
export interface ReplyQuestionResult {
  question: Question;
  entry?: ThreadEntry;
  answered?: true;
}

/** T502: the session that asked can only settle its own node's open question. */
export class NotYourQuestionError extends Error {
  constructor(id: string) {
    super(`question ${id} was not asked on your node`);
    this.name = 'NotYourQuestionError';
  }
}

export class QuestionService {
  private readonly clock: () => Date;
  private readonly deliver: AnswerDelivery | undefined;
  private readonly replyTo: ReplyDelivery | undefined;

  constructor(
    private readonly store: StateStore,
    private readonly streams: StreamService,
    options: QuestionServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.deliver = options.deliver;
    this.replyTo = options.reply;
  }

  /**
   * §1.4/§2.3: the record, the `question` thread entry, both status flips
   * (as `daemon`, since it touches both halves, §2.2) and the event. The
   * stream must exist, so a question never outlives its stream.
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
      ...(input.coordinator !== undefined ? { coordinator: input.coordinator } : {}),
      status: 'open',
      raised_at: this.clock().toISOString(),
    };
    // T502 (D62): an agent asking again while you talked back to its earlier
    // question (a reply it hasn't settled) replaces that question; read before the write.
    const reasked =
      input.raised_by !== 'human' && input.session !== undefined
        ? this.repliedTo(input.stream, input.session)
        : [];
    const saved = await this.persist(record);

    // `agent:<session>` when an agent asked from a live session, else `human` or `daemon`.
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
        {
          kind: 'question',
          body: saved.text,
          ref: questionPath(saved.id),
          // T503 (§6): asked in a chat thread, it shows there and in the main flow and Needs me.
          ...(input.thread !== undefined ? { thread: input.thread } : {}),
        },
        input.session,
      );
    }
    for (const earlier of reasked) await this.supersedeByQuestion(earlier, saved);

    await this.streams.update('daemon', saved.stream, {
      agent: { status: 'question' },
      // T338: with the coordinator first, it is not waiting on you yet.
      human: { status: saved.coordinator !== undefined ? 'open' : 'waiting_on_you' },
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
   * Answers an open question: record, `answer` thread entry by `human`,
   * status flips back (§2.3), event, and delivery to the waiting session.
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

    // T338: a coordinator's answer (`agent:<session>`) is not the operator's.
    const byAgent = input.by.startsWith('agent:');
    await this.streams.appendThread(byAgent ? 'daemon' : 'human', saved.stream, {
      kind: 'answer',
      body: byAgent
        ? `Your coordinator answers: ${answer}`.slice(0, MESSAGE_BODY_MAX_CHARS)
        : answer,
      ref: questionPath(saved.id),
    });
    // Back to `working` only if a live session exists (claiming an agent
    // works when no process exists is the lie the two-writer split exists
    // to stop). With none, the status the exit path left (`done`/`blocked`)
    // stays: `idle` is the wake policy's "the human stopped it" (T243), and
    // writing it here kept the `answer` from waking the node (T336).
    const node = this.streams.get(saved.stream);
    const liveSession = node.sessions.some((session) =>
      LIVE_SESSION_STATUSES.includes(session.status),
    );
    await this.streams.update('daemon', saved.stream, {
      ...(liveSession
        ? { agent: { status: 'working' } }
        : node.agent.status === 'question'
          ? // A question with no process behind it: `idle` only if none ever ran.
            { agent: { status: node.sessions.length > 0 ? 'done' : 'idle' } }
          : {}),
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

  /**
   * T502 (D62, design/chat-threads.md §5): what you typed in a question's
   * own box. A choice question stays open: the line goes on its thread
   * (`ref: questions/<id>.yaml`) and to its agent as a reply about it
   * (`ReplyDelivery`), and the node no longer waits on you; the agent
   * settles it or asks again. A question with no choices is answered by
   * it, as before (`resolved_as: reply`).
   */
  async reply(id: QuestionId, input: { text: string; by: string }): Promise<ReplyQuestionResult> {
    const current = this.get(id);
    if (current.status !== 'open') throw new QuestionAlreadyAnsweredError(id);
    const text = normalizeText(input.text);
    if (text.length === 0) throw new EmptyQuestionTextError('answer');
    if (current.options === undefined || current.options.length === 0) {
      const { question } = await this.answer(id, { answer: text, by: input.by });
      return { question, answered: true };
    }
    const entry =
      this.replyTo !== undefined
        ? await this.replyTo(current, text)
        : await this.streams.appendThread('human', current.stream, {
            kind: 'line',
            body: text,
            ref: questionPath(current.id),
          });
    // Waiting on the agent now, not on you. Its turn (if one is live) works on the reply.
    const node = this.streams.get(current.stream);
    const live = node.sessions.some((session) => LIVE_SESSION_STATUSES.includes(session.status));
    await this.streams
      .update('daemon', current.stream, {
        ...(live ? { agent: { status: 'working' } } : {}),
        human: { status: 'open' },
      })
      .catch(() => {
        // The line and its delivery happened; the status pair is best effort.
      });
    return { question: this.get(id), entry };
  }

  /**
   * T502 (D62): the agent's `settle_question`: your reply decided its open
   * question. The answer is recorded as `settled`, by the agent, with an
   * `answer` line on the thread; nothing is delivered (the agent said it).
   */
  async settle(
    id: QuestionId,
    input: { answer: string; session: string; stream: string },
  ): Promise<Question> {
    const current = this.get(id);
    if (current.stream !== input.stream) throw new NotYourQuestionError(id);
    if (current.status !== 'open') throw new QuestionAlreadyAnsweredError(id);
    const answer = normalizeText(input.answer);
    if (answer.length === 0) throw new EmptyQuestionTextError('answer');
    const by = `agent:${input.session}`;
    const saved = await this.persist({
      ...current,
      status: 'answered',
      answer,
      resolved_as: 'settled',
      answered_by: by,
      answered_at: this.clock().toISOString(),
    });
    await this.streams.appendThread(
      'agent',
      saved.stream,
      { kind: 'answer', body: answer, ref: questionPath(saved.id) },
      input.session,
    );
    // Nothing else open on the node: it no longer waits on you.
    if (!this.listOpen().some((q) => q.stream === saved.stream)) {
      const node = this.streams.get(saved.stream);
      if (node.human.status === 'waiting_on_you') {
        await this.streams
          .update('daemon', saved.stream, { human: { status: 'open' } })
          .catch(() => {});
      }
    }
    await this.store.appendEvent(
      buildEvent('question_answered', {
        stream: saved.stream,
        agent: by,
        session: input.session,
        data: { id: saved.id, answer: saved.answer, settled: true },
      }),
    );
    return saved;
  }

  /** T502: `session`'s open questions on `stream` that you replied to in their thread. */
  private repliedTo(stream: string, session: string): Question[] {
    const open = this.listOpen().filter((q) => q.stream === stream && q.session === session);
    if (open.length === 0) return [];
    let thread: ThreadEntry[];
    try {
      thread = this.store.readThread(stream);
    } catch {
      return [];
    }
    const replied = new Set(
      thread
        .filter((e) => e.by === 'human' && e.kind === 'line')
        .map((e) => questionIdOfThreadRef(e.ref))
        .filter((q): q is QuestionId => q !== undefined),
    );
    return open.filter((q) => replied.has(q.id));
  }

  /** T502 (D62): asked again: the earlier question is superseded by the newer one, its thread carrying on. */
  private async supersedeByQuestion(earlier: Question, newer: Question): Promise<void> {
    const saved = await this.persist({
      ...earlier,
      status: 'answered',
      answer: normalizeText(`asked again: ${newer.text}`),
      resolved_as: 'superseded',
      answered_by: 'daemon',
      answered_at: this.clock().toISOString(),
      superseded_by: newer.id,
    });
    await this.streams.appendThread('daemon', saved.stream, {
      kind: 'event',
      body: 'the agent asked this again',
      ref: questionPath(saved.id),
    });
    await this.store.appendEvent(
      buildEvent('question_answered', {
        stream: saved.stream,
        agent: 'daemon',
        ...(saved.session !== undefined ? { session: saved.session } : {}),
        data: { id: saved.id, superseded_by: newer.id },
      }),
    );
  }

  /**
   * Resolving a gate resolves every question the same session still has
   * open, as `superseded` (a worker once asked and hit a gate in one turn;
   * the gate was approved and the question held the stream open forever).
   * No delivery (the gate decision is it) and no status writes (the
   * turn-end rule owns those).
   */
  async supersede(sessionId: string, byGateId: string): Promise<Question[]> {
    const open = this.listOpen().filter((question) => question.session === sessionId);
    const superseded: Question[] = [];
    for (const question of open) {
      const now = this.clock();
      const saved = await this.persist({
        ...question,
        status: 'answered',
        answer: `superseded by ${byGateId}`,
        resolved_as: 'superseded',
        answered_by: 'daemon',
        answered_at: now.toISOString(),
      });
      await this.streams.appendThread('daemon', saved.stream, {
        kind: 'event',
        body: `question ${saved.id} superseded by ${byGateId}`,
        ref: questionPath(saved.id),
      });
      await this.store.appendEvent(
        buildEvent('question_answered', {
          stream: saved.stream,
          agent: 'daemon',
          session: sessionId,
          data: { id: saved.id, superseded_by: byGateId },
        }),
      );
      superseded.push(saved);
    }
    return superseded;
  }

  /** T338: the coordinator passes a part's question on: it enters the operator's inbox. */
  async passUp(id: QuestionId): Promise<Question> {
    const current = this.get(id);
    if (current.status !== 'open') throw new QuestionAlreadyAnsweredError(id);
    const saved = await this.persist({ ...current, passed_up_at: this.clock().toISOString() });
    await this.streams.appendThread('daemon', saved.stream, {
      kind: 'event',
      body: 'your coordinator passed this question to the operator',
      ref: questionPath(saved.id),
    });
    await this.streams.update('daemon', saved.stream, { human: { status: 'waiting_on_you' } });
    return saved;
  }

  /**
   * T338: approving `parent`'s plan answers the questions its parts sent
   * it first (about the plan, a contract, a sibling): each is `superseded`
   * by the plan version, whose `plan_changed` reaches the part. Questions
   * that went straight to the operator, or were passed up to them, are left
   * for the operator.
   */
  async supersedeByPlan(parent: string, version: number): Promise<Question[]> {
    const by = `plan v${version}`;
    const out: Question[] = [];
    for (const question of this.listOpen().filter(
      (q) => q.coordinator === parent && q.passed_up_at === undefined,
    )) {
      const saved = await this.persist({
        ...question,
        status: 'answered',
        answer: `superseded by the approved ${by}`,
        resolved_as: 'superseded',
        answered_by: 'daemon',
        answered_at: this.clock().toISOString(),
      });
      await this.streams.appendThread('daemon', saved.stream, {
        kind: 'event',
        body: `question superseded by the approved ${by}; your part of it is in your brief`,
        ref: questionPath(saved.id),
      });
      await this.store.appendEvent(
        buildEvent('question_answered', {
          stream: saved.stream,
          agent: 'daemon',
          ...(saved.session !== undefined ? { session: saved.session } : {}),
          data: { id: saved.id, superseded_by: by },
        }),
      );
      out.push(saved);
    }
    return out;
  }

  /**
   * The human replied on the thread and that line was prompted into the
   * session that asked: the reply answers every question that session has
   * open (`reply`, by `human`, citing the line), so the card leaves the
   * inbox. Called only once the line reached that session's prompt queue;
   * the line was the delivery.
   */
  async answerFromThread(
    sessionId: string,
    line: { body: string; ts: string },
  ): Promise<Question[]> {
    const open = this.listOpen().filter((question) => question.session === sessionId);
    const answered: Question[] = [];
    for (const question of open) {
      const answer = normalizeText(`replied on the thread (${line.ts}): ${line.body}`);
      const saved = await this.persist({
        ...question,
        status: 'answered',
        answer,
        resolved_as: 'reply',
        answered_by: 'human',
        answered_at: this.clock().toISOString(),
      });
      await this.streams.appendThread('daemon', saved.stream, {
        kind: 'event',
        body: `question ${saved.id} answered by the human's thread line of ${line.ts}`,
        ref: questionPath(saved.id),
      });
      await this.streams
        .update('daemon', saved.stream, {
          agent: { status: 'working' },
          human: { status: 'open' },
        })
        .catch(() => {
          // The record is already closed; the status half is best effort.
        });
      await this.store.appendEvent(
        buildEvent('question_answered', {
          stream: saved.stream,
          agent: 'human',
          session: sessionId,
          data: { id: saved.id, answer: saved.answer, via: 'thread' },
        }),
      );
      answered.push(saved);
    }
    return answered;
  }

  get(id: QuestionId): Question {
    try {
      return this.store.getEntity(questionPath(id), validateQuestion);
    } catch (err) {
      if (err instanceof NotFoundError) throw new QuestionNotFoundError(id);
      throw err;
    }
  }

  /** Durable: reads `questions/**` fresh from disk every call. */
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

  /** Hands the answer to the session that asked. An operator's question (no `session`) has nobody to wake. */
  private async deliverAnswer(question: Question): Promise<void> {
    if (question.answer === undefined || question.session === undefined) return;
    if (this.deliver === undefined) return;
    await this.deliver(question.session, question);
  }
}
