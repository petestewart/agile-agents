/**
 * Resident EM session (T041 — design/agile-agents-design.md §17 "Technical
 * shape" → EM chat: "the EM runs as a child process of the daemon over ACP;
 * the daemon relays its events over the WebSocket").
 *
 * Before this, the only EM vendor session in the system was the one-shot
 * gate delegate (`em/delegate.ts`): spawned per decision, prompted once,
 * closed. `POST /api/chat/em` wrote the human's line to the EM's bus inbox
 * and nothing ever answered it (Pete, 2026-09-11: "should I have gotten an
 * answer from the em agent here" — no). This class is the missing half: ONE
 * ACP session, spawned lazily on the first prompt and kept for the daemon's
 * lifetime, whose turns stream back as deltas.
 *
 * Deliberately NOT built on `runner/session.ts`'s `startAgentSession`: that
 * module's contract is one *ticket* worktree session — it registers an
 * `AgentRecord`, writes `.claude/settings.json` into a worktree, drives the
 * ledger/liveness/exit-to-`ready` machinery and requires a `TicketId`. The
 * EM is not a ticket agent. The sibling precedent for a non-ticket EM
 * session is `em/delegate.ts`, and this file uses exactly its seams — the
 * same `spawn?: (opts: SpawnSessionOptions) => SpawnedSession` injection
 * point, the same `resolveAcpProvider`, the same `openStderrLog` — so the
 * fake-agent transport the offline tests already use drives this too, and
 * no vendor credential ever reaches the daemon.
 *
 * Gate decisions stay with `em/delegate.ts` (one-shot session per decision).
 * This resident session is never asked to decide a gate: a chat turn can
 * occupy it for minutes, and a gate that waits on a busy chat session would
 * be exactly the stall the ticket's acceptance criterion forbids ("killing
 * the resident session does not stall gates"). One decider, always
 * available, is simpler than "prefer resident when idle" and is what the
 * ticket permits.
 */

import {
  type AcpProviderConfig,
  type AgentEvent,
  type SpawnSessionOptions,
  type SpawnedSession,
  spawnSession as defaultSpawnSession,
  resolveAcpProvider,
} from '@agile-agents/acp-client';
import { type CliInvocation, normalizeCliBin } from '../runner/cli-bin';
import { openStderrLog } from '../runner/session';

/** Whole-turn budget (spawn + handshake + one turn). Chat turns are interactive, so this is shorter than a ticket session's but longer than the gate delegate's. */
export const DEFAULT_EM_TURN_TIMEOUT_MS = 120_000;

export interface ResidentEmOptions {
  /** The session's cwd — the repo root, same as the gate delegate's. */
  cwd: string;
  provider?: AcpProviderConfig;
  /** How spawned sessions reach this daemon's CLI for the MCP bridge (`runner/cli-bin.ts`). Without it the session gets no `agile` verbs. */
  cliBin?: string | CliInvocation;
  /** `--socket` for the MCP bridge, when the cwd wouldn't resolve to this daemon on its own. */
  socketPath?: string;
  /** Test seam: the fake-agent spawn, exactly as `em/delegate.ts` takes it. */
  spawn?: (opts: SpawnSessionOptions) => SpawnedSession;
  /** Per-turn budget. Default `DEFAULT_EM_TURN_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Progress notices (`agile run --live` prints them). */
  onNotice?: (line: string) => void;
  /** Where the resident session's stderr goes (`openStderrLog`). */
  stderrLogDir?: string;
  /**
   * The EM role brief (`briefs/em.md` via `renderEmBrief`), rendered fresh
   * per spawn — the sprint and policy it quotes can change over the
   * daemon's life. Prepended to the first prompt of each session (including
   * one respawned after a crash), never re-sent on later turns of the same
   * session: the vendor keeps the conversation, so repeating it would just
   * burn context.
   */
  brief?: () => string;
}

/**
 * One EM turn. Async-iterable over the reply's text deltas (what the control
 * room renders as it arrives), with `done` resolving to the full reply text
 * once the turn settles. Iterating is optional — `done` settles either way.
 */
export interface EmTurn extends AsyncIterable<string> {
  done: Promise<string>;
}

/** Minimal push queue: producer pushes deltas, consumer iterates, `close`/`fail` ends the iteration. */
class DeltaQueue {
  private readonly buffer: string[] = [];
  private waiting: (() => void) | undefined;
  private ended = false;
  private failure: Error | undefined;

  push(chunk: string): void {
    if (this.ended) return;
    this.buffer.push(chunk);
    this.wake();
  }

  close(): void {
    this.ended = true;
    this.wake();
  }

  fail(err: Error): void {
    if (this.ended) return;
    this.failure = err;
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }

  async *iterate(): AsyncGenerator<string> {
    for (;;) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift() as string;
      }
      if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}

/** The text of one `agent_message_chunk` frame, or `undefined` for every other ACP frame. Mirrors `acp-client`'s own `applyFinalMessageEvent` fold, narrowed to the streaming-delta case. */
export function messageChunkText(event: AgentEvent): string | undefined {
  if (event.type !== 'event') return undefined;
  const frame = event.event;
  if (frame.acp !== 'notification' || frame.message.method !== 'session/update') return undefined;
  const params = frame.message.params as { update?: Record<string, unknown> } | undefined;
  const update = params?.update;
  if (!update || update.sessionUpdate !== 'agent_message_chunk') return undefined;
  const content = update.content as { type?: string; text?: unknown } | undefined;
  if (!content || content.type !== 'text' || typeof content.text !== 'string') return undefined;
  return content.text.length > 0 ? content.text : undefined;
}

function mcpServerConfig(cli: CliInvocation, socketPath: string | undefined): unknown {
  return {
    name: 'agile',
    command: cli.command,
    args: [
      ...cli.args,
      'mcp',
      '--agent',
      'em',
      ...(socketPath !== undefined ? ['--socket', socketPath] : []),
    ],
    env: [],
  };
}

/**
 * The daemon's one long-lived EM session. Spawns lazily, serialises turns
 * (one `session/prompt` in flight at a time — a second `prompt()` queues
 * behind the first rather than interleaving on the same ACP session), and
 * respawns transparently after the vendor process dies or is killed.
 */
export class ResidentEm {
  private readonly provider: AcpProviderConfig;
  private readonly spawn: (opts: SpawnSessionOptions) => SpawnedSession;
  private readonly timeoutMs: number;
  private readonly notice: (line: string) => void;
  private readonly cli: CliInvocation;
  private session: SpawnedSession | undefined;
  private unsubscribe: (() => void) | undefined;
  /** Turn queue: every turn chains off the previous one, settled or failed. */
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /** Set on every fresh spawn; cleared once the brief has ridden along with a prompt. */
  private needsBrief = false;

  constructor(private readonly options: ResidentEmOptions) {
    this.provider = options.provider ?? resolveAcpProvider(undefined);
    this.spawn = options.spawn ?? ((opts: SpawnSessionOptions) => defaultSpawnSession(opts));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EM_TURN_TIMEOUT_MS;
    this.notice = options.onNotice ?? (() => {});
    this.cli = normalizeCliBin(options.cliBin);
  }

  /** Whether a live vendor process is currently held. `false` before the first prompt and after `kill()`. */
  get alive(): boolean {
    return this.session !== undefined && !this.session.exited;
  }

  /**
   * Queue one turn. The returned `EmTurn` streams the reply's text deltas
   * and resolves `done` with the full reply.
   *
   * Failures (spawn error, dead vendor, timeout, a turn the vendor reports
   * as `failed`) reject `done` and throw out of the iteration — they never
   * take the daemon or the next turn down: the session is dropped and the
   * following prompt respawns it.
   */
  prompt(text: string): EmTurn {
    const queue = new DeltaQueue();
    const done = this.chain.then(
      () => this.runTurn(text, queue),
      () => this.runTurn(text, queue),
    );
    this.chain = done.catch(() => undefined);
    // Nothing is required to await `done`; without this a turn nobody
    // iterates would surface as an unhandled rejection.
    void done.catch(() => undefined);
    return {
      done,
      [Symbol.asyncIterator]: () => queue.iterate(),
    };
  }

  private async runTurn(text: string, queue: DeltaQueue): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let streamed = '';
    try {
      const session = await this.ensureSession();
      const prompt =
        this.needsBrief && this.options.brief ? `${this.options.brief()}\n\n${text}` : text;
      this.needsBrief = false;
      const unsubscribe = session.on((event) => {
        const chunk = messageChunkText(event);
        if (chunk !== undefined) {
          streamed += chunk;
          queue.push(chunk);
        }
      });
      try {
        const turn = (async () => {
          const reply = await session.prompt(prompt);
          if (reply.status !== 'completed' && reply.error) {
            throw new Error(`resident EM turn failed: ${reply.error.message ?? reply.status}`);
          }
          return reply.text.length > 0 ? reply.text : streamed;
        })();
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`resident EM turn timed out after ${this.timeoutMs}ms`)),
            this.timeoutMs,
          );
        });
        const full = await Promise.race([turn, timeout]);
        queue.close();
        return full;
      } finally {
        unsubscribe();
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.notice(`resident EM turn failed: ${error.message}`);
      // A failed turn may have left the vendor wedged or gone; drop it so
      // the next prompt respawns rather than re-using a broken session.
      this.dropSession();
      queue.fail(error);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<SpawnedSession> {
    if (this.stopped) throw new Error('resident EM session is stopped');
    if (this.session && !this.session.exited) return this.session;
    this.dropSession();
    const stderrLog = openStderrLog(this.options.stderrLogDir, 'em-resident', new Date());
    if (stderrLog) this.notice(`resident EM session stderr -> ${stderrLog.path}`);
    const session = this.spawn({
      cmd: this.provider.command,
      args: [...this.provider.args],
      cwd: this.options.cwd,
      envOverrides: this.provider.envOverrides,
      clientCapabilities: this.provider.clientCapabilities,
      mcpServers: [mcpServerConfig(this.cli, this.options.socketPath)],
      ...(stderrLog ? { onStderr: stderrLog.append } : {}),
      ...(this.provider.defaultModeId !== undefined ? { modeId: this.provider.defaultModeId } : {}),
    });
    this.session = session;
    this.needsBrief = true;
    // A vendor that dies (crash, `kill -9`, operator closing it) must not
    // leave a dead handle behind: the next prompt respawns instead.
    this.unsubscribe = session.on((event) => {
      if (event.type === 'exit' || event.type === 'error') {
        if (this.session === session) this.dropSession();
      }
    });
    await session.initialized;
    this.notice('resident EM session ready');
    return session;
  }

  private dropSession(): void {
    const session = this.session;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session = undefined;
    session?.close();
  }

  /**
   * Kill the vendor process without stopping the resident: the next prompt
   * spawns a fresh one. This is what the offline proof for "killing the
   * resident session does not stall gates" drives.
   */
  kill(): void {
    this.dropSession();
  }

  /** Daemon shutdown: kill the process and refuse further turns. */
  stop(): void {
    this.stopped = true;
    this.dropSession();
  }
}
