/**
 * The eight MCP verbs an attached session gets (§4.1), the whole
 * agent-facing surface: `ask` · `progress` · `finding` · `propose_knowledge` ·
 * `propose_next` · `read_stream` · `search_docs` · `test_run`.
 *
 * Every verb names its `session`, resolved through the agent registry
 * (live only while the session is) to its stream and worktree. An exited
 * session resolves to nothing and every verb refuses; no stream id is
 * taken from the caller.
 */

import { isAbsolute, normalize } from 'node:path';
import {
  type AgentId,
  type AgentVerb,
  CoordinatorChangeSchema,
  DIRECTOR_NODE,
  type KnowledgeScope,
  type RoutedEvent,
  type SessionRole,
  type StatusCard,
  type StreamFinding,
  type ThreadEntry,
  formatKnowledgeScope,
  formatZodError,
  parseKnowledgeScope,
  validateVerbInput,
  withExamplesNote,
} from '@agile-agents/shared';
import type { AutonomyService } from '../coordination/autonomy';
import { type ContractService, assertChildren } from '../coordination/contracts';
import type { PlanService } from '../coordination/plans';
import type { SiblingService } from '../coordination/siblings';
import type { DocsSearch, SearchHit } from '../docs/service';
import { summaryOf } from '../events/delivery';
import type { EmitRouted } from '../events/producers';
import { type KnowledgeService, worktreeRelativePaths } from '../knowledge/service';
import type { QuestionService } from '../questions/service';
import { NotFoundError, type StateStore } from '../store';
import type { StreamService } from '../streams/service';
import { type TestRunOutput, runTestRun } from '../tools/test-run';

/** A verb called from a session that is not (or no longer) attached. */
export class UnknownSessionError extends Error {
  constructor(public readonly session: string) {
    super(`unknown session: ${session} is not attached to a stream`);
    this.name = 'UnknownSessionError';
  }
}

/** A verb that needs a worktree, called from a session that has none (a planning stream). */
export class NoWorktreeError extends Error {
  constructor(verb: string) {
    super(`${verb} needs a repo worktree; this stream has none`);
    this.name = 'NoWorktreeError';
  }
}

/** One `lookup_knowledge` hit: what the agent needs, not the whole record. */
export interface LookupKnowledgeItem {
  id: string;
  kind: string;
  text: string;
  scope: string;
  enforcement: string;
  paths?: string[];
  critical?: true;
}

/**
 * `lookup_knowledge`'s path, made repo-relative so it can match item globs:
 * an absolute path is taken relative to the worktree, `./` and `..` are
 * resolved, and anything outside the worktree is refused.
 */
export function lookupPath(path: string, worktree: string | undefined): string {
  const normal = isAbsolute(path) ? normalize(path) : normalize(path).replace(/\/+$/, '');
  const [rel] =
    worktree === undefined
      ? isAbsolute(normal) || normal === '..' || normal.startsWith('../')
        ? []
        : [normal]
      : worktreeRelativePaths([normal], worktree);
  if (rel === undefined || rel === '.') {
    throw new Error(
      `lookup_knowledge: ${path} is not a path inside this stream's worktree; pass a repo-relative path`,
    );
  }
  return rel;
}

/** Where a verb call came from, resolved from the registry rather than trusted. */
export interface VerbCaller {
  session: string;
  stream: string;
  role: SessionRole;
  worktree?: string;
}

export interface VerbServiceOptions {
  store: StateStore;
  streams: StreamService;
  questions: QuestionService;
  /** `search_docs`'s read side. */
  docs?: DocsSearch;
  /** What `propose_knowledge` writes through. */
  rules?: KnowledgeService;
  /** §5.5's "at most three" proposals from a lessons session, enforced as a gate. */
  /** T244: `read_event`'s read side (`RoutedEventService`). */
  events?: { get(id: string): RoutedEvent | undefined };
  /** T246: `deliver`'s write side (`DeliveryService.push`). */
  delivery?: { push(stream: string): Promise<unknown> };
  /** T283: `read_card`'s read side. */
  cards?: { read(caller: string, target: string): StatusCard };
  /** T281: `plan_write` / `contract_write`, coordinator sessions only. */
  plans?: PlanService;
  contracts?: ContractService;
  /** T282: the autonomy gate for the coordinator's structural verbs. */
  autonomy?: AutonomyService;
  /** T286: `ask_sibling` / `reply_sibling`, and the joint-proposal check. */
  siblings?: SiblingService;
  /** T287: `note_child`'s write side (a `coordinator_note` routed event). */
  emitRouted?: EmitRouted;
  proposalLimit?: { assertCanPropose(caller: Pick<VerbCaller, 'session' | 'role'>): void };
}

export class VerbService {
  constructor(private readonly options: VerbServiceOptions) {}

  /** Resolves a session id to its stream/role/worktree, or refuses. */
  caller(session: string): VerbCaller {
    let record: ReturnType<StateStore['getAgent']>;
    try {
      record = this.options.store.getAgent(session as AgentId);
    } catch (err) {
      if (err instanceof NotFoundError) throw new UnknownSessionError(session);
      throw err;
    }
    if (record.stream === undefined) throw new UnknownSessionError(session);
    return {
      session,
      stream: record.stream,
      role: record.role ?? 'worker',
      ...(record.worktree !== undefined ? { worktree: record.worktree } : {}),
    };
  }

  /** §1.4: a question is raised on the caller's stream. */
  async ask(input: unknown): Promise<{ id: string }> {
    const { session, text } = validateVerbInput('ask', input);
    const caller = this.caller(session);
    const question = await this.options.questions.raise({
      stream: caller.stream,
      raised_by: session as AgentId,
      session,
      text,
    });
    return { id: question.id };
  }

  async progress(input: unknown): Promise<ThreadEntry> {
    const { session, text } = validateVerbInput('progress', input);
    const caller = this.caller(session);
    await this.options.streams.update('agent', caller.stream, { agent: { progress: text } });
    return this.options.streams.appendThread(
      'agent',
      caller.stream,
      { kind: 'line', body: text },
      session,
    );
  }

  /** A finding goes to the thread (the narrative) and to `agent.findings` (the list the cockpit groups), §4.2. */
  async finding(input: unknown): Promise<StreamFinding> {
    const { session, severity, file, line, text } = validateVerbInput('finding', input);
    const caller = this.caller(session);
    const finding: StreamFinding = {
      severity,
      file,
      ...(line !== undefined ? { line } : {}),
      text,
    };
    const current = this.options.streams.get(caller.stream);
    await this.options.streams.update('agent', caller.stream, {
      agent: { findings: [...(current.agent.findings ?? []), finding] },
    });
    await this.options.streams.appendThread(
      'agent',
      caller.stream,
      {
        kind: 'finding',
        body: `${severity} ${file}${line !== undefined ? `:${line}` : ''} — ${text}`.slice(0, 800),
      },
      session,
    );
    return finding;
  }

  /**
   * §5.1/D4, T264: an agent may only propose. The item is minted `proposed`
   * with its source back to this node and session (`lessons` for a retro),
   * plus a thread entry `ref`'d to it; the human decides in the inbox.
   *
   * Scope: `global`, `repo:<name>`, `project:<id>`, `subtree:<id>`, or bare
   * `repo`/`project`/`subtree` for this node's own. Omitted, this node's
   * subtree (§14.3): never wider by default.
   */
  async proposeKnowledge(input: unknown): Promise<ThreadEntry> {
    const { session, text, kind, scope, paths, examples, enforcement, critical } =
      validateVerbInput('propose_knowledge', input);
    const caller = this.caller(session);
    // §5.5's proposal budget, checked before anything is written.
    this.options.proposalLimit?.assertCanPropose(caller);
    const checked = enforcement === 'action' || enforcement === 'ship';
    const item = await this.options.rules?.create('agent', {
      text,
      ...(kind !== undefined ? { kind } : {}),
      scope: this.resolveProposedScope(caller, scope),
      ...(paths !== undefined ? { paths } : {}),
      ...(enforcement !== undefined ? { enforcement } : {}),
      ...(checked ? { check: { by: 'classifier', examples: examples ?? [] } } : {}),
      ...(critical !== undefined ? { critical } : {}),
      source: {
        by: caller.role === 'lessons' ? 'lessons' : 'agent',
        node: caller.stream,
        session,
        // A tell/review item has no check to hold them: keep them visible (T260).
        ...(!checked && examples !== undefined && examples.length > 0
          ? { finding: withExamplesNote(undefined, examples) }
          : {}),
      },
    });
    return this.options.streams.appendThread(
      'agent',
      caller.stream,
      {
        kind: 'proposal',
        body:
          item === undefined
            ? `knowledge proposed: ${text}`
            : `${item.kind} proposed (${formatKnowledgeScope(item.scope)}): ${text}`,
        ref: item === undefined ? 'knowledge_proposed' : `knowledge/${item.id}.yaml`,
      },
      session,
    );
  }

  /** The scope grammar of `propose_knowledge`, resolved against the calling session's node. */
  private resolveProposedScope(caller: VerbCaller, scope: string | undefined): KnowledgeScope {
    const stream = this.options.streams.get(caller.stream);
    const trimmed = scope?.trim();
    if (trimmed === undefined || trimmed === 'subtree' || trimmed === 'stream') {
      return { kind: 'subtree', node: stream.id };
    }
    if (trimmed === 'repo') {
      if (stream.repo === undefined) {
        throw new Error(
          'propose_knowledge: scope "repo" needs a node with a repo; this one has none',
        );
      }
      return { kind: 'repo', repo: stream.repo };
    }
    if (trimmed === 'project') {
      if (stream.project === undefined) {
        throw new Error(
          'propose_knowledge: scope "project" needs a node in a project; this one has none',
        );
      }
      return { kind: 'project', project: stream.project };
    }
    return parseKnowledgeScope(trimmed);
  }

  /** A follow-up worth its own stream. A human creates the child; this only records the proposal (§4.1). */
  async proposeNext(input: unknown): Promise<ThreadEntry> {
    const { session, title, goal } = validateVerbInput('propose_next', input);
    const caller = this.caller(session);
    const current = this.options.streams.get(caller.stream);
    await this.options.streams.update('agent', caller.stream, {
      agent: { proposed_next: [...(current.agent.proposed_next ?? []), title].slice(-20) },
    });
    return this.options.streams.appendThread(
      'agent',
      caller.stream,
      { kind: 'proposal', body: `next: ${title} — ${goal}`.slice(0, 800) },
      session,
    );
  }

  /** The tail of this session's own stream thread. */
  readStream(input: unknown): { stream: string; entries: ThreadEntry[]; total: number } {
    const { session, limit } = validateVerbInput('read_stream', input);
    const caller = this.caller(session);
    const page = this.options.streams.readThread(caller.stream, { limit: 500 });
    const take = limit ?? 20;
    return {
      stream: caller.stream,
      entries: page.entries.slice(-take),
      total: page.total,
    };
  }

  /** Repo docs (`<home>/repos/<name>/docs/`) plus this stream's own notes; empty with no docs service. */
  async searchDocs(input: unknown): Promise<SearchHit[]> {
    const { session, query } = validateVerbInput('search_docs', input);
    const caller = this.caller(session);
    if (this.options.docs === undefined) return [];
    return this.options.docs.search(query, { stream: caller.stream });
  }

  /** T244: a routed event's full payload, only for an event routed to the caller's stream. */
  readEvent(input: unknown): RoutedEvent & { summary: string } {
    const { session, id } = validateVerbInput('read_event', input);
    const caller = this.caller(session);
    const event = this.options.events?.get(id);
    if (event === undefined || !event.routing.some((r) => r.node === caller.stream)) {
      throw new Error(`read_event: no event ${id} was routed to this stream`);
    }
    const titleOf = (sid: string) => this.options.streams.list().find((s) => s.id === sid)?.title;
    return { ...event, summary: summaryOf(event, caller.stream, titleOf) };
  }

  /**
   * T246 (§4.1): a worker pushes its fix and updates its open PR. A
   * reviewer is read-only; refusals (no open PR) come back as the error.
   */
  async deliver(input: unknown): Promise<unknown> {
    const { session } = validateVerbInput('deliver', input);
    const caller = this.caller(session);
    if (caller.role !== 'worker') throw new Error(`deliver: a ${caller.role} session cannot push`);
    if (this.options.delivery === undefined) throw new Error('deliver: delivery is not available');
    return this.options.delivery.push(caller.stream);
  }

  /**
   * T263: the accepted items in scope for the caller's node that apply to
   * `path` (items with no globs apply everywhere). Read-only, any role.
   */
  lookupKnowledge(input: unknown): { path: string; items: LookupKnowledgeItem[] } {
    const { session, path } = validateVerbInput('lookup_knowledge', input);
    const caller = this.caller(session);
    const rel = lookupPath(path, caller.worktree);
    const items = this.options.rules?.inScope(caller.stream, undefined, [rel]) ?? [];
    return {
      path: rel,
      items: items.map((item) => ({
        id: item.id,
        kind: item.kind,
        text: item.text,
        scope: formatKnowledgeScope(item.scope),
        enforcement: item.enforcement,
        ...(item.paths !== undefined && item.paths.length > 0 ? { paths: item.paths } : {}),
        ...(item.critical ? { critical: true } : {}),
      })),
    };
  }

  /** T283 (§14.5): a sibling's or ancestor's status card. */
  readCard(input: unknown): StatusCard {
    const { session, node } = validateVerbInput('read_card', input);
    const caller = this.caller(session);
    if (this.options.cards === undefined) throw new Error('read_card: cards are not available');
    return this.options.cards.read(caller.stream, node);
  }

  /** T281 (§14.4): the coordinator's plan; always lands `draft` for the operator to approve. */
  async planWrite(input: unknown): Promise<unknown> {
    const { session, owners, contracts } = validateVerbInput('plan_write', input);
    const caller = this.coordinatorCaller(session, 'plan_write');
    if (this.options.plans === undefined) throw new Error('plan_write: plans are not available');
    return this.options.plans.write(caller.stream, owners, contracts);
  }

  /** T281 (§14.4): create or bump a contract on the coordinator's node; a bump tells its parties. */
  async contractWrite(input: unknown): Promise<unknown> {
    const { session, ...fields } = validateVerbInput('contract_write', input);
    const caller = this.coordinatorCaller(session, 'contract_write');
    if (this.options.contracts === undefined) {
      throw new Error('contract_write: contracts are not available');
    }
    const by = `agent:${session}`;
    // T282: changing an agreed contract is `approve_contract`, gated by the
    // autonomy level; creating one is covered by the plan's approval.
    if (this.options.autonomy !== undefined && fields.id !== undefined) {
      const before = this.options.contracts.get(fields.id);
      const sameParties =
        [...before.parties].sort().join(',') === [...new Set(fields.parties)].sort().join(',');
      // Any change to an agreed contract (title, body or parties) is gated.
      if (
        before.body !== fields.body.trim() ||
        before.title !== fields.title.trim() ||
        !sameParties
      ) {
        const { id, ...rest } = fields;
        return this.options.autonomy.act(caller.stream, 'coordinator', by, {
          action: 'approve_contract',
          contract: id,
          ...rest,
        });
      }
    }
    const { routine: _routine, ...write } = fields;
    return this.options.contracts.write(caller.stream, write, by);
  }

  /** T285 (§9.1): a child, co-signed by siblings in `with`, proposes a contract change. */
  async proposeContract(input: unknown): Promise<unknown> {
    const {
      session,
      contract,
      with: cosigners,
      ...proposal
    } = validateVerbInput('propose_contract', input);
    const caller = this.caller(session);
    if (caller.role !== 'worker' && caller.role !== 'coordinator') {
      throw new Error(`propose_contract: a ${caller.role} session cannot propose`);
    }
    if (this.options.contracts === undefined) {
      throw new Error('propose_contract: contracts are not available');
    }
    // T286: a co-signer must actually have agreed (answered an ask_sibling from the caller).
    const unagreed = (cosigners ?? []).filter(
      (id) =>
        id !== caller.stream &&
        this.options.siblings?.agreed(caller.stream, id, contract, proposal.body) !== true,
    );
    if (unagreed.length > 0) {
      throw new Error(
        `propose_contract: ${unagreed.join(', ')} has not agreed to this contract and body; ask_sibling and wait for a reply with agree`,
      );
    }
    return this.options.contracts.propose(
      contract,
      [caller.stream, ...(cosigners ?? [])],
      proposal,
    );
  }

  /** T286 (§9.5): ask a sibling about a detail. */
  async askSibling(input: unknown): Promise<unknown> {
    const { session, node, question } = validateVerbInput('ask_sibling', input);
    return this.siblingsFor(session, 'ask_sibling', (s, from) => s.ask(from, node, question));
  }

  async replySibling(input: unknown): Promise<unknown> {
    const { session, ask, body, agree } = validateVerbInput('reply_sibling', input);
    return this.siblingsFor(session, 'reply_sibling', (s, from) => s.reply(from, ask, body, agree));
  }

  private siblingsFor<T>(
    session: string,
    verb: string,
    run: (siblings: SiblingService, from: string) => Promise<T>,
  ): Promise<T> {
    const caller = this.caller(session);
    if (caller.role !== 'worker' && caller.role !== 'coordinator') {
      throw new Error(`${verb}: a ${caller.role} session cannot`);
    }
    if (this.options.siblings === undefined) throw new Error(`${verb}: siblings are not available`);
    return run(this.options.siblings, caller.stream);
  }

  /**
   * T285: the coordinator decides a proposal on its own node's contract.
   * Approval goes through the gate as `approve_contract` (applied at Run
   * when the coordinator judges it routine, else an inbox card).
   */
  async decideContract(input: unknown): Promise<unknown> {
    const {
      session,
      proposal: id,
      decision,
      reason,
      routine,
    } = validateVerbInput('decide_contract', input);
    const caller = this.coordinatorCaller(session, 'decide_contract');
    const { contracts, autonomy } = this.options;
    if (contracts === undefined || autonomy === undefined) {
      throw new Error('decide_contract: contracts are not available');
    }
    const { contract, proposal } = contracts.findProposal(id);
    if (contract.node !== caller.stream) {
      throw new Error(`decide_contract: ${contract.id} belongs to another node`);
    }
    if (proposal.status !== 'open') throw new Error(`decide_contract: ${id} is ${proposal.status}`);
    const by = `agent:${session}`;
    if (decision === 'reject') return contracts.reject(id, reason ?? '', by);
    const outcome = await autonomy.act(caller.stream, 'coordinator', by, {
      action: 'approve_contract',
      contract: contract.id,
      title: contract.title,
      body: proposal.body,
      parties: contract.parties,
      reason: reason ?? proposal.reason,
      routine: routine ?? false,
      proposal: id,
    });
    if (!outcome.applied) await contracts.markAsked(id);
    return outcome;
  }

  /** T282: the coordinator's structural verbs, all through the autonomy gate. */
  async addChild(input: unknown): Promise<unknown> {
    const { session, ...change } = validateVerbInput('add_child', input);
    return this.gated(session, 'add_child', { action: 'add_child', ...change });
  }

  async addWaitsOn(input: unknown): Promise<unknown> {
    const { session, ...change } = validateVerbInput('add_waits_on', input);
    if (this.isDirector(session)) {
      return this.directorGated(session, 'add_waits_on', { action: 'add_waits_on', ...change });
    }
    return this.gated(session, 'add_waits_on', { action: 'add_waits_on', ...change });
  }

  /**
   * T301 (§12, P16): the Director's verbs, each through the autonomy gate at
   * the project's `director` level. Held changes land on the Director page.
   */
  async draftTree(input: unknown): Promise<unknown> {
    const { session, ...tree } = validateVerbInput('draft_tree', input);
    return this.directorGated(session, 'draft_tree', { action: 'create_tree', tree });
  }

  async createProject(input: unknown): Promise<unknown> {
    const { session, ...fields } = validateVerbInput('create_project', input);
    return this.directorGated(session, 'create_project', { action: 'create_project', ...fields });
  }

  async createNode(input: unknown): Promise<unknown> {
    const { session, ...node } = validateVerbInput('create_node', input);
    return this.directorGated(session, 'create_node', { action: 'create_node', node });
  }

  async startNode(input: unknown): Promise<unknown> {
    const { session, node } = validateVerbInput('start_node', input);
    return this.directorGated(session, 'start_node', { action: 'start_node', node });
  }

  async restartNode(input: unknown): Promise<unknown> {
    const { session, node } = validateVerbInput('restart_node', input);
    return this.directorGated(session, 'restart_node', { action: 'restart_node', node });
  }

  /** The Director's session: the one its record names, streamless, on the coordinator table. */
  private isDirector(session: string): boolean {
    if (this.options.store.getDirector()?.session?.id !== session) return false;
    try {
      const record = this.options.store.getAgent(session as AgentId);
      return record.stream === undefined && record.role === 'coordinator';
    } catch {
      return false;
    }
  }

  private async directorGated(session: string, verb: string, raw: unknown): Promise<unknown> {
    if (!this.isDirector(session)) throw new Error(`${verb}: only the Director can`);
    if (this.options.autonomy === undefined) throw new Error(`${verb}: autonomy is not available`);
    const parsed = CoordinatorChangeSchema.safeParse(raw);
    if (!parsed.success) throw new Error(formatZodError(verb, parsed.error));
    return this.options.autonomy.act(DIRECTOR_NODE, 'director', `agent:${session}`, parsed.data);
  }

  async setOwner(input: unknown): Promise<unknown> {
    const { session, ...change } = validateVerbInput('set_owner', input);
    return this.gated(session, 'set_owner', { action: 'set_owner', ...change });
  }

  /** T287 (§9.4): a targeted note from a coordinator to one of its children. Not gated: it changes nothing. */
  async noteChild(input: unknown): Promise<{ event: string }> {
    const { session, child, body } = validateVerbInput('note_child', input);
    const caller = this.coordinatorCaller(session, 'note_child');
    if (this.options.emitRouted === undefined)
      throw new Error('note_child: events are not available');
    assertChildren(this.options.streams, caller.stream, [child], 'note_child');
    const project = this.options.streams.get(child).project;
    const event = await this.options.emitRouted({
      type: 'coordinator_note',
      subject: child,
      by: `agent:${session}`,
      ...(project !== undefined ? { project } : {}),
      payload: { body },
    });
    if (event === undefined) throw new Error('note_child: the note was not sent');
    return { event: event.id };
  }

  private async gated(
    session: string,
    verb: string,
    change: Parameters<AutonomyService['act']>[3],
  ): Promise<unknown> {
    const caller = this.coordinatorCaller(session, verb);
    if (this.options.autonomy === undefined) throw new Error(`${verb}: autonomy is not available`);
    return this.options.autonomy.act(caller.stream, 'coordinator', `agent:${session}`, change);
  }

  private coordinatorCaller(session: string, verb: string): VerbCaller {
    const caller = this.caller(session);
    if (caller.role !== 'coordinator') {
      throw new Error(`${verb}: only a coordinator can; a ${caller.role} proposes`);
    }
    return caller;
  }

  /** The repo's own test command, in this session's worktree. Failures only, never a green log. */
  async testRun(input: unknown): Promise<TestRunOutput> {
    const { session, command } = validateVerbInput('test_run', input);
    const caller = this.caller(session);
    if (caller.worktree === undefined) throw new NoWorktreeError('test_run');
    return runTestRun({
      input: { command },
      worktree: caller.worktree,
      repoRoot: caller.worktree,
    });
  }
}

/** Verb name → the `VerbService` method behind it, for the RPC edge and the MCP bridge. */
export function verbHandlers(
  service: VerbService,
): Record<AgentVerb, (input: unknown) => Promise<unknown> | unknown> {
  return {
    ask: (input) => service.ask(input),
    progress: (input) => service.progress(input),
    finding: (input) => service.finding(input),
    propose_knowledge: (input) => service.proposeKnowledge(input),
    propose_next: (input) => service.proposeNext(input),
    read_stream: (input) => service.readStream(input),
    search_docs: (input) => service.searchDocs(input),
    test_run: (input) => service.testRun(input),
    read_event: (input) => service.readEvent(input),
    deliver: (input) => service.deliver(input),
    lookup_knowledge: (input) => service.lookupKnowledge(input),
    read_card: (input) => service.readCard(input),
    plan_write: (input) => service.planWrite(input),
    contract_write: (input) => service.contractWrite(input),
    add_child: (input) => service.addChild(input),
    add_waits_on: (input) => service.addWaitsOn(input),
    set_owner: (input) => service.setOwner(input),
    note_child: (input) => service.noteChild(input),
    propose_contract: (input) => service.proposeContract(input),
    decide_contract: (input) => service.decideContract(input),
    ask_sibling: (input) => service.askSibling(input),
    reply_sibling: (input) => service.replySibling(input),
    draft_tree: (input) => service.draftTree(input),
    create_project: (input) => service.createProject(input),
    create_node: (input) => service.createNode(input),
    start_node: (input) => service.startNode(input),
    restart_node: (input) => service.restartNode(input),
  };
}
