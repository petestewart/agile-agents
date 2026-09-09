/**
 * `startAgentSession` — spawns one ACP session for an already-placed
 * worktree and wires it into the daemon (T012 — design/
 * agile-agents-design.md §8 "Adapter contract": "(ticket, oracle_refs,
 * kb_refs, worktree) -> (diff, report, status, ledger events)"; §4 "Ledger";
 * §5 "Liveness"; §6 tier 1/2 enforcement).
 *
 * Scope: this module owns exactly one running session's wiring — hook
 * settings, MCP config, permission responder, ledger, event log, heartbeat,
 * registration, and exit/crash handling. `runner.ts` owns *which* worktree
 * and ticket state transition a call to `spawn()` implies; this module just
 * runs the session once handed a worktree path and a rendered brief.
 *
 * `AgentRecord.pid` (DESIGN-GAP): `@agile-agents/acp-client`'s
 * `SpawnedSession` (packages/acp-client/src/session.ts) never exposes the
 * spawned child's OS pid — Terma's `AcpSession` didn't either, and adding it
 * is a `packages/acp-client` change outside this ticket's file ownership.
 * Registration therefore omits `pid` from the heartbeat patch and lets
 * `StateStore.heartbeat`'s existing fallback (`patch.pid ?? existing?.pid ??
 * process.pid`) supply the *daemon's* pid instead of the agent subprocess's
 * — informational only; nothing in this codebase does OS-level operations
 * (kill, monitor) against `AgentRecord.pid` today (grepped: only
 * `cli/status`/`cli/daemon` print it). The crash test drives a real kill
 * against the fake agent's own pid independently (see `fake-agent.ts` and
 * `runner.test.ts`), not through this field.
 *
 * `role`/`worktree`/`session_id` survival (DESIGN-GAP): `StateStore.heartbeat`
 * and `Bus.heartbeat` (both outside this ticket's file ownership) rebuild
 * `AgentRecord` from only its five original fields on every write past the
 * 30s coalescing window, silently dropping any other field already on disk.
 * `recordHeartbeat` below (a) registers the full record once via
 * `store.putAgent` at start, then (b) after every `bus.heartbeat()` call,
 * re-applies `role`/`worktree`/`session_id` via `store.putAgent` whenever the
 * heartbeat's own write actually happened and dropped them (cheap: reading
 * the just-written record back is a plain file read, and the extra
 * `putAgent` only fires on the writes that need it, not on every coalesced
 * no-op).
 *
 * `tool_call` observation (DESIGN-GAP): `@agile-agents/shared`'s
 * `EVENT_KINDS` (packages/shared/src/event.ts) has no kind for "an ACP
 * `tool_call`/`tool_call_update` was observed" — every existing kind names a
 * specific store mutation, and `event.ts` is outside this ticket's file
 * ownership. `entity_put` is reused (event.ts's own doc comment names it as
 * the bucket for "any future entity with no dedicated helper yet") purely as
 * an event-log marker — no entity file is written alongside it. Escalated in
 * the pipeline report: a dedicated `tool_call` `EventKind` is the correct
 * fix, gated on `packages/shared/src/event.ts` file ownership.
 */

import {
  ACP_PROVIDERS,
  type AcpProviderConfig,
  type AgentEvent,
  type SpawnSessionOptions,
  type SpawnedSession,
  spawnSession as defaultSpawnSession,
} from '@agile-agents/acp-client';
import type { AgentId, LedgerKind, TicketId } from '@agile-agents/shared';
import { ulid, validateLedgerLine } from '@agile-agents/shared';
import type { Bus } from '../bus';
import { pickCurrentSprint } from '../feed';
import type { GateService } from '../gates';
import { writeClaudeSettings } from '../hook';
import {
  type AcpPermissionRequestParams,
  type PermissionResponderHandle,
  type PermissionRole,
  buildPermissionResponder,
} from '../permissions';
import { buildEvent } from '../store';
import type { StateStore } from '../store';

const ROLE_LEDGER_KIND: Record<PermissionRole, LedgerKind> = {
  engineer: 'engineer',
  reviewer: 'review',
  qa: 'qa',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export interface AgentSessionOptions {
  store: StateStore;
  bus: Bus;
  role: PermissionRole;
  agentId: AgentId;
  ticket: TicketId;
  /** Absolute path — the session's `cwd` and where `.claude/settings.json` is written. */
  worktreePath: string;
  /** Rendered role brief (`brief.ts`) — sent as the first `prompt()`. */
  brief: string;
  /** Path/name of the `agile` CLI binary, for both the hook command and the MCP server's stdio command. Defaults to `'agile'` (on `$PATH`). */
  cliBin?: string;
  /** `AGILE_SOCKET_PATH` for the worktree's hook + MCP bridge, when the worktree's own `git rev-parse --show-toplevel` wouldn't already resolve to the main repo (every `.worktrees/**` ticket worktree). */
  socketPath?: string;
  provider?: AcpProviderConfig;
  /** Resolves the current sprint id for ledger filing — same convention as `ToolService.currentSprintId`. */
  currentSprintId?: () => string | undefined;
  /** Optional — hands `hil` permission verdicts to T018's `GateService` instead of the responder's default store-backed writer. */
  gateService?: GateService;
  /** Test seam: inject a fake `spawnSession` (the fake-agent helper) instead of the real ACP client. */
  spawn?: typeof defaultSpawnSession;
  now?: () => Date;
  hookTimeoutSeconds?: number;
}

export interface AgentExitInfo {
  agentId: AgentId;
  ticket: TicketId;
  /** Human-readable reason recorded on the ticket's history and the escalate message. */
  reason: string;
  /** Whether the ticket was actually transitioned back to `ready` (false if it wasn't in a live status any more — already reviewed/QA'd/done out from under the exit). */
  ticketReadied: boolean;
}

export interface AgentSessionHandle {
  agentId: AgentId;
  ticket: TicketId;
  role: PermissionRole;
  worktree: string;
  session: SpawnedSession;
  responder: PermissionResponderHandle;
  /** Resolves once the process has exited/crashed *and* the exit/crash handling (ticket -> ready, escalate, deleteAgent) has finished. Never rejects. */
  exited: Promise<AgentExitInfo>;
  /** `session.cancel()` + `session.close()`, for a graceful stop (`runner.stop`) — does not itself run the exit/crash handling (that's `exited`, driven by the session's own `exit` event either way). */
  stop(): void;
}

/** Builds the MCP stdio server entry T011's report specifies: `agile mcp --agent <id> --ticket <id>`. */
function mcpServerConfig(cliBin: string, agentId: AgentId, ticket: TicketId): unknown {
  return {
    name: 'agile',
    command: cliBin,
    args: ['mcp', '--agent', agentId, '--ticket', ticket],
  };
}

/** Best-effort model id from the `_agile/session_state` notification's `configOptions` — shape is vendor-specific and not modeled anywhere; falls back to `'unknown'` rather than guessing at a field name that isn't there. */
function modelFromSessionState(params: unknown): string | undefined {
  const p = asRecord(params);
  const configOptions = p?.configOptions;
  if (Array.isArray(configOptions)) {
    for (const opt of configOptions) {
      const o = asRecord(opt);
      if (typeof o?.model === 'string') return o.model;
      if (typeof o?.currentValue === 'string' && o?.id === 'model') return o.currentValue;
    }
  }
  const record = asRecord(configOptions);
  if (typeof record?.model === 'string') return record.model;
  return undefined;
}

export function startAgentSession(opts: AgentSessionOptions): AgentSessionHandle {
  const {
    store,
    bus,
    role,
    agentId,
    ticket,
    worktreePath,
    brief,
    gateService,
    now = () => new Date(),
  } = opts;
  const cliBin = opts.cliBin ?? 'agile';
  const provider = opts.provider ?? ACP_PROVIDERS.claude;
  const spawn = opts.spawn ?? defaultSpawnSession;
  const currentSprintId =
    opts.currentSprintId ?? (() => pickCurrentSprint(store.listSprints())?.id);

  // Tier 1 (§6): hook wiring active before the agent's first tool call.
  writeClaudeSettings(worktreePath, {
    agileBin: cliBin,
    socketPath: opts.socketPath,
    timeoutSeconds: opts.hookTimeoutSeconds,
  });

  const spawnOptions: SpawnSessionOptions = {
    cmd: provider.command,
    args: [...provider.args],
    cwd: worktreePath,
    envOverrides: {
      ...provider.envOverrides,
      AGILE_AGENT: agentId,
      AGILE_TICKET: ticket,
      ...(opts.socketPath ? { AGILE_SOCKET_PATH: opts.socketPath } : {}),
    },
    clientCapabilities: provider.clientCapabilities,
    mcpServers: [mcpServerConfig(cliBin, agentId, ticket)],
    modeId: 'default',
  };
  const session = spawn(spawnOptions);

  const responder = buildPermissionResponder(store, {
    role,
    ticket,
    agent: agentId,
    worktreePath,
    session,
    ...(gateService
      ? {
          requestHil: (input) =>
            gateService
              .request(`permission:${role}`, {
                policy: store.getPolicy(),
                ticket: input.ticket,
                hilKind: input.hilKind,
                from: input.agent,
              })
              .then((req) => ({ id: req.id })),
        }
      : {}),
  });

  let model = 'unknown';
  let lastUsedTokens = 0;
  let settled = false;
  let resolveExited!: (info: AgentExitInfo) => void;
  const exited = new Promise<AgentExitInfo>((resolve) => {
    resolveExited = resolve;
  });

  /**
   * Every fire-and-forget store write this module makes (heartbeat, ledger,
   * tool_call observation) is chained onto this promise. `finish()` awaits
   * the latest link before resolving `exited` — since `StateStore`'s mutex
   * processes writes strictly in the order they were enqueued, awaiting the
   * *last* one enqueued guarantees every earlier one has already landed too.
   * Without this, a test (or a caller) that deletes the worktree/repo right
   * after `exited` resolves can race a still-in-flight deferred commit into
   * a "not a git repository" error — the failure this tracker exists to
   * close off.
   */
  let pendingWrites: Promise<unknown> = Promise.resolve();
  function track(promise: Promise<unknown>): void {
    pendingWrites = promise.catch(() => {});
  }

  /** Re-applies role/worktree/session_id if the heartbeat write just dropped them (see file header). */
  async function recordHeartbeat(patch: { vendor?: string; model?: string } = {}): Promise<void> {
    await bus.heartbeat(agentId, { vendor: provider.id, model, ticket, ...patch });
    let current: ReturnType<StateStore['getAgent']> | undefined;
    try {
      current = store.getAgent(agentId);
    } catch {
      return;
    }
    if (
      current.role === role &&
      current.worktree === worktreePath &&
      (session.sessionId === null || current.session_id === session.sessionId)
    ) {
      return;
    }
    await store.putAgent(agentId, {
      ...current,
      role,
      worktree: worktreePath,
      ...(session.sessionId !== null ? { session_id: session.sessionId } : {}),
    });
  }

  async function finish(reason: string): Promise<void> {
    if (settled) return;
    settled = true;
    unsubscribe();
    // See `pendingWrites`'s doc comment — every earlier fire-and-forget
    // write is guaranteed to have landed by the time this resolves.
    await pendingWrites;

    let ticketReadied = false;
    try {
      const current = store.getTicket(ticket);
      const LIVE_STATUSES = new Set(['assigned', 'in_progress', 'in_review', 'in_qa', 'blocked']);
      if (LIVE_STATUSES.has(current.status)) {
        await store.transitionTicket(ticket, 'ready', { by: agentId, reason });
        ticketReadied = true;
      }
    } catch {
      // Ticket vanished or transition illegal from under us — nothing to ripple back.
    }

    await bus.send({
      id: ulid(),
      ts: now().toISOString(),
      from: agentId,
      to: ['em'],
      kind: 'escalate',
      priority: 'urgent',
      ticket,
      body: `${agentId} (${role}) session ended: ${reason}`.slice(0, 800),
      requires_ack: true,
    });

    try {
      store.getAgent(agentId);
      await store.deleteAgent(agentId);
    } catch {
      // Already gone (e.g. `checkLiveness` beat us to it) — fine.
    }

    // Flushes any deferred-commit ledger/tool_call writes queued earlier in
    // this session's life (store.ts's "Deferred-commit batching") — without
    // this, `exited` can resolve while a background flush timer is still
    // due, and a caller that tears down the worktree/repo right after
    // `exited` races that timer into a "not a git repository" failure.
    await store.flush();
    resolveExited({ agentId, ticket, reason, ticketReadied });
  }

  const unsubscribe = session.on((event: AgentEvent) => {
    track(recordHeartbeat());

    if (event.type === 'exit') {
      void finish(`process exited (code ${event.exitCode})`);
      return;
    }
    if (event.type === 'error') {
      void finish(`transport error: ${event.message}`);
      return;
    }

    const frame = event.event;
    if (frame.acp === 'request' && frame.method === 'session/request_permission') {
      void responder.handleRequest(frame.id, frame.params as AcpPermissionRequestParams);
      return;
    }

    if (frame.acp === 'notification' && frame.message.method === '_agile/session_state') {
      const p = asRecord(frame.message.params);
      const resolvedModel = modelFromSessionState(p);
      if (resolvedModel !== undefined) {
        model = resolvedModel;
        track(recordHeartbeat({ model: resolvedModel }));
      }
      const sessionId = p?.sessionId;
      if (typeof sessionId === 'string') {
        try {
          const current = store.getAgent(agentId);
          track(store.putAgent(agentId, { ...current, session_id: sessionId }));
        } catch {
          // Not registered yet — the initial `putAgent` below will carry session_id once known.
        }
      }
      return;
    }

    if (frame.acp === 'notification' && frame.message.method === 'session/update') {
      const params = asRecord(frame.message.params);
      const update = asRecord(params?.update);
      const kind = update?.sessionUpdate;

      if (kind === 'usage_update') {
        const used = typeof update?.used === 'number' ? update.used : undefined;
        if (used !== undefined) {
          // DESIGN-GAP (file header): `usage_update` carries only
          // `{used, size}` — a running context-window total, not an
          // in/out split or a cost. `in_tokens` is the delta since the
          // last update (0 on the very first one, or if the counter went
          // backwards, e.g. a fresh turn); `out_tokens`/`cost_usd` stay 0.
          const delta = Math.max(0, used - lastUsedTokens);
          lastUsedTokens = used;
          const sprint = currentSprintId();
          if (sprint !== undefined) {
            track(
              store.appendLedgerLine(
                sprint,
                validateLedgerLine({
                  ts: now().toISOString(),
                  sprint,
                  ticket,
                  agent: agentId,
                  model,
                  in_tokens: delta,
                  out_tokens: 0,
                  cost_usd: 0,
                  kind: ROLE_LEDGER_KIND[role],
                }),
                { commit: 'deferred' },
              ),
            );
          }
        }
        return;
      }

      if (kind === 'tool_call' || kind === 'tool_call_update') {
        track(
          store.appendEvent(
            buildEvent('entity_put', {
              ticket,
              agent: agentId,
              data: {
                // See file header: `entity_put` is a documented stand-in for
                // the missing dedicated `tool_call` EventKind.
                observation: 'tool_call',
                sessionUpdate: kind,
                toolCallId: update?.toolCallId,
                toolKind: update?.kind,
                title: update?.title,
                status: update?.status,
              },
            }),
            { commit: 'deferred' },
          ),
        );
      }
    }
  });

  // Registration (§5 "Storage": agents/<agent>.yaml) — before the first
  // prompt, so a crash during the very first turn still has a record to
  // clean up.
  void store
    .putAgent(agentId, {
      vendor: provider.id,
      model,
      ticket,
      pid: process.pid,
      last_seen: now().toISOString(),
      role,
      worktree: worktreePath,
    })
    .then(() => session.prompt(brief))
    .catch(() => {
      // A failed registration or a rejected first prompt both surface
      // through the session's own `exit`/`error` events (acp-client settles
      // any reserved turn on close/exit) — nothing further to do here.
    });

  return {
    agentId,
    ticket,
    role,
    worktree: worktreePath,
    session,
    responder,
    exited,
    stop() {
      // Deliberately does NOT call `unsubscribe()` here — `close()` only
      // *starts* tearing the process down (SIGTERM, escalating to SIGKILL
      // after a grace period); the exit/crash handling in `finish()` runs
      // off the session's own later `exit` event, through the same listener
      // a real crash drives. Unsubscribing here would silence that event
      // and `exited` would never resolve.
      session.cancel();
      session.close();
    },
  };
}
