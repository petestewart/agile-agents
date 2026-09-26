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
  DIRECTOR_NODE,
  type Delivery,
  type DirectorRecord,
  type Event,
  type HomeConfig,
  KnowledgeIdSchema,
  type KnowledgeItem,
  type KnowledgePrincipal,
  type LegacyRule,
  LegacyRuleIdSchema,
  type Policy,
  type Project,
  ProjectIdSchema,
  type RepoEntry,
  type ReposConfig,
  type RoutedEvent,
  type SessionDefaultsPatch,
  SessionDefaultsPatchSchema,
  type StatusCard,
  StatusCardSchema,
  type Stream,
  type StreamPrincipal,
  type ThreadEntry,
  type TrackerSystem,
  UlidSchema,
  assertKnowledgeAcceptable,
  assertKnowledgeWrite,
  assertNoStreamCycle,
  assertNoWaitsOnCycle,
  assertStreamWrite,
  formatKnowledgeScope,
  formatZodError,
  projectNameKey,
  validateAgentRecord,
  validateDelivery,
  validateDirectorRecord,
  validateEvent,
  validateHomeConfig,
  validateKnowledgeItem,
  validateLegacyRule,
  validatePolicy,
  validateProject,
  validateRepoEntry,
  validateReposConfig,
  validateRoutedEvent,
  validateStatusCard,
  validateStream,
  validateThreadEntry,
} from '@agile-agents/shared';
import { parse as parseYaml } from 'yaml';
import { buildEvent, needsFsync } from './events';
import {
  appendJsonlLine,
  appendJsonlLines,
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
 * What every knowledge event carries in `data` (§7.4). An item's event has
 * a `stream` scope only when the item is subtree-scoped.
 */
function knowledgeEventData(
  item: KnowledgeItem,
  principal: KnowledgePrincipal,
): Record<string, unknown> {
  return {
    id: item.id,
    status: item.status,
    enforcement: item.enforcement,
    scope: formatKnowledgeScope(item.scope),
    principal,
  };
}

function knowledgeEventStream(item: KnowledgeItem): { stream?: string } {
  return item.scope.kind === 'subtree' ? { stream: item.scope.node } : {};
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

  /** For event sources with no dedicated store method (hook decisions, session events). */
  async appendEvent(event: Event): Promise<Event> {
    return this.mutex.run(() => {
      const validated = validateEvent(event);
      this.writeEventLine(validated);
      return validated;
    });
  }

  /**
   * Read-only: the `log/events.jsonl` audit stream. `endOffset` stops at that
   * byte (a line boundary), so a reader can pair it with a tailer's offset.
   */
  listEvents(endOffset?: number): Event[] {
    return readJsonlFile<unknown>(this.abs('log', 'events.jsonl'), endOffset).map((line) =>
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

  /**
   * T320 (D31): sets (`token`) or removes (`undefined`) `trackers.<system>.token`
   * in `<home>/config.yaml`, exactly as `setClassifierApiKey` does: raw edit,
   * strict schema, 0600, and an event with no data.
   */
  async setTrackerToken(
    system: TrackerSystem,
    token: string | undefined,
    options: { by?: string } = {},
  ): Promise<void> {
    await this.setTrackerSettings(system, { token: token ?? null }, options);
  }

  /**
   * T326: `setTrackerToken`'s write, widened to Jira's non-secret
   * `base_url`/`email` so a first Jira setup (whose schema requires
   * `base_url`) is one atomic write. Absent = unchanged, `null` = removed.
   * The event names who wrote it and nothing else.
   */
  async setTrackerSettings(
    system: TrackerSystem,
    patch: { base_url?: string | null; email?: string | null; token?: string | null },
    options: { by?: string } = {},
  ): Promise<void> {
    await this.mutate(() => {
      const path = this.abs('config.yaml');
      const raw = mappingCopy(fileExists(path) ? readYamlFile(path) : {});
      const trackers = mappingCopy(raw.trackers);
      const entry = mappingCopy(trackers[system]);
      for (const field of ['base_url', 'email', 'token'] as const) {
        const value = patch[field];
        if (value === undefined) continue;
        if (value === null) Reflect.deleteProperty(entry, field);
        else entry[field] = value;
      }
      if (Object.keys(entry).length === 0) Reflect.deleteProperty(trackers, system);
      else trackers[system] = entry;
      if (Object.keys(trackers).length === 0) Reflect.deleteProperty(raw, 'trackers');
      else raw.trackers = trackers;
      try {
        validateHomeConfig(raw);
      } catch {
        // Never echo a token; say what is most likely missing.
        const hint =
          system === 'jira' && entry.base_url === undefined && Object.keys(entry).length > 0
            ? ' (jira needs a base URL)'
            : '';
        throw new Error(
          `config.yaml would not validate with these ${system} settings${hint}; nothing written`,
        );
      }
      writeYamlFileAtomic(path, raw, 0o600);
      const event = buildEvent('home_config_put', { agent: options.by, data: {} });
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

  /**
   * T222: one repo's delivery settings (§14.8). `patch` is already checked
   * by the caller (the pr refusal needs git and GitHub auth); `null` removes
   * a field. Fields not in the patch are kept.
   */
  async setRepoSettings(
    name: string,
    patch: Record<string, unknown>,
    options: { by?: string } = {},
  ): Promise<RepoEntry> {
    return this.mutate(() => {
      const repos = this.getRepos();
      const current = repos[name];
      if (current === undefined) throw new NotFoundError('RepoEntry', name);
      const raw: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete raw[key];
        else if (value !== undefined) raw[key] = value;
      }
      const entry = validateRepoEntry(raw);
      const validated = validateReposConfig({ ...repos, [name]: entry });
      writeYamlFileAtomic(this.abs('repos.yaml'), validated);
      const event = buildEvent('repos_put', {
        agent: options.by,
        data: { repo: name, settings: Object.keys(patch) },
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
    // §14.8 defaults written out, so a repo added after the migration looks migrated.
    const next = {
      ...this.getRepos(),
      [name]: validateRepoEntry({
        delivery: 'direct',
        visibility: { mode: 'public' },
        ...(entry as object),
      }),
    };
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
      this.assertWaitsOn(validated, undefined);
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

  /** P8: every new `waits_on` target exists, and the edges stay acyclic. */
  private assertWaitsOn(after: Stream, before: Stream | undefined): void {
    const targets = (after.waits_on ?? []).map((w) => w.node);
    const old = new Set((before?.waits_on ?? []).map((w) => w.node));
    for (const target of targets) {
      if (!old.has(target) && target !== after.id && !this.hasStream(target)) {
        throw new NotFoundError('Stream', target);
      }
    }
    assertNoWaitsOnCycle(after.id, targets, (sid) => {
      const path = this.abs(this.streamRelPath(sid));
      if (!fileExists(path)) return [];
      return (this.readStreamFile(path).waits_on ?? []).map((w) => w.node);
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
      if (JSON.stringify(before.waits_on) !== JSON.stringify(after.waits_on)) {
        this.assertWaitsOn(after, before);
      }
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

  // ------------------------------------------------------------------ Director

  /** T300 (§14.11, P16): `director.yaml`, the singleton record; undefined before the first write. */
  getDirector(): DirectorRecord | undefined {
    const path = this.abs('director.yaml');
    if (!fileExists(path)) return undefined;
    return readRecord(path, 'director', validateDirectorRecord);
  }

  async putDirector(record: unknown): Promise<DirectorRecord> {
    return this.mutate(() => {
      const validated = validateDirectorRecord(record);
      writeYamlFileAtomic(this.abs('director.yaml'), validated);
      return {
        result: validated,
        event: buildEvent('director_put', {
          data: validated.session
            ? { session: validated.session.id, status: validated.session.status }
            : {},
        }),
      };
    });
  }

  /** `threads/director.jsonl`: the same entries and checks as a stream's thread. */
  async appendDirectorThread(entry: unknown): Promise<ThreadEntry> {
    return this.mutate(() => {
      const validated = validateThreadEntry(entry);
      appendJsonlLine(this.abs(join('threads', `${DIRECTOR_NODE}.jsonl`)), validated);
      const event = buildEvent('thread_appended', {
        data: { thread: DIRECTOR_NODE, by: validated.by, entry_kind: validated.kind },
      });
      return { result: validated, event };
    });
  }

  readDirectorThread(): ThreadEntry[] {
    return this.readJsonlValidated(
      this.abs(join('threads', `${DIRECTOR_NODE}.jsonl`)),
      'thread',
      validateThreadEntry,
    );
  }

  // ------------------------------------------------------------------ Knowledge

  /**
   * `knowledge/K-<ulid>.yaml`, one file per item (projects-design §14.3).
   * The store applies the principal split (`assertKnowledgeWrite`, D4) and
   * the check invariants (`assertKnowledgeAcceptable`). Scope refs are
   * checked by `KnowledgeService`.
   */
  private knowledgeRelPath(id: string): string {
    const result = KnowledgeIdSchema.safeParse(id);
    if (!result.success) {
      throw new Error(`invalid KnowledgeItem id: ${id} must look like K-<ulid>`);
    }
    return join('knowledge', `${result.data}.yaml`);
  }

  private readKnowledgeFile(absPath: string): KnowledgeItem {
    return readRecord(absPath, 'knowledge item', validateKnowledgeItem);
  }

  getKnowledge(id: string): KnowledgeItem {
    const path = this.abs(this.knowledgeRelPath(id));
    if (!fileExists(path)) throw new NotFoundError('KnowledgeItem', id);
    return this.readKnowledgeFile(path);
  }

  hasKnowledge(id: string): boolean {
    return fileExists(this.abs(this.knowledgeRelPath(id)));
  }

  /** Every item in the home, oldest id first (ULIDs sort by time). */
  listKnowledge(): KnowledgeItem[] {
    const dir = this.abs('knowledge');
    return listDataFiles(dir, '.yaml')
      .map((name) => this.readKnowledgeFile(join(dir, name)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Creates one item. The caller supplies the whole record; this validates
   * it, applies both structural checks for the creating principal, refuses
   * a duplicate id, and mints `knowledge_put`.
   */
  async createKnowledge(principal: KnowledgePrincipal, item: unknown): Promise<KnowledgeItem> {
    return this.mutate(() => {
      const validated = assertKnowledgeAcceptable(
        assertKnowledgeWrite(principal, undefined, validateKnowledgeItem(item)),
      );
      const relPath = this.knowledgeRelPath(validated.id);
      if (fileExists(this.abs(relPath))) {
        throw new AlreadyExistsError('KnowledgeItem', validated.id);
      }
      writeYamlFileAtomic(this.abs(relPath), validated);
      return {
        result: validated,
        event: buildEvent('knowledge_put', {
          ...knowledgeEventStream(validated),
          data: knowledgeEventData(validated, principal),
        }),
      };
    });
  }

  /**
   * Read-modify-write of one item under the mutex. `options.kind` is
   * `knowledge_decided` for the human's accept/retire and `knowledge_put`
   * for every other edit (§7.4).
   */
  async updateKnowledge(
    principal: KnowledgePrincipal,
    id: string,
    mutator: (before: KnowledgeItem) => KnowledgeItem,
    options: { kind?: 'knowledge_put' | 'knowledge_decided' } = {},
  ): Promise<KnowledgeItem> {
    return this.mutate(() => {
      const relPath = this.knowledgeRelPath(id);
      if (!fileExists(this.abs(relPath))) throw new NotFoundError('KnowledgeItem', id);
      const before = this.readKnowledgeFile(this.abs(relPath));
      const after = assertKnowledgeAcceptable(
        assertKnowledgeWrite(principal, before, validateKnowledgeItem(mutator(before))),
      );
      writeYamlFileAtomic(this.abs(relPath), after);
      return {
        result: after,
        event: buildEvent(options.kind ?? 'knowledge_put', {
          ...knowledgeEventStream(after),
          data: knowledgeEventData(after, principal),
        }),
      };
    });
  }

  /**
   * The legacy `rules/R-<ulid>.yaml` records, read-only, for the one-shot
   * migration (§17.1 step 2). Nothing writes `rules/` any more; it stays on
   * disk for one phase.
   */
  listLegacyRules(): LegacyRule[] {
    const dir = this.abs('rules');
    return listDataFiles(dir, '.yaml')
      .map((name) => {
        const id = name.replace(/\.yaml$/, '');
        if (!LegacyRuleIdSchema.safeParse(id).success) {
          throw new Error(`invalid Rule file: rules/${name} must be named R-<ulid>.yaml`);
        }
        return readRecord(join(dir, name), 'rule', validateLegacyRule);
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // ------------------------------------------------------------------ Projects

  /** `projects/P-<ulid>.yaml`, one file per project (projects-design §14.1). */
  private projectRelPath(id: string): string {
    const result = ProjectIdSchema.safeParse(id);
    if (!result.success) throw new Error(`invalid Project id: ${id} must look like P-<ulid>`);
    return join('projects', `${result.data}.yaml`);
  }

  private readProjectFile(absPath: string): Project {
    return readRecord(absPath, 'project', validateProject);
  }

  getProject(id: string): Project {
    const path = this.abs(this.projectRelPath(id));
    if (!fileExists(path)) throw new NotFoundError('Project', id);
    return this.readProjectFile(path);
  }

  /** Every project in the home, oldest id first. */
  listProjects(): Project[] {
    const dir = this.abs('projects');
    return listDataFiles(dir, '.yaml')
      .map((name) => this.readProjectFile(join(dir, name)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Names are unique case-insensitively, archived projects included. */
  assertProjectNameFree(name: string, self?: string): void {
    const key = projectNameKey(name);
    const clash = this.listProjects().find((p) => p.id !== self && projectNameKey(p.name) === key);
    if (clash !== undefined) throw new AlreadyExistsError('Project', `named "${clash.name}"`);
  }

  async createProject(project: unknown): Promise<Project> {
    return this.mutate(() => {
      const validated = validateProject(project);
      const relPath = this.projectRelPath(validated.id);
      if (fileExists(this.abs(relPath))) throw new AlreadyExistsError('Project', validated.id);
      this.assertProjectNameFree(validated.name);
      writeYamlFileAtomic(this.abs(relPath), validated);
      return { result: validated, event: projectEvent('project_created', validated) };
    });
  }

  /** Read-modify-write under the mutex; `id`, `root` and `created_at` never change. */
  async updateProject(id: string, mutator: (before: Project) => Project): Promise<Project> {
    return this.mutate(() => {
      const relPath = this.projectRelPath(id);
      if (!fileExists(this.abs(relPath))) throw new NotFoundError('Project', id);
      const before = this.readProjectFile(this.abs(relPath));
      const after = validateProject(mutator(before));
      for (const field of ['id', 'root', 'created_at'] as const) {
        if (after[field] !== before[field]) {
          throw new Error(`invalid Project write: ${field} may not change`);
        }
      }
      this.assertProjectNameFree(after.name, after.id);
      writeYamlFileAtomic(this.abs(relPath), after);
      return { result: after, event: projectEvent('project_updated', after) };
    });
  }

  /**
   * Reads the thread, validating every line and naming the file *and the
   * line number* of the first bad one (§7.3). Missing file = empty thread,
   * which is the normal state of a freshly created stream.
   */
  readThread(streamId: string): ThreadEntry[] {
    return this.readJsonlValidated(
      this.abs(this.threadRelPath(streamId)),
      'thread',
      validateThreadEntry,
    );
  }

  /** Every line validated; a bad one is refused with the file and its line number (§7.3). */
  private readJsonlValidated<T>(absPath: string, what: string, validate: (raw: unknown) => T): T[] {
    if (!fileExists(absPath)) return [];
    const lines = readFileSync(absPath, 'utf8').split('\n');
    const out: T[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? '').trim();
      if (line.length === 0) continue;
      try {
        out.push(validate(JSON.parse(line)));
      } catch (err) {
        throw new Error(
          `corrupt ${what} file ${absPath}:${i + 1}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return out;
  }

  // ------------------------------------------------------- Status cards
  // T283, projects-design §14.5: `cards/<node-id>.yaml`. Rewritten on every
  // recompute, so, like routed events, no audit `Event` per write.

  private cardRelPath(node: string): string {
    return join('cards', `${this.streamIdSegment(node)}.yaml`);
  }

  /** The node's card, or `undefined` before the daemon first writes it. */
  getCard(node: string): StatusCard | undefined {
    const path = this.abs(this.cardRelPath(node));
    if (!fileExists(path)) return undefined;
    return readCardFile(path);
  }

  /** Read-modify-write under the mutex; the mutator returns `undefined` to leave the file alone. */
  async updateCard(
    node: string,
    mutator: (before: StatusCard | undefined) => StatusCard | undefined,
  ): Promise<StatusCard | undefined> {
    return this.mutex.run(() => {
      const relPath = this.cardRelPath(node);
      const before = this.getCard(node);
      const next = mutator(before);
      if (next === undefined) return before;
      const after = validateStatusCard(next);
      if (after.node !== node) throw new Error(`invalid card write: node ${after.node} ≠ ${node}`);
      writeYamlFileAtomic(this.abs(relPath), after);
      return after;
    });
  }

  // ------------------------------------------------------- Routed events
  // T240, projects-design §14.9, P9: `events/log.jsonl` plus one queue per
  // recipient. Not the audit log: these writes emit no audit `Event`.
  // Every append is fsynced before it returns. `events/service.ts` is the API.

  private deliveryQueueRelPath(node: string): string {
    const segment = node === DIRECTOR_NODE ? node : this.streamIdSegment(node);
    return join('events', 'queue', `${segment}.jsonl`);
  }

  /** Appends the event, then its deliveries, each fsynced, under the mutex. */
  async appendRoutedEvent(event: unknown, deliveries: readonly unknown[]): Promise<RoutedEvent> {
    return this.mutex.run(() => {
      const validated = validateRoutedEvent(event);
      const lines = deliveries.map((d) => validateDelivery(d));
      appendJsonlLine(this.abs('events', 'log.jsonl'), validated, { fsync: true });
      this.writeDeliveryLines(lines);
      return validated;
    });
  }

  /** Appends delivery state changes (one write + fsync per recipient queue). */
  async appendDeliveries(deliveries: readonly unknown[]): Promise<Delivery[]> {
    return this.mutex.run(() => {
      const lines = deliveries.map((d) => validateDelivery(d));
      this.writeDeliveryLines(lines);
      return lines;
    });
  }

  private writeDeliveryLines(lines: readonly Delivery[]): void {
    const byNode = new Map<string, Delivery[]>();
    for (const line of lines) byNode.set(line.node, [...(byNode.get(line.node) ?? []), line]);
    for (const [node, group] of byNode) {
      appendJsonlLines(this.abs(this.deliveryQueueRelPath(node)), group, { fsync: true });
    }
  }

  /** The whole routed event log, in append order. */
  readRoutedEvents(): RoutedEvent[] {
    return this.readJsonlValidated(
      this.abs('events', 'log.jsonl'),
      'routed event log',
      validateRoutedEvent,
    );
  }

  /** Every delivery line of one node's queue, in append order. */
  readDeliveries(node: string): Delivery[] {
    const absPath = this.abs(this.deliveryQueueRelPath(node));
    return this.readJsonlValidated(absPath, 'delivery queue', (raw) => {
      const line = validateDelivery(raw);
      if (line.node !== node) throw new Error(`delivery for node ${line.node} in ${node}'s queue`);
      return line;
    });
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

function projectEvent(kind: 'project_created' | 'project_updated', project: Project): Event {
  return buildEvent(kind, {
    stream: project.root,
    data: {
      id: project.id,
      name: project.name,
      root: project.root,
      archived: project.archived === true,
    },
  });
}

/** Reads and validates one YAML record; a corrupt one is refused with its path (§7.3). */
/**
 * A card, refused with `path:line` when corrupt (T283): the YAML error's
 * line, or the line of the first invalid top-level key (1 if none).
 */
function readCardFile(absPath: string): StatusCard {
  const text = readFileSync(absPath, 'utf8');
  const fail = (line: number, msg: string): never => {
    throw new Error(`corrupt card file ${absPath}:${line}: ${msg}`);
  };
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    const line = (err as { linePos?: Array<{ line: number }> }).linePos?.[0]?.line ?? 1;
    return fail(line, err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err));
  }
  const result = StatusCardSchema.safeParse(raw);
  if (result.success) return result.data;
  const key = result.error.issues[0]?.path[0];
  const idx =
    typeof key === 'string' ? text.split('\n').findIndex((l) => l.startsWith(`${key}:`)) : -1;
  return fail(idx >= 0 ? idx + 1 : 1, formatZodError('StatusCard', result.error));
}

function readRecord<T>(absPath: string, what: string, validate: (raw: unknown) => T): T {
  try {
    return validate(readYamlFile(absPath));
  } catch (err) {
    throw new Error(
      `corrupt ${what} file ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
