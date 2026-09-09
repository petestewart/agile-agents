/**
 * `StateStore` — the validating read/write layer over `.agile/` (T005; design
 * agile-agents-design.md §4 "State model", §5 "Storage" (ordering/failure),
 * §15 "Git model and teams").
 *
 * Every write: validate with the shared zod schema first (so a failing
 * validation touches no file), then an atomic file write (fs.ts), then one
 * git commit on the `agile-state` worktree batching every file that one
 * logical operation touched (git.ts). Reads never mutate.
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
 */

import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Event,
  type KbFact,
  type KbId,
  type KbIndex,
  type LedgerLine,
  type OracleEntry,
  type OracleId,
  type OracleIndex,
  type SprintId,
  type Stanza,
  type Ticket,
  type TicketId,
  type TicketStatus,
  isLegalTransition,
  validateEvent,
  validateKbFact,
  validateKbIndex,
  validateLedgerLine,
  validateOracleEntry,
  validateOracleIndex,
  validateStanza,
  validateTicket,
} from '@agile-agents/shared';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildStateTransitionEvent } from './events';
import {
  appendJsonlLine,
  atomicWriteFile,
  ensureDir,
  fileExists,
  readJsonlFile,
  readYamlFile,
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
 */
function formatOracleChangelogLine(entry: OracleEntry): string {
  const date = entry.decided || todayIso();
  if (entry.supersedes.length > 0) {
    return `${date} ${entry.id} supersedes ${entry.supersedes.join(', ')}: ${entry.rationale}`;
  }
  return `${date} ${entry.id} ${entry.status}: ${entry.rationale}`;
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
  if (!existsSync(path)) {
    appendFileSync(path, '# Changelog\n\n');
  }
  appendFileSync(path, `${line}\n`);
}

function safeParseStanza(input: unknown): Stanza | undefined {
  try {
    return validateStanza(input);
  } catch {
    return undefined;
  }
}

export class StateStore {
  private readonly mutex = new Mutex();

  private constructor(private readonly stateRoot: string) {}

  static open(stateRoot: string): StateStore {
    if (!existsSync(stateRoot)) {
      throw new Error(`StateStore.open: ${stateRoot} does not exist (run \`agile init\` first)`);
    }
    return new StateStore(stateRoot);
  }

  private abs(...parts: string[]): string {
    return join(this.stateRoot, ...parts);
  }

  private commit(relativePaths: string[], message: string): string | null {
    return commitPaths(this.stateRoot, relativePaths, message);
  }

  // ---------------------------------------------------------------- Ticket

  getTicket(id: TicketId): Ticket {
    const path = this.abs('tickets', `${id}.yaml`);
    if (!fileExists(path)) throw new NotFoundError('Ticket', id);
    return validateTicket(readYamlFile(path));
  }

  listTickets(): Ticket[] {
    const dir = this.abs('tickets');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => validateTicket(readYamlFile(join(dir, name))));
  }

  /**
   * Creates or wholesale-replaces a ticket file. Used to seed tickets (there
   * is no `assign`/`create` ceremony in T005's scope) — unlike
   * `transitionTicket`, this does not check `isLegalTransition` (there is no
   * "from" state the first time) and does not emit an event: only a status
   * *transition* is an event source (§3, events.ts), and creation isn't one.
   */
  async putTicket(ticket: Ticket): Promise<Ticket> {
    return this.mutex.run(() => {
      const validated = validateTicket(ticket);
      const relPath = join('tickets', `${validated.id}.yaml`);
      writeYamlFileAtomic(this.abs(relPath), validated);
      this.commit([relPath], 'ticket_put');
      return validated;
    });
  }

  /**
   * The only ticket status mutator. Checks `isLegalTransition` *before*
   * touching any file (so an illegal transition throws with nothing written,
   * committed, or logged — T005 acceptance criterion), appends one
   * `history` line, appends the transition event to the ticket's board
   * file, and emits exactly one `state_transition` event to
   * `log/events.jsonl` — all three files land in one commit whose message
   * is that event's `kind` ("state_transition" for every transition, so
   * `git log --format=%s` reproduces the kind sequence — T005's
   * property-test / audit-trail requirement).
   */
  async transitionTicket(
    id: TicketId,
    to: TicketStatus,
    options: TransitionOptions,
  ): Promise<Ticket> {
    return this.mutex.run(() => {
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
      const eventsRel = join('log', 'events.jsonl');
      const boardRel = join('board', 'status', `${id}.jsonl`);

      writeYamlFileAtomic(this.abs(ticketRel), updated);
      appendJsonlLine(this.abs(eventsRel), event);
      appendJsonlLine(this.abs(boardRel), event);

      this.commit([ticketRel, eventsRel, boardRel], event.kind);

      return updated;
    });
  }

  // ----------------------------------------------------------------- Board

  /**
   * Appends an agent-written checkpoint stanza (§4 "Board") to the ticket's
   * append-only board file — the same file `transitionTicket` also appends
   * `state_transition` events to (see `listBoardRaw`/`listStanzas` for
   * reading either kind back out). Own commit; no event (only ticket
   * transitions are an event source, see events.ts).
   */
  async appendStanza(input: Stanza): Promise<Stanza> {
    return this.mutex.run(() => {
      const stanza = validateStanza(input);
      const boardRel = join('board', 'status', `${stanza.ticket}.jsonl`);
      appendJsonlLine(this.abs(boardRel), stanza);
      this.commit([boardRel], `stanza:${stanza.kind}`);
      return stanza;
    });
  }

  /** Every line in a ticket's board file, whatever shape (stanza or transition event), unvalidated. */
  listBoardRaw(ticket: TicketId): unknown[] {
    return readJsonlFile(this.abs('board', 'status', `${ticket}.jsonl`));
  }

  /** Only the lines that parse as an agent-written `Stanza` (transition-event lines are filtered out). */
  listStanzas(ticket: TicketId): Stanza[] {
    return this.listBoardRaw(ticket)
      .map((line) => safeParseStanza(line))
      .filter((s): s is Stanza => s !== undefined);
  }

  // --------------------------------------------------------------- Oracle

  /**
   * Writes the entry's markdown file (frontmatter + body), then updates
   * `oracle/index.yaml` ("active only" — §4: an entry whose `status` is no
   * longer `active` is *removed* from the index here, not merely updated,
   * matching "Superseded files ... drop out of index.yaml") and appends one
   * `oracle/changelog.md` line. All three files land in one commit; no
   * event (see events.ts's scoping note).
   */
  async putOracleEntry(entry: OracleEntry, body: string): Promise<OracleEntry> {
    return this.mutex.run(() => {
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

      this.commit([entryRel, indexRel, changelogRel], 'oracle_put');
      return validated;
    });
  }

  getOracleEntry(id: OracleId): { entry: OracleEntry; body: string } {
    const path = this.abs(oracleEntryRelPath(id));
    if (!fileExists(path)) throw new NotFoundError('OracleEntry', id);
    const parsed = parseFrontmatter<unknown>(readFileSync(path, 'utf8'));
    return { entry: validateOracleEntry(parsed.data), body: parsed.body };
  }

  listOracleIndex(): OracleIndex {
    return readOracleIndex(this.abs('oracle', 'index.yaml'));
  }

  // ----------------------------------------------------------------- KB

  async putKbFact(fact: KbFact, body: string): Promise<KbFact> {
    return this.mutex.run(() => {
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

      this.commit([factRel, indexRel], 'kb_put');
      return validated;
    });
  }

  getKbFact(id: KbId): { fact: KbFact; body: string } {
    const path = this.abs('knowledge', 'facts', `${id}.md`);
    if (!fileExists(path)) throw new NotFoundError('KbFact', id);
    const parsed = parseFrontmatter<unknown>(readFileSync(path, 'utf8'));
    return { fact: validateKbFact(parsed.data), body: parsed.body };
  }

  listKbIndex(): KbIndex {
    return readKbIndex(this.abs('knowledge', 'index.yaml'));
  }

  // -------------------------------------------------------------- Ledger

  async appendLedgerLine(sprint: SprintId, line: LedgerLine): Promise<LedgerLine> {
    return this.mutex.run(() => {
      const validated = validateLedgerLine(line);
      const ledgerRel = join('ledger', `${sprint}.jsonl`);
      appendJsonlLine(this.abs(ledgerRel), validated);
      this.commit([ledgerRel], 'ledger_append');
      return validated;
    });
  }

  listLedger(sprint: SprintId): LedgerLine[] {
    return readJsonlFile<LedgerLine>(this.abs('ledger', `${sprint}.jsonl`));
  }

  // -------------------------------------------------------------- Events

  /** Read-only: the full `log/events.jsonl` audit stream. */
  listEvents(): Event[] {
    return readJsonlFile<unknown>(this.abs('log', 'events.jsonl')).map((line) =>
      validateEvent(line),
    );
  }
}
