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
 * The default run: `claude -p` with Haiku, one turn, no MCP servers, in a
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
          '--max-turns',
          '1',
          '--output-format',
          'text',
          '--strict-mcp-config',
        ],
        {
          cwd: tmpdir(),
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
