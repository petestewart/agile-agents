/**
 * `agile hook <event>` — the single entrypoint vendor hook configs call
 * (design §18 "Technical shape": "the single entrypoint every vendor hook
 * config calls (`agile hook pre-tool-use`), normalizing each vendor's hook
 * payload format"). Forwards stdin JSON to `hook.<event>` (kebab-case CLI
 * event -> snake_case RPC method: `pre-tool-use` -> `hook.pre_tool_use`,
 * `post-tool-use` -> `hook.post_tool_use`, `stop` -> `hook.stop`) and prints
 * the daemon's reply as JSON to stdout, verbatim — this file never inspects
 * or reshapes a successful `hook.*` result; `packages/daemon/src/hook/`
 * (T009) is what decides what that JSON looks like.
 *
 * T009 flips the previous T008 default: **fail-closed is now the default**
 * (CLAUDE.md Discovered Issues Log, 2026-09-09: "`agile hook` fails open
 * only until T009 lands; T009 makes fail-closed the default ... with a 2 s
 * timeout"). On any RPC failure (the `hook.*` stub's -32001, a real handler
 * error, or the daemon being unreachable entirely):
 *
 * - `pre-tool-use`: prints the fail-closed deny shape from this file's
 *   header comment history — `{"hookSpecificOutput": {"hookEventName":
 *   "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason":
 *   "agile daemon unreachable"}}` — and exits 0, so Claude's PreToolUse
 *   hook contract (a JSON `permissionDecision` on stdout) actually blocks
 *   the call and shows the model the reason, per
 *   `spike/spike-out/claude-default-perm-hooks.json` (`hookReasonSeenByModel:
 *   true`) — an exit-1/2 failure with nothing on stdout would not.
 * - `post-tool-use`/`stop`: DESIGN-GAP — neither event has a "deny the tool
 *   call" concept (the tool already ran, or the turn is already ending), so
 *   there is nothing a fail-*closed* JSON could usefully block; these two
 *   always print `{}` and exit 0 regardless of `failClosed`, same as the
 *   old fail-open behaviour, with the same stderr warning.
 *
 * `--fail-open` restores the pre-T009 default (permissive `{}` pass-through
 * on any failure, for every event) — kept as an escape hatch, not the
 * default, per the Discovered Issues Log decision above.
 *
 * Review carry-over (independent review, "hook" item 3, still true): stdout
 * must stay pure JSON (it's what a vendor hook config parses as the
 * decision), so every warning goes to stderr, which Claude's hook contract
 * ignores on exit 0 — free visibility in the vendor's own hook log, zero
 * behavioural change to what the model sees.
 */

import { type ParsedArgs, hasFlag, optionalString, readStdin } from '../args';
import { RpcCallError, callRpc } from '../client';
import { printJson } from '../format';

const NOT_IMPLEMENTED_CODE = -32001;

/** Review fix (independent review, "hook" item 3): the hook path inherits
 * `callRpc`'s general 5s default, which is too long for a per-tool-call
 * hook to hang on a wedged daemon. `--timeout` overrides it. */
export const DEFAULT_HOOK_TIMEOUT_MS = 2000;

/** `pre-tool-use` -> `pre_tool_use`, `post-tool-use` -> `post_tool_use`, `stop` -> `stop`. */
export function hookEventToMethod(event: string): string {
  return `hook.${event.replace(/-/g, '_')}`;
}

const CLAUDE_HOOK_EVENT_NAMES: Record<string, string> = {
  'pre-tool-use': 'PreToolUse',
  'post-tool-use': 'PostToolUse',
  stop: 'Stop',
};

/** The fail-closed deny shape for a `pre-tool-use` RPC failure — see this file's header. */
function failClosedDenyJson(event: string, reason: string): unknown {
  const hookEventName = CLAUDE_HOOK_EVENT_NAMES[event];
  if (hookEventName !== 'PreToolUse') return {};
  return {
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export interface RunHookOptions {
  socketPath: string;
  event: string;
  failClosed: boolean;
  /** Milliseconds to wait for the daemon before failing (open or closed per `failClosed`). Default 2000. */
  timeoutMs?: number;
  stdin?: NodeJS.ReadableStream;
}

export async function runHook(options: RunHookOptions): Promise<number> {
  const { socketPath, event, failClosed } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const raw = await readStdin(options.stdin);

  let payload: unknown;
  try {
    payload = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch (err) {
    console.error(
      `agile hook ${event}: invalid JSON on stdin: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  // T012 QA/review round (out-of-file-grant necessity, documented in the
  // pipeline report): `writeClaudeSettings`'s `agentId` option embeds
  // `AGILE_AGENT=<id>` onto the hook command string, which sets this env
  // var for *this CLI process* — the only place that value is visible, since
  // the daemon is a separate long-running process. `HookService`'s
  // `resolveAgentByCwd` needs it as a disambiguation hint when a reviewer
  // and an engineer share one physical worktree (§12); Claude's own hook
  // payload never carries an `agile_agent` field, so this is additive, not
  // a reinterpretation of the vendor's contract.
  if (
    typeof process.env.AGILE_AGENT === 'string' &&
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload)
  ) {
    (payload as Record<string, unknown>).agile_agent = process.env.AGILE_AGENT;
  }

  const method = hookEventToMethod(event);

  try {
    const result = await callRpc<unknown>(socketPath, method, payload, { timeoutMs });
    printJson(result);
    return 0;
  } catch (err) {
    const isStub = err instanceof RpcCallError && err.code === NOT_IMPLEMENTED_CODE;
    const detail = `${isStub ? 'hook.* not implemented yet' : 'RPC failed'}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (!failClosed) {
      // Fail-open (--fail-open): a stub reply or an unreachable daemon both
      // mean "the daemon has no opinion yet" from the hook's point of view.
      // stdout stays pure JSON (a vendor hook parses it as the decision);
      // the warning is stderr-only so it never corrupts that contract.
      console.error('agile hook: daemon unreachable or hook.* not implemented; failing open');
      printJson({});
      return 0;
    }
    // Fail-closed (default, T009): stdout still stays pure JSON so Claude's
    // hook contract can act on it — see this file's header for why only
    // pre-tool-use gets an actual deny shape.
    console.error(`agile hook ${event}: ${detail}`);
    printJson(failClosedDenyJson(event, 'agile daemon unreachable'));
    return 0;
  }
}

export function parseHookArgs(args: ParsedArgs): {
  event: string;
  failClosed: boolean;
  timeoutMs?: number;
} {
  const event = args.positionals[0];
  if (!event) throw new Error('usage: agile hook <event> (e.g. pre-tool-use)');
  const timeoutRaw = optionalString(args.options, 'timeout');
  const timeoutMs = timeoutRaw !== undefined ? Number(timeoutRaw) : undefined;
  if (timeoutRaw !== undefined && (timeoutMs === undefined || Number.isNaN(timeoutMs))) {
    throw new Error(
      `--timeout must be a number of milliseconds, got ${JSON.stringify(timeoutRaw)}`,
    );
  }
  // T009: fail-closed is now the default; --fail-open restores the old
  // permissive default; --fail-closed is accepted (and true) for
  // explicitness/back-compat but no longer needed to opt in.
  const failClosed = !hasFlag(args.options, 'fail-open');
  return { event, failClosed, timeoutMs };
}
