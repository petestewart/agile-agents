/**
 * `StreamService`: create, read, list (tree), update, close and archive a
 * stream, and append to or read its thread (§2, §7.2). Every method takes
 * an explicit principal (§2.2): `human` from the RPC edge, `agent` from
 * the verbs, `daemon` for lifecycle writes. No git here: branch and
 * worktree appear on first attach; `repo` is only a key into `repos.yaml`.
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

/** `create` got a `parent` that is not a stream in this home (-32602 at the edge). */
export class UnknownParentStreamError extends Error {
  constructor(public readonly parent: string) {
    super(`unknown parent stream: ${parent}`);
    this.name = 'UnknownParentStreamError';
  }
}

/** `create` named a project that does not exist, or none when one is required (-32602 at the edge). */
export class StreamProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamProjectError';
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

/** The thread author a principal writes as; `agent` needs its session id (`agent:<ulid>`, §2.1). */
export function threadAuthorFor(principal: StreamPrincipal, sessionId?: string): ThreadAuthor {
  // coordinator/director write under their own name (§14.12).
  if (principal !== 'agent') return principal;
  if (sessionId === undefined) {
    throw new Error('an agent principal must name its session id to write to a thread');
  }
  return `agent:${sessionId}`;
}

export interface StreamServiceOptions {
  /** Tells the retro (§5.5) a stream closed. Fire-and-forget: never a failed close. */
  onStreamEnd?: (streamId: string) => void | Promise<void>;
}

export class StreamService {
  constructor(
    private readonly store: StateStore,
    private readonly options: StreamServiceOptions = {},
  ) {}

  /**
   * §2.3: create ⇒ `human.status: open`, `agent.status: idle`. The daemon mints id and timestamps.
   *
   * T201: with `project`, the parent defaults to the project's root and a
   * given parent must be in that project; without one, the parent's project
   * is inherited. `requireProject` (the RPC edge) refuses a node that would
   * end up with none.
   */
  async create(
    principal: StreamPrincipal,
    rawInput: unknown,
    options: { requireProject?: boolean } = {},
  ): Promise<Stream> {
    const input: StreamCreateInput = validateStreamCreateInput(rawInput);
    if (input.parent !== undefined && !this.store.hasStream(input.parent)) {
      throw new UnknownParentStreamError(input.parent);
    }
    const parentProject =
      input.parent !== undefined ? this.store.getStream(input.parent).project : undefined;
    let parent = input.parent;
    let project = input.project;
    if (project !== undefined) {
      let root: string;
      try {
        root = this.store.getProject(project).root;
      } catch {
        throw new StreamProjectError(`unknown project: ${project}`);
      }
      if (parent === undefined) parent = root;
      else if (parent !== root && parentProject !== project) {
        throw new StreamProjectError(`parent ${parent} is not in project ${project}`);
      }
    } else {
      project = parentProject;
    }
    if (options.requireProject === true && project === undefined) {
      throw new StreamProjectError(
        'a project is required: pass "project" (or a parent that belongs to one)',
      );
    }
    if (input.helper_of !== undefined && input.helper_of !== parent) {
      throw new StreamProjectError('helper_of must name the parent node');
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
      ...(parent !== undefined ? { parent } : {}),
      ...(input.repo !== undefined ? { repo: input.repo } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(input.labels !== undefined ? { labels: input.labels } : {}),
      ...(input.helper_of !== undefined ? { helper_of: input.helper_of } : {}),
      created_at: now,
      agent: { status: 'idle', updated_at: now },
      human: { status: 'open' },
      sessions: [],
    };
    return this.insert(principal, stream);
  }

  /** A project's root node (T200/T201): no parent, carries the project id. */
  async createRoot(
    principal: StreamPrincipal,
    project: string,
    title: string,
    goal: string,
  ): Promise<Stream> {
    const now = new Date().toISOString();
    return this.insert(principal, {
      id: ulid(),
      title,
      goal,
      project,
      created_at: now,
      agent: { status: 'idle', updated_at: now },
      human: { status: 'open' },
      sessions: [],
    });
  }

  private async insert(principal: StreamPrincipal, stream: Stream): Promise<Stream> {
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

  /** Parent/child structure over the visible set; a hidden parent's children surface at the root. */
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
   * Applies a patch under the store's mutex: top-level fields replace,
   * `agent`/`human` shallow-merge. The store enforces the two-writer split.
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
   * §2.3's human end state, `human.status: closed`. A `note` goes on
   * `human.note` and, as the durable record of why, on the thread.
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
    // §5.5: the retro runs on land or close. Fire-and-forget; contractually
    // non-throwing, caught as belt and braces.
    void Promise.resolve(this.options.onStreamEnd?.(id)).catch(() => {});
    return closed;
  }

  /** Sets the `archived` flag (nothing moves on disk); `list` hides it. Human status is kept. */
  async archive(principal: StreamPrincipal, id: string): Promise<Stream> {
    return this.update(principal, id, { archived: true }, { kind: 'stream_archived' });
  }

  /** One thread line. Over the cap is rejected: a human should be told, not truncated. */
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

  /** Paged read by line index (append-only, so indices are stable). */
  readThread(id: string, options: ThreadPageOptions = {}): ThreadPage {
    // An unknown stream is a NotFoundError, not an empty thread.
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
  archived?: true;
  /** `'off'` opts the stream out of the classifier tier (§6.4); `null` clears the opt-out. */
  classifier?: 'off' | null;
  /** T176: `null` clears it. */
  land_conflict?: Stream['land_conflict'] | null;
  /** Node fields (§14.2, T201). `delivery_state`/`touched` pass the store only for the daemon. */
  project?: Stream['project'];
  labels?: Stream['labels'];
  waits_on?: Stream['waits_on'];
  external_link?: Stream['external_link'];
  autonomy?: Stream['autonomy'];
  delivery?: Stream['delivery'];
  merge_together?: Stream['merge_together'];
  helper_of?: Stream['helper_of'];
  delivery_state?: Stream['delivery_state'];
  touched?: Stream['touched'];
  agent?: Partial<Stream['agent']>;
  human?: Partial<Stream['human']>;
}

function applyPatch(before: Stream, patch: StreamPatch): Stream {
  const { agent, human, classifier, land_conflict, ...rest } = patch;
  // `classifier` is tri-state (absent, `'off'`, `null` = remove), rebuilt
  // so a cleared opt-out leaves no key in the YAML.
  const { classifier: existing, ...withoutOptOut } = before;
  const optOut = classifier === undefined ? existing : (classifier ?? undefined);
  const next: Stream = {
    ...withoutOptOut,
    ...(optOut !== undefined ? { classifier: optOut } : {}),
    ...rest,
  };
  if (land_conflict === null) Reflect.deleteProperty(next, 'land_conflict');
  else if (land_conflict !== undefined) next.land_conflict = land_conflict;
  if (agent !== undefined) {
    // Any agent-half change is a fresh observation: stamp `updated_at` unless given.
    next.agent = { ...before.agent, updated_at: new Date().toISOString(), ...agent };
  }
  if (human !== undefined) {
    next.human = { ...before.human, ...human };
  }
  return next;
}
