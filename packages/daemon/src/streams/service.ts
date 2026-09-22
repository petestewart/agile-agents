/**
 * `StreamService` — create / read / list(tree) / update / close / archive a
 * stream, and append to or read its thread (T120; cockpit design §2 for the
 * record and the two-writer split, §7.2 for the home layout).
 *
 * Every method takes an explicit **principal** (design §2.2): the RPC edge
 * stamps `human` and never accepts one from params, the runner and T130's
 * MCP verbs will pass `agent`, and the daemon's own lifecycle writes pass
 * `daemon`. That is why this service API exists separately from `rpc.ts` —
 * so an agent-principal caller has something to call that is not the human
 * edge.
 *
 * No git: a stream's `branch`/`worktree` appear on first attach (T130), so
 * nothing here spawns git, reads a worktree or touches a repo. A `repo` on
 * a stream is only a key into `repos.yaml`, validated on create.
 */

import {
  type Stream,
  type StreamCreateInput,
  type StreamPrincipal,
  THREAD_BODY_MAX_CHARS,
  type ThreadAuthor,
  type ThreadEntry,
  type ThreadEntryKind,
  ulid,
  validateStreamCreateInput,
} from '@agile-agents/shared';
import type { StateStore } from '../store/store';

/** One node of the `list` tree: the record plus its child streams. */
export interface StreamNode {
  stream: Stream;
  children: StreamNode[];
}

export interface ListStreamsOptions {
  /** Archived streams are hidden by default (they stay on disk either way). */
  include_archived?: boolean;
}

export interface ThreadAppendInput {
  kind: ThreadEntryKind;
  body: string;
  ref?: string;
}

export interface ThreadPageOptions {
  /** Return entries after this 0-based line index. */
  after?: number;
  limit?: number;
}

export interface ThreadPage {
  entries: ThreadEntry[];
  /** 0-based index of the first returned entry (`after + 1`, or 0). */
  from: number;
  /** Total entries in the thread, so a caller can tell it is at the end. */
  total: number;
  /** Pass as the next `after`; absent when the page reached the end. */
  next?: number;
}

const DEFAULT_THREAD_LIMIT = 100;

/**
 * `create` was given a `parent` that is not a stream in this home. Typed so
 * the RPC edge reports it as `invalid params` (-32602) — bad caller input,
 * not an internal fault (T126).
 */
export class UnknownParentStreamError extends Error {
  constructor(public readonly parent: string) {
    super(`unknown parent stream: ${parent}`);
    this.name = 'UnknownParentStreamError';
  }
}

/** `create` was given a `repo` that is not registered in `repos.yaml`. */
export class UnknownRepoError extends Error {
  constructor(
    public readonly repo: string,
    known: readonly string[],
  ) {
    super(
      `unknown repo: ${repo} is not registered in repos.yaml${
        known.length > 0 ? ` (registered: ${known.join(', ')})` : ' (none registered)'
      }`,
    );
    this.name = 'UnknownRepoError';
  }
}

/**
 * The thread author a principal writes as. `agent` needs its session id
 * (`agent:<ulid>`, §2.1) — a bare `agent` principal has no thread identity,
 * so callers pass the session explicitly.
 */
export function threadAuthorFor(principal: StreamPrincipal, sessionId?: string): ThreadAuthor {
  if (principal !== 'agent') return principal;
  if (sessionId === undefined) {
    throw new Error('an agent principal must name its session id to write to a thread');
  }
  return `agent:${sessionId}`;
}

export interface StreamServiceOptions {
  /**
   * T141 (§5.5): what `close` tells the retro. Fire-and-forget — a lessons
   * session that cannot start is a thread line, never a failed close — and
   * wired in `daemon.ts`, because `LessonsService` sits above this one.
   */
  onStreamEnd?: (streamId: string) => void | Promise<void>;
}

export class StreamService {
  constructor(
    private readonly store: StateStore,
    private readonly options: StreamServiceOptions = {},
  ) {}

  /**
   * §2.3: "create ──► human.status: open, agent.status: idle". The daemon
   * mints `id`/`created_at`/both halves; `branch`/`worktree` stay absent
   * until a worker attaches (T130).
   */
  async create(principal: StreamPrincipal, rawInput: unknown): Promise<Stream> {
    const input: StreamCreateInput = validateStreamCreateInput(rawInput);
    if (input.parent !== undefined && !this.store.hasStream(input.parent)) {
      throw new UnknownParentStreamError(input.parent);
    }
    if (input.repo !== undefined) {
      const repos = this.store.getRepos();
      if (repos[input.repo] === undefined) {
        throw new UnknownRepoError(input.repo, Object.keys(repos).sort());
      }
    }
    const now = new Date().toISOString();
    const stream: Stream = {
      id: ulid(),
      title: input.title,
      goal: input.goal,
      ...(input.parent !== undefined ? { parent: input.parent } : {}),
      ...(input.repo !== undefined ? { repo: input.repo } : {}),
      ...(input.target_branch !== undefined ? { target_branch: input.target_branch } : {}),
      created_at: now,
      agent: { status: 'idle', updated_at: now },
      human: { status: 'open' },
      sessions: [],
    };
    const created = await this.store.createStream(stream);
    await this.appendThread(principal, created.id, {
      kind: 'event',
      body: `stream created: ${created.title}`,
    });
    return created;
  }

  get(id: string): Stream {
    return this.store.getStream(id);
  }

  list(options: ListStreamsOptions = {}): Stream[] {
    const all = this.store.listStreams();
    return options.include_archived === true ? all : all.filter((s) => s.archived !== true);
  }

  /**
   * Parent/child structure over the visible set. A stream whose parent is
   * hidden (archived, or deleted by hand) surfaces at the root rather than
   * disappearing with it — hiding a parent must never hide live work.
   */
  tree(options: ListStreamsOptions = {}): StreamNode[] {
    const visible = this.list(options);
    const nodes = new Map<string, StreamNode>(
      visible.map((stream) => [stream.id, { stream, children: [] }]),
    );
    const roots: StreamNode[] = [];
    for (const node of nodes.values()) {
      const parentId = node.stream.parent;
      const parent = parentId !== undefined ? nodes.get(parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  /**
   * Applies a patch under the store's mutex. Top-level fields are replaced;
   * `agent`/`human` are shallow-merged so a caller can set one field
   * without restating the half. The store applies `assertStreamWrite`, so a
   * `human` principal patching `agent.*` is rejected there, not here.
   */
  async update(
    principal: StreamPrincipal,
    id: string,
    patch: StreamPatch,
    options: { kind?: 'stream_updated' | 'stream_closed' | 'stream_archived' } = {},
  ): Promise<Stream> {
    return this.store.updateStream(principal, id, (before) => applyPatch(before, patch), options);
  }

  /**
   * §2.3's human end state: `human.status: closed` (never an agent write).
   *
   * A `note` lands in two places: on `human.note` (the current record) and
   * as one `line` on the thread (the durable record of *why* it closed) —
   * T126, QA rough edge 2: the note used to vanish from the thread, leaving
   * a later reader no trace of the close. The close itself still emits a
   * single `stream_closed` event; the thread line is its own
   * `thread_appended`, exactly like any other line.
   */
  async close(principal: StreamPrincipal, id: string, note?: string): Promise<Stream> {
    const closed = await this.update(
      principal,
      id,
      { human: { status: 'closed', ...(note !== undefined ? { note } : {}) } },
      { kind: 'stream_closed' },
    );
    if (note !== undefined) {
      await this.appendThread(principal, id, { kind: 'line', body: `closed: ${note}` });
    }
    // §5.5: the retro runs on land *or* close. Fire-and-forget: the close
    // has already happened, and `LessonsService.onStreamEnd` records its
    // own failures on the thread.
    void Promise.resolve(this.options.onStreamEnd?.(id)).catch(() => {
      // `onStreamEnd` is contractually non-throwing; this is belt and braces.
    });
    return closed;
  }

  /**
   * Archiving moves nothing on disk (§7.2 has one file per stream and no
   * archive directory) — it sets the `archived` flag, and `list` hides it
   * unless asked. The stream's human status is left alone: a `landed`
   * stream stays landed once archived.
   */
  async archive(principal: StreamPrincipal, id: string): Promise<Stream> {
    return this.update(principal, id, { archived: true }, { kind: 'stream_archived' });
  }

  /**
   * One thread line. Bodies over the cap are **rejected** here: overflowing
   * to a file with a `ref` is the agent path (T130), and a human typing a
   * long line should be told, not silently truncated or spilled to disk.
   */
  async appendThread(
    principal: StreamPrincipal,
    id: string,
    input: ThreadAppendInput,
    sessionId?: string,
  ): Promise<ThreadEntry> {
    if (input.body.length > THREAD_BODY_MAX_CHARS) {
      throw new Error(
        `thread body is ${input.body.length} characters; the cap is ${THREAD_BODY_MAX_CHARS} — write the detail to a file and pass it as "ref"`,
      );
    }
    return this.store.appendThreadEntry(id, {
      ts: new Date().toISOString(),
      by: threadAuthorFor(principal, sessionId),
      kind: input.kind,
      body: input.body,
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
    });
  }

  /** Paged read by line index — the thread is append-only, so indices are stable. */
  readThread(id: string, options: ThreadPageOptions = {}): ThreadPage {
    // Existence check first: an unknown stream is a NotFoundError, not an
    // empty thread.
    this.store.getStream(id);
    const all = this.store.readThread(id);
    const from = options.after === undefined ? 0 : options.after + 1;
    if (from < 0 || !Number.isInteger(from)) {
      throw new Error(`invalid "after": ${String(options.after)} must be a non-negative integer`);
    }
    const limit =
      options.limit === undefined ? DEFAULT_THREAD_LIMIT : Math.max(1, Math.trunc(options.limit));
    const entries = all.slice(from, from + limit);
    const lastIndex = from + entries.length - 1;
    return {
      entries,
      from,
      total: all.length,
      ...(lastIndex >= 0 && lastIndex < all.length - 1 ? { next: lastIndex } : {}),
    };
  }
}

/** A partial stream write. `agent`/`human` merge; everything else replaces. */
export interface StreamPatch {
  title?: string;
  goal?: string;
  parent?: string;
  repo?: string;
  branch?: string;
  worktree?: string;
  target_branch?: string;
  archived?: true;
  agent?: Partial<Stream['agent']>;
  human?: Partial<Stream['human']>;
}

function applyPatch(before: Stream, patch: StreamPatch): Stream {
  const { agent, human, ...rest } = patch;
  const next: Stream = { ...before, ...rest };
  if (agent !== undefined) {
    // Any agent-half change is a fresh observation; stamp it (§2.1's
    // `agent.updated_at`) unless the caller set it explicitly.
    next.agent = { ...before.agent, updated_at: new Date().toISOString(), ...agent };
  }
  if (human !== undefined) {
    next.human = { ...before.human, ...human };
  }
  return next;
}
