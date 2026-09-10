/**
 * EM-session gate delegate (`--live`).
 *
 * `GateService` resolves an `em`/`architect`-owned gate through its
 * `delegate` and fails closed without one: `--fake` injects an
 * auto-approver, and a real run had nothing, so every em-owned request
 * (`unblock` from the PreToolUse hook, `approve_plan`, ...) parked as
 * `pending: no delegate configured` for the rest of the run (first live
 * runs, 2026-09-10). The EM in this system is a role brief (`briefs/em.md`),
 * not a standing session, so its decisions are taken the way
 * `em/live.test.ts` already exercises the brief: a one-shot vendor session,
 * prompted with the real EM brief plus the request, answering with a
 * rationale and a final `DECISION: approve|deny` line.
 *
 * Async by design (`DelegateFn` may return a promise): the hook that raised
 * an `unblock` request has a 5 s budget to answer Claude and cannot wait on
 * a model turn, so the request is persisted `pending` immediately and
 * resolved when this settles. Fail closed on every failure mode — spawn
 * error, timeout, an answer with no decision line — so an unanswerable
 * gate denies with the failure as the rationale instead of hanging.
 */

import {
  type AcpProviderConfig,
  type SpawnSessionOptions,
  type SpawnedSession,
  spawnSession as defaultSpawnSession,
  resolveAcpProvider,
} from '@agile-agents/acp-client';
import type { Policy, Sprint } from '@agile-agents/shared';
import { renderEmBrief } from '../briefs';
import type { DelegateContext, DelegateFn, GateDecision } from '../gates';
import { openStderrLog } from '../runner/session';
import { NotFoundError, StateStore } from '../store';

export interface EmSessionDelegateOptions {
  /** `.agile/` root — the policy and sprint the brief renders from are read fresh per decision. */
  stateRoot: string;
  /** The session's cwd (repo root). The EM session has no MCP tools and no worktree. */
  cwd: string;
  provider?: AcpProviderConfig;
  /** Test seam: the fake-agent spawn (`runner/fake-agent.ts`'s `agent_text` step answers). */
  spawn?: (opts: SpawnSessionOptions) => SpawnedSession;
  /** Whole-decision budget (spawn + handshake + one turn). Default 90 s. */
  timeoutMs?: number;
  /** Progress notices (`agile run --live` prints them). */
  onNotice?: (line: string) => void;
  /** Where the EM session's stderr goes (`openStderrLog`, one file per decision: `em-<ts>.stderr.log`). The sixth live run's EM session went silent for six minutes with nothing on record. */
  stderrLogDir?: string;
}

export const DEFAULT_EM_DECISION_TIMEOUT_MS = 90_000;

const DECISION_LINE = /^\s*DECISION:\s*(approve|deny)\b[^\n]*$/im;

/** Extracts the verdict from an EM reply: the LAST `DECISION: approve|deny` line, with the text before it as the rationale. `undefined` when the reply has no decision line. */
export function parseEmDecision(
  text: string,
): { decision: 'approve' | 'deny'; rationale: string } | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = DECISION_LINE.exec(lines[i] ?? '');
    if (!m) continue;
    const decision = (m[1] ?? '').toLowerCase() as 'approve' | 'deny';
    const rationale = lines.slice(0, i).join('\n').trim().replace(/\s+/g, ' ').slice(0, 600);
    return { decision, rationale };
  }
  return undefined;
}

function latestSprint(store: StateStore): Sprint {
  const sprints = store.listSprints();
  const latest = [...sprints].sort((a, b) => b.started.localeCompare(a.started))[0];
  if (latest) return latest;
  return {
    id: 'S-0',
    goal: '(no sprint planned yet)',
    tickets: [],
    budget_tokens: 0,
    started: new Date(0).toISOString(),
    carried_over: [],
  } as unknown as Sprint;
}

function policyOrDefault(store: StateStore): Policy {
  try {
    return store.getPolicy();
  } catch (err) {
    if (err instanceof NotFoundError) return { gates: {}, breaker_signals: [] };
    throw err;
  }
}

/** The prompt an EM session gets for one gate decision: the real EM brief, then the request, then the answer format. Exported for the test and for `agile run --live`'s notice. */
export function renderEmDecisionPrompt(store: StateStore, ctx: DelegateContext): string {
  const brief = renderEmBrief({
    agent: 'em',
    sprint: latestSprint(store),
    policy: policyOrDefault(store),
  });
  const ticket = ctx.ticket ? ` for ticket ${ctx.ticket}` : '';
  return [
    brief,
    '',
    '## Gate decision requested',
    `The daemon needs your decision on a \`${ctx.gate}\` gate (kind: ${ctx.hilKind ?? 'unknown'})${ticket}. Policy makes \`${ctx.owner}\` the owner of this gate, and you are deciding as the EM.`,
    `What was asked: ${ctx.summary ?? '(no summary recorded)'}`,
    '',
    'Decide as the EM would: approve when the request is safe, reversible or scoped to the ticket’s own branch/worktree, and consistent with the sprint goal; deny when it touches shared branches, installs or deletes outside the worktree, or is not something the ticket needs. Do not run tools — decide from the text.',
    'Answer with a one-paragraph rationale, then a final line that is exactly `DECISION: approve` or `DECISION: deny`.',
  ].join('\n');
}

/** Builds the delegate. Each call spawns a fresh vendor session, prompts once, parses the verdict, closes the session. */
export function createEmSessionDelegate(options: EmSessionDelegateOptions): DelegateFn {
  const provider = options.provider ?? resolveAcpProvider(undefined);
  const spawn = options.spawn ?? ((opts: SpawnSessionOptions) => defaultSpawnSession(opts));
  const timeoutMs = options.timeoutMs ?? DEFAULT_EM_DECISION_TIMEOUT_MS;
  const notice = options.onNotice ?? (() => {});

  return async (ctx): Promise<GateDecision> => {
    const store = StateStore.open(options.stateRoot);
    const prompt = renderEmDecisionPrompt(store, ctx);
    notice(
      `agile run --live: EM deciding gate ${ctx.gate}${ctx.ticket ? ` (${ctx.ticket})` : ''}...`,
    );
    let session: SpawnedSession | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const decided = (async () => {
        const stderrLog = openStderrLog(options.stderrLogDir, 'em', new Date());
        if (stderrLog) notice(`agile run --live: EM session stderr -> ${stderrLog.path}`);
        session = spawn({
          cmd: provider.command,
          args: [...provider.args],
          cwd: options.cwd,
          envOverrides: provider.envOverrides,
          clientCapabilities: provider.clientCapabilities,
          mcpServers: [],
          ...(stderrLog ? { onStderr: stderrLog.append } : {}),
          ...(provider.defaultModeId !== undefined ? { modeId: provider.defaultModeId } : {}),
        });
        await session.initialized;
        const reply = await session.prompt(prompt);
        if (reply.status !== 'completed' && reply.error) {
          throw new Error(`EM session turn failed: ${reply.error.message ?? reply.status}`);
        }
        const parsed = parseEmDecision(reply.text);
        if (!parsed) {
          throw new Error(
            `EM session answered without a DECISION line: ${reply.text.trim().slice(0, 200) || '(empty)'}`,
          );
        }
        return parsed;
      })();
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`EM session decision timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      const parsed = await Promise.race([decided, timeout]);
      notice(
        `agile run --live: EM ${parsed.decision === 'approve' ? 'approved' : 'denied'} gate ${ctx.gate}${ctx.ticket ? ` (${ctx.ticket})` : ''}${parsed.rationale ? ` — ${parsed.rationale.slice(0, 200)}` : ''}`,
      );
      return { decision: parsed.decision, by: 'em', rationale: parsed.rationale || undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notice(
        `agile run --live: EM could not decide gate ${ctx.gate}: ${message} — denying (fail closed)`,
      );
      return { decision: 'deny', by: 'em', rationale: `fail closed: ${message}` };
    } finally {
      if (timer) clearTimeout(timer);
      session?.close();
    }
  };
}
