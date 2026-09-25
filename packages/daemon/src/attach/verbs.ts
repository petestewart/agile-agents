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
  type KnowledgeScope,
  type RoutedEvent,
  type SessionRole,
  type StreamFinding,
  type ThreadEntry,
  formatKnowledgeScope,
  parseKnowledgeScope,
  quoteThreadBody,
  validateVerbInput,
  withExamplesNote,
} from '@agile-agents/shared';
import type { DocsSearch, SearchHit } from '../docs/service';
import { summaryOf } from '../events/delivery';
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
      // T330: an agent line may run to 16k chars; the tool result quotes the head.
      entries: page.entries
        .slice(-take)
        .map((entry) => ({ ...entry, body: quoteThreadBody(entry.body) })),
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
  };
}
