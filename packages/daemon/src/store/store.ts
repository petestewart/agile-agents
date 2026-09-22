/**
 * `StateStore` — the validating read/write layer over the state home
 * (T005, T111; PLAN.md §5 "State home").
 *
 * Every write: validate with the shared zod schema first (so a failing
 * validation touches no file), then an atomic file write (fs.ts), plus the
 * one `Event` line that operation mints in `log/events.jsonl`. T111: the
 * home is `$AGILE_HOME` (default `~/.agile/`), a plain directory, so there
 * is no commit step and no `agile-state` branch — the event log is the
 * audit trail. Reads never mutate.
 *
 * Concurrency: one daemon process, so a plain async mutex around each
 * mutation method is enough — it only needs to serialize this process's own
 * concurrent RPC calls against each other, not guard against another
 * process (that's the daemon-wide lock file, lock.ts). All the actual file
 * work below is synchronous (*Sync fs calls), so nothing else runs on the
 * single JS thread while a mutation is mid-flight anyway; the mutex exists
 * so a caller can safely fire mutations concurrently (e.g. two RPC requests
 * racing) without reasoning about interleaving, and so a slower future
 * implementation (real async I/O) doesn't silently reintroduce a race.
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import {
  type AgentId,
  type AgentRecord,
  type Event,
  type Policy,
  type ReposConfig,
  type Rule,
  RuleIdSchema,
  type RulePrincipal,
  type Stream,
  type StreamPrincipal,
  type ThreadEntry,
  type Ticket,
  type TicketId,
  type TicketStatus,
  UlidSchema,
  type VendorsConfig,
  type VendorsConfigInput,
  assertNoStreamCycle,
  assertRuleAcceptable,
  assertRuleWrite,
  assertStreamWrite,
  isLegalTransition,
  validateAgentRecord,
  validateEvent,
  validatePolicy,
  validateRepoEntry,
  validateReposConfig,
  validateRule,
  validateStream,
  validateThreadEntry,
  validateTicket,
  validateVendorsConfig,
} from '@agile-agents/shared';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildEvent, needsFsync } from './events';
import {
  appendJsonlLine,
  atomicWriteFile,
  ensureDir,
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

export class IllegalTransitionError extends Error {
  constructor(
    public readonly ticket: TicketId,
    public readonly from: TicketStatus,
    public readonly to: TicketStatus,
  ) {
    super(`illegal transition for ${ticket}: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

/**
 * A create that collides with an existing record. Typed so the RPC edge can
 * report it as `invalid params` (-32602) rather than an internal error
 * (T126): a duplicate id is caller input, not a daemon fault.
 */
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

export interface TransitionOptions {
  by: string;
  reason?: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `history` line format (§4 "Ticket" shows two examples — "created by
 * architect", "assigned to eng-3 (claude/sonnet)" — with no grammar beyond
 * that). DESIGN-GAP: a single grammar covering every transition is used
 * here, since `transitionTicket` is generic across the whole edge table:
 * `<date> <from> -> <to> by <agent>[ — <reason>]`.
 */
function formatHistoryLine(
  from: TicketStatus,
  to: TicketStatus,
  by: string,
  reason?: string,
): string {
  const base = `${todayIso()} ${from} -> ${to} by ${by}`;
  return reason ? `${base} — ${reason}` : base;
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

/**
 * The state every stream event carries in `data` (T123, cockpit design
 * §7.4): the status pair *after* the mutation plus the archived flag, which
 * is exactly what `reconstructStreams` needs to rebuild every stream's
 * state from `log/events.jsonl` alone.
 */
function streamStateData(stream: Stream): Record<string, unknown> {
  return {
    agent_status: stream.agent.status,
    human_status: stream.human.status,
    archived: stream.archived === true,
  };
}

/**
 * What every rule event carries in `data` (T140, §7.4): the id, the state
 * a reader needs to follow a rule's life (`status`, `enforcement`, the
 * rendered scope) and the principal that wrote it. A rule is not
 * stream-scoped in general (a global rule belongs to none), so the event's
 * `stream` scope is set only for a stream-scoped rule.
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

/** The pieces one mutation needs: its return value, the paths it touched, and its one Event. */
interface MutationResult<T> {
  result: T;
  relPaths: string[];
  event: Event;
}

/**
 * T111: the state home (`AGILE_HOME`, default `~/.agile/`) is a plain
 * directory of YAML/JSONL files, not a git worktree. The orphan
 * `agile-state` branch and the per-mutation commit that went with it are
 * gone, so a "deferred commit" has nothing left to defer: every write lands
 * on disk immediately, and `log/events.jsonl` is the audit trail.
 * `appendEvent`'s `{commit}` option is accepted and ignored.
 */
/** CLAUDE.md tunable: "heartbeat 30 s" — `StateStore.heartbeat`'s coalescing window. */
export const HEARTBEAT_COALESCE_MS = 30 * 1000;

export class StateStore {
  private readonly mutex = new Mutex();
  private closed = false;

  // Round 5 review (opus) B1: an absolute symlink target is walked from the
  // filesystem root and checked for containment against `stateRoot`'s
  // *literal* text — but when the state root is itself reached through a
  // symlinked ancestor directory (macOS `tmpdir()` under `/var ->
  // /private/var`, or any operator layout with a linked parent), the walk
  // legitimately resolves through that ancestor to the *real* directory,
  // which no longer shares the literal prefix. Cached once here (the
  // directory is required to exist by `open()`'s `existsSync` check, so
  // `realpathSync` is safe) so `resolveComponentSymlink` can accept
  // containment against either form — see its own doc comment.
  private readonly realStateRoot: string;

  private constructor(private readonly stateRoot: string) {
    this.realStateRoot = realpathSync(stateRoot);
  }

  /** Marks this store closed. Kept as a lifecycle hook for callers (daemon shutdown, test teardown); nothing is buffered any more. */
  close(): void {
    this.closed = true;
  }

  static open(stateRoot: string): StateStore {
    if (!existsSync(stateRoot)) {
      throw new Error(`StateStore.open: ${stateRoot} does not exist (run \`agile init\` first)`);
    }
    // Review B4: clean up anything a prior crash left mid-write before any
    // listX call can trip over it.
    sweepStaleTempFiles(stateRoot);
    return new StateStore(stateRoot);
  }

  /**
   * T025 review round 1 (blocker 1): every caller of `abs()` was trusted to
   * have already validated its own path-derived segments (most do, via a
   * schema like `TicketIdSchema`/`OracleIdSchema` before ever reaching
   * here) — but `abs()` itself had no containment guard, so a single
   * missed validation anywhere (present and future) turns into an
   * arbitrary read/write/delete under `.agile/`'s *parent*, not just
   * inside it. `join()` alone does not stop this: `join(root, '..',
   * '..', 'x')` normalizes to a path outside `root` without error.
   * Resolve to an absolute path and require it to be `stateRoot` itself or
   * a descendant of it (`stateRoot + sep` prefix, not a bare `startsWith`,
   * so a sibling directory that merely shares the same string prefix —
   * `state-root-evil` next to `state-root` — cannot pass by accident).
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
   * T032 follow-up to the lexical guard above: `resolve()` never touches the
   * filesystem, so it stops `..` traversal in *caller-supplied* segments but
   * not a symlink planted *inside* the state root that points outside it —
   * the lexical path still reads as contained, and then the real fs call
   * (read/write/unlink) follows the link off the state root. Three review
   * rounds progressively closed this (see `.pipeline-review.md` for the
   * full history — dangling targets, then a leaf link's escaping *ancestor*
   * directory, both needed `lstatSync`, not `existsSync`/a single
   * multi-component resolve); this version additionally never lexically
   * `normalize()`s a symlink's own target text, for the reason below.
   *
   * Round 3 review (opus) found that computing a hop's target via
   * `normalize(rawTarget)` collapses `..` *before* the containment check
   * and before the target is decomposed into components to walk — so
   * `.agile/esc -> <outside>/sub` plus a leaf `-> "<stateRoot>/esc/../pwned.jsonl"`
   * normalizes straight to `<stateRoot>/pwned.jsonl` (lexically fine) and
   * the `esc` segment — the actual escaping symlink — is never `lstat`ed at
   * all, because `normalize` already erased it before the walk began. The
   * kernel does not resolve paths this way: it resolves `esc` *first*
   * (following the link to `<outside>/sub`) and only then applies `..`,
   * landing in `<outside>`, not back inside the root.
   *
   * Fixed by never handing a symlink's raw `readlinkSync` output to
   * `normalize()`/`relative()`: `walkSegments` takes each `/`-separated raw
   * segment in order and threads `current` through them itself — a plain
   * segment is `join`ed on and passed to `resolveComponentSymlink` (which
   * may hop it elsewhere, checking containment immediately, before any
   * later segment is even looked at); a `..` segment pops one component off
   * `current` **as currently resolved** (i.e. after any symlink hop already
   * applied to it), exactly mirroring kernel resolution order, never a bulk
   * textual collapse; `.` and empty segments (a leading/trailing/doubled
   * separator) are skipped. An escaping directory link is therefore refused
   * the moment `resolveComponentSymlink` reaches it, before any trailing
   * `..` in the same target string could lexically "cancel" it back to
   * looking contained. `resolveComponentSymlink` uses this same walk for a
   * hop's target (absolute targets walk from the filesystem root; relative
   * targets walk from the symlink's own — already resolved — directory), so
   * the fix applies uniformly to both forms and to arbitrarily nested
   * chains. The shared `budget` still bounds the total hop count
   * (`MAX_SYMLINK_HOPS`) so a cycle or a long chain terminates rather than
   * looping.
   *
   * TOCTOU residual (documented, not closed — round 2 B2): this guard runs
   * once, synchronously, inside `abs()`; it holds no file descriptor and
   * re-checks nothing at the actual `readFileSync`/`appendFileSync`/
   * `writeFileSync`/`unlinkSync` call site a moment later, every one of
   * which follows symlinks itself. A component swapped for a symlink
   * *after* this check returns and *before* that syscall lands would still
   * escape. Closing that race for real would mean opening every write
   * target with `O_NOFOLLOW` or moving to an fd-relative (`openat`-style)
   * store, which doesn't fit the current atomic-rename write helpers
   * (`fs.ts`'s `writeYamlFileAtomic`/`atomicWriteFile` write a temp file
   * then `rename` it over the target — the target itself is never opened
   * for write) without a broader rework. Accepted as out of scope for this
   * ticket: the prerequisite is a second, concurrent, in-process-or-sibling
   * actor able to write inside `.agile/` at the exact instant between this
   * check and the next fs call — the same "a local writer already has a
   * foothold inside the state root" threat model this whole guard exists
   * for, not a new one. A future ticket that wants the race closed should
   * look at `fs.ts`'s write helpers first.
   */
  private assertNoEscapingSymlink(resolved: string, root: string, parts: string[]): void {
    // `resolved` was produced by `resolve(this.stateRoot, ...parts)` in
    // `abs()` — a lexical normalization of *code-controlled* segments
    // (ticket ids, `'board'`, `'halts'`, ...) that has already passed the
    // plain containment check there, so it can never itself carry a `..`
    // that still needs kernel-order (post-symlink) handling. That hazard is
    // specific to a *symlink's own* `readlinkSync` text (see
    // `resolveComponentSymlink`), not to this top-level entry.
    const rel = relative(root, resolved);
    // Round 5 nit N3: explicit here (not just relied on as a side effect of
    // `walkSegments`'s own `''`/`'.'` skip) so the invariant is local to
    // whichever function computes the segment list, not just to whichever
    // happens to consume it today.
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
   * Walks `segments` one raw path component at a time starting from
   * `baseDir`, resolving any symlink hop along the way (`resolveComponentSymlink`)
   * and popping `..` off the path *as currently resolved* rather than
   * collapsing it lexically ahead of time (round 3 B1 — see this class's
   * doc comment above `assertNoEscapingSymlink`). `.` and empty segments are
   * skipped. Returns the final resolved location (existing or not).
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
   * If `path` is a symlink (dangling or not), resolves one hop by walking
   * its *raw* `readlinkSync` target with `walkSegments` — never
   * `normalize()`d first, so a `..` in the target is applied against the
   * hop's actually-resolved position, not lexically erased before an
   * escaping component in the same target is ever examined (round 3 B1).
   * An absolute target walks from the filesystem root; a relative one walks
   * from `path`'s own (already-resolved) directory. Checks the fully
   * resolved hop target for containment before returning it. Returns `path`
   * unchanged when it isn't a symlink, or doesn't exist yet.
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
      // Round 2 nit N1: only a missing component (`ENOENT`, or `ENOTDIR`
      // when an earlier segment we already resolved turned out not to be a
      // directory after all) means "nothing to resolve here" — anything
      // else (`EACCES`, `ELOOP`, a NUL byte's `ERR_INVALID_ARG_VALUE`, ...)
      // is a real filesystem error the caller's own subsequent read/write
      // is about to hit too, and swallowing it here would just relabel a
      // permissions/encoding problem as an ordinary "not created yet" path.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return path;
      throw err;
    }
    if (!stat.isSymbolicLink()) return path;

    budget.hops += 1;
    if (budget.hops > StateStore.MAX_SYMLINK_HOPS) {
      // Round 2 nit N2: this cap catches a genuine escape chain and a pure
      // symlink *cycle* alike (e.g. a<->b, neither ever escaping on its
      // own) — refusing either way is correct, but "too deep" undersells
      // the cycle case, so the message names both.
      throw new Error(
        `state path escapes the state root (symlink chain exceeded ${StateStore.MAX_SYMLINK_HOPS} hops — a link cycle or a genuine escape): ${parts.join('/')}`,
      );
    }

    const rawTarget = readlinkSync(path);
    let baseDir: string;
    let rawSegments: string[];
    if (isAbsolute(rawTarget)) {
      // Round 5 B1: an absolute target is walked the way a kernel would —
      // but blindly starting every absolute walk at the filesystem root
      // means `lstat`ing `root`'s own ancestry, and a state root reached
      // through a symlinked ancestor directory (macOS `tmpdir()` under
      // `/var -> /private/var`, or any linked parent) then resolves that
      // ancestor to its real location, which no longer shares `root`'s
      // *literal* prefix — a plainly inside-root absolute target (built,
      // as ordinary code does, from the literal `stateRoot` string) was
      // false-refused. Fixed by first checking whether the raw target
      // itself already names `root` (its usual literal text) or
      // `realStateRoot` (root's cached real path) as a prefix — the common
      // case for any absolute target actually meant to land inside this
      // store — and, if so, walking only the remainder from that root form
      // directly, never touching root's own ancestry at all (exactly like
      // the relative-target branch below). A target like
      // `"<root>/esc/../pwned.jsonl"` still has `root` as its prefix, so
      // the remainder walked is `["esc", "..", "pwned.jsonl"]` from `root`
      // — `esc` is still an ordinary segment of that walk and still gets
      // `lstat`ed. Only a target naming *neither* root form at all falls
      // back to a full filesystem-root walk (kernel-accurate, and — since
      // such a target does not even claim to be inside this store — the
      // rare residual risk of an unrelated ancestor symlink elsewhere on
      // disk tripping the per-hop check is accepted, the same way other
      // out-of-scope TOCTOU-class residuals are documented rather than
      // chased to full generality).
      if (this.isContainedIn(rawTarget, root)) {
        baseDir = root;
        rawSegments = rawTarget.slice(root.length).split(sep);
      } else if (this.isContainedIn(rawTarget, this.realStateRoot)) {
        baseDir = this.realStateRoot;
        rawSegments = rawTarget.slice(this.realStateRoot.length).split(sep);
      } else {
        baseDir = parse(root).root;
        // Round 5 nit N1: split on the platform separator only — a
        // backslash is an ordinary filename character on POSIX, not a path
        // separator, so treating it as one (the round 3/4 `/[\\/]/` regex)
        // would mis-split a target that legitimately contains one.
        rawSegments = rawTarget.split(sep);
      }
    } else {
      // Relative target: resolved against `path`'s own directory, which is
      // already a fully resolved location by the time we get here (every
      // earlier component on the way to `path` has already been through
      // this same function).
      baseDir = dirname(path);
      rawSegments = rawTarget.split(sep);
    }

    const nextTarget = this.walkSegments(baseDir, rawSegments, root, parts, budget);

    // Round 5 B1: accept containment against either root form — `nextTarget`
    // is already fully symlink-resolved by `walkSegments`, so comparing it
    // to `realStateRoot` is exactly as safe as comparing it to the literal
    // `root`, and is what makes the shortcut above (and the fallback
    // filesystem-root walk, which may legitimately land inside the real
    // root without ever mentioning its literal text) correct.
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

  /** Appends `event`'s line to `log/events.jsonl`. Synchronous — callers already hold the mutex. */
  private deferEventSync(event: Event, _extraRelPaths: string[] = []): void {
    this.writeEventLine(event);
  }

  /** Appends `event` to `log/events.jsonl` — the home's audit trail (T111: no commit, the home is not a git worktree). */
  private commitEvent(_relPaths: string[], event: Event): void {
    this.writeEventLine(validateEvent(event));
  }

  /**
   * The one writer of `log/events.jsonl` (§7.4: "append-only, one writer").
   * Gate and land events are fsynced — see `needsFsync` in `events.ts`.
   */
  private writeEventLine(event: Event): void {
    appendJsonlLine(this.abs(join('log', 'events.jsonl')), event, {
      fsync: needsFsync(event.kind),
    });
  }

  /** Runs one mutation under the mutex: `fn` does the validated file write(s) and builds its one Event; this commits it. */
  private mutate<T>(fn: () => MutationResult<T>): Promise<T> {
    return this.mutex.run(() => {
      const { result, relPaths, event } = fn();
      this.commitEvent(relPaths, event);
      return result;
    });
  }

  /**
   * Drains in-flight mutations. Every write is already on disk (T111: no
   * deferred commit), so this only waits for the mutex to go idle — kept
   * because `daemon.ts` and tests call it as their deterministic
   * "everything has landed" point.
   */
  async flush(): Promise<void> {
    return this.mutex.run(() => {});
  }

  /**
   * Public escape hatch for the two named event sources T005 doesn't itself
   * produce (review fix, manager decision B1): `message` (T006's bus) and
   * `hook_decision` (T008/T009's hook endpoint) go through this instead of
   * re-implementing append+commit outside the store (which CLAUDE.md's
   * "written only through the daemon's validating store" forbids).
   *
   * `{commit: 'deferred'}` (T009 review round, hot-path decision): appends
   * the event line immediately but batches the commit — see the file's
   * "Deferred-commit batching" header comment. Every other caller keeps the
   * original one-event-one-commit behaviour (`commit: 'immediate'`, the
   * default).
   */
  async appendEvent(
    event: Event,
    options: { commit?: 'immediate' | 'deferred' } = {},
  ): Promise<Event> {
    if (options.commit === 'deferred') {
      return this.mutex.run(() => {
        const validated = validateEvent(event);
        this.deferEventSync(validated);
        return validated;
      });
    }
    return this.mutex.run(() => {
      const validated = validateEvent(event);
      this.commitEvent([], validated);
      return validated;
    });
  }

  /** Read-only: the full `log/events.jsonl` audit stream. */
  listEvents(): Event[] {
    return readJsonlFile<unknown>(this.abs('log', 'events.jsonl')).map((line) =>
      validateEvent(line),
    );
  }

  // ---------------------------------------------------------------- Ticket

  getTicket(id: TicketId): Ticket {
    const path = this.abs('tickets', `${id}.yaml`);
    if (!fileExists(path)) throw new NotFoundError('Ticket', id);
    return validateTicket(readYamlFile(path));
  }

  listTickets(): Ticket[] {
    const dir = this.abs('tickets');
    return listDataFiles(dir, '.yaml').map((name) => validateTicket(readYamlFile(join(dir, name))));
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
      return { result: validated, relPaths: [relPath], event };
    });
  }

  /**
   * Heartbeat write, deferred-commit + coalesced (T009 review round, hot-path
   * decision): the pre-tool-use hook calls this on every tool call, so two
   * things keep it cheap — (1) the write is deferred (see the file's
   * "Deferred-commit batching" header), and (2) CLAUDE.md's 30s heartbeat
   * tunable means a `last_seen` less than `HEARTBEAT_COALESCE_MS` old with no
   * ticket reassignment pending is a pure no-op: no file write, no event,
   * nothing queued — the existing record is returned unchanged. The only
   * fields it may touch are `last_seen` and `stream`; every other field is
   * carried over from the record on disk verbatim (T012 round 4: a rebuilt
   * record silently dropped `role`/`worktree` and decayed a live session's
   * hook policy mid-run).
   *
   * Round 4 (QA round 3 REJECT — a real regression, not a test-harness
   * artifact): this used to reconstruct the WHOLE `AgentRecord` from only
   * `vendor`/`model`/`ticket`/`pid` on every write past the coalescing
   * window, silently dropping `role`/`worktree`/`session_id` — fields this
   * method's own patch never carried, and `hook/service.ts`'s `buildContext`
   * calls this on *every* PreToolUse hook call with nothing but `{ ticket }`.
   * A live reviewer or QA session making one tool call roughly every 30+
   * seconds (entirely normal) would silently lose `role` after its first
   * heartbeat past the window, decaying to `resolveAgentByCwd`'s
   * `role ?? 'engineer'` fallback — a reviewer editing its own worktree
   * unchallenged is exactly the tier-1 gate round 3 just finished proving
   * real. Fixed at the root, per the QA finding, so it cannot recur from any
   * caller: this method now ONLY ever touches `last_seen` and (if given)
   * `ticket` — every other field is carried over from the existing record
   * verbatim, never reconstructed — and heartbeating an agent with no
   * existing record is treated as a caller bug (`getAgent` throws
   * `NotFoundError`), not a silent "create a blank one". A record must be
   * registered via `putAgent` first; `Bus.heartbeat` is the one place that
   * still creates a minimal record on an agent's true first heartbeat, and
   * delegates to this method for every heartbeat after that (see its own
   * doc comment).
   */
  async heartbeat(
    id: AgentId,
    patch: { stream?: string } = {},
    now: () => Date = () => new Date(),
  ): Promise<AgentRecord> {
    return this.mutex.run(() => {
      // Throws `NotFoundError` if `id` isn't registered — deliberate, see
      // this method's doc comment: heartbeating an unregistered agent is a
      // bug at the call site, never a reason to fabricate a fresh record.
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

      // Every field carries over from `existing` verbatim except the two
      // this method is actually allowed to touch — this is the fix: never
      // reconstruct the record from a patch, only ever patch it.
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
      this.deferEventSync(event, [relPath]);
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
   * T044: the `agent_deleted` event carries the record that was removed
   * (`vendor`/`model`/`role`/`ticket`). §17 v2's Team table "keeps finished
   * agents ...", and a session's exit path
   * (`runner/session.ts`'s `finish()`) *deletes* the registry file — so
   * after a departure the only remaining trace of who that agent was, and
   * on what model, is this line in `log/events.jsonl`. `AgentRecord` itself
   * gains no `left_at`/status field for it: nothing survives to carry one,
   * and the event already has the timestamp. Same shape as `heartbeat`'s
   * own `data: {heartbeat: true}` — the payload is free-form
   * (`EventSchema.data`) and this is the one writer of these fields.
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
      return { result: undefined, relPaths: [relPath], event };
    });
  }

  // -------------------------------------------------------- Policy/Vendors

  getPolicy(): Policy {
    const path = this.abs('policy.yaml');
    if (!fileExists(path)) throw new NotFoundError('Policy', 'policy.yaml');
    return validatePolicy(readYamlFile(path));
  }

  /**
   * T043: `options.by` records who changed the gates block, the same way
   * `putTicket` records who moved a ticket — the control room's Settings
   * screen writes `human`. Optional, so every pre-T043 caller keeps minting
   * an actor-less `policy_put`.
   */
  async putPolicy(policy: Policy, options: { by?: string } = {}): Promise<Policy> {
    return this.mutate(() => {
      const validated = validatePolicy(policy);
      const relPath = 'policy.yaml';
      writeYamlFileAtomic(this.abs(relPath), validated);
      const event = buildEvent('policy_put', { agent: options.by, data: {} });
      return { result: validated, relPaths: [relPath], event };
    });
  }

  getVendors(): VendorsConfig {
    const path = this.abs('vendors.yaml');
    if (!fileExists(path)) throw new NotFoundError('VendorsConfig', 'vendors.yaml');
    return validateVendorsConfig(readYamlFile(path));
  }

  async putVendors(vendors: VendorsConfigInput): Promise<VendorsConfig> {
    return this.mutate(() => {
      const validated = validateVendorsConfig(vendors);
      const relPath = 'vendors.yaml';
      writeYamlFileAtomic(this.abs(relPath), validated);
      const event = buildEvent('vendors_put');
      return { result: validated, relPaths: [relPath], event };
    });
  }

  // ---------------------------------------------------------- Repo registry

  /**
   * `repos.yaml` in the state home (PLAN.md §5, D9): the repos this one
   * daemon serves. Absent file = no repos registered yet, which is a normal
   * state for a fresh home, so this returns `{}` rather than throwing.
   */
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
      return { result: validated, relPaths: [relPath], event };
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
   * T120 (cockpit design §2, §7.2): `streams/<id>.yaml` is the stream
   * record and `threads/<id>.jsonl` its append-only thread. Same shape as
   * the repo registry above — home-relative paths through `abs()`,
   * validated on every read, one event per mutation — plus the two checks
   * that are structural rather than schema-level: the two-writer split
   * (`assertStreamWrite`, D11) and the parent-cycle check
   * (`assertNoStreamCycle`, D1). Both live in shared as pure functions;
   * this is the one place they are applied.
   *
   * No git, ever: a stream's `branch`/`worktree` are created on first
   * attach (T130), not here, so a stream without a repo never touches a
   * repository at all.
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

  /**
   * §7.3: "A corrupt file is refused **with the path and the line number**,
   * never silently defaulted." A YAML record has no one line to blame, so
   * the path plus the validation error is the most a record read can say;
   * `readThread` below does name the line.
   */
  private readStreamFile(absPath: string): Stream {
    let raw: unknown;
    try {
      raw = readYamlFile(absPath);
    } catch (err) {
      throw new Error(
        `corrupt stream file ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      return validateStream(raw);
    } catch (err) {
      throw new Error(
        `corrupt stream file ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
      return { result: validated, relPaths: [relPath], event };
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
      return { result: after, relPaths: [relPath], event };
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
      return { result: validated, relPaths: [relPath], event };
    });
  }

  // ------------------------------------------------------------------ Rules

  /**
   * T140 (cockpit design §5): `rules/R-<ulid>.yaml`, one file per rule.
   * Same shape as the streams block above — home-relative paths through
   * `abs()`, validated on every read, one event per mutation — plus the two
   * structural checks that are not schema-level and live in shared as pure
   * functions: the principal split (`assertRuleWrite`, **D4**: agents may
   * create `proposed` only; `status`/`decided_at`/`decided_by` are
   * human-only) and the tier invariants (`assertRuleAcceptable`, §5.2/§5.6).
   * This is the one place both are applied.
   *
   * Scope *refs* are not checked here: whether a `repo` ref is in
   * `repos.yaml` and a `stream` ref is a stream in this home is
   * `RulesService`'s check, beside the rest of its input validation.
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

  /** §7.3: a corrupt record is refused with its path, never silently defaulted. */
  private readRuleFile(absPath: string): Rule {
    let raw: unknown;
    try {
      raw = readYamlFile(absPath);
    } catch (err) {
      throw new Error(
        `corrupt rule file ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      return validateRule(raw);
    } catch (err) {
      throw new Error(
        `corrupt rule file ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
        relPaths: [relPath],
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
        relPaths: [relPath],
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
   * Generic validating put/get/delete trio (review B2) for any entity with
   * no dedicated helper above — T006's `bus/inbox/**`/`bus/threads/**`
   * message files today, whatever needs one tomorrow. Serializes as yaml
   * unless `relPath` ends in `.json`. Mints a generic `entity_put`/
   * `entity_deleted` event carrying the `relPath`.
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
      return { result: validated, relPaths: [relPath], event };
    });
  }

  /**
   * Atomic multi-file put: validates every entry first, writes them all, and
   * mints exactly ONE caller-supplied event + one commit for the whole batch.
   * Used for logical operations that touch several files (a bus send fanning
   * out to N inboxes plus a thread copy) so the audit trail reads as one
   * operation, not N.
   */
  async putEntities(
    writes: Array<{ relPath: string; validator: (input: unknown) => unknown; data: unknown }>,
    event: Event,
  ): Promise<void> {
    const contained = writes.map((w) => ({ ...w, relPath: this.containedRelPath(w.relPath) }));
    return this.mutate(() => {
      const validatedEvent = validateEvent(event);
      const validated = contained.map((w) => ({ relPath: w.relPath, value: w.validator(w.data) }));
      for (const v of validated) writeEntityFile(this.abs(v.relPath), v.value);
      return {
        result: undefined,
        relPaths: validated.map((v) => v.relPath),
        event: validatedEvent,
      };
    });
  }

  /**
   * Prose documents (T042): `oracle/product.md` — the one file in the §4
   * layout that is neither a validated entity nor an oracle entry with
   * frontmatter, and which the Plan screen's Brief pane reads and writes.
   * Same containment check, same atomic write, same one-file-one-commit
   * `entity_put` event as `putEntity` above; the only difference is that
   * the payload is markdown text rather than a serialized object, so there
   * is nothing to validate beyond "it is a string".
   */
  async putDoc(
    rawRelPath: string,
    content: string,
    options: { by?: string } = {},
  ): Promise<string> {
    const relPath = this.containedRelPath(rawRelPath);
    if (typeof content !== 'string') throw new Error('putDoc: content must be a string');
    return this.mutate(() => {
      atomicWriteFile(this.abs(relPath), content);
      const event = buildEvent('entity_put', {
        ...(options.by !== undefined ? { agent: options.by } : {}),
        data: { relPath },
      });
      return { result: content, relPaths: [relPath], event };
    });
  }

  /** Reads a prose document written by `putDoc` (or by `agile init`). Throws `NotFoundError` when the file is missing, like every other getter. */
  getDoc(rawRelPath: string): string {
    const relPath = this.containedRelPath(rawRelPath);
    const path = this.abs(relPath);
    if (!fileExists(path)) throw new NotFoundError('Doc', relPath);
    return readFileSync(path, 'utf8');
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
      return { result: undefined, relPaths: [relPath], event };
    });
  }

  /**
   * Read-only: every entity file directly inside `rawRelDir` (`.yaml` and
   * `.json`, same hidden/temp-file filter as every other store `listX`, see
   * `fs.ts`'s `listDataFiles`), validated. Companion to the generic entity
   * trio above for a caller (e.g. `GateService`) that needs to enumerate a
   * whole directory of generically-stored entities rather than reading them
   * one id at a time. A missing directory returns `[]`, same as every other
   * `listX` on an empty/uninitialized collection.
   */
  listEntities<T>(rawRelDir: string, validator: (input: unknown) => T): T[] {
    const relDir = this.containedRelPath(rawRelDir);
    const dirAbs = this.abs(relDir);
    const names = [...listDataFiles(dirAbs, '.yaml'), ...listDataFiles(dirAbs, '.json')];
    return names.map((name) => validator(readEntityFile(this.abs(relDir, name))));
  }
}

function readEntityFileRaw(path: string): string {
  return readFileSync(path, 'utf8');
}

function isTicketIdLike(value: string): boolean {
  return /^TKT-\d{4,}$/.test(value);
}
