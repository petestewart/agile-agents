/**
 * `StateStore`: the validating read/write layer over the state home
 * (`$AGILE_HOME`, default `~/.agile/`, a plain directory).
 *
 * Every write validates with the shared zod schema first (so a failing
 * validation touches no file), then does an atomic file write (fs.ts) and
 * appends the one `Event` that operation mints to `log/events.jsonl`, the
 * audit trail. Reads never mutate.
 *
 * One daemon process (lock.ts guards against a second), so a plain async
 * mutex around each mutation is enough: it serializes this process's own
 * concurrent RPC calls, so callers can fire mutations concurrently without
 * reasoning about interleaving.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import {
  type AgentId,
  type AgentRecord,
  type Event,
  type HomeConfig,
  type Policy,
  type RepoEntry,
  type ReposConfig,
  type Rule,
  RuleIdSchema,
  type RulePrincipal,
  type SessionDefaultsPatch,
  SessionDefaultsPatchSchema,
  type Stream,
  type StreamPrincipal,
  type ThreadEntry,
  UlidSchema,
  assertNoStreamCycle,
  assertRuleAcceptable,
  assertRuleWrite,
  assertStreamWrite,
  validateAgentRecord,
  validateEvent,
  validateHomeConfig,
  validatePolicy,
  validateRepoEntry,
  validateReposConfig,
  validateRule,
  validateStream,
  validateThreadEntry,
} from '@agile-agents/shared';
import { buildEvent, needsFsync } from './events';
import {
  appendJsonlLine,
  fileExists,
  listDataFiles,
  readJsonFile,
  readJsonlFile,
  readYamlFile,
  removeFile,
  sweepStaleTempFiles,
  writeJsonFileAtomic,
  writeYamlFileAtomic,
} from './fs';

export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

/** A create that collides with an existing record: caller input (-32602), not a daemon fault. */
export class AlreadyExistsError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} already exists`);
    this.name = 'AlreadyExistsError';
  }
}

/** Serializes async mutation calls against each other, in FIFO order. See file header. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // Swallow rejections on the chain itself (not on what callers get back)
    // so one failed mutation doesn't wedge every mutation after it.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Generic entity (de)serialization by extension — `.json` or yaml (everything else). */
function writeEntityFile(absPath: string, data: unknown): void {
  if (absPath.endsWith('.json')) {
    writeJsonFileAtomic(absPath, data);
  } else {
    writeYamlFileAtomic(absPath, data);
  }
}

function readEntityFile<T>(absPath: string): T {
  if (absPath.endsWith('.json')) return readJsonFile<T>(absPath);
  return readYamlFile<T>(absPath);
}

/** What every stream event carries in `data` (§7.4): enough to rebuild state from the log alone. */
function streamStateData(stream: Stream): Record<string, unknown> {
  return {
    agent_status: stream.agent.status,
    human_status: stream.human.status,
    archived: stream.archived === true,
  };
}

/**
 * What every rule event carries in `data` (§7.4). A rule's event has a
 * `stream` scope only when the rule itself is stream-scoped.
 */
function ruleEventData(rule: Rule, principal: RulePrincipal): Record<string, unknown> {
  return {
    id: rule.id,
    status: rule.status,
    enforcement: rule.enforcement,
    scope: rule.scope.ref === undefined ? rule.scope.kind : `${rule.scope.kind}:${rule.scope.ref}`,
    principal,
  };
}

/** A rule event's `stream` scope — only a stream-scoped rule has one. */
function ruleEventStream(rule: Rule): { stream?: string } {
  return rule.scope.kind === 'stream' && rule.scope.ref !== undefined
    ? { stream: rule.scope.ref }
    : {};
}

/** One mutation's return value and its one Event. */
interface MutationResult<T> {
  result: T;
  event: Event;
}

/** `StateStore.heartbeat`'s coalescing window. */
export const HEARTBEAT_COALESCE_MS = 30 * 1000;

export class StateStore {
  private readonly mutex = new Mutex();

  // An absolute symlink target may resolve through a symlinked ancestor of
  // the state root (macOS `tmpdir()` under `/var -> /private/var`), so
  // containment is accepted against the real path too. `open()` checks the
  // directory exists, so `realpathSync` is safe here.
  private readonly realStateRoot: string;

  private constructor(private readonly stateRoot: string) {
    this.realStateRoot = realpathSync(stateRoot);
  }

  /** Lifecycle hook for callers (daemon shutdown, test teardown); nothing is buffered, so a no-op. */
  close(): void {}

  static open(stateRoot: string): StateStore {
    if (!existsSync(stateRoot)) {
      throw new Error(`StateStore.open: ${stateRoot} does not exist (run \`agile init\` first)`);
    }
    // Clean up anything a prior crash left mid-write before any list call trips on it.
    sweepStaleTempFiles(stateRoot);
    return new StateStore(stateRoot);
  }

  /**
   * Resolves a home-relative path and refuses anything outside the state
   * root, whatever the caller validated: `join(root, '..', 'x')` escapes
   * without error. The check is `root + sep` so a sibling that shares the
   * string prefix (`state-root-evil`) cannot pass.
   */
  private abs(...parts: string[]): string {
    const resolved = resolve(this.stateRoot, ...parts);
    const root = resolve(this.stateRoot);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error(`state path escapes the state root: ${parts.join('/')}`);
    }
    this.assertNoEscapingSymlink(resolved, root, parts);
    return resolved;
  }

  /**
   * `resolve()` never touches the filesystem, so it stops `..` in
   * caller-supplied segments but not a symlink planted *inside* the state
   * root that points outside it. This walks every component with `lstat`
   * (dangling links and escaping ancestor directories included).
   *
   * A symlink's raw target is never `normalize()`d: that would collapse
   * `esc/../x` before `esc` (the escaping link) is ever examined, whereas
   * the kernel resolves `esc` first and only then applies `..`.
   * `walkSegments` mirrors kernel order: a plain segment is joined and
   * resolved (a hop is containment-checked at once), `..` pops a component
   * off the path as currently resolved, `.` and empty segments are skipped.
   * `MAX_SYMLINK_HOPS` bounds cycles and long chains.
   *
   * TOCTOU residual (accepted): this runs once inside `abs()` and holds no
   * fd, so a component swapped for a symlink between this check and the
   * syscall would still escape. Closing it needs `O_NOFOLLOW`/fd-relative
   * writes in fs.ts; the threat (a local writer already inside the state
   * root) is the same one this guard covers.
   */
  private assertNoEscapingSymlink(resolved: string, root: string, parts: string[]): void {
    // `resolved` came from a lexical `resolve()` of code-controlled segments
    // that already passed the containment check in `abs()`, so it carries no
    // `..` needing kernel-order handling; that hazard is only in link targets.
    const rel = relative(root, resolved);
    const segments = rel === '' ? [] : rel.split(sep).filter((seg) => seg.length > 0);
    this.walkSegments(root, segments, root, parts, { hops: 0 });
  }

  /** `target` is `root` itself or lies under it (`root + sep` prefix, never a bare string-prefix match). */
  private isContainedIn(target: string, root: string): boolean {
    return target === root || target.startsWith(root + sep);
  }

  /** Loosely modelled on Linux's `MAXSYMLINKS` — a link chain (or cycle) this long is never legitimate. */
  private static readonly MAX_SYMLINK_HOPS = 40;

  /**
   * Walks `segments` from `baseDir`, resolving symlink hops as it goes and
   * popping `..` off the path as currently resolved (see
   * `assertNoEscapingSymlink`). Returns the final location, existing or not.
   */
  private walkSegments(
    baseDir: string,
    segments: string[],
    root: string,
    parts: string[],
    budget: { hops: number },
  ): string {
    let current = baseDir;
    for (const seg of segments) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        current = dirname(current);
        continue;
      }
      current = join(current, seg);
      current = this.resolveComponentSymlink(current, root, parts, budget);
    }
    return current;
  }

  /**
   * If `path` is a symlink (dangling or not), resolves one hop by walking its
   * raw target with `walkSegments`: an absolute target from the root, a
   * relative one from `path`'s already-resolved directory. The resolved hop
   * is containment-checked. Returns `path` unchanged when it is not a link
   * or does not exist yet.
   */
  private resolveComponentSymlink(
    path: string,
    root: string,
    parts: string[],
    budget: { hops: number },
  ): string {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch (err) {
      // Only a missing component (or a resolved segment that turned out not
      // to be a directory) means "nothing to resolve". Anything else is a real
      // error the caller would hit too; don't relabel it as "not created yet".
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return path;
      throw err;
    }
    if (!stat.isSymbolicLink()) return path;

    budget.hops += 1;
    if (budget.hops > StateStore.MAX_SYMLINK_HOPS) {
      // Catches an escape chain and a pure cycle alike, so the message names both.
      throw new Error(
        `state path escapes the state root (symlink chain exceeded ${StateStore.MAX_SYMLINK_HOPS} hops — a link cycle or a genuine escape): ${parts.join('/')}`,
      );
    }

    const rawTarget = readlinkSync(path);
    let baseDir: string;
    let rawSegments: string[];
    if (isAbsolute(rawTarget)) {
      // A target that names `root` (literal) or `realStateRoot` as its
      // prefix walks only the remainder from that root form, never touching
      // root's own ancestry (which may resolve through a symlinked parent to
      // a path that no longer shares the literal prefix). `esc` in
      // `<root>/esc/../x` is still a segment of that walk and still gets
      // `lstat`ed. Any other absolute target walks from the filesystem root.
      if (this.isContainedIn(rawTarget, root)) {
        baseDir = root;
        rawSegments = rawTarget.slice(root.length).split(sep);
      } else if (this.isContainedIn(rawTarget, this.realStateRoot)) {
        baseDir = this.realStateRoot;
        rawSegments = rawTarget.slice(this.realStateRoot.length).split(sep);
      } else {
        baseDir = parse(root).root;
        // Platform separator only: a backslash is a filename character on POSIX.
        rawSegments = rawTarget.split(sep);
      }
    } else {
      // Relative target: `path`'s directory is already fully resolved.
      baseDir = dirname(path);
      rawSegments = rawTarget.split(sep);
    }

    const nextTarget = this.walkSegments(baseDir, rawSegments, root, parts, budget);

    // `nextTarget` is fully resolved, so either root form is a safe comparison.
    if (
      !this.isContainedIn(nextTarget, root) &&
      !this.isContainedIn(nextTarget, this.realStateRoot)
    ) {
      throw new Error(`state path escapes the state root (symlink): ${parts.join('/')}`);
    }

    return nextTarget;
  }

  /**
   * Caller-supplied relative paths (the generic entity trio) must stay inside
   * the state root: no absolute paths, no `..` segments, no `.git`.
   */
  private containedRelPath(relPath: string): string {
    const normalized = normalize(relPath);
    if (
      isAbsolute(normalized) ||
      normalized === '.' ||
      normalized.startsWith('..') ||
      normalized.split(/[\\/]/).some((seg) => seg === '..' || seg === '.git')
    ) {
      throw new Error(`entity path escapes the state root: ${relPath}`);
    }
    return normalized;
  }

  /** The one writer of `log/events.jsonl` (§7.4). Gate and land events are fsynced (`needsFsync`). */

  private writeEventLine(event: Event): void {
    appendJsonlLine(this.abs(join('log', 'events.jsonl')), event, {
      fsync: needsFsync(event.kind),
    });
  }

  /** Runs one mutation under the mutex: `fn` does the validated write(s) and builds its one Event. */
  private mutate<T>(fn: () => MutationResult<T>): Promise<T> {
    return this.mutex.run(() => {
      const { result, event } = fn();
      this.writeEventLine(validateEvent(event));
      return result;
    });
  }

  /** Waits for in-flight mutations: the deterministic "everything has landed" point. */
  async flush(): Promise<void> {
    return this.mutex.run(() => {});
  }

  /**
   * For event sources with no dedicated store method (hook decisions,
   * session events), so they don't append outside the store. `commit` is
   * accepted for existing callers; every write is immediate.
   */
  async appendEvent(
    event: Event,
    _options: { commit?: 'immediate' | 'deferred' } = {},
  ): Promise<Event> {
    return this.mutex.run(() => {
      const validated = validateEvent(event);
      this.writeEventLine(validated);
      return validated;
    });
  }

  /** Read-only: the full `log/events.jsonl` audit stream. */
  listEvents(): Event[] {
    return readJsonlFile<unknown>(this.abs('log', 'events.jsonl')).map((line) =>
      validateEvent(line),
    );
  }

  // ---------------------------------------------------------- AgentRecord

  private agentRelPath(id: AgentId): string {
    return join('bus', 'agents', `${id}.yaml`);
  }

  async putAgent(id: AgentId, record: AgentRecord): Promise<AgentRecord> {
    return this.mutate(() => {
      const validated = validateAgentRecord(record);
      const relPath = this.agentRelPath(id);
      writeYamlFileAtomic(this.abs(relPath), validated);
      const event = buildEvent('agent_put', { agent: id, data: {} });
      return { result: validated, event };
    });
  }

  /**
   * Heartbeat write, coalesced: the pre-tool-use hook calls this on every
   * tool call, so a `last_seen` younger than `HEARTBEAT_COALESCE_MS` with no
   * stream change is a no-op. Only `last_seen` and `stream` are touched;
   * every other field (`role`, `worktree`, ...) is carried over verbatim,
   * because rebuilding the record once dropped a reviewer's `role` mid-run
   * and let it edit its own worktree. An unregistered agent throws
   * `NotFoundError`: register with `putAgent` first.
   */
  async heartbeat(
    id: AgentId,
    patch: { stream?: string } = {},
    now: () => Date = () => new Date(),
  ): Promise<AgentRecord> {
    return this.mutex.run(() => {
      const existing = this.getAgent(id);

      const nowDate = now();
      const streamChanged = patch.stream !== undefined && patch.stream !== existing.stream;
      const lastSeenMs = Date.parse(existing.last_seen);
      if (
        !streamChanged &&
        !Number.isNaN(lastSeenMs) &&
        nowDate.getTime() - lastSeenMs < HEARTBEAT_COALESCE_MS
      ) {
        return existing;
      }

      const record: AgentRecord = {
        ...existing,
        ...((patch.stream ?? existing.stream) !== undefined
          ? { stream: patch.stream ?? existing.stream }
          : {}),
        last_seen: nowDate.toISOString(),
      };
      const validated = validateAgentRecord(record);
      const relPath = this.agentRelPath(id);
      writeYamlFileAtomic(this.abs(relPath), validated);
      const event = buildEvent('agent_put', { agent: id, data: { heartbeat: true } });
      this.writeEventLine(event);
      return validated;
    });
  }

  getAgent(id: AgentId): AgentRecord {
    const path = this.abs(this.agentRelPath(id));
    if (!fileExists(path)) throw new NotFoundError('AgentRecord', id);
    return validateAgentRecord(readYamlFile(path));
  }

  listAgents(): Array<{ id: string; record: AgentRecord }> {
    const dir = this.abs('bus', 'agents');
    return listDataFiles(dir, '.yaml').map((name) => ({
      id: name.slice(0, -'.yaml'.length),
      record: validateAgentRecord(readYamlFile(join(dir, name))),
    }));
  }

  /**
   * `agent_deleted` carries the removed record's vendor/model/role/stream:
   * a session's exit deletes the registry file, so this event is the only
   * remaining trace of who that agent was.
   */
  async deleteAgent(id: AgentId): Promise<void> {
    return this.mutate(() => {
      const relPath = this.agentRelPath(id);
      if (!fileExists(this.abs(relPath))) throw new NotFoundError('AgentRecord', id);
      const record = validateAgentRecord(readYamlFile(this.abs(relPath)));
      removeFile(this.abs(relPath));
      const event = buildEvent('agent_deleted', {
        agent: id,
        data: {
          vendor: record.vendor,
          model: record.model,
          ...(record.role !== undefined ? { role: record.role } : {}),
          ...(record.stream !== undefined ? { stream: record.stream } : {}),
        },
      });
      return { result: undefined, event };
    });
  }

  // -------------------------------------------------------- Policy/Vendors

  getPolicy(): Policy {
    const path = this.abs('policy.yaml');
    if (!fileExists(path)) throw new NotFoundError('Policy', 'policy.yaml');
    return validatePolicy(readYamlFile(path));
  }

  /** `options.by` records who changed the gates block (the cockpit's Settings writes `human`). */
  async putPolicy(policy: Policy, options: { by?: string } = {}): Promise<Policy> {
    return this.mutate(() => {
      const validated = validatePolicy(policy);
      const relPath = 'policy.yaml';
      writeYamlFileAtomic(this.abs(relPath), validated);
      const event = buildEvent('policy_put', { agent: options.by, data: {} });
      return { result: validated, event };
    });
  }

  /**
   * Sets (`key`) or removes (`undefined`) `classifier.api_key` in
   * `<home>/config.yaml`. The raw mapping is edited, not the parsed config,
   * so nothing the operator wrote is rewritten; the result goes through the
   * strict schema first. The file is owner-only (0600) because it holds a
   * credential, and the event carries no data: the key never reaches
   * `events.jsonl`. YAML comments in `config.yaml` do not survive.
   */
  async setClassifierApiKey(key: string | undefined): Promise<void> {
    await this.mutate(() => {
      const relPath = 'config.yaml';
      const path = this.abs(relPath);
      const raw = mappingCopy(fileExists(path) ? readYamlFile(path) : {});
      const classifier = mappingCopy(raw.classifier);
      if (key === undefined) Reflect.deleteProperty(classifier, 'api_key');
      else classifier.api_key = key;
      if (Object.keys(classifier).length === 0) Reflect.deleteProperty(raw, 'classifier');
      else raw.classifier = classifier;
      try {
        validateHomeConfig(raw);
      } catch {
        // The schema's message could quote the value; never echo a key.
        throw new Error('config.yaml would not validate with this classifier key; nothing written');
      }
      writeYamlFileAtomic(path, raw, 0o600);
      const event = buildEvent('home_config_put', { data: {} });
      return { result: undefined, event };
    });
  }

  /** `<home>/config.yaml` through the strict schema; a missing file is `{}`. */
  getHomeConfig(): HomeConfig {
    const path = this.abs('config.yaml');
    if (!fileExists(path)) return {};
    return validateHomeConfig(readYamlFile(path) ?? {});
  }

  /**
   * D17: home-wide `default_vendor|default_model|default_effort` in
   * `<home>/config.yaml`. Same raw-edit shape as `setClassifierApiKey`
   * (absent = unchanged, `null` = removed). Attach reads the file per
   * session, so no restart is needed.
   */
  async setHomeSessionDefaults(
    patch: SessionDefaultsPatch,
    options: { by?: string } = {},
  ): Promise<HomeConfig> {
    const validPatch = SessionDefaultsPatchSchema.parse(patch);
    return this.mutate(() => {
      const relPath = 'config.yaml';
      const path = this.abs(relPath);
      const raw = mappingCopy(fileExists(path) ? readYamlFile(path) : {});
      applyDefaultsPatch(raw, validPatch, {
        vendor: 'default_vendor',
        model: 'default_model',
        effort: 'default_effort',
      });
      const validated = validateHomeConfig(raw);
      // 0600: the same file may hold the classifier key.
      writeYamlFileAtomic(path, raw, 0o600);
      const event = buildEvent('home_config_put', {
        agent: options.by,
        data: { session_defaults: sessionDefaultsEventData(validPatch) },
      });
      return { result: validated, event };
    });
  }

  /** D17: one repo's `vendor|model|effort` in `repos.yaml`, same patch rules. */
  async setRepoSessionDefaults(
    name: string,
    patch: SessionDefaultsPatch,
    options: { by?: string } = {},
  ): Promise<RepoEntry> {
    const validPatch = SessionDefaultsPatchSchema.parse(patch);
    return this.mutate(() => {
      const repos = this.getRepos();
      const current = repos[name];
      if (current === undefined) throw new NotFoundError('RepoEntry', name);
      const raw: Record<string, unknown> = { ...current };
      applyDefaultsPatch(raw, validPatch, { vendor: 'vendor', model: 'model', effort: 'effort' });
      const entry = validateRepoEntry(raw);
      const validated = validateReposConfig({ ...repos, [name]: entry });
      const relPath = 'repos.yaml';
      writeYamlFileAtomic(this.abs(relPath), validated);
      const event = buildEvent('repos_put', {
        agent: options.by,
        data: { repo: name, session_defaults: sessionDefaultsEventData(validPatch) },
      });
      return { result: entry, event };
    });
  }

  // ---------------------------------------------------------- Repo registry

  /** `repos.yaml` (D9): the repos this daemon serves. A missing file is `{}`, the fresh-home state. */
  getRepos(): ReposConfig {
    const path = this.abs('repos.yaml');
    if (!fileExists(path)) return {};
    return validateReposConfig(readYamlFile(path) ?? {});
  }

  async putRepos(repos: unknown): Promise<ReposConfig> {
    return this.mutate(() => {
      const validated = validateReposConfig(repos);
      const relPath = 'repos.yaml';
      writeYamlFileAtomic(this.abs(relPath), validated);
      const event = buildEvent('repos_put');
      return { result: validated, event };
    });
  }

  /**
   * Registers (or re-registers) one repo under `name`. Merges into the
   * existing registry so `agile repo add` is additive; re-adding the same
   * name replaces that entry.
   */
  async addRepo(name: string, entry: unknown): Promise<ReposConfig> {
    const next = { ...this.getRepos(), [name]: validateRepoEntry(entry) };
    return this.putRepos(next);
  }

  // ------------------------------------------------------ Streams + threads

  /**
   * `streams/<id>.yaml` is the stream record and `threads/<id>.jsonl` its
   * append-only thread (§2, §7.2). Beyond the schema, the store applies the
   * two structural checks from shared: the two-writer split
   * (`assertStreamWrite`, D11) and the parent-cycle check
   * (`assertNoStreamCycle`, D1). No git here: branch and worktree are
   * created on first attach.
   */
  private streamRelPath(id: string): string {
    return join('streams', `${this.streamIdSegment(id)}.yaml`);
  }

  private threadRelPath(id: string): string {
    return join('threads', `${this.streamIdSegment(id)}.jsonl`);
  }

  /** A stream id is a ULID; reject anything else before it reaches a path. */
  private streamIdSegment(id: string): string {
    const result = UlidSchema.safeParse(id);
    if (!result.success) {
      throw new Error(`invalid Stream id: ${id} must be a 26-character Crockford-base32 ULID`);
    }
    return result.data;
  }

  private readStreamFile(absPath: string): Stream {
    return readRecord(absPath, 'stream', validateStream);
  }

  getStream(id: string): Stream {
    const path = this.abs(this.streamRelPath(id));
    if (!fileExists(path)) throw new NotFoundError('Stream', id);
    return this.readStreamFile(path);
  }

  hasStream(id: string): boolean {
    return fileExists(this.abs(this.streamRelPath(id)));
  }

  /** Every stream record in the home, oldest id first (ULIDs sort by time). */
  listStreams(): Stream[] {
    const dir = this.abs('streams');
    return listDataFiles(dir, '.yaml')
      .map((name) => this.readStreamFile(join(dir, name)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Creates one stream. The caller supplies the whole record (the service
   * mints `id`/`created_at`/both status halves); this validates it, refuses
   * a duplicate id and a parent cycle, and mints `stream_created`.
   */
  async createStream(stream: unknown): Promise<Stream> {
    return this.mutate(() => {
      const validated = validateStream(stream);
      const relPath = this.streamRelPath(validated.id);
      if (fileExists(this.abs(relPath))) {
        throw new AlreadyExistsError('Stream', validated.id);
      }
      assertNoStreamCycle(validated.id, validated.parent, (sid) => this.lookupStreamParent(sid));
      writeYamlFileAtomic(this.abs(relPath), validated);
      const event = buildEvent('stream_created', {
        stream: validated.id,
        data: {
          ...streamStateData(validated),
          ...(validated.parent !== undefined ? { parent: validated.parent } : {}),
          ...(validated.repo !== undefined ? { repo: validated.repo } : {}),
        },
      });
      return { result: validated, event };
    });
  }

  private lookupStreamParent(id: string): string | undefined {
    const path = this.abs(this.streamRelPath(id));
    if (!fileExists(path)) return undefined;
    return this.readStreamFile(path).parent;
  }

  /**
   * Read-modify-write of one stream under the mutex, so the two-writer
   * check sees the same `before` the write lands on. `mutator` returns the
   * whole next record; `assertStreamWrite` decides whether this principal
   * was allowed to change what it changed.
   */
  async updateStream(
    principal: StreamPrincipal,
    id: string,
    mutator: (before: Stream) => Stream,
    options: { kind?: 'stream_updated' | 'stream_closed' | 'stream_archived' } = {},
  ): Promise<Stream> {
    return this.mutate(() => {
      const relPath = this.streamRelPath(id);
      if (!fileExists(this.abs(relPath))) throw new NotFoundError('Stream', id);
      const before = this.readStreamFile(this.abs(relPath));
      const after = validateStream(mutator(before));
      if (after.id !== before.id) {
        throw new Error(`invalid Stream write: id ${before.id} may not change to ${after.id}`);
      }
      assertStreamWrite(principal, before, after);
      assertNoStreamCycle(after.id, after.parent, (sid) =>
        sid === after.id ? after.parent : this.lookupStreamParent(sid),
      );
      writeYamlFileAtomic(this.abs(relPath), after);
      const event = buildEvent(options.kind ?? 'stream_updated', {
        stream: after.id,
        data: { ...streamStateData(after), principal },
      });
      return { result: after, event };
    });
  }

  /** Appends one validated entry to `threads/<stream>.jsonl`. */
  async appendThreadEntry(streamId: string, entry: unknown): Promise<ThreadEntry> {
    return this.mutate(() => {
      const streamRel = this.streamRelPath(streamId);
      if (!fileExists(this.abs(streamRel))) throw new NotFoundError('Stream', streamId);
      const validated = validateThreadEntry(entry);
      const relPath = this.threadRelPath(streamId);
      appendJsonlLine(this.abs(relPath), validated);
      const event = buildEvent('thread_appended', {
        stream: streamId,
        data: { by: validated.by, entry_kind: validated.kind },
      });
      return { result: validated, event };
    });
  }

  // ------------------------------------------------------------------ Rules

  /**
   * `rules/R-<ulid>.yaml`, one file per rule (§5). The store applies the
   * principal split (`assertRuleWrite`, D4: agents create `proposed` only;
   * decisions are human-only) and the tier invariants
   * (`assertRuleAcceptable`). Scope refs are checked by `RulesService`.
   */
  private ruleRelPath(id: string): string {
    return join('rules', `${this.ruleIdSegment(id)}.yaml`);
  }

  /** A rule id is `R-<ulid>`; reject anything else before it reaches a path. */
  private ruleIdSegment(id: string): string {
    const result = RuleIdSchema.safeParse(id);
    if (!result.success) {
      throw new Error(`invalid Rule id: ${id} must look like R-<ulid>`);
    }
    return result.data;
  }

  private readRuleFile(absPath: string): Rule {
    return readRecord(absPath, 'rule', validateRule);
  }

  getRule(id: string): Rule {
    const path = this.abs(this.ruleRelPath(id));
    if (!fileExists(path)) throw new NotFoundError('Rule', id);
    return this.readRuleFile(path);
  }

  hasRule(id: string): boolean {
    return fileExists(this.abs(this.ruleRelPath(id)));
  }

  /** Every rule in the home, oldest id first (ULIDs sort by time). */
  listRules(): Rule[] {
    const dir = this.abs('rules');
    return listDataFiles(dir, '.yaml')
      .map((name) => this.readRuleFile(join(dir, name)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Creates one rule. The caller supplies the whole record (the service
   * mints `id`/`created_at`/`status`/`stats`); this validates it, applies
   * both structural checks for the creating principal, refuses a duplicate
   * id, and mints `rule_put`.
   */
  async createRule(principal: RulePrincipal, rule: unknown): Promise<Rule> {
    return this.mutate(() => {
      const validated = assertRuleAcceptable(
        assertRuleWrite(principal, undefined, validateRule(rule)),
      );
      const relPath = this.ruleRelPath(validated.id);
      if (fileExists(this.abs(relPath))) {
        throw new AlreadyExistsError('Rule', validated.id);
      }
      writeYamlFileAtomic(this.abs(relPath), validated);
      return {
        result: validated,
        event: buildEvent('rule_put', {
          ...ruleEventStream(validated),
          data: ruleEventData(validated, principal),
        }),
      };
    });
  }

  /**
   * Read-modify-write of one rule under the mutex, so the principal check
   * sees the same `before` the write lands on. `mutator` returns the whole
   * next record. `options.kind` is `rule_decided` for the human's
   * accept/retire and `rule_put` for every other edit (§7.4).
   */
  async updateRule(
    principal: RulePrincipal,
    id: string,
    mutator: (before: Rule) => Rule,
    options: { kind?: 'rule_put' | 'rule_decided' } = {},
  ): Promise<Rule> {
    return this.mutate(() => {
      const relPath = this.ruleRelPath(id);
      if (!fileExists(this.abs(relPath))) throw new NotFoundError('Rule', id);
      const before = this.readRuleFile(this.abs(relPath));
      const after = assertRuleAcceptable(
        assertRuleWrite(principal, before, validateRule(mutator(before))),
      );
      writeYamlFileAtomic(this.abs(relPath), after);
      return {
        result: after,
        event: buildEvent(options.kind ?? 'rule_put', {
          ...ruleEventStream(after),
          data: ruleEventData(after, principal),
        }),
      };
    });
  }

  /**
   * Reads the thread, validating every line and naming the file *and the
   * line number* of the first bad one (§7.3). Missing file = empty thread,
   * which is the normal state of a freshly created stream.
   */
  readThread(streamId: string): ThreadEntry[] {
    const absPath = this.abs(this.threadRelPath(streamId));
    if (!fileExists(absPath)) return [];
    const lines = readFileSync(absPath, 'utf8').split('\n');
    const entries: ThreadEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? '').trim();
      if (line.length === 0) continue;
      try {
        entries.push(validateThreadEntry(JSON.parse(line)));
      } catch (err) {
        throw new Error(
          `corrupt thread file ${absPath}:${i + 1}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return entries;
  }

  // -------------------------------------------------------- Generic entity

  /**
   * Validating put/get/delete for entities with no dedicated helper (the
   * bus inbox and gate records). YAML unless `relPath` ends in `.json`.
   */
  async putEntity<T>(
    rawRelPath: string,
    validator: (input: unknown) => T,
    data: unknown,
  ): Promise<T> {
    const relPath = this.containedRelPath(rawRelPath);
    return this.mutate(() => {
      const validated = validator(data);
      writeEntityFile(this.abs(relPath), validated);
      const event = buildEvent('entity_put', { data: { relPath } });
      return { result: validated, event };
    });
  }

  getEntity<T>(rawRelPath: string, validator: (input: unknown) => T): T {
    const relPath = this.containedRelPath(rawRelPath);
    const path = this.abs(relPath);
    if (!fileExists(path)) throw new NotFoundError('Entity', relPath);
    return validator(readEntityFile(path));
  }

  async deleteEntity(rawRelPath: string): Promise<void> {
    const relPath = this.containedRelPath(rawRelPath);
    return this.mutate(() => {
      if (!fileExists(this.abs(relPath))) throw new NotFoundError('Entity', relPath);
      removeFile(this.abs(relPath));
      const event = buildEvent('entity_deleted', { data: { relPath } });
      return { result: undefined, event };
    });
  }

  /** Every entity directly inside `rawRelDir`, validated. A missing directory is `[]`. */
  listEntities<T>(rawRelDir: string, validator: (input: unknown) => T): T[] {
    const relDir = this.containedRelPath(rawRelDir);
    const dirAbs = this.abs(relDir);
    const names = [...listDataFiles(dirAbs, '.yaml'), ...listDataFiles(dirAbs, '.json')];
    return names.map((name) => validator(readEntityFile(this.abs(relDir, name))));
  }
}

/** Absent = unchanged, `null` = delete the key, a value = set it. */
function applyDefaultsPatch(
  raw: Record<string, unknown>,
  patch: SessionDefaultsPatch,
  keys: { vendor: string; model: string; effort: string },
): void {
  for (const field of ['vendor', 'model', 'effort'] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (value === null) Reflect.deleteProperty(raw, keys[field]);
    else raw[keys[field]] = value;
  }
}

/** The event's record of what changed — `null` for a cleared field. */
function sessionDefaultsEventData(patch: SessionDefaultsPatch): Record<string, string | null> {
  const data: Record<string, string | null> = {};
  for (const field of ['vendor', 'model', 'effort'] as const) {
    const value = patch[field];
    if (value !== undefined) data[field] = value;
  }
  return data;
}

/** A shallow copy of a YAML mapping, or `{}` for anything else. */
function mappingCopy(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/** Reads and validates one YAML record; a corrupt one is refused with its path (§7.3). */
function readRecord<T>(absPath: string, what: string, validate: (raw: unknown) => T): T {
  try {
    return validate(readYamlFile(absPath));
  } catch (err) {
    throw new Error(
      `corrupt ${what} file ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
