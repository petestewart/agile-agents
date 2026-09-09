/**
 * The `agile` Pi extension (T022 — design/agile-agents-design.md §22 scope;
 * design/spike-findings.md §C4). Installed verbatim (this file's own source,
 * copied byte-for-byte by `install.ts`) to `~/.pi/agent/extensions/agile.ts`
 * so it loads for every local `pi` session, not just ones the daemon spawns
 * — the "self-guarding on a daemon-set env var" requirement (this file's
 * `GATE_ENV_VAR`) is what keeps it a no-op for a human's own interactive
 * `pi` sessions.
 *
 * Self-contained by design: once installed this file runs inside `pi`'s own
 * process, not this monorepo's — it can depend on **nothing but Node
 * builtins** (no `@agile-agents/*` import survives being copied out). Types
 * from `@earendil-works/pi-coding-agent` aren't imported for the same
 * reason (adding it as a real dependency would only type-check the
 * *source* copy, not the one actually loaded by `pi`); the handful of
 * fields this file touches are typed locally instead, verified by hand
 * against `node_modules/@earendil-works/pi-coding-agent@0.85.1/dist/core/
 * extensions/types.d.ts` during T022's verify-before-build (that package
 * version matches design/spike-findings.md §C4's "pi-mono 0.85.1").
 *
 * Enforcement seam: rather than re-deriving Pi's own halt/inbox/budget/role
 * policy, `tool_call` forwards to the exact same `hook.pre_tool_use` RPC
 * method Claude's `.claude/settings.json` PreToolUse hook calls
 * (`packages/daemon/src/hook/service.ts` — same decision tiers: halt,
 * urgent inbox, budget, role×tool policy, §6's tier table) and translates
 * its Claude-shaped `hookSpecificOutput` reply into Pi's `{block, reason}`
 * `tool_call` result. Liveness heartbeat rides on that same call (`bus.
 * heartbeat` rides on `hook.pre_tool_use` daemon-side — §5 "Liveness"), so
 * no separate per-tool-call heartbeat RPC is needed; a periodic timer
 * (`HEARTBEAT_INTERVAL_MS`) covers long, tool-call-free turns (a plan/
 * thinking-only stretch past the 30s heartbeat tunable — CLAUDE.md
 * "Tunables (initial): heartbeat 30 s").
 *
 * `tool_result` rewriting is the one thing Claude's hook tier cannot do at
 * all (`hook/service.ts`'s own DESIGN-GAP: "Claude's PostToolUse hook cannot
 * rewrite `tool_response`") but Pi's extension API can (spike-findings.md
 * §C4: "`tool_result` handlers can replace tool output before the LLM sees
 * it"), so `summarizeTestOutputIfNeeded` runs locally (no daemon round trip
 * needed for the rewrite decision itself) alongside a `hook.post_tool_use`
 * call for the same ledger/usage recording Claude gets.
 *
 * Halts and urgent inbox messages are delivered as the *reason* on a denied
 * `tool_call` (same as Claude — the deny reason is the delivery, per
 * `decide.ts`'s own header). Normal-priority inbox messages have no
 * `tool_call`-result field to ride on (Pi's `ToolCallEventResult` is just
 * `{block, reason, terminate}` — no Claude-style `additionalContext`), so
 * they're delivered instead via `before_agent_start`'s `message` result,
 * once per turn, acked the same way `decide.ts` acks them for Claude.
 */

import { connect } from 'node:net';

// ---------------------------------------------------------------------------
// Config — read once at extension load, from env vars the daemon sets when
// it spawns a Pi session (`session.ts`'s `envOverrides`, mirroring how
// `AGILE_AGENT`/`AGILE_TICKET`/`AGILE_SOCKET_PATH` already flow into every
// other adapter).
// ---------------------------------------------------------------------------

/** Set to `'1'` by the daemon on every Pi session it spawns; absent (or any other value) for a human's own interactive `pi` — the extension registers nothing at all in that case. */
export const GATE_ENV_VAR = 'AGILE_PI_GATE';

export interface AgileExtensionEnv {
  AGILE_PI_GATE?: string;
  AGILE_SOCKET_PATH?: string;
  AGILE_AGENT?: string;
  AGILE_TICKET?: string;
}

/** Default heartbeat cadence — CLAUDE.md "Tunables (initial): heartbeat 30 s". */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Above this many characters, a test-run-shaped `bash` result is distilled instead of passed through raw (§7 "signal over volume"; `tools/test-run.ts`'s own raw-output-to-file convention is the MCP-tool-path analogue — this is the harness-path one, unique to Pi per spike-findings.md §C4). */
export const TEST_OUTPUT_REWRITE_THRESHOLD = 2000;

/** How many trailing lines of a distilled test run to keep verbatim (the failure tail is almost always what's needed next). */
const TEST_OUTPUT_TAIL_LINES = 40;

// ---------------------------------------------------------------------------
// Minimal local typings for the slice of the Pi extension API this file
// uses — see the file header for why these aren't imported from the real
// package.
// ---------------------------------------------------------------------------

export interface PiToolCallEvent {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface PiToolCallResult {
  block?: boolean;
  reason?: string;
}

export interface PiTextContent {
  type: 'text';
  text: string;
}

export interface PiToolResultEvent {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: PiTextContent[];
  isError: boolean;
}

export interface PiToolResultEventResult {
  content?: PiTextContent[];
}

export interface PiBeforeAgentStartEvent {
  type: 'before_agent_start';
  prompt: string;
}

export interface PiBeforeAgentStartResult {
  message?: {
    customType: string;
    content: PiTextContent[];
    display?: string;
  };
}

export interface PiExtensionContext {
  cwd: string;
}

export type PiHandler<E, R> = (
  event: E,
  ctx: PiExtensionContext,
) => Promise<R | undefined> | R | undefined;

export interface PiExtensionApi {
  on(event: 'tool_call', handler: PiHandler<PiToolCallEvent, PiToolCallResult>): void;
  on(event: 'tool_result', handler: PiHandler<PiToolResultEvent, PiToolResultEventResult>): void;
  on(
    event: 'before_agent_start',
    handler: PiHandler<PiBeforeAgentStartEvent, PiBeforeAgentStartResult>,
  ): void;
  on(event: 'agent_settled', handler: PiHandler<{ type: 'agent_settled' }, void>): void;
  on(event: 'session_shutdown', handler: PiHandler<{ type: 'session_shutdown' }, void>): void;
}

// ---------------------------------------------------------------------------
// Minimal self-contained unix-socket JSON-RPC 2.0 client — deliberately not
// imported from `packages/cli/src/client.ts`'s `callRpc` (same wire format,
// same one-request-per-connection shape) because this file has to survive
// being copied out of the monorepo with zero workspace imports. Kept small;
// any divergence from `client.ts`'s behaviour should be treated as a bug in
// one of the two, not an intentional difference.
// ---------------------------------------------------------------------------

export interface RpcClient {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

let rpcId = 1;

export function createSocketRpcClient(socketPath: string, timeoutMs = 5000): RpcClient {
  return {
    call<T>(method: string, params?: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const id = rpcId++;
        const socket = connect(socketPath);
        let buffer = '';
        let settled = false;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          fn();
        };

        const timer = setTimeout(() => {
          finish(() => reject(new Error(`agile pi extension: timed out calling ${method}`)));
        }, timeoutMs);

        socket.on('error', (err: Error) => {
          finish(() => reject(new Error(`agile pi extension: ${method}: ${err.message}`)));
        });
        socket.on('close', () => {
          finish(() =>
            reject(
              new Error(
                `agile pi extension: daemon closed connection before replying to ${method}`,
              ),
            ),
          );
        });
        socket.on('connect', () => {
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          let nl = buffer.indexOf('\n');
          while (nl !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf('\n');
            if (!line) continue;
            let parsed: { id?: unknown; result?: unknown; error?: { message?: string } };
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }
            if (parsed.id !== id) continue;
            finish(() => {
              if (parsed.error) {
                reject(new Error(`agile pi extension: ${method}: ${parsed.error?.message}`));
              } else {
                resolve(parsed.result as T);
              }
            });
            return;
          }
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Pure logic — unit-testable with no socket/process involved.
// ---------------------------------------------------------------------------

/** Claude-shaped `hook.pre_tool_use` reply (`hook/service.ts`'s actual JSON contract) — only the fields this file reads. */
export interface HookPreToolUseReply {
  hookSpecificOutput?: {
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
}

/**
 * Translates the daemon's Claude-shaped `hook.pre_tool_use` verdict into
 * Pi's `tool_call` result. `ask` has no synchronous human-in-the-loop
 * channel from a Pi `tool_call` handler back to the daemon's `GateService`
 * today (DESIGN-GAP — `ExtensionContext.ui.confirm` exists but only asks
 * the *local* Pi user, not the daemon's HIL queue), so it fails safe as a
 * deny with the same reason, per CLAUDE.md's own "fail-safe over-deny"
 * precedent (T029's header) rather than silently allowing.
 */
export function toPiToolCallResult(reply: HookPreToolUseReply): PiToolCallResult {
  const out = reply.hookSpecificOutput;
  if (!out || out.permissionDecision === 'allow' || out.permissionDecision === undefined) {
    return {};
  }
  return { block: true, reason: out.permissionDecisionReason ?? 'AGILE-GATE: blocked' };
}

/** `bash` (or any tool) invocations whose command text looks like it ran a test suite — the only class `tool_result` rewriting targets, per this ticket's scope ("`tool_result` rewriting for `test_run`-class outputs"). */
const TEST_COMMAND_PATTERN =
  /\b(npm|pnpm|yarn|bun|go|cargo|pytest|jest|vitest|mocha|rspec|gradle|mvn)\b.*\btest\b|\bpytest\b|\bjest\b|\bvitest\b|\bgo test\b/i;

export function looksLikeTestRun(toolName: string, input: Record<string, unknown>): boolean {
  const command = input.command;
  return toolName === 'bash' && typeof command === 'string' && TEST_COMMAND_PATTERN.test(command);
}

export interface SummarizedOutput {
  text: string;
  rewritten: boolean;
}

/**
 * Distills a large test-run output into a pass/fail-oriented summary plus
 * a verbatim tail — the "test_run-class outputs" rewrite named in this
 * ticket's scope, and the harness-side analogue of `tools/test-run.ts`'s
 * MCP-tool-path summarization (signal over volume, CLAUDE.md). Below
 * `TEST_OUTPUT_REWRITE_THRESHOLD` the text passes through unchanged — most
 * green single-package runs are short enough already.
 */
export function summarizeTestOutput(text: string): SummarizedOutput {
  if (text.length <= TEST_OUTPUT_REWRITE_THRESHOLD) return { text, rewritten: false };

  const lines = text.split('\n');
  const FAIL_PATTERN = /fail|error|✗|✕|AssertionError/i;
  const PASS_PATTERN = /pass|✓|✔|\bok\b/i;
  let failing = 0;
  let passing = 0;
  for (const line of lines) {
    if (FAIL_PATTERN.test(line)) failing++;
    else if (PASS_PATTERN.test(line)) passing++;
  }
  const tail = lines.slice(-TEST_OUTPUT_TAIL_LINES).join('\n');
  const summary =
    `AGILE-SUMMARY: test run output was ${text.length} bytes ` +
    `(~${passing} pass-looking / ${failing} fail-looking lines); ` +
    `showing the last ${Math.min(TEST_OUTPUT_TAIL_LINES, lines.length)} lines:\n\n${tail}`;
  return { text: summary, rewritten: true };
}

/** Concatenates normal-priority inbox bodies up to a cap — same pointer-not-payload shape as `decide.ts`'s `buildAdditionalContext`, reimplemented locally since this file can't import that one. */
export function formatInboxMessage(
  messages: Array<{ kind: string; from: string; body: string }>,
  maxChars = 4000,
): string {
  const lines: string[] = [];
  let total = 0;
  for (const m of messages) {
    const line = `[${m.kind} from ${m.from}] ${m.body}`;
    if (total + line.length > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The extension factory itself.
// ---------------------------------------------------------------------------

export interface CreateAgileExtensionOptions {
  env?: AgileExtensionEnv;
  /** Test seam — defaults to `createSocketRpcClient(env.AGILE_SOCKET_PATH)`. */
  rpc?: RpcClient;
  heartbeatIntervalMs?: number;
}

/**
 * Builds the extension factory. `install.ts` never calls this directly —
 * it copies this *file's own source* to `~/.pi/agent/extensions/agile.ts`,
 * where `pi`'s extension loader imports it and calls the default export
 * with its own `ExtensionAPI`. This function exists so the same wiring is
 * unit-testable in this repo against a fake `pi` + a real `startRpcServer`
 * (`agile-extension.test.ts`), without needing an actual `pi` process.
 */
export function createAgileExtension(opts: CreateAgileExtensionOptions = {}) {
  return function agileExtension(pi: PiExtensionApi): void {
    const env = opts.env ?? (process.env as AgileExtensionEnv);
    if (env[GATE_ENV_VAR] !== '1') return; // Not an agile-spawned session — no-op, per the file header.

    const socketPath = env.AGILE_SOCKET_PATH;
    const agent = env.AGILE_AGENT;
    const ticket = env.AGILE_TICKET;
    if (!socketPath || !agent) return; // Nothing to gate against — fail closed by registering nothing rather than crashing pi's extension loader.

    const rpc = opts.rpc ?? createSocketRpcClient(socketPath);

    const heartbeat = () => {
      void rpc.call('bus.heartbeat', { agent, patch: { ticket } }).catch(() => {
        // Best-effort — a missed heartbeat surfaces via the daemon's own
        // liveness sweep (§5), not as a crash in the agent's own process.
      });
    };

    pi.on('tool_call', async (event, ctx): Promise<PiToolCallResult> => {
      try {
        const reply = await rpc.call<HookPreToolUseReply>('hook.pre_tool_use', {
          cwd: ctx.cwd,
          tool_name: event.toolName,
          tool_input: event.input,
          agile_agent: agent,
        });
        return toPiToolCallResult(reply);
      } catch {
        // Fail-closed (CLAUDE.md/T009 precedent: "fail-closed is now the
        // default"): an unreachable daemon blocks the call rather than
        // silently allowing it.
        return { block: true, reason: 'AGILE-GATE: agile daemon unreachable' };
      }
    });

    pi.on('tool_result', async (event, ctx): Promise<PiToolResultEventResult | undefined> => {
      void rpc
        .call('hook.post_tool_use', {
          cwd: ctx.cwd,
          tool_name: event.toolName,
          tool_input: event.input,
          agile_agent: agent,
        })
        .catch(() => {
          // Ledger/usage recording is best-effort here too — never blocks
          // the result the model already produced (post-hoc event, same as
          // Claude's PostToolUse: "the tool already ran").
        });

      if (!looksLikeTestRun(event.toolName, event.input)) return;
      const combined = event.content.map((c) => c.text).join('\n');
      const { text, rewritten } = summarizeTestOutput(combined);
      if (!rewritten) return;
      return { content: [{ type: 'text', text }] };
    });

    pi.on('before_agent_start', async (): Promise<PiBeforeAgentStartResult | undefined> => {
      type InboxMessage = { id: string; kind: string; from: string; body: string };
      let messages: InboxMessage[];
      try {
        messages = await rpc.call<InboxMessage[]>('bus.poll', { agent, priority: 'normal' });
      } catch {
        return; // Best-effort delivery — a missed inbox flush isn't a gate failure.
      }
      if (!Array.isArray(messages) || messages.length === 0) return;
      for (const m of messages) {
        void rpc.call('bus.ack', { agent, id: m.id }).catch(() => {});
      }
      return {
        message: {
          customType: 'agile-inbox',
          content: [{ type: 'text', text: formatInboxMessage(messages) }],
          display: 'shown',
        },
      };
    });

    pi.on('agent_settled', () => {
      heartbeat();
    });

    const heartbeatTimer = setInterval(
      heartbeat,
      opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
    );
    // Node/Bun: an interval with `.unref()` never keeps the process alive
    // on its own — pi's own event loop (streaming, stdio) already does that.
    heartbeatTimer.unref?.();

    pi.on('session_shutdown', () => {
      clearInterval(heartbeatTimer);
    });

    // Fires once at registration too, matching Claude's own PreToolUse
    // heartbeat riding on the very first tool call — this covers the gap
    // before that first call.
    heartbeat();
  };
}

/** Default export — what `pi`'s extension loader actually calls once this file is installed. Uses ambient `process.env`, matching every other adapter's env-var wiring (`session.ts`'s `envOverrides`). */
export default createAgileExtension();
