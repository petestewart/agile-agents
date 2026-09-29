/**
 * T414 (D41): a node made without a title gets one from a cheap model.
 *
 * New node derives a placeholder from the goal's first line so the node has
 * a name at once; this asks a one-shot `claude -p --model haiku` (the user's
 * own Claude Code login: the daemon still holds no vendor credentials) for a
 * short title, off the create path, and puts it in place of the placeholder.
 * A title the human changed meanwhile is left alone, and a missing CLI, a
 * failed call or an unusable answer leaves the placeholder.
 *
 * Off under `bun test` (NODE_ENV=test): no test ever needs a vendor.
 */

import { tmpdir } from 'node:os';
import type { Stream } from '@agile-agents/shared';
import { withoutDaemonSecrets } from '../secret-env';
import type { StreamService } from './service';

/** One model call: the prompt in, the reply's text out (`undefined` on any failure). */
export type TitleRun = (prompt: string) => Promise<string | undefined>;

export const TITLE_MODEL = 'haiku';
export const TITLE_TIMEOUT_MS = 30_000;
/** A title longer than this is cut at a word boundary. */
export const TITLE_MAX_CHARS = 60;
/** How much of the goal the model reads. */
const GOAL_MAX_CHARS = 2000;

export function titlePrompt(goal: string): string {
  return [
    'Write a short title for this task or question: at most 6 words, sentence case,',
    'no quotes, no trailing punctuation. Reply with the title only.',
    '',
    goal.trim().slice(0, GOAL_MAX_CHARS),
  ].join('\n');
}

/** The model's reply as a title: its first line, unwrapped, trimmed, at most `TITLE_MAX_CHARS`. */
export function cleanTitle(raw: string | undefined): string | undefined {
  const line = raw
    ?.split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (line === undefined) return undefined;
  let title = line
    .replace(/^(\*\*)?title(\*\*)?\s*:\s*/i, '')
    .replace(/^["'`*_#\s]+|["'`*_\s]+$/g, '')
    .replace(/[.!?;:,\s]+$/, '')
    .trim();
  if (title.length > TITLE_MAX_CHARS) {
    const cut = title.slice(0, TITLE_MAX_CHARS);
    const space = cut.lastIndexOf(' ');
    title = (space > TITLE_MAX_CHARS * 0.5 ? cut.slice(0, space) : cut).trim();
  }
  return title === '' ? undefined : title;
}

/**
 * The default run: `claude -p` with Haiku, no tools (one reply), no MCP servers, in a
 * scratch directory (no project instructions to load). `undefined` when
 * there is no `claude` on the PATH or under `bun test`.
 */
export function claudeTitleRun(
  env: Record<string, string | undefined> = process.env,
): TitleRun | undefined {
  if (env.NODE_ENV === 'test') return undefined;
  const bin = Bun.which('claude');
  if (bin === null) return undefined;
  return async (prompt) => {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(
        [
          bin,
          '-p',
          prompt,
          '--model',
          TITLE_MODEL,
          // No tools: the model can only reply, so the call is one turn.
          '--tools',
          '',
          '--output-format',
          'text',
          '--strict-mcp-config',
        ],
        {
          cwd: tmpdir(),
          // T486: the daemon's own env, less its secrets (the classifier key).
          env: withoutDaemonSecrets(),
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'ignore',
          timeout: TITLE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      );
    } catch {
      return undefined;
    }
    const [out, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      proc.exited,
    ]);
    return code === 0 ? out : undefined;
  };
}

export class TitleNamer {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly options: {
      streams: Pick<StreamService, 'get' | 'update'>;
      run: TitleRun;
      onError?: (err: unknown) => void;
    },
  ) {}

  /** Asks for a title for `stream`, whose title is a placeholder; returns at once. */
  name(stream: Pick<Stream, 'id' | 'title' | 'goal'>): void {
    const job = this.nameNow(stream).catch((err) => this.options.onError?.(err));
    this.inFlight.add(job);
    void job.finally(() => this.inFlight.delete(job));
  }

  /** Every title still being asked for (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  private async nameNow(stream: Pick<Stream, 'id' | 'title' | 'goal'>): Promise<void> {
    // T477: a node with no goal is named from what it was first asked, else nothing to name.
    if (stream.goal === undefined) return;
    const title = cleanTitle(await this.options.run(titlePrompt(stream.goal)));
    if (title === undefined || title === stream.title) return;
    // The human may have renamed it (or deleted it) while the model thought.
    let current: Stream;
    try {
      current = this.options.streams.get(stream.id);
    } catch {
      return;
    }
    if (current.title !== stream.title || current.archived === true) return;
    await this.options.streams.update('daemon', stream.id, { title });
  }
}

// ---------------------------------------------------------------- T422: a goal from a conversation

/** How much of a conversation the goal draft reads (its newest lines). */
const DRAFT_LINES = 30;
const DRAFT_LINE_CHARS = 1200;
export const DRAFT_GOAL_MAX_CHARS = 1500;
/** T435: what the model replies when no work follows from the conversation. */
export const NO_GOAL = 'NONE';

/** T435: a drafted goal longer than this is the model explaining, not a goal. */
export const DRAFT_GOAL_USABLE_CHARS = 600;

/**
 * T422 (D42): the prompt for a work goal drawn from a conversation: what it
 * was asked and its newest lines, answered as the goal of the work it
 * concluded (or of the research, when that is what it asks for).
 */
export function draftGoalPrompt(
  question: string,
  lines: readonly { who: 'you' | 'agent'; text: string }[],
): string {
  const talk = lines
    .slice(-DRAFT_LINES)
    .map(
      (l) =>
        `${l.who === 'you' ? 'Human' : 'Agent'}: ${l.text.replace(/\s+/g, ' ').slice(0, DRAFT_LINE_CHARS)}`,
    )
    .join('\n');
  return [
    'This conversation has reached a conclusion that should now become work.',
    'Write the goal for that work: one to three sentences, imperative, saying what should',
    'be done and what done looks like. Plain text, no preamble, no quotes, no lists.',
    `If no work follows from it, reply ${NO_GOAL} and nothing else.`,
    '',
    `The question: ${question.trim().slice(0, DRAFT_LINE_CHARS)}`,
    '',
    talk,
  ].join('\n');
}

/**
 * T435 (audit r6 #6): the model talking to you rather than a goal: it
 * speaks as itself ("I don't have…", "I'd need…"), addresses you ("Could
 * you…", "Please share…", "Let me know…") or says it lacks what it needs.
 */
const ADDRESSES_YOU =
  /(?:^|[.!?:;]\s+|\n\s*)(?:I|I'm|I’m|I've|I’ve|I'd|I’d|I'll|I’ll)\b|\b(?:could|can|would|will) you\b|\bplease (?:share|provide|tell|clarify|confirm|send|paste|let)\b|\blet me know\b|\b(?:without|need) (?:more|the|any) (?:context|details|information)\b/i;
/** A line that starts a list: "- a", "* a", "• a", "1. a", "2) a". */
const LIST_LINE = /(?:^|\n)\s*(?:[-*•]\s+|\d+[.)]\s+)/;
/** A list run into one line: "…either: 1. Share it… 2. Tell me…". */
const INLINE_LIST = /(?:^|\s)1[.)]\s+\S[\s\S]*?\s2[.)]\s+\S/;
/** A sentence that asks: a question mark before a space or the end. */
const ASKS = /\?(?:\s|$)/;

/**
 * T435: the model's draft as a goal, or `undefined` when it is no goal at
 * all: empty, "NONE" (the prompt's escape), a question, the model talking
 * to you, a list, or longer than `DRAFT_GOAL_USABLE_CHARS`. The draft-goal
 * route then falls back to the last reply, then the question.
 */
export function draftedGoal(raw: string | undefined): string | undefined {
  const goal = cleanGoal(raw);
  if (goal === undefined) return undefined;
  if (goal.replace(/[.!\s]+$/, '').toUpperCase() === NO_GOAL) return undefined;
  if (goal.length > DRAFT_GOAL_USABLE_CHARS) return undefined;
  if (ASKS.test(goal) || ADDRESSES_YOU.test(goal)) return undefined;
  if (LIST_LINE.test(goal) || INLINE_LIST.test(goal)) return undefined;
  return goal;
}

/** The model's goal: trimmed, unwrapped, capped; nothing usable is `undefined`. */
export function cleanGoal(raw: string | undefined): string | undefined {
  const text = raw
    ?.trim()
    .replace(/^(\*\*)?goal(\*\*)?\s*:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (text === undefined || text === '') return undefined;
  return text.length > DRAFT_GOAL_MAX_CHARS ? `${text.slice(0, DRAFT_GOAL_MAX_CHARS - 1)}…` : text;
}
