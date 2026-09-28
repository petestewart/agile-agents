/**
 * T456 (D43 follow-up): the pure half of what happens when a node's agent
 * crashes (its vendor exits non-zero on its own). `AttachService.onExit`
 * runs it: retry the same vendor once, then the next vendor on the
 * `vendor_failure.fallback` list, and D43's block once those are spent.
 */

import {
  type ResolvedVendorFailure,
  type SessionVendor,
  vendorHasHooks,
} from '@agile-agents/shared';

/** Restarts after a crash per node in a sliding hour (retries and switches alike), in memory. */
export const CRASH_RESTARTS_PER_HOUR = 3;

/**
 * A login or credential refusal. Claude Code's reads "Invalid API key ·
 * Please run /login"; Cursor and Grok raise `AuthRequiredError`, which ends
 * a session as a failed prompt, not a crash, so it never reaches here.
 */
const LOGIN_REFUSAL =
  /\b(?:log ?in|logged (?:out|in)|sign ?in|authenticat\w*|unauthori[sz]ed|api[ _-]?key|credentials?|oauth|forbidden|401|403)\b|\/login\b/i;

/** A model the vendor won't run ("does not support this model", "unknown model"). */
const MODEL_REFUSAL =
  /does not support this model|\b(?:unknown|invalid|unsupported) model\b|\bmodel\b.{0,80}\b(?:not (?:found|supported|available)|unsupported|does not exist)\b/i;

/**
 * The retry rule: a crash is retried once unless it is one that starting
 * the same vendor and model again can't fix. The evidence the daemon holds
 * is the vendor's last stderr line and its exit code (a crash's timing says
 * nothing reliable: a login refusal and a startup crash both end at once):
 *
 * - the stderr line names a login or credential refusal (`LOGIN_REFUSAL`);
 * - the stderr line names a model the vendor refuses (`MODEL_REFUSAL`);
 * - exit code 126 or 127: the shell could not run the command.
 *
 * Each goes straight to the fallback list. A vendor command missing from
 * the daemon's PATH never gets this far: attach refuses it before a spawn
 * (T437), and the fallback skips it. Returns the reason in words, or
 * `undefined` when a retry may help.
 */
export function retryWontHelp(
  vendorError: string | undefined,
  exitCode: number | undefined,
): string | undefined {
  if (exitCode === 126 || exitCode === 127) return 'its command could not run';
  if (vendorError === undefined) return undefined;
  if (LOGIN_REFUSAL.test(vendorError)) return 'a login refusal';
  if (MODEL_REFUSAL.test(vendorError)) return 'a model refusal';
  return undefined;
}

/**
 * The fallback vendors to try, in order: not tried in this failure yet,
 * installed, and — unless `allow_hookless` — with pre-tool hooks when the
 * crashed vendor had them (a fallback never lowers the enforcement floor).
 */
export function fallbackVendors(
  policy: ResolvedVendorFailure,
  crashed: string,
  tried: ReadonlySet<string>,
  installed: (vendor: SessionVendor) => boolean,
): SessionVendor[] {
  const needsHooks = !policy.allow_hookless && vendorHasHooks(crashed);
  return policy.fallback.filter(
    (vendor) => !tried.has(vendor) && (!needsHooks || vendorHasHooks(vendor)) && installed(vendor),
  );
}

/**
 * Appended to the new agent's brief: the last agent stopped mid-turn, and
 * only what the daemon holds (the thread, the worktree, the plan, this
 * brief) carries over; the failed vendor's own context does not.
 */
export function crashHandover(input: {
  failed: string;
  reason: string;
  retry: boolean;
  inWorktree: boolean;
}): string {
  const check = input.inWorktree
    ? 'Before you go on, run `git status` (and `git diff`) in your worktree to see what it left, and read the thread above for where it got to.'
    : 'Before you go on, read the thread above for where it got to.';
  return [
    '## Taking over',
    `The previous agent on this node (${input.failed}) stopped mid-turn: ${input.reason}.`,
    input.retry
      ? 'You are the same agent started again, with none of its memory of this work.'
      : 'You take its place.',
    'Only what the daemon holds carries over: this brief, the thread, the plan and the worktree. Its own session context is gone.',
    check,
    'Then carry on with the goal; do not redo work that is already there.',
  ].join('\n');
}

/**
 * T460: how to log a vendor back in. Its harness runs headless over ACP,
 * so an interactive `/login` can't run in the cockpit; it runs in a
 * terminal, with the user's own login (no vendor credentials in the daemon).
 */
const LOGIN_HOW: Partial<Record<string, string>> = {
  claude: 'run `claude` and type /login',
  gemini: 'run `gemini` and sign in',
  codex: 'run `codex login`',
  cursor: 'run `cursor-agent login`',
};

/** T460: a vendor's login refusal in words, with the way to log in. */
export function loginRefusalWords(vendor: string, label: string): string {
  const how = LOGIN_HOW[vendor] ?? `log in to ${label}`;
  return `${label} isn’t logged in. Log in from a terminal (${how}), then send a message to start it again.`;
}

/**
 * T460: why a turn failed, in words, for the thread, Details and Needs me.
 * A login refusal says how to log in; anything else names what the agent
 * said, else its last stderr line, else the turn error. `said` is the agent's
 * own text in the failed turn; `vendorError` its last stderr line; `message`
 * the turn error (usually "the turn did not finish cleanly").
 */
export function turnFailureWords(input: {
  vendor: string;
  label: string;
  said: string | undefined;
  vendorError: string | undefined;
  message: string;
}): string {
  const refusal =
    retryWontHelp(input.said, undefined) ?? retryWontHelp(input.vendorError, undefined);
  if (refusal === 'a login refusal') return loginRefusalWords(input.vendor, input.label);
  const why = (input.said ?? input.vendorError ?? input.message).replace(/[.\s]+$/, '');
  return `${input.label}’s turn failed: ${why}. Send a message to start it again.`;
}
