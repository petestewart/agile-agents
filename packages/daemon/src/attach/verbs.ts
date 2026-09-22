/**
 * The eight MCP verbs an attached session gets (design/cockpit-design.md
 * §4.1). This is the whole agent-facing surface:
 *
 *   `ask` · `progress` · `finding` · `propose_rule` · `propose_next` ·
 *   `read_stream` · `search_docs` · `test_run`
 *
 * T130 replaced the tool *framework* (a tool is a folder with a
 * `tool.yaml`, a cache, a ledger kind and a promote-to-KB rule) with this
 * fixed table. What survives of the old framework is exactly one thing:
 * `test_run`'s output contract — "failing test names, assertions and the
 * relevant stack frames — never a green log".
 *
 * Identity: every verb names its `session`, and the session is resolved
 * through the agent registry (`bus/agents/<session>.yaml`, written by
 * `runner/session.ts` while the session is live) to its stream and
 * worktree. A session that has exited resolves to nothing and every verb
 * refuses — an agent cannot write to a stream it is no longer attached to.
 * Nothing here trusts a stream id from the caller.
 */

import {
  type AgentId,
  type AgentVerb,
  type RuleScope,
  type SessionRole,
  type StreamFinding,
  type ThreadEntry,
  formatRuleScope,
  parseRuleScope,
  validateVerbInput,
} from '@agile-agents/shared';
import type { DocsSearch, SearchHit } from '../docs/service';
import type { QuestionService } from '../questions/service';
import type { RulesService } from '../rules/service';
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
  /** T134's `DocsService` — `search_docs` is typed against the read side only. */
  docs?: DocsSearch;
  /** T140's `RulesService` — what `propose_rule` writes its proposal through. */
  rules?: RulesService;
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

  /** §1.4: a question is raised on the stream, routed by the session that asked (this closes T121's open issue). */
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

  /** A finding goes to the thread *and* to `agent.findings` (§4.2) — one is the narrative, the other is the list the cockpit groups. */
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
   * §5.1/**D4**: an agent may *propose* a rule — the record is written with
   * `status: 'proposed'` and provenance pointing back at this stream and
   * session, and `status`/`decided_*` stay human-only (the store rejects an
   * agent that tries). The proposal also keeps its thread entry, `ref`'d to
   * the rule's file: the thread is where a later reader sees *when* in the
   * work the rule was proposed, and the inbox `rule_accept` item (§3.1) is
   * where the human decides it.
   *
   * Scope (§5.1: "a rule learned on one repo must not silently govern
   * another") is taken from the verb's `scope` string — `global`,
   * `repo:<name>`, `stream:<id>`, or the bare words `repo`/`stream` meaning
   * *this* session's repo or stream. Omitted, it defaults to the narrowest
   * honest scope: this stream's repo when it has one, the stream itself
   * otherwise. Never global by default — widening a rule is the human's
   * call, and it is one edit away in the inbox.
   */
  async proposeRule(input: unknown): Promise<ThreadEntry> {
    const { session, text, scope } = validateVerbInput('propose_rule', input);
    const caller = this.caller(session);
    const rule = await this.options.rules?.create('agent', {
      text,
      scope: this.resolveProposedScope(caller, scope),
      provenance: { stream: caller.stream, session, by: `agent:${session}` },
    });
    return this.options.streams.appendThread(
      'agent',
      caller.stream,
      {
        kind: 'proposal',
        body:
          rule === undefined
            ? `rule proposed: ${text}`
            : `rule proposed (${formatRuleScope(rule.scope)}): ${text}`,
        ref: rule === undefined ? 'rule_proposed' : `rules/${rule.id}.yaml`,
      },
      session,
    );
  }

  /** The scope grammar of `propose_rule`, resolved against the calling session's stream. */
  private resolveProposedScope(caller: VerbCaller, scope: string | undefined): RuleScope {
    const stream = this.options.streams.get(caller.stream);
    const repoScope = (): RuleScope => {
      if (stream.repo === undefined) {
        throw new Error(`propose_rule: scope "repo" needs a stream with a repo; this one has none`);
      }
      return { kind: 'repo', ref: stream.repo };
    };
    if (scope === undefined) {
      return stream.repo === undefined ? { kind: 'stream', ref: stream.id } : repoScope();
    }
    const trimmed = scope.trim();
    if (trimmed === 'repo') return repoScope();
    if (trimmed === 'stream') return { kind: 'stream', ref: stream.id };
    return parseRuleScope(trimmed);
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

  /** Repo `.agile-docs/` plus this stream's own notes (T134). Empty when no docs service is wired. */
  async searchDocs(input: unknown): Promise<SearchHit[]> {
    const { session, query } = validateVerbInput('search_docs', input);
    const caller = this.caller(session);
    if (this.options.docs === undefined) return [];
    return this.options.docs.search(query, { stream: caller.stream });
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
  };
}
