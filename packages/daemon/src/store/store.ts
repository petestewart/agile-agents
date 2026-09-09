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

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
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

export class StateStore {
  private readonly mutex = new Mutex();

  private constructor(private readonly stateRoot: string) {}

  static open(stateRoot: string): StateStore {
    if (!existsSync(stateRoot)) {
      throw new Error(`StateStore.open: ${stateRoot} does not exist (run \`agile init\` first)`);
    }
    // Review B4: clean up anything a prior crash left mid-write before any
    // listX call can trip over it.
    sweepStaleTempFiles(stateRoot);
    return new StateStore(stateRoot);
  }

  private abs(...parts: string[]): string {
    return join(this.stateRoot, ...parts);
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

  /** Appends `event` to `log/events.jsonl` and commits `relPaths` (plus that file) with message = event.kind. */
  private commitEvent(relPaths: string[], event: Event): void {
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
   * Public escape hatch for the two named event sources T005 doesn't itself
   * produce (review fix, manager decision B1): `message` (T006's bus) and
   * `hook_decision` (T008/T009's hook endpoint) go through this instead of
   * re-implementing append+commit outside the store (which CLAUDE.md's
   * "written only through the daemon's validating store" forbids).
   */
  async appendEvent(event: Event): Promise<Event> {
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

  /** Review nit: `line.sprint` must match the `sprint` argument (previously unchecked). */
  async appendLedgerLine(sprint: SprintId, line: LedgerLine): Promise<LedgerLine> {
    return this.mutate(() => {
      const validated = validateLedgerLine(line);
      if (validated.sprint !== sprint) {
        throw new Error(
          `appendLedgerLine: line.sprint (${JSON.stringify(validated.sprint)}) does not match sprint argument (${JSON.stringify(sprint)})`,
        );
      }
      const ledgerRel = join('ledger', `${sprint}.jsonl`);
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

  /** Creates (or updates, e.g. a quorum flip) a halt file. §4 "Halts": presence of the file = halt active. */
  async putHalt(halt: Halt): Promise<Halt> {
    return this.mutate(() => {
      const validated = validateHalt(halt);
      const relPath = this.haltRelPath(validated.id);
      writeYamlFileAtomic(this.abs(relPath), validated);
      const event = buildEvent('halt_created', {
        data: { id: validated.id, scope: validated.scope },
      });
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

  async putVendors(vendors: VendorsConfig): Promise<VendorsConfig> {
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
}

function readEntityFileRaw(path: string): string {
  return readFileSync(path, 'utf8');
}

function isTicketIdLike(value: string): boolean {
  return /^TKT-\d{4,}$/.test(value);
}
