/**
 * The eight MCP verbs an attached session gets (§4.1), the whole
 * agent-facing surface: `ask` · `progress` · `finding` · `propose_rule` ·
 * `propose_next` · `read_stream` · `search_docs` · `test_run`.
 *
 * Every verb names its `session`, resolved through the agent registry
 * (live only while the session is) to its stream and worktree. An exited
 * session resolves to nothing and every verb refuses; no stream id is
 * taken from the caller.
 */

import {
  type AgentId,
  type AgentVerb,
  type KnowledgeScope,
  type RoutedEvent,
  type SessionRole,
  type StreamFinding,
  type ThreadEntry,
  formatKnowledgeScope,
  legacyEnforcement,
  parseKnowledgeScope,
  validateVerbInput,
  withExamplesNote,
} from '@agile-agents/shared';
import type { DocsSearch, SearchHit } from '../docs/service';
import { summaryOf } from '../events/delivery';
import type { KnowledgeService } from '../knowledge/service';
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
  /** What `propose_rule` writes through. */
  rules?: KnowledgeService;
  /** §5.5's "at most three" proposals from a lessons session, enforced as a gate. */
  /** T244: `read_event`'s read side (`RoutedEventService`). */
  events?: { get(id: string): RoutedEvent | undefined };
  /** T246: `deliver`'s write side (`DeliveryService.push`). */
  delivery?: { push(stream: string): Promise<unknown> };
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
   * §5.1/D4: an agent may only propose. The rule is minted `proposed` with
   * provenance back to this stream and session (whatever the input says),
   * plus a thread entry `ref`'d to it; the human decides in the inbox.
   * Optional `examples`, `enforcement` and `critical` ride along.
   *
   * Scope: `global`, `repo:<name>`, `stream:<id>`, or bare `repo`/`stream`
   * for this session's own. Omitted, the narrowest honest scope: this
   * stream's repo, else the stream. Never global by default (§5.1: a rule
   * from one repo must not silently govern another).
   */
  async proposeRule(input: unknown): Promise<ThreadEntry> {
    const { session, text, scope, examples, enforcement, critical } = validateVerbInput(
      'propose_rule',
      input,
    );
    const caller = this.caller(session);
    // §5.5's proposal budget, checked before anything is written.
    this.options.proposalLimit?.assertCanPropose(caller);
    // The verb still speaks the old tiers (T264 replaces it with
    // `propose_knowledge`); they map as the home migration maps them.
    const mapped = enforcement === undefined ? undefined : legacyEnforcement(enforcement);
    const checked = mapped === 'action' || mapped === 'ship';
    const rule = await this.options.rules?.create('agent', {
      text,
      scope: this.resolveProposedScope(caller, scope),
      ...(mapped !== undefined ? { enforcement: mapped } : {}),
      ...(checked ? { check: { by: 'classifier', examples: examples ?? [] } } : {}),
      ...(critical !== undefined ? { critical } : {}),
      source: {
        by: 'agent',
        node: caller.stream,
        session,
        // A tell item has no check to hold them: keep them visible (T260).
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
          rule === undefined
            ? `rule proposed: ${text}`
            : `rule proposed (${formatKnowledgeScope(rule.scope)}): ${text}`,
        ref: rule === undefined ? 'rule_proposed' : `knowledge/${rule.id}.yaml`,
      },
      session,
    );
  }

  /** The scope grammar of `propose_rule`, resolved against the calling session's stream. */
  private resolveProposedScope(caller: VerbCaller, scope: string | undefined): KnowledgeScope {
    const stream = this.options.streams.get(caller.stream);
    const repoScope = (): KnowledgeScope => {
      if (stream.repo === undefined) {
        throw new Error(`propose_rule: scope "repo" needs a stream with a repo; this one has none`);
      }
      return { kind: 'repo', repo: stream.repo };
    };
    if (scope === undefined) {
      return stream.repo === undefined ? { kind: 'subtree', node: stream.id } : repoScope();
    }
    const trimmed = scope.trim();
    if (trimmed === 'repo') return repoScope();
    if (trimmed === 'stream' || trimmed === 'subtree') return { kind: 'subtree', node: stream.id };
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
    propose_rule: (input) => service.proposeRule(input),
    propose_next: (input) => service.proposeNext(input),
    read_stream: (input) => service.readStream(input),
    search_docs: (input) => service.searchDocs(input),
    test_run: (input) => service.testRun(input),
    read_event: (input) => service.readEvent(input),
    deliver: (input) => service.deliver(input),
  };
}
