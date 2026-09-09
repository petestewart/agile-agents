/**
 * `StateStore` — the validating read/write layer over `.agile/` (T005; design
 * agile-agents-design.md §4 "State model", §5 "Storage" (ordering/failure),
 * §15 "Git model and teams").
 *
 * Every write: validate with the shared zod schema first (so a failing
 * validation touches no file), then an atomic file write (fs.ts), then one
 * git commit on the `agile-state` worktree batching every file that one
 * logical operation touched, plus the one `Event` line that operation mints
 * in `log/events.jsonl` (git.ts) — the commit message is that event's
 * `kind`, so the commit log and the event log share one vocabulary (review
 * fix, manager decision B1). Reads never mutate.
 *
 * Concurrency: one daemon process per repo (§15), so a plain async mutex
 * around each mutation method is enough — it only needs to serialize this
 * process's own concurrent RPC calls against each other, not guard against
 * another process (that's the daemon-wide lock file, lock.ts). All the
 * actual file/git work below is synchronous (Bun.spawnSync, *Sync fs calls),
 * so nothing else runs on the single JS thread while a mutation is
 * mid-flight anyway; the mutex exists so a caller can safely fire mutations
 * concurrently (e.g. two RPC requests racing) without reasoning about
 * interleaving, and so a slower future implementation (real async I/O)
 * doesn't silently reintroduce a race.
 *
 * Partial-state note (review nit, documented not fully solved): every
 * mutation writes its entity file(s) first, then commits. If the commit
 * step throws (see git.ts's header), the write already landed on disk (and
 * in `log/events.jsonl`) ahead of `agile-state`'s committed history — the
 * error surfaces to the caller rather than being swallowed, but no
 * automatic rollback of the just-written bytes is implemented.
 */

import { appendFileSync, existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import {
  type AgentId,
  type AgentRecord,
  type Event,
  type Halt,
  type HaltId,
  type KbFact,
  type KbId,
  type KbIndex,
  type LedgerLine,
  type OracleEntry,
  type OracleId,
  type OracleIndex,
  type Policy,
  type Quota,
  type Sprint,
  type SprintId,
  type Stanza,
  type Ticket,
  type TicketId,
  type TicketStatus,
  type VendorsConfig,
  type VendorsConfigInput,
  isLegalTransition,
  validateAgentRecord,
  validateEvent,
  validateHalt,
  validateKbFact,
  validateKbIndex,
  validateLedgerLine,
  validateOracleEntry,
  validateOracleIndex,
  validatePolicy,
  validateQuota,
  validateSprint,
  validateStanza,
  validateTicket,
  validateVendorsConfig,
} from '@agile-agents/shared';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildEvent, buildStateTransitionEvent } from './events';
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
import { commitPaths } from './git';

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

/**
 * `oracle/changelog.md` line format (§4 "Oracle": "gets one line per change:
 * `2026-09-07 DEC-0042 supersedes DEC-0019: <one line>`"). Generalized past
 * the one given example (a supersession) to any oracle write, since
 * `putOracleEntry` is the only writer and every write needs a line.
 * Collapses embedded newlines (review nit) so a multi-line rationale can't
 * break the file's "one line per change" contract.
 */
function formatOracleChangelogLine(entry: OracleEntry): string {
  const date = entry.decided || todayIso();
  const rationale = entry.rationale.replace(/\s*\n\s*/g, ' ').trim();
  if (entry.supersedes.length > 0) {
    return `${date} ${entry.id} supersedes ${entry.supersedes.join(', ')}: ${rationale}`;
  }
  return `${date} ${entry.id} ${entry.status}: ${rationale}`;
}

function oracleEntryRelPath(id: OracleId): string {
  const dir = id.startsWith('DEC-') ? 'decisions' : 'specs';
  return join('oracle', dir, `${id}.md`);
}

/**
 * `---\n<yaml frontmatter>---\n\n<body>` — the on-disk shape §4
 * "Oracle"/"Knowledge store" describe as markdown files with a yaml header
 * ("Body is prose ... the yaml block is the frontmatter of a markdown
 * file", oracle.ts). No frontmatter library is a repo dependency (see
 * CLAUDE.md — no new dependencies), so this is a small local parser
 * over the two-package convention (`---` delimited yaml, then body).
 */
function renderFrontmatter(frontmatter: unknown, body: string): string {
  return `---\n${stringifyYaml(frontmatter)}---\n\n${body.trimStart()}\n`;
}

function parseFrontmatter<T>(content: string): { data: T; body: string } {
  if (!content.startsWith('---\n')) {
    throw new Error('malformed frontmatter file: must start with "---\\n"');
  }
  const closeIndex = content.indexOf('\n---\n', 4);
  if (closeIndex === -1) {
    throw new Error('malformed frontmatter file: no closing "---"');
  }
  const yamlBlock = content.slice(4, closeIndex + 1);
  const body = content.slice(closeIndex + 5).replace(/^\n+/, '');
  return { data: parseYaml(yamlBlock) as T, body };
}

function readOracleIndex(path: string): OracleIndex {
  if (!fileExists(path)) return {};
  return validateOracleIndex(readYamlFile(path) ?? {});
}

function readKbIndex(path: string): KbIndex {
  if (!fileExists(path)) return {};
  return validateKbIndex(readYamlFile(path) ?? {});
}

function appendChangelogLine(path: string, line: string): void {
  ensureDir(join(path, '..'));
  if (!fileExists(path)) {
    appendFileSync(path, '# Changelog\n\n');
  }
  appendFileSync(path, `${line}\n`);
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

/** The pieces one mutation needs: its return value, the paths it touched, and its one Event. */
interface MutationResult<T> {
  result: T;
  relPaths: string[];
  event: Event;
}

/**
 * Deferred-commit batching (T009 review round, "Hot-path decision"): a
 * pre-tool-use hook call previously cost one `git commit` for its
 * `hook_decision` event and another for its heartbeat — two commits per
 * tool call is not sustainable. `appendEvent(event, {commit:'deferred'})`
 * (and `heartbeat`, below) append their line/file write immediately (so a
 * reader of `log/events.jsonl`/`bus/agents/<id>.yaml` sees it right away)
 * but queue the relative path instead of committing — a debounced timer
 * (`DEFERRED_FLUSH_MS`) batches every queued path into one commit, and any
 * *regular* (non-deferred) mutation flushes whatever is queued first, as
 * its own preceding commit, so the audit trail never silently drops a
 * deferred write behind a later one. `StateStore.flush()` (called by
 * `daemon.ts` on shutdown) flushes on demand for tests/graceful stop.
 */
const DEFERRED_FLUSH_MS = 5000;
const DEFERRED_COMMIT_MESSAGE = 'deferred_batch';
/** CLAUDE.md tunable: "heartbeat 30 s" — `StateStore.heartbeat`'s coalescing window. */
export const HEARTBEAT_COALESCE_MS = 30 * 1000;

export class StateStore {
  private readonly mutex = new Mutex();
  private readonly deferredRelPaths = new Set<string>();
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  // Review fix (T012 QA/review round): once closed, no *new* deferred-flush
  // timer is armed — see `scheduleDeferredFlush` — so a caller that has torn
  // this store down (a test's `afterEach`, a daemon shutdown) can be sure no
  // stray timer outlives it.
  private closed = false;

  private constructor(private readonly stateRoot: string) {}

  /**
   * Marks this store closed (so `scheduleDeferredFlush` becomes a no-op
   * from this point on — no *new* timer can ever be armed again) and routes
   * a flush of whatever's currently queued through the mutex, respecting
   * FIFO order with any mutation already in flight or queued ahead of it.
   *
   * Review round 3 (opus, nit from round 2 promoted to a required fix):
   * round 2 called `flushDeferredNow()` directly here, bypassing the
   * mutex — harmless in practice (the store's git work is synchronous, and
   * every real caller already `await`s `flush()` first, which itself runs
   * under the mutex and leaves it idle), but it was the one place this
   * class's own "every mutation is serialized" invariant didn't actually
   * hold. Fire-and-forget is intentional: `close()` stays a synchronous,
   * void-returning method (every call site — `daemon.ts` shutdown, both
   * runner test files' `afterEach`, `store.test.ts` — calls it bare, with
   * no `await`) so a caller that wants a *guaranteed*-drained store before
   * proceeding synchronously must call `await store.flush()` first, same as
   * before; `close()` is the belt-and-suspenders timer-cancellation/backstop
   * flush, not the primary drain path. `git.ts`'s `commitPaths` still
   * no-ops (logging, not throwing) instead of crashing if `stateRoot` is
   * gone by the time this queued flush actually runs, so a caller that
   * immediately removes the worktree right after `close()` (exactly what
   * the round-1 QA race reproduces) is still safe either way.
   */
  close(): void {
    this.closed = true;
    this.mutex
      .run(() => this.flushDeferredNow())
      .catch(() => {
        // Swallowed deliberately — same reasoning as `scheduleDeferredFlush`'s
        // own timer callback: a failed flush here has nowhere useful to
        // report to (this is teardown), and `commitPaths`'s missing-worktree
        // guard means it shouldn't normally even reject.
      });
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
   * filesystem, so it stops `..` traversal but not a symlink planted
   * *inside* the state root that points outside it (e.g.
   * `.agile/tickets/evil -> /etc`) — the lexical path still reads as
   * contained, and then the real fs call (read/write/unlink) follows the
   * link off the state root.
   *
   * Round 1 review (opus) found the first version of this guard (walk up
   * to the nearest *existing* ancestor via `existsSync`, then `realpathSync`
   * that) missed a **dangling** symlink: `existsSync` follows symlinks and
   * reports `false` for one whose target doesn't exist yet, so the walk
   * skipped straight past it to its legitimate parent and let the write
   * through — `appendJsonlLine`/`appendFileSync`-style creates then follow
   * the link and land outside the root with no error.
   *
   * Fixed by walking every path *component* from `root` down to `resolved`
   * with `lstatSync` (which reports a symlink as a symlink whether or not
   * its target exists — the fix `existsSync` couldn't do) and, at each
   * symlink hop (dangling or not, following chains), resolving its raw
   * `readlinkSync` target and checking *that* for containment before
   * continuing the walk from there. A component that doesn't exist at all
   * (`lstatSync` throws) ends the walk early — nothing under a
   * not-yet-created path can itself be a pre-planted symlink, so the
   * ordinary not-yet-existing-file case (`putTicket` to a fresh id, a new
   * board/ledger file, ...) passes straight through with no filesystem
   * surprises.
   */
  private assertNoEscapingSymlink(resolved: string, root: string, parts: string[]): void {
    const rel = relative(root, resolved);
    const segments = rel === '' ? [] : rel.split(sep).filter((seg) => seg.length > 0);
    let current = root;
    for (const seg of segments) {
      current = join(current, seg);
      current = this.followSymlinkChain(current, root, parts);
    }
  }

  /**
   * Resolves `path` if it is a symlink (or a chain of them), checking
   * containment against `root` at every hop, dangling or not. Returns the
   * final location (existing or not) so the caller can keep walking
   * subsequent path components from there — a symlinked *directory*
   * component must have its own children checked against where it actually
   * points, not where it lexically sits.
   */
  private followSymlinkChain(path: string, root: string, parts: string[]): string {
    let current = path;
    for (let hop = 0; hop < 40; hop++) {
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(current);
      } catch {
        return current; // doesn't exist (yet) — nothing left to resolve
      }
      if (!stat.isSymbolicLink()) return current;
      const rawTarget = readlinkSync(current);
      const nextTarget = isAbsolute(rawTarget)
        ? normalize(rawTarget)
        : normalize(join(dirname(current), rawTarget));
      if (nextTarget !== root && !nextTarget.startsWith(root + sep)) {
        throw new Error(`state path escapes the state root (symlink): ${parts.join('/')}`);
      }
      current = nextTarget;
    }
    throw new Error(
      `state path escapes the state root (symlink chain too deep): ${parts.join('/')}`,
    );
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

  /** Commits whatever deferred paths are queued (if any) as one commit, and clears the queue/timer. Synchronous — callers already hold the mutex. */
  private flushDeferredNow(): void {
    if (this.deferredTimer !== null) {
      clearTimeout(this.deferredTimer);
      this.deferredTimer = null;
    }
    if (this.deferredRelPaths.size === 0) return;
    const paths = [...this.deferredRelPaths];
    this.deferredRelPaths.clear();
    commitPaths(this.stateRoot, paths, DEFERRED_COMMIT_MESSAGE);
  }

  /** Arms the debounce timer (if not already armed) to flush queued deferred paths after `DEFERRED_FLUSH_MS`. `unref`d so it never keeps the process alive on its own. No-op once `close()` has been called (see its doc comment). */
  private scheduleDeferredFlush(): void {
    if (this.closed || this.deferredTimer !== null) return;
    const timer = setTimeout(() => {
      this.mutex.run(() => this.flushDeferredNow()).catch(() => {});
    }, DEFERRED_FLUSH_MS);
    timer.unref?.();
    this.deferredTimer = timer;
  }

  /** Appends `event`'s line to `log/events.jsonl` immediately and queues the path for the next flush — no commit yet. Synchronous — callers already hold the mutex. */
  private deferEventSync(event: Event, extraRelPaths: string[] = []): void {
    const eventsRel = join('log', 'events.jsonl');
    appendJsonlLine(this.abs(eventsRel), event);
    this.deferredRelPaths.add(eventsRel);
    for (const p of extraRelPaths) this.deferredRelPaths.add(p);
    this.scheduleDeferredFlush();
  }

  /** Appends `event` to `log/events.jsonl` and commits `relPaths` (plus that file) with message = event.kind — flushing any pending deferred paths first (as their own preceding commit), so a batched write is never silently absorbed into an unrelated commit message. */
  private commitEvent(relPaths: string[], event: Event): void {
    this.flushDeferredNow();
    const validated = validateEvent(event);
    const eventsRel = join('log', 'events.jsonl');
    appendJsonlLine(this.abs(eventsRel), validated);
    const paths = relPaths.includes(eventsRel) ? relPaths : [...relPaths, eventsRel];
    commitPaths(this.stateRoot, paths, validated.kind);
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
   * Flushes any pending deferred writes into one commit right now. Called by
   * `daemon.ts` on graceful shutdown (so a deferred hook_decision/heartbeat
   * batch is never lost) and by tests that want a deterministic flush point
   * instead of waiting `DEFERRED_FLUSH_MS`.
   */
  async flush(): Promise<void> {
    return this.mutex.run(() => this.flushDeferredNow());
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

  /**
   * Creates or wholesale-replaces a ticket file. Used to seed tickets (there
   * is no `assign`/`create` ceremony in T005's scope) — unlike
   * `transitionTicket`, this does not check `isLegalTransition` (there is no
   * "from" state the first time). Mints a `ticket_put` event (review B1).
   */
  async putTicket(ticket: Ticket, options: { by?: string } = {}): Promise<Ticket> {
    return this.mutate(() => {
      const validated = validateTicket(ticket);
      const relPath = join('tickets', `${validated.id}.yaml`);
      writeYamlFileAtomic(this.abs(relPath), validated);
      const event = buildEvent('ticket_put', { ticket: validated.id, agent: options.by, data: {} });
      return { result: validated, relPaths: [relPath], event };
    });
  }

  /**
   * The only ticket status mutator. Checks `isLegalTransition` *before*
   * touching any file (so an illegal transition throws with nothing written,
   * committed, or logged — T005 acceptance criterion), appends one
   * `history` line, and emits exactly one `state_transition` event to
   * `log/events.jsonl` — both files land in one commit whose message is
   * that event's `kind` ("state_transition" for every transition, so
   * `git log --format=%s` reproduces the kind sequence — T005's
   * property-test / audit-trail requirement).
   *
   * Review fix (B5): no longer mirrors the event onto
   * `board/status/<ticket>.jsonl` — that file holds only agent-written
   * `Stanza`s (§4 "Board"); the ticket's transition history lives in
   * `log/events.jsonl` (filterable by `ticket`) and in `Ticket.history`.
   */
  async transitionTicket(
    id: TicketId,
    to: TicketStatus,
    options: TransitionOptions,
  ): Promise<Ticket> {
    return this.mutate(() => {
      const current = this.getTicket(id);
      if (!isLegalTransition(current.status, to)) {
        throw new IllegalTransitionError(id, current.status, to);
      }

      const updated = validateTicket({
        ...current,
        status: to,
        history: [
          ...current.history,
          formatHistoryLine(current.status, to, options.by, options.reason),
        ],
      });

      const event = buildStateTransitionEvent({
        ticket: id,
        agent: options.by,
        from: current.status,
        to,
        reason: options.reason,
      });

      const ticketRel = join('tickets', `${id}.yaml`);
      writeYamlFileAtomic(this.abs(ticketRel), updated);

      return { result: updated, relPaths: [ticketRel], event };
    });
  }

  // ----------------------------------------------------------------- Board

  /**
   * Appends an agent-written checkpoint stanza (§4 "Board") — the *only*
   * line shape `board/status/<ticket>.jsonl` holds (review B5; ticket
   * transitions no longer mirror there, see `transitionTicket`). Mints one
   * `stanza_appended` event.
   */
  async appendStanza(input: Stanza): Promise<Stanza> {
    return this.mutate(() => {
      const stanza = validateStanza(input);
      const boardRel = join('board', 'status', `${stanza.ticket}.jsonl`);
      appendJsonlLine(this.abs(boardRel), stanza);
      const event = buildEvent('stanza_appended', {
        ticket: stanza.ticket,
        agent: stanza.agent,
        data: { kind: stanza.kind },
      });
      return { result: stanza, relPaths: [boardRel], event };
    });
  }

  /** Every raw line in a ticket's board file, unvalidated (diagnostics only — prefer `listStanzas`). */
  listBoardRaw(ticket: TicketId): unknown[] {
    return readJsonlFile(this.abs('board', 'status', `${ticket}.jsonl`));
  }

  /**
   * Every stanza in a ticket's board file, validated. Review fix (B5): a
   * line that fails to parse as a `Stanza` is no longer silently dropped —
   * this throws, naming the file and the 1-based line number, so a
   * schema-drifted or corrupted line surfaces instead of vanishing.
   */
  listStanzas(ticket: TicketId): Stanza[] {
    const relPath = join('board', 'status', `${ticket}.jsonl`);
    return this.listBoardRaw(ticket).map((line, index) => {
      try {
        return validateStanza(line);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`malformed stanza in ${relPath} at line ${index + 1}: ${message}`);
      }
    });
  }

  // --------------------------------------------------------------- Oracle

  /**
   * Writes the entry's markdown file (frontmatter + body), then updates
   * `oracle/index.yaml` ("active only" — §4: an entry whose `status` is no
   * longer `active` is *removed* from the index here, not merely updated,
   * matching "Superseded files ... drop out of index.yaml") and appends one
   * `oracle/changelog.md` line. All three files land in one commit along
   * with the one `oracle_put` event this mints (review B1).
   */
  async putOracleEntry(entry: OracleEntry, body: string): Promise<OracleEntry> {
    return this.mutate(() => {
      const validated = validateOracleEntry(entry);
      const entryRel = oracleEntryRelPath(validated.id);
      const indexRel = join('oracle', 'index.yaml');
      const changelogRel = join('oracle', 'changelog.md');

      atomicWriteFile(this.abs(entryRel), renderFrontmatter(validated, body));

      const index = readOracleIndex(this.abs(indexRel));
      if (validated.status === 'active') {
        index[validated.id] = {
          title: validated.title,
          status: validated.status,
          supersedes: validated.supersedes,
          depends: validated.depends,
        };
      } else {
        delete index[validated.id];
      }
      writeYamlFileAtomic(this.abs(indexRel), validateOracleIndex(index));

      appendChangelogLine(this.abs(changelogRel), formatOracleChangelogLine(validated));

      const event = buildEvent('oracle_put', {
        agent: validated.by,
        data: { id: validated.id, status: validated.status },
      });
      return { result: validated, relPaths: [entryRel, indexRel, changelogRel], event };
    });
  }

  getOracleEntry(id: OracleId): { entry: OracleEntry; body: string } {
    const path = this.abs(oracleEntryRelPath(id));
    if (!fileExists(path)) throw new NotFoundError('OracleEntry', id);
    const parsed = parseFrontmatter<unknown>(readEntityFileRaw(path));
    return { entry: validateOracleEntry(parsed.data), body: parsed.body };
  }

  listOracleIndex(): OracleIndex {
    return readOracleIndex(this.abs('oracle', 'index.yaml'));
  }

  // ----------------------------------------------------------------- KB

  async putKbFact(fact: KbFact, body: string): Promise<KbFact> {
    return this.mutate(() => {
      const validated = validateKbFact(fact);
      const factRel = join('knowledge', 'facts', `${validated.id}.md`);
      const indexRel = join('knowledge', 'index.yaml');

      atomicWriteFile(this.abs(factRel), renderFrontmatter(validated, body));

      const index = readKbIndex(this.abs(indexRel));
      index[validated.id] = {
        kind: validated.kind,
        scope: validated.scope,
        confidence: validated.confidence,
        expires: validated.expires,
      };
      writeYamlFileAtomic(this.abs(indexRel), validateKbIndex(index));

      const event = buildEvent('kb_put', { data: { id: validated.id, kind: validated.kind } });
      return { result: validated, relPaths: [factRel, indexRel], event };
    });
  }

  getKbFact(id: KbId): { fact: KbFact; body: string } {
    const path = this.abs('knowledge', 'facts', `${id}.md`);
    if (!fileExists(path)) throw new NotFoundError('KbFact', id);
    const parsed = parseFrontmatter<unknown>(readEntityFileRaw(path));
    return { fact: validateKbFact(parsed.data), body: parsed.body };
  }

  listKbIndex(): KbIndex {
    return readKbIndex(this.abs('knowledge', 'index.yaml'));
  }

  // -------------------------------------------------------------- Ledger

  /**
   * Review nit: `line.sprint` must match the `sprint` argument (previously
   * unchecked). `{commit: 'deferred'}` (T011 — the tool framework's MCP tool
   * calls can be frequent enough during a busy session to warrant the same
   * hot-path batching T009 gave `hook_decision`/heartbeat writes; see the
   * file's "Deferred-commit batching" header) appends the line immediately
   * but queues the commit — every other caller keeps the default immediate
   * one-line-one-commit behaviour.
   */
  async appendLedgerLine(
    sprint: SprintId,
    line: LedgerLine,
    options: { commit?: 'immediate' | 'deferred' } = {},
  ): Promise<LedgerLine> {
    const validated = validateLedgerLine(line);
    if (validated.sprint !== sprint) {
      throw new Error(
        `appendLedgerLine: line.sprint (${JSON.stringify(validated.sprint)}) does not match sprint argument (${JSON.stringify(sprint)})`,
      );
    }
    const ledgerRel = join('ledger', `${sprint}.jsonl`);

    if (options.commit === 'deferred') {
      return this.mutex.run(() => {
        appendJsonlLine(this.abs(ledgerRel), validated);
        const event = buildEvent('ledger_appended', {
          ticket: isTicketIdLike(validated.ticket) ? (validated.ticket as TicketId) : undefined,
          agent: validated.agent.length > 0 ? validated.agent : undefined,
          data: { sprint, kind: validated.kind },
        });
        this.deferEventSync(event, [ledgerRel]);
        return validated;
      });
    }

    return this.mutate(() => {
      appendJsonlLine(this.abs(ledgerRel), validated);
      const event = buildEvent('ledger_appended', {
        ticket: isTicketIdLike(validated.ticket) ? (validated.ticket as TicketId) : undefined,
        agent: validated.agent.length > 0 ? validated.agent : undefined,
        data: { sprint, kind: validated.kind },
      });
      return { result: validated, relPaths: [ledgerRel], event };
    });
  }

  listLedger(sprint: SprintId): LedgerLine[] {
    return readJsonlFile<LedgerLine>(this.abs('ledger', `${sprint}.jsonl`));
  }

  // ---------------------------------------------------------------- Halt

  private haltRelPath(id: HaltId): string {
    return join('board', 'halts', `${id}.yaml`);
  }

  /**
   * Creates (or updates, e.g. a quorum flip) a halt file. §4 "Halts":
   * presence of the file = halt active. Review fix (T007 manager decision):
   * previously always minted `halt_created`, even for an update to an
   * existing halt (e.g. `recordStandupReport` persisting a quorum flip) —
   * indistinguishable from an actual creation in the event/commit log. Now
   * mints `halt_created` only the first time a given id's file is written,
   * `halt_updated` on every subsequent put. A quorum flip to `reached`
   * carries `{haltId, quorum: 'reached'}` as the event's `data` so the feed
   * can show it without diffing the file.
   */
  async putHalt(halt: Halt): Promise<Halt> {
    return this.mutate(() => {
      const validated = validateHalt(halt);
      const relPath = this.haltRelPath(validated.id);
      const existed = fileExists(this.abs(relPath));
      writeYamlFileAtomic(this.abs(relPath), validated);
      const kind = existed ? 'halt_updated' : 'halt_created';
      const data =
        existed && validated.quorum === 'reached'
          ? { haltId: validated.id, quorum: validated.quorum }
          : { id: validated.id, scope: validated.scope };
      const event = buildEvent(kind, { data });
      return { result: validated, relPaths: [relPath], event };
    });
  }

  getHalt(id: HaltId): Halt {
    const path = this.abs(this.haltRelPath(id));
    if (!fileExists(path)) throw new NotFoundError('Halt', id);
    return validateHalt(readYamlFile(path));
  }

  listHalts(): Halt[] {
    const dir = this.abs('board', 'halts');
    return listDataFiles(dir, '.yaml').map((name) => validateHalt(readYamlFile(join(dir, name))));
  }

  /** Releases a halt: "Delete the file to release" (§4 "Halts"). */
  async deleteHalt(id: HaltId): Promise<void> {
    return this.mutate(() => {
      const relPath = this.haltRelPath(id);
      if (!fileExists(this.abs(relPath))) throw new NotFoundError('Halt', id);
      removeFile(this.abs(relPath));
      const event = buildEvent('halt_released', { data: { id } });
      return { result: undefined, relPaths: [relPath], event };
    });
  }

  // -------------------------------------------------------------- Sprint

  private sprintRelPath(id: SprintId): string {
    return join('sprints', `${id}.yaml`);
  }

  async putSprint(sprint: Sprint): Promise<Sprint> {
    return this.mutate(() => {
      const validated = validateSprint(sprint);
      const relPath = this.sprintRelPath(validated.id);
      writeYamlFileAtomic(this.abs(relPath), validated);
      const event = buildEvent('sprint_put', { data: { id: validated.id } });
      return { result: validated, relPaths: [relPath], event };
    });
  }

  getSprint(id: SprintId): Sprint {
    const path = this.abs(this.sprintRelPath(id));
    if (!fileExists(path)) throw new NotFoundError('Sprint', id);
    return validateSprint(readYamlFile(path));
  }

  listSprints(): Sprint[] {
    const dir = this.abs('sprints');
    return listDataFiles(dir, '.yaml').map((name) => validateSprint(readYamlFile(join(dir, name))));
  }

  // --------------------------------------------------------------- Quota

  /**
   * DESIGN-GAP: §4 "Quota" gives the record's schema but the Layout tree
   * (§4) never names a file path for it (unlike every other entity). Filed
   * at `quota/<vendor>-<account>.yaml`, one file per account, mirroring how
   * every other per-id entity in the layout gets its own file.
   */
  private quotaRelPath(vendor: string, account: string): string {
    return join('quota', `${vendor}-${account}.yaml`);
  }

  async putQuota(quota: Quota): Promise<Quota> {
    return this.mutate(() => {
      const validated = validateQuota(quota);
      const relPath = this.quotaRelPath(validated.vendor, validated.account);
      writeYamlFileAtomic(this.abs(relPath), validated);
      const event = buildEvent('quota_put', {
        data: { vendor: validated.vendor, account: validated.account },
      });
      return { result: validated, relPaths: [relPath], event };
    });
  }

  getQuota(vendor: string, account: string): Quota {
    const path = this.abs(this.quotaRelPath(vendor, account));
    if (!fileExists(path)) throw new NotFoundError('Quota', `${vendor}-${account}`);
    return validateQuota(readYamlFile(path));
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
   * nothing queued — the existing record is returned unchanged.
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
    patch: { ticket?: TicketId } = {},
    now: () => Date = () => new Date(),
  ): Promise<AgentRecord> {
    return this.mutex.run(() => {
      // Throws `NotFoundError` if `id` isn't registered — deliberate, see
      // this method's doc comment: heartbeating an unregistered agent is a
      // bug at the call site, never a reason to fabricate a fresh record.
      const existing = this.getAgent(id);

      const nowDate = now();
      const ticketChanged = patch.ticket !== undefined && patch.ticket !== existing.ticket;
      const lastSeenMs = Date.parse(existing.last_seen);
      if (
        !ticketChanged &&
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
        ticket: patch.ticket ?? existing.ticket,
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

  async deleteAgent(id: AgentId): Promise<void> {
    return this.mutate(() => {
      const relPath = this.agentRelPath(id);
      if (!fileExists(this.abs(relPath))) throw new NotFoundError('AgentRecord', id);
      removeFile(this.abs(relPath));
      const event = buildEvent('agent_deleted', { agent: id, data: {} });
      return { result: undefined, relPaths: [relPath], event };
    });
  }

  // -------------------------------------------------------- Policy/Vendors

  getPolicy(): Policy {
    const path = this.abs('policy.yaml');
    if (!fileExists(path)) throw new NotFoundError('Policy', 'policy.yaml');
    return validatePolicy(readYamlFile(path));
  }

  async putPolicy(policy: Policy): Promise<Policy> {
    return this.mutate(() => {
      const validated = validatePolicy(policy);
      const relPath = 'policy.yaml';
      writeYamlFileAtomic(this.abs(relPath), validated);
      const event = buildEvent('policy_put');
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
