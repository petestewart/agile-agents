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
 *
 * T506: `--vendor codex` is Codex's own `PreToolUse` hook (the daemon's
 * `.codex/hooks.json`, design/spike-findings.md §C5). The payload goes to
 * the same `hook.pre_tool_use` marked `agile_vendor: 'codex'` (the daemon
 * reads Codex's input), and the reply is rendered in Codex's contract: an
 * allow is exit 0 with nothing on stdout; a deny is exit 2 with the reason
 * on stderr (the model sees "Command blocked by PreToolUse hook: <reason>").
 * Every failure is exit 2 too: Codex runs a call whose hook failed with any
 * other code.
 *
 * T511: `--repo <root>` (with `--vendor codex`). Codex reads a worktree's
 * project hooks from its main repo (spike-findings §C5 round 4), so the
 * daemon's hook sits at `<root>/.codex/` and also runs for the operator's
 * own Codex in that repo. With `--repo`, a call whose input `cwd`
 * (realpath'd where it can be) is not inside `<root>/.worktrees/` is
 * allowed at once: exit 0, nothing printed, no daemon call. Inside, it is
 * gated as above, fail-closed. A `cwd` that is missing, not a string or
 * not absolute counts as inside: it is gated. (T512 keeps this form for
 * old scripts.)
 *
 * T512: the gate is user-level (`$CODEX_HOME/hooks.json`, §C5 round 5), so
 * it runs for every Codex the operator starts. Its script passes `--home
 * <home>` and one `--repo <root>` per registered repo (repeatable; read as
 * given, never split on commas: a path may hold one). With `--home`, a
 * call is gated when its `cwd` is strictly inside any `<root>/.worktrees/`
 * or at or under the home (the Director and nodes with no repo run in
 * `<home>/sessions/<id>`), or when it is missing or relative; any other
 * call is allowed with no daemon contact, so the operator's own Codex
 * anywhere works with the daemon down. The decision is the arguments' and
 * the `cwd`'s only (`codexCallGated`).
 */

import { codexCallGated } from '@agile-agents/daemon';
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

/** T506: the vendors whose hook contract this CLI speaks besides Claude's (the default). */
export const HOOK_VENDORS = ['claude', 'codex'] as const;
export type HookVendor = (typeof HOOK_VENDORS)[number];

/** Codex's block exit code: any other non-zero exit lets the call run. */
export const CODEX_BLOCK_EXIT = 2;

/** The reason of a Claude-shaped `hook.pre_tool_use` reply that does not allow the call, else undefined. */
export function denyReasonOf(reply: unknown): string | undefined {
  const out =
    typeof reply === 'object' && reply !== null
      ? (reply as { hookSpecificOutput?: unknown }).hookSpecificOutput
      : undefined;
  const decision =
    typeof out === 'object' && out !== null
      ? (out as { permissionDecision?: unknown; permissionDecisionReason?: unknown })
      : undefined;
  if (decision?.permissionDecision === 'allow') return undefined;
  // Anything but an explicit allow blocks: a reply this file can't read is not a yes.
  const reason = decision?.permissionDecisionReason;
  return typeof reason === 'string' && reason.length > 0 ? reason : 'AGILE-GATE: blocked';
}

/**
 * T511: whether a Codex hook call with this input `cwd` comes from a node's
 * worktree under `<repo>/.worktrees/`, and so must be gated (the single
 * `--repo` form). Any form of the `cwd` (as given, realpath) inside any
 * form of the folder counts; a `cwd` that can't be read as an absolute path
 * counts too (fail closed).
 */
export function codexCallInWorktrees(cwd: unknown, repo: string): boolean {
  return codexCallGated(cwd, { repos: [repo] });
}

export interface RunHookOptions {
  socketPath: string;
  event: string;
  failClosed: boolean;
  /** T506: whose hook contract to speak; default Claude's. */
  vendor?: HookVendor;
  /**
   * T511/T512 (Codex only): the registered repo roots; calls from their
   * `.worktrees/` are gated. With neither this nor `home`, every call is.
   */
  repos?: readonly string[];
  /** T512 (Codex only): the agile home; calls from under it are gated too, and `.worktrees/` strictly. */
  home?: string;
  /** Milliseconds to wait for the daemon before failing (open or closed per `failClosed`). Default 2000. */
  timeoutMs?: number;
  stdin?: NodeJS.ReadableStream;
}

export async function runHook(options: RunHookOptions): Promise<number> {
  const { socketPath, event, failClosed } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const codex = options.vendor === 'codex' && event === 'pre-tool-use';
  const raw = await readStdin(options.stdin);

  let payload: unknown;
  try {
    payload = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch (err) {
    console.error(
      `agile hook ${event}: invalid JSON on stdin: ${err instanceof Error ? err.message : String(err)}`,
    );
    return codex ? CODEX_BLOCK_EXIT : 1;
  }
  if (codex) {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      console.error('AGILE-GATE: the hook input is not a JSON object');
      return CODEX_BLOCK_EXIT;
    }
    // T511/T512: the operator's own Codex is not the daemon's to gate. Decided
    // locally, before any daemon contact.
    const scoped = (options.repos?.length ?? 0) > 0 || options.home !== undefined;
    if (
      scoped &&
      !codexCallGated((payload as Record<string, unknown>).cwd, {
        repos: options.repos ?? [],
        ...(options.home !== undefined ? { home: options.home } : {}),
      })
    ) {
      return 0;
    }
    (payload as Record<string, unknown>).agile_vendor = 'codex';
  }

  // `AGILE_AGENT` reaches this CLI process from the vendor session's own
  // env (`runner/session.ts` sets it per session; Claude runs hook commands
  // with that env). It used to be embedded in the per-worktree
  // settings.json instead, where a reviewer sharing the engineer's worktree
  // overwrote it (twentieth live run, 2026-09-11). `HookService`'s
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
    if (codex) {
      const reason = denyReasonOf(result);
      if (reason === undefined) return 0;
      process.stderr.write(reason);
      return CODEX_BLOCK_EXIT;
    }
    printJson(result);
    return 0;
  } catch (err) {
    const isStub = err instanceof RpcCallError && err.code === NOT_IMPLEMENTED_CODE;
    const detail = `${isStub ? 'hook.* not implemented yet' : 'RPC failed'}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (codex) {
      console.error(`agile hook ${event}: ${detail}`);
      if (!failClosed) return 0;
      process.stderr.write('AGILE-GATE: agile daemon unreachable');
      return CODEX_BLOCK_EXIT;
    }
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
  vendor?: HookVendor;
  repos?: string[];
  home?: string;
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
  const vendorRaw = optionalString(args.options, 'vendor');
  if (vendorRaw !== undefined && !(HOOK_VENDORS as readonly string[]).includes(vendorRaw)) {
    throw new Error(
      `--vendor must be one of ${HOOK_VENDORS.join(', ')}, got ${JSON.stringify(vendorRaw)}`,
    );
  }
  const codexPreToolUse = vendorRaw === 'codex' && event === 'pre-tool-use';
  // T511/T512: `--repo` (repeatable, each value whole: a path may hold a
  // comma) scopes Codex's gate to the daemon's worktrees.
  const repoGiven = hasFlag(args.options, 'repo');
  const repos = args.repeated?.repo ?? [];
  if (repoGiven && (!codexPreToolUse || args.options.repo === true || repos.some((r) => r === ''))) {
    throw new Error('--repo <root> goes with pre-tool-use --vendor codex');
  }
  // T512: `--home` gates calls from under the agile home too.
  const homeGiven = hasFlag(args.options, 'home');
  const home = optionalString(args.options, 'home');
  if (homeGiven && (!codexPreToolUse || home === undefined || home === '')) {
    throw new Error('--home <dir> goes with pre-tool-use --vendor codex');
  }
  return {
    event,
    failClosed,
    timeoutMs,
    ...(vendorRaw !== undefined ? { vendor: vendorRaw as HookVendor } : {}),
    ...(repos.length > 0 ? { repos } : {}),
    ...(home !== undefined ? { home } : {}),
  };
}
