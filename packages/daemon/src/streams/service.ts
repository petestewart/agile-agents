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
  liveChildrenOf,
  nodeRole,
  threadBodyMaxFor,
  ulid,
  validateStreamCreateInput,
} from '@agile-agents/shared';
import { assertRepoHasCommits } from '../store/rpc-methods';
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
  /** T347: written for the agent; hidden from the cockpit's thread view. */
  agent_only?: true;
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

/** T333: a move D34 refuses (-32602 at the RPC edge, 400 over HTTP). */
export class NodeMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeMoveError';
  }
}

/** T333: what a move asks of plans and contracts (read lazily; no import cycle). */
export interface MoveCoordination {
  /** True while `node`'s plan is a draft awaiting approval. */
  planAwaitingApproval(node: string): boolean;
  /** Where `parent`'s plan or contracts still name `child` ("plan v2", "contract C-…"). */
  namedIn(parent: string, child: string): string[];
}

export interface StreamServiceOptions {
  /** T244: after each written update (the event producers). Awaited; a throw is logged, never a failed update. */
  onUpdated?: (before: Stream, after: Stream) => void | Promise<void>;
  /** T333: consulted by `move`. */
  coordination?: MoveCoordination;
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
    const seed = input.seed_line === undefined ? undefined : this.seedFor(input, parent);
    if (input.helper_of !== undefined && input.helper_of !== parent) {
      throw new StreamProjectError('helper_of must name the parent node');
    }
    let repo = input.repo;
    if (input.helper_of !== undefined) {
      // T288: a helper works on its parent's repo and delivers into its branch.
      const host = this.store.getStream(input.helper_of).repo;
      if (host === undefined)
        throw new StreamProjectError('helper_of must name a node with a repo');
      if (repo !== undefined && repo !== host) {
        throw new StreamProjectError(
          `a helper works on ${host}; for ${repo} use \`node add-repo\` (the §7 reshape)`,
        );
      }
      repo = host;
    }
    if (repo !== undefined) {
      const repos = this.store.getRepos();
      const entry = repos[repo];
      if (entry === undefined) throw new UnknownRepoError(repo, Object.keys(repos).sort());
      assertRepoHasCommits(repo, entry);
    }
    const now = new Date().toISOString();
    const stream: Stream = {
      id: ulid(),
      title: input.title,
      goal: input.goal,
      ...(parent !== undefined ? { parent } : {}),
      ...(repo !== undefined ? { repo } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(input.labels !== undefined ? { labels: input.labels } : {}),
      ...(input.helper_of !== undefined ? { helper_of: input.helper_of } : {}),
      created_at: now,
      agent: { status: 'idle', updated_at: now },
      human: { status: 'open' },
      sessions: [],
    };
    const created = await this.insert(principal, stream);
    if (seed !== undefined && parent !== undefined) {
      await this.appendThread(principal, created.id, { kind: 'event', body: seed, ref: parent });
      await this.appendThread(principal, parent, {
        kind: 'event',
        body: `tangent branched off line ${String(input.seed_line)}: ${created.title}`.slice(
          0,
          800,
        ),
        ref: created.id,
      });
    }
    return created;
  }

  /**
   * T332 (D33): a tangent's opening line — the parent's line `seed_line`,
   * quoted. Only a conversation branches off, and the tangent is one too.
   */
  private seedFor(input: StreamCreateInput, parent: string | undefined): string {
    if (parent === undefined || input.repo !== undefined || input.helper_of !== undefined) {
      throw new StreamProjectError('seed_line needs a parent, and a tangent has no repo');
    }
    const all = this.store.listStreams();
    const host = this.store.getStream(parent);
    const role = nodeRole(host, liveChildrenOf(parent, all), all);
    if (role !== 'conversation') {
      throw new StreamProjectError(`only a conversation branches off; ${parent} is ${role}`);
    }
    const line = this.store.readThread(parent)[input.seed_line ?? -1];
    if (line === undefined) {
      throw new StreamProjectError(
        `seed_line ${String(input.seed_line)}: no such line on ${parent}`,
      );
    }
    const who = line.by === 'human' ? 'you' : line.by.startsWith('agent:') ? 'its agent' : line.by;
    const head = `Branched off ${host.title.slice(0, 120)}, from this line (${who}):\n\n`;
    const room = THREAD_BODY_MAX_CHARS - head.length - 3;
    const text = line.body.length > room ? `${line.body.slice(0, room - 1)}…` : line.body;
    return `${head}${text.replace(/^/gm, '> ')}`.slice(0, THREAD_BODY_MAX_CHARS);
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
    let prior: Stream | undefined;
    const after = await this.store.updateStream(
      principal,
      id,
      (before) => {
        prior = before;
        return applyPatch(before, patch);
      },
      options,
    );
    if (prior !== undefined && this.options.onUpdated !== undefined) {
      await Promise.resolve(this.options.onUpdated(prior, after)).catch((err) =>
        console.error(`stream ${id} update hook failed:`, err),
      );
    }
    return after;
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
    return closed;
  }

  /**
   * T228 (P8): adds (or, with `remove`, drops) a `waits_on` edge from `id`
   * to `on`. The store refuses an unknown target or a cycle. `satisfied_at`
   * is the daemon's (`DeliveryService.settle`).
   */
  async wait(
    principal: 'human' | 'coordinator' | 'director',
    id: string,
    on: string,
    options: { remove?: boolean } = {},
  ): Promise<Stream> {
    const edges = this.get(id).waits_on ?? [];
    const rest = edges.filter((w) => w.node !== on);
    if (options.remove !== true && rest.length !== edges.length) return this.get(id);
    const next = options.remove
      ? rest
      : [...edges, { node: on, added_by: principal, added_at: new Date().toISOString() }];
    const updated = await this.update(principal, id, { waits_on: next });
    await this.appendThread(principal, id, {
      kind: 'event',
      body: options.remove ? `no longer waits on ${on}` : `waits on ${on}`,
    });
    return updated;
  }

  /**
   * T333 (D34): moves `id` under `target` — a node, or a project id for its
   * root — in the same project. Refused: a project root, into its own
   * subtree, across projects, and while the old or the new parent's plan
   * awaits approval. Only `parent` changes: roles are derived, so they
   * follow; a work node keeps its branch and worktree, and sessions are not
   * touched. The node and both parents get a thread line; the old parent's
   * line names any plan or contract of its that still names the node.
   * Moving to the current parent is a no-op.
   */
  async move(id: string, target: string): Promise<Stream> {
    const node = this.get(id);
    const from = node.parent;
    if (from === undefined) throw new NodeMoveError(`${id} is a project root; it cannot move`);
    let to = target;
    if (target.startsWith('P-')) {
      try {
        to = this.store.getProject(target).root;
      } catch {
        throw new NodeMoveError(`unknown project: ${target}`);
      }
    } else if (!this.store.hasStream(target)) {
      throw new UnknownParentStreamError(target);
    }
    if (to === from) return node;
    const parent = this.get(to);
    if (parent.project !== node.project) {
      throw new NodeMoveError(
        `${parent.title} is in ${parent.project ?? 'no project'}, ${node.title} in ${node.project ?? 'none'}: a node moves only within its project`,
      );
    }
    for (let cur: string | undefined = to; cur !== undefined; cur = this.get(cur).parent) {
      if (cur === id) throw new NodeMoveError(`${parent.title} is inside ${node.title}'s subtree`);
    }
    for (const p of [from, to]) {
      if (this.options.coordination?.planAwaitingApproval(p) === true) {
        throw new NodeMoveError(
          `${this.get(p).title}'s plan is awaiting approval; approve it before moving nodes`,
        );
      }
    }
    const old = this.get(from);
    const moved = await this.update('human', id, { parent: to });
    const stale = this.options.coordination?.namedIn(from, id) ?? [];
    await this.appendThread('human', from, {
      kind: 'event',
      body: `moved away: ${node.title} (${id}) is now under ${parent.title}${
        stale.length > 0 ? `; still named in this node's ${stale.join(', ')}` : ''
      }`,
    });
    await this.appendThread('human', to, {
      kind: 'event',
      body: `moved here: ${node.title} (${id}) from ${old.title}`,
    });
    await this.appendThread('human', id, {
      kind: 'event',
      body: `moved from ${old.title} to ${parent.title}`,
    });
    return moved;
  }

  /** T282: the node's coordinator autonomy override; `null` inherits the project's. */
  async setAutonomy(id: string, autonomy: Stream['autonomy'] | null): Promise<Stream> {
    const updated = await this.update('human', id, { autonomy });
    await this.appendThread('human', id, {
      kind: 'event',
      body: `coordinator autonomy: ${autonomy ?? 'inherit the project'}`,
    });
    return updated;
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
    const by = threadAuthorFor(principal, sessionId);
    const max = threadBodyMaxFor(by, input.kind);
    if (input.body.length > max) {
      throw new Error(
        `thread body is ${input.body.length} characters; the cap is ${max} — write the detail to a file and pass it as "ref"`,
      );
    }
    return this.store.appendThreadEntry(id, {
      ts: new Date().toISOString(),
      by,
      kind: input.kind,
      body: input.body,
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
      ...(input.agent_only ? { agent_only: true } : {}),
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
  /** T282: `null` clears the override, so the project's level applies. */
  autonomy?: Stream['autonomy'] | null;
  delivery?: Stream['delivery'];
  merge_together?: Stream['merge_together'];
  helper_of?: Stream['helper_of'];
  delivery_state?: Stream['delivery_state'];
  touched?: Stream['touched'];
  agent?: Partial<Stream['agent']>;
  human?: Partial<Stream['human']>;
}

function applyPatch(before: Stream, patch: StreamPatch): Stream {
  const { agent, human, classifier, land_conflict, autonomy, ...rest } = patch;
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
  if (autonomy === null) Reflect.deleteProperty(next, 'autonomy');
  else if (autonomy !== undefined) next.autonomy = autonomy;
  if (agent !== undefined) {
    // Any agent-half change is a fresh observation: stamp `updated_at` unless given.
    next.agent = { ...before.agent, updated_at: new Date().toISOString(), ...agent };
  }
  if (human !== undefined) {
    next.human = { ...before.human, ...human };
  }
  return next;
}
