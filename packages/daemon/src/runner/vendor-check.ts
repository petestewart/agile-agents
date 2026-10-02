/**
 * T489 (D58): the vendor self-check. The facts routing depends on (does a
 * vendor take the model it is given, does effort take, what usage does it
 * report, does resume work) can only be measured with the operator's own
 * logins, so the daemon measures them itself, one vendor at a time:
 *
 *  1. a probe session with no node and no repo (as T467's Refresh opens
 *     one: its cwd is the probe's own session dir, the env
 *     `withoutDaemonSecrets()`, the installed CLI (T480)), whose tool calls
 *     are all refused and whose file reads and writes are refused;
 *  2. the model: a listed model other than the current one (not the
 *     vendor's own default or Auto), set through T467's path
 *     (`setModelThroughOption`) and read back from the reply;
 *  3. the effort: where the vendor reports a `thought_level` option, a
 *     different D12 level it lists, set through T488's path
 *     (`setEffortThroughOption`) and read back;
 *  4. one tiny prompt (`VENDOR_CHECK_PROMPT`), bounded; the session's
 *     `usage.jsonl` (T485a) is written as any session's is and read back for
 *     the usage fields that arrived, and anything that looks like a rate
 *     limit or plan usage is kept (names and values, capped, never anything
 *     that looks like a credential);
 *  5. where the provider supports it, the vendor is stopped and started
 *     again with `session/load` on the same ACP session id (no second prompt);
 *  6. one result file, `self-check.json`, beside the probe's
 *     `session-state.json` (`VendorCheckResultSchema`).
 *
 * A vendor that asks for a login says so in T460's words and the check
 * stops there. `VendorCheckService` keeps the latest result per vendor
 * (rebuilt from the files at start, as the model catalog is), runs the
 * checks one at a time, and fires on its own after a CLI update or on a CLI
 * version it has no check for, unless the home says `vendor_checks: manual`.
 * `vendorCapabilities` is the pure view routing reads (Choose leaves out a
 * vendor whose last check kept its own model or refused the pick).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  ACP_PROVIDERS,
  ACP_TURN_ENDED_METHOD,
  type AcpProviderConfig,
  type AgentEvent,
  AuthRequiredError,
  type SessionReply,
  type SpawnSessionOptions,
  type SpawnedSession,
  spawnSession as defaultSpawnSession,
} from '@agile-agents/acp-client';
import {
  type BridgeManifest,
  DEFAULT_VENDOR_CHECK_MODE,
  EFFORT_LEVELS,
  type HomeConfig,
  SESSION_VENDORS,
  type SessionVendor,
  VENDOR_CHECK_FIELDS_MAX,
  VENDOR_CHECK_FILE,
  VENDOR_CHECK_PROMPT,
  VENDOR_CHECK_RATE_LIMITS_MAX,
  type VendorCheckMode,
  type VendorCheckPrompt,
  type VendorCheckRateLimit,
  type VendorCheckReason,
  type VendorCheckResult,
  VendorCheckResultSchema,
  type VendorCheckResume,
  type VendorCheckRow,
  type VendorCheckSetting,
  type VendorCheckSettingOutcome,
  type VendorCheckUsage,
  type VendorChecksStatus,
  type VendorInstallView,
  isSessionVendor,
  ulid,
  vendorLoginHow,
} from '@agile-agents/shared';
import { retryWontHelp } from '../attach/fallback';
import { providerIn } from '../bridges/bridges';
import { RpcParamError, requireObject } from '../gates/rpc';
import { bridgesOf } from '../harness/service';
import type { RpcMethodHandler } from '../rpc';
import { withoutDaemonSecrets } from '../secret-env';
import type { InstalledCli } from './installed-cli';
import {
  USAGE_LOG_FILE,
  missingVendorCommand,
  saveSessionState,
  setEffortThroughOption,
  setModelThroughOption,
  usageRecorder,
} from './session';
import { asRecord, vendorEffortOption, vendorModelOption } from './vendor-models';

/** How long the vendor has to open a session (and to load one, for the resume). */
export const VENDOR_CHECK_OPEN_TIMEOUT_MS = 60_000;
/** How long the one prompt may take. */
export const VENDOR_CHECK_PROMPT_TIMEOUT_MS = 90_000;
/** How long a stopped vendor has to exit before the resume starts it again. */
const EXIT_WAIT_MS = 5_000;

/**
 * T460's words for a vendor that isn't logged in, for a check: how to log
 * in, then check again.
 */
export function notLoggedInWords(vendor: string, label: string): string {
  return `${label} isn’t logged in. Log in from a terminal (${vendorLoginHow(vendor, label)}), then check it again.`;
}

// ------------------------------------------------------------ what the vendor sent

/** A field name that reads as a rate limit or plan usage (never the context window). */
const RATE_LIMIT_NAME =
  /rate.?limit|ratelimit|\blimits?\b|limit|quota|\bplan\b|plan_?type|remaining|reset|retry.?after|throttl|credit|allowance|weekly|billing|subscription/i;
/**
 * A subtree of token counts (`_meta.quota.token_count`, `…model_usage.N`):
 * what the session used, not what the plan has left, so never a rate limit
 * even under a name like `quota`.
 */
const TOKEN_COUNT_NAME = /^(?:token_?counts?|model_?usage)$/i;
/** A field name that could hold a credential: never recorded. */
const CREDENTIAL_NAME =
  /api.?key|secret|password|passwd|cookie|bearer|authori[sz]ation|credential|access.?token|refresh.?token|id.?token|session.?token|^token$|^auth$/i;
/** A value that looks like a credential (a key, a bearer, a JWT, a long opaque string). */
function looksLikeCredential(value: string): boolean {
  if (/^(?:sk-|pk-|rk-|ghp_|gho_|xox[a-z]-|Bearer\s)/i.test(value)) return true;
  if (/^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/.test(value)) return true;
  return value.length >= 32 && /^[A-Za-z0-9+/=_.-]+$/.test(value) && /\d/.test(value);
}

function jsonCut(value: unknown, max = 200): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The leaves of `value` whose path names a rate limit or plan usage, with
 * their values as sent (capped). A path that names a credential, or a value
 * that looks like one, is never kept.
 */
export function rateLimitFields(
  value: unknown,
  where: VendorCheckRateLimit['where'],
  out: VendorCheckRateLimit[],
): void {
  const walk = (node: unknown, path: string[], depth: number): void => {
    if (out.length >= VENDOR_CHECK_RATE_LIMITS_MAX) return;
    if (path.some((p) => CREDENTIAL_NAME.test(p) || TOKEN_COUNT_NAME.test(p))) return;
    if (node === null || typeof node !== 'object') {
      if (path.length === 0 || !path.some((p) => RATE_LIMIT_NAME.test(p))) return;
      if (typeof node === 'string' && looksLikeCredential(node)) return;
      const name = path.join('.').slice(0, 120);
      if (out.some((f) => f.where === where && f.name === name)) return;
      out.push({ where, name, value: jsonCut(node) });
      return;
    }
    if (depth >= 5) return;
    if (Array.isArray(node)) {
      node.slice(0, 5).forEach((item, i) => walk(item, [...path, String(i)], depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>).slice(0, 50)) {
      walk(child, [...path, key], depth + 1);
    }
  };
  walk(value, [], 0);
}

/** Up to `VENDOR_CHECK_FIELDS_MAX` distinct names, each cut to 120 characters. */
function addNames(into: string[], names: Iterable<string>): void {
  for (const raw of names) {
    const name = raw.slice(0, 120);
    if (name === '' || into.includes(name) || into.length >= VENDOR_CHECK_FIELDS_MAX) continue;
    into.push(name);
  }
}

function hasNumber(value: unknown, depth = 0): boolean {
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  const r = asRecord(value);
  if (r === null || depth > 2) return false;
  return Object.values(r).some((v) => hasNumber(v, depth + 1));
}

/**
 * T485a's `usage.jsonl`, read back: which usage fields arrived, any `cost`,
 * whether the turn's token counts arrived, and the rate-limit fields among
 * them. A line that doesn't parse is skipped (it is a log).
 */
export function readUsageLog(
  sessionDir: string,
  rateLimits: VendorCheckRateLimit[],
): VendorCheckUsage | undefined {
  let text: string;
  try {
    text = readFileSync(join(sessionDir, USAGE_LOG_FILE), 'utf8');
  } catch {
    return undefined;
  }
  const usage: VendorCheckUsage = {
    update_fields: [],
    reply_keys: [],
    reply_usage_fields: [],
    turn_tokens: false,
    context: false,
  };
  let cost: unknown;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry === null) continue;
    if (entry.kind === 'usage_update') {
      const update = asRecord(entry.update);
      if (update === null) continue;
      const { sessionUpdate: _kind, ...fields } = update;
      addNames(usage.update_fields, Object.keys(fields));
      if (typeof fields.used === 'number' && typeof fields.size === 'number') usage.context = true;
      if (fields.cost !== undefined && cost === undefined) cost = fields.cost;
      rateLimitFields(fields, 'usage_update', rateLimits);
    } else if (entry.kind === 'turn_end') {
      if (Array.isArray(entry.replyKeys)) {
        addNames(
          usage.reply_keys,
          entry.replyKeys.filter((k): k is string => typeof k === 'string'),
        );
      }
      const replyUsage = asRecord(entry.usage);
      if (replyUsage !== null) {
        addNames(usage.reply_usage_fields, Object.keys(replyUsage));
        if (hasNumber(replyUsage)) usage.turn_tokens = true;
        if (replyUsage.cost !== undefined && cost === undefined) cost = replyUsage.cost;
      }
      const meta = asRecord(entry._meta);
      if (meta?.cost !== undefined && cost === undefined) cost = meta.cost;
      if (entry.usage !== undefined) rateLimitFields(entry.usage, 'turn_end', rateLimits);
      if (entry._meta !== undefined) rateLimitFields(entry._meta, 'turn_end', rateLimits);
    }
  }
  if (cost !== undefined) usage.cost = jsonCut(cost);
  return usage;
}

// ------------------------------------------------------------ what to set

/** A model value that is the vendor's own default ("default", Cursor's `default[]`, "Auto"). */
function isDefaultModel(value: string, name: string): boolean {
  return /^default\b/i.test(value) || /^(?:auto|default)\b/i.test(name.trim());
}

/**
 * The model a check sets: a listed one other than the current, preferring
 * one that isn't the vendor's own default or Auto. `undefined` when the list
 * has no other.
 */
export function modelToTry(
  options: ReadonlyArray<{ value: string; name: string }>,
  current: string | undefined,
): string | undefined {
  const others = options.filter((o) => o.value !== current);
  return (others.find((o) => !isDefaultModel(o.value, o.name)) ?? others[0])?.value;
}

/** The effort a check sets: a D12 level the vendor lists other than the current, cheapest first. */
export function effortToTry(
  values: readonly string[],
  current: string | undefined,
): string | undefined {
  return EFFORT_LEVELS.find((level) => level !== current && values.includes(level));
}

// ------------------------------------------------------------ one check

export interface RunVendorCheckOptions {
  vendor: SessionVendor;
  provider: AcpProviderConfig;
  /** The probe session's id: its dir is `sessionDir`. */
  session: string;
  /** Created if missing: the vendor's cwd and every file the check writes. */
  sessionDir: string;
  reason: VendorCheckReason;
  by: 'human' | 'daemon';
  cliVersion?: string;
  /** T480 (D49): the installed CLI the bridge runs. */
  installedCli?: InstalledCli;
  /** Test seam: a fake `spawnSession`. */
  spawn?: typeof defaultSpawnSession;
  openTimeoutMs?: number;
  promptTimeoutMs?: number;
  /** Every reply the vendor sent about its session, as saved (the model catalog keeps its list). */
  onSessionState?: (state: Record<string, unknown>) => void;
  /** Each vendor process the check starts (the service stops them when the daemon stops). */
  onSpawned?: (spawned: SpawnedSession) => void;
  now?: () => Date;
}

class CheckTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CheckTimeout(`${what} in ${Math.round(ms / 1000)} s`)),
        ms,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
}

/** A setting's step when the check stopped before it. */
const SKIPPED: VendorCheckSetting = { outcome: 'skipped' };

/**
 * Runs one vendor's self-check and writes its `self-check.json`. Never
 * throws: whatever went wrong is in the result, in words.
 */
export async function runVendorCheck(opts: RunVendorCheckOptions): Promise<VendorCheckResult> {
  const now = opts.now ?? (() => new Date());
  const { provider, sessionDir } = opts;
  const label = provider.label;
  const startedAt = now().toISOString();
  mkdirSync(sessionDir, { recursive: true });
  const errors: string[] = [];
  const rateLimits: VendorCheckRateLimit[] = [];
  const recordUsage = usageRecorder(sessionDir);
  const stderrPath = join(sessionDir, 'stderr.log');
  let stderrTail = '';
  let lastState: Record<string, unknown> | null = null;
  let loggedIn = true;
  let opened = false;
  let model: VendorCheckSetting = SKIPPED;
  let effort: VendorCheckSetting = SKIPPED;
  let prompt: VendorCheckPrompt = { outcome: 'skipped' };
  let usage: VendorCheckUsage | undefined;
  let resume: VendorCheckResume = { outcome: 'skipped' };

  const spawnOne = (): {
    spawned: SpawnedSession;
    exited: Promise<void>;
    failure: () => string | undefined;
  } => {
    let failure: string | undefined;
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const spawnOptions: SpawnSessionOptions = {
      cmd: provider.command,
      args: [...provider.args],
      cwd: sessionDir,
      // T486: the daemon's own env, less its secrets (the classifier key).
      env: withoutDaemonSecrets(),
      envOverrides: { ...provider.envOverrides, ...(opts.installedCli?.env ?? {}) },
      clientCapabilities: provider.clientCapabilities,
      mcpServers: [],
      // The prompt needs no files: the vendor may read and write none through the client.
      fsImpl: {
        readFile: async () => {
          throw new Error('the vendor self-check reads no files');
        },
        writeFile: async () => {
          throw new Error('the vendor self-check writes no files');
        },
        realpath: async (path) => realpathSync(path),
      },
      onStderr: (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-4000);
        try {
          appendFileSync(stderrPath, chunk);
        } catch {
          // Diagnostics only.
        }
      },
    };
    const spawned = (opts.spawn ?? defaultSpawnSession)(spawnOptions);
    opts.onSpawned?.(spawned);
    spawned.on((event: AgentEvent) => {
      if (event.type === 'error') failure = event.message;
      if (event.type === 'exit') {
        if (failure === undefined) failure = `the agent exited (code ${event.exitCode})`;
        markExited();
        return;
      }
      if (event.type !== 'event') return;
      const frame = event.event;
      if (frame.acp === 'request' && frame.method === 'session/request_permission') {
        // Deny every tool call: the prompt needs none.
        const options = asRecord(frame.params)?.options;
        const reject = Array.isArray(options)
          ? options
              .map((o) => asRecord(o))
              .find((o) => o !== null && typeof o.kind === 'string' && o.kind.startsWith('reject'))
          : undefined;
        spawned.respondPermission(
          frame.id,
          typeof reject?.optionId === 'string'
            ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
            : { outcome: { outcome: 'cancelled' } },
        );
        return;
      }
      if (frame.acp === 'request') {
        spawned.respondPermissionError(frame.id, -32601, 'not available in the vendor self-check');
        return;
      }
      if (frame.acp !== 'notification') return;
      const method = frame.message.method;
      if (method === '_agile/session_state') {
        let p = asRecord(frame.message.params);
        // As the runner does: a `session/set_config_option` reply carries only `configOptions`.
        if (p?.source === 'session/set_config_option' && lastState !== null) {
          const { at: _at, vendor: _vendor, ...before } = lastState;
          p = {
            ...before,
            ...(p.configOptions !== null && p.configOptions !== undefined
              ? { configOptions: p.configOptions }
              : {}),
            source: p.source,
          };
        }
        lastState = saveSessionState(sessionDir, p, provider.id);
        rateLimitFields(asRecord(lastState)?._meta, 'session', rateLimits);
        try {
          opts.onSessionState?.(lastState);
        } catch {
          // Bookkeeping only.
        }
        return;
      }
      if (method === ACP_TURN_ENDED_METHOD) {
        const p = asRecord(frame.message.params);
        recordUsage('turn_end', {
          stopReason: p?.stopReason ?? null,
          replyKeys: Array.isArray(p?.replyKeys) ? p.replyKeys : [],
          ...(p?.usage !== undefined ? { usage: p.usage } : {}),
          ...(p?._meta !== undefined ? { _meta: p._meta } : {}),
        });
        return;
      }
      if (method === 'session/update') {
        const update = asRecord(asRecord(frame.message.params)?.update);
        if (update?.sessionUpdate === 'usage_update') recordUsage('usage_update', { update });
      }
    });
    return { spawned, exited, failure: () => failure };
  };

  /** Stops a vendor and waits (bounded) for it to exit. */
  const stop = async (run: { spawned: SpawnedSession; exited: Promise<void> }): Promise<void> => {
    try {
      run.spawned.close();
    } catch {
      // Already gone.
    }
    await Promise.race([run.exited, Bun.sleep(EXIT_WAIT_MS)]);
  };

  /** A failure in words; a login refusal stops the check with T460's words. */
  const failed = (err: unknown, what: string, run: { failure: () => string | undefined }): void => {
    const why = messageOf(err);
    const login =
      err instanceof AuthRequiredError ||
      retryWontHelp(why, undefined) === 'a login refusal' ||
      retryWontHelp(stderrTail.trim().split('\n').pop(), undefined) === 'a login refusal';
    if (login) {
      loggedIn = false;
      errors.push(notLoggedInWords(provider.id, label));
      return;
    }
    const exit = run.failure();
    errors.push(
      `${label} ${what}: ${exit !== undefined && !why.includes(exit) ? `${why} (${exit})` : why}`.slice(
        0,
        500,
      ),
    );
  };

  const openWithAuth = async (spawned: SpawnedSession, load?: string): Promise<void> => {
    const once = () => (load !== undefined ? spawned.load(load) : spawned.open());
    try {
      await once();
    } catch (err) {
      const auth = err instanceof AuthRequiredError || load !== undefined;
      if (!auth || provider.authMethods.length === 0) throw err;
      let lastErr: unknown = err;
      for (const methodId of provider.authMethods) {
        try {
          await spawned.authenticate(methodId);
          await once();
          return;
        } catch (retryErr) {
          lastErr = retryErr;
        }
      }
      throw lastErr;
    }
  };

  const first = spawnOne();
  let acpSessionId: string | null = null;
  try {
    // 1. Open.
    try {
      await withTimeout(
        openWithAuth(first.spawned),
        opts.openTimeoutMs ?? VENDOR_CHECK_OPEN_TIMEOUT_MS,
        'no answer',
      );
      opened = true;
      acpSessionId = first.spawned.sessionId;
    } catch (err) {
      failed(err, 'did not open a session', first);
    }

    if (opened) {
      // 2. The model.
      // Read through a function: the event listener sets it, which flow analysis can't see.
      const reply = (): Record<string, unknown> | null => lastState;
      let configOptions: unknown = reply()?.configOptions;
      const option = vendorModelOption(reply());
      const pick = option !== undefined ? modelToTry(option.options, option.current) : undefined;
      if (option === undefined) {
        model = { outcome: 'not_applicable', detail: `${label} reported no model list` };
      } else if (pick === undefined) {
        model = {
          outcome: 'not_applicable',
          ...(option.current !== undefined ? { from: option.current.slice(0, 200) } : {}),
          detail: `${label} lists no model other than the one it runs`,
        };
      } else {
        const set = await setModelThroughOption(first.spawned, label, option, pick);
        if (set.configOptions !== undefined) configOptions = set.configOptions;
        const outcome: VendorCheckSettingOutcome =
          set.outcome === 'no_option' ? 'not_applicable' : set.outcome;
        model = {
          outcome,
          ...(option.current !== undefined ? { from: option.current.slice(0, 200) } : {}),
          to: pick.slice(0, 200),
          ...(set.after !== undefined ? { after: set.after.slice(0, 200) } : {}),
          detail: (set.result.ok ? `${label} took ${pick}` : set.result.line).slice(0, 500),
        };
        if (outcome === 'refused' && set.error !== undefined) {
          errors.push(`${label} refused the model ${pick}: ${set.error}`.slice(0, 500));
        }
      }

      // 3. The effort.
      const effortOption = vendorEffortOption(configOptions);
      const level =
        effortOption !== undefined
          ? effortToTry(effortOption.values, effortOption.current)
          : undefined;
      if (effortOption === undefined) {
        effort = { outcome: 'not_applicable', detail: `${label} reported no effort option` };
      } else if (level === undefined) {
        effort = {
          outcome: 'not_applicable',
          ...(effortOption.current !== undefined
            ? { from: effortOption.current.slice(0, 200) }
            : {}),
          detail: `${label} lists no other effort level of low, medium, high or max`,
        };
      } else {
        const set = await setEffortThroughOption(first.spawned, label, effortOption, level);
        effort = {
          outcome: set.outcome,
          ...(effortOption.current !== undefined
            ? { from: effortOption.current.slice(0, 200) }
            : {}),
          to: level,
          ...(set.after !== undefined ? { after: set.after.slice(0, 200) } : {}),
          detail: (set.result.ok ? `${label} took effort ${level}` : set.result.line).slice(0, 500),
        };
        if (set.outcome === 'refused' && set.error !== undefined) {
          errors.push(`${label} refused effort: ${set.error}`.slice(0, 500));
        }
      }

      // 4. One tiny prompt.
      const promptStarted = Date.now();
      const timeoutMs = opts.promptTimeoutMs ?? VENDOR_CHECK_PROMPT_TIMEOUT_MS;
      try {
        const reply: SessionReply = await withTimeout(
          first.spawned.prompt(VENDOR_CHECK_PROMPT),
          timeoutMs,
          'no reply',
        );
        const took = Date.now() - promptStarted;
        const said = typeof reply.text === 'string' ? reply.text.trim().slice(0, 200) : '';
        if (reply.status === 'completed') {
          prompt = {
            outcome: 'finished',
            took_ms: took,
            ...(said !== '' ? { reply: said } : {}),
          };
        } else {
          const why = reply.error?.message ?? `the turn was ${reply.status}`;
          prompt = {
            outcome: 'failed',
            took_ms: took,
            ...(said !== '' ? { reply: said } : {}),
            detail: why.slice(0, 500),
          };
          failed(new Error(said !== '' ? `${why}: ${said}` : why), 'failed the prompt', first);
        }
      } catch (err) {
        if (err instanceof CheckTimeout) {
          prompt = {
            outcome: 'timed_out',
            detail: `no reply in ${Math.round(timeoutMs / 1000)} s`,
          };
          errors.push(`${label} did not answer the prompt in ${Math.round(timeoutMs / 1000)} s`);
          try {
            first.spawned.cancel();
          } catch {
            // Closing anyway.
          }
        } else {
          prompt = {
            outcome: 'failed',
            detail: messageOf(err).slice(0, 500) || 'the prompt failed',
          };
          failed(err, 'failed the prompt', first);
        }
      }
      const stopReason = lastTurnStopReason(sessionDir);
      if (prompt.outcome === 'finished' && stopReason !== undefined) {
        prompt = { ...prompt, stop_reason: stopReason };
      }
      usage = readUsageLog(sessionDir, rateLimits);
    }
  } finally {
    await stop(first);
  }

  // 5. Resume, on the same ACP session id.
  if (opened && loggedIn) {
    if (!provider.loadSession) {
      resume = {
        outcome: 'not_supported',
        detail: `${label} isn’t set up here to resume a session (session/load)`,
      };
    } else if (acpSessionId === null) {
      resume = { outcome: 'failed', detail: 'the first session named no id to resume' };
    } else {
      const second = spawnOne();
      try {
        await withTimeout(
          openWithAuth(second.spawned, acpSessionId),
          opts.openTimeoutMs ?? VENDOR_CHECK_OPEN_TIMEOUT_MS,
          'no answer',
        );
        resume = { outcome: 'ok', detail: `${label} loaded its session again` };
      } catch (err) {
        const why = messageOf(err) || 'the load failed';
        resume = { outcome: 'failed', detail: `session/load failed: ${why}`.slice(0, 500) };
        errors.push(`${label} could not resume its session: ${why}`.slice(0, 500));
      } finally {
        await stop(second);
      }
    }
  }

  const result: VendorCheckResult = {
    vendor: opts.vendor,
    label,
    session: opts.session,
    ...(opts.cliVersion !== undefined ? { cli_version: opts.cliVersion.slice(0, 64) } : {}),
    ...bridgeOf(opts.vendor),
    started_at: startedAt,
    finished_at: now().toISOString(),
    reason: opts.reason,
    by: opts.by,
    logged_in: loggedIn,
    opened,
    model,
    effort,
    prompt,
    ...(usage !== undefined ? { usage } : {}),
    rate_limits: rateLimits.slice(0, VENDOR_CHECK_RATE_LIMITS_MAX),
    resume,
    errors: errors.slice(0, 10),
  };
  const valid = VendorCheckResultSchema.parse(result);
  writeVendorCheck(sessionDir, valid);
  return valid;
}

/** The last `turn_end`'s stop reason in a session's `usage.jsonl`. */
function lastTurnStopReason(sessionDir: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(sessionDir, USAGE_LOG_FILE), 'utf8');
  } catch {
    return undefined;
  }
  let reason: string | undefined;
  for (const line of text.split('\n')) {
    try {
      const entry = asRecord(JSON.parse(line));
      if (entry?.kind === 'turn_end' && typeof entry.stopReason === 'string') {
        reason = entry.stopReason.slice(0, 64);
      }
    } catch {
      // A log line.
    }
  }
  return reason;
}

/** The ACP bridge the daemon pins for a vendor (Claude's, Codex's, Antigravity's), as `{bridge}`. */
function bridgeOf(vendor: SessionVendor): Pick<VendorCheckResult, 'bridge'> {
  // T500: a downloaded server is named by its registry entry and pinned version.
  const pin = ACP_PROVIDERS[vendor].bridge;
  if (pin !== undefined) return { bridge: { package: pin.registryId, version: pin.version } };
  const bridge = bridgesOf({ [vendor]: ACP_PROVIDERS[vendor] })[0];
  return bridge !== undefined
    ? { bridge: { package: bridge.package, version: bridge.pinned } }
    : {};
}

/** Writes `self-check.json` (validated) into a probe session's dir. */
export function writeVendorCheck(sessionDir: string, result: VendorCheckResult): void {
  const valid = VendorCheckResultSchema.parse(result);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, VENDOR_CHECK_FILE), `${JSON.stringify(valid, null, 2)}\n`);
}

/** A session dir's `self-check.json`, if it is there and validates. */
export function readVendorCheck(sessionDir: string): VendorCheckResult | undefined {
  const file = join(sessionDir, VENDOR_CHECK_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = VendorCheckResultSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------ what routing reads

/** T489: what a vendor's last check says, for routing. */
export interface VendorCapability {
  vendor: SessionVendor;
  label: string;
  checked_at: string;
  cli_version?: string;
  logged_in: boolean;
  model: VendorCheckSettingOutcome;
  effort: VendorCheckSettingOutcome;
  /** The turn's own token counts arrived. */
  turn_tokens: boolean;
  resume: VendorCheckResume['outcome'];
}

/** The pure view of the latest results: one capability per vendor checked. */
export function vendorCapabilities(
  results: Iterable<VendorCheckResult>,
): Partial<Record<SessionVendor, VendorCapability>> {
  const out: Partial<Record<SessionVendor, VendorCapability>> = {};
  for (const r of results) {
    const before = out[r.vendor];
    if (before !== undefined && before.checked_at >= r.finished_at) continue;
    out[r.vendor] = {
      vendor: r.vendor,
      label: r.label,
      checked_at: r.finished_at,
      ...(r.cli_version !== undefined ? { cli_version: r.cli_version } : {}),
      logged_in: r.logged_in,
      model: r.model.outcome,
      effort: r.effort.outcome,
      turn_tokens: r.usage?.turn_tokens === true,
      resume: r.resume.outcome,
    };
  }
  return out;
}

/**
 * The vendors Choose leaves out, with why in words: those whose last check
 * says a model pick doesn't take (the vendor kept its own model and said
 * nothing). A refused pick leaves the vendor in (T494): the refusal is loud,
 * it is about the one model the check tried (one the plan may not include),
 * and a start that hits it fails over as any start error does. A vendor
 * never checked is not left out.
 */
export function vendorsLeftOut(
  capabilities: Partial<Record<SessionVendor, VendorCapability>>,
): Map<SessionVendor, string> {
  const out = new Map<SessionVendor, string>();
  for (const cap of Object.values(capabilities)) {
    if (cap === undefined) continue;
    if (cap.model === 'kept') {
      out.set(cap.vendor, `left out ${cap.label}: its last check kept its own model`);
    }
  }
  return out;
}

// ------------------------------------------------------------ the service

export interface VendorCheckServiceOptions {
  /** The state home: `<home>/sessions/<id>/self-check.json`. */
  home: string;
  /** The home config (the automatic trigger's switch), written through the validating store. */
  store?: {
    getHomeConfig(): HomeConfig;
    setVendorCheckMode(mode: VendorCheckMode, options?: { by?: string }): Promise<HomeConfig>;
  };
  /** The vendors this daemon knows (default every session vendor). */
  vendors?: readonly SessionVendor[];
  /** Whether a vendor's command is on PATH; why not, in words (default `missingVendorCommand`). */
  missing?: (vendor: SessionVendor) => string | undefined;
  /** Test seam: the provider a vendor maps to (the fake agent). */
  provider?: (vendor: SessionVendor) => AcpProviderConfig;
  /** Test seam: a fake `spawnSession`. */
  spawn?: typeof defaultSpawnSession;
  /** T480 (D49): the installed CLI a vendor's bridge runs. */
  installedCli?: (vendor: SessionVendor) => InstalledCli | undefined;
  /** T481: the vendor CLI's version as the daemon last read it. */
  cliVersion?: (vendor: SessionVendor) => string | undefined;
  /** T500: the servers this app downloads (Antigravity's): Install, and what is installed. */
  installs?: VendorInstalls;
  /** Every reply a check's session sent (the model catalog keeps the vendor's list). */
  onSessionState?: (vendor: SessionVendor, state: Record<string, unknown>, session: string) => void;
  openTimeoutMs?: number;
  promptTimeoutMs?: number;
  onError?: (err: unknown) => void;
  now?: () => Date;
}

/** T500: what the self-check needs of `BridgeInstallService` (`../bridges`). */
export interface VendorInstalls {
  /** The install's view for a downloaded bridge; `undefined` for any other vendor. */
  view(vendor: SessionVendor): VendorInstallView | undefined;
  /** Starts an install without waiting (throws, in words, for a vendor with nothing to install). */
  start(vendor: SessionVendor): void;
  /** Installs and resolves with the manifest. */
  install(vendor: SessionVendor): Promise<BridgeManifest>;
  /** Whether any install runs. */
  busy(): boolean;
}

interface Pending {
  vendor: SessionVendor;
  reason: VendorCheckReason;
  by: 'human' | 'daemon';
  done: Promise<VendorCheckResult>;
}

export class VendorCheckService {
  private readonly latest = new Map<SessionVendor, VendorCheckResult>();
  private readonly pending = new Map<SessionVendor, Pending>();
  private running: SessionVendor | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  /** The vendor processes the running check started, stopped with the daemon. */
  private readonly live = new Set<SpawnedSession>();
  private stopped = false;
  /** `vendor@version`s the automatic trigger already fired for (at most once per version). */
  private readonly triggered = new Set<string>();
  /** Called whenever a check starts, finishes or the switch changes. */
  onChange: (() => void) | undefined;

  constructor(private readonly options: VendorCheckServiceOptions) {}

  private get vendors(): readonly SessionVendor[] {
    return this.options.vendors ?? SESSION_VENDORS;
  }

  private missing(vendor: SessionVendor): string | undefined {
    return (
      this.options.missing ??
      ((v) => missingVendorCommand(providerIn(this.options.home, ACP_PROVIDERS[v])))
    )(vendor);
  }

  private changed(): void {
    try {
      this.onChange?.();
    } catch (err) {
      this.options.onError?.(err);
    }
  }

  /**
   * The newest `self-check.json` per vendor, read from the session dirs (a
   * file that doesn't validate is skipped: it is a record, not state).
   */
  load(): this {
    const root = join(this.options.home, 'sessions');
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return this;
    }
    for (const name of names) {
      const result = readVendorCheck(join(root, name));
      if (result === undefined || result.session !== name) continue;
      const before = this.latest.get(result.vendor);
      if (before === undefined || before.finished_at < result.finished_at) {
        this.latest.set(result.vendor, result);
      }
    }
    return this;
  }

  mode(): VendorCheckMode {
    try {
      return this.options.store?.getHomeConfig().vendor_checks ?? DEFAULT_VENDOR_CHECK_MODE;
    } catch (err) {
      // A config.yaml that doesn't validate is refused with its path wherever it is read.
      this.options.onError?.(err);
      return 'manual';
    }
  }

  async setMode(mode: VendorCheckMode): Promise<VendorChecksStatus> {
    if (this.options.store === undefined) throw new Error('no home to keep the setting in');
    await this.options.store.setVendorCheckMode(mode, { by: 'human' });
    this.changed();
    return this.status();
  }

  /** The latest result per vendor. */
  results(): Partial<Record<SessionVendor, VendorCheckResult>> {
    return Object.fromEntries(this.latest) as Partial<Record<SessionVendor, VendorCheckResult>>;
  }

  /** T489: the pure view routing reads (`vendorCapabilities` over the latest results). */
  capabilities(): Partial<Record<SessionVendor, VendorCapability>> {
    return vendorCapabilities(this.latest.values());
  }

  status(): VendorChecksStatus {
    const rows: VendorCheckRow[] = this.vendors.map((vendor) => {
      const last = this.latest.get(vendor);
      const version = this.cliVersion(vendor);
      const missing = this.missing(vendor);
      const install = this.installView(vendor);
      return {
        vendor,
        label: this.provider(vendor).label,
        installed: missing === undefined,
        ...(missing !== undefined ? { missing } : {}),
        ...(version !== undefined ? { cli_version: version } : {}),
        running: this.running === vendor,
        queued: this.pending.has(vendor) && this.running !== vendor,
        ...(last !== undefined ? { last } : {}),
        ...(install !== undefined ? { install } : {}),
      };
    });
    return { mode: this.mode(), vendors: rows, running: this.pending.size > 0 };
  }

  private installView(vendor: SessionVendor): VendorInstallView | undefined {
    try {
      return this.options.installs?.view(vendor);
    } catch (err) {
      this.options.onError?.(err);
      return undefined;
    }
  }

  private installsFor(vendor: SessionVendor): VendorInstalls {
    if (!this.vendors.includes(vendor))
      throw new VendorNotInstalledError(`no such vendor here: ${vendor}`);
    const installs = this.options.installs;
    if (installs === undefined || installs.view(vendor) === undefined) {
      throw new VendorNotInstalledError(
        `${this.provider(vendor).label} isn't installed by this app: install its command-line tool yourself.`,
      );
    }
    return installs;
  }

  /**
   * T500: Install (Settings → Agents → Vendors): downloads the vendor's
   * pinned server without waiting; the row shows it installing, then its
   * manifest or what went wrong. Never automatic.
   */
  startInstall(vendor: SessionVendor): VendorChecksStatus {
    this.installsFor(vendor).start(vendor);
    this.changed();
    return this.status();
  }

  /** T500: `agile vendors install <vendor>`: installs and waits. */
  async install(
    vendor: SessionVendor,
  ): Promise<{ manifest: BridgeManifest; status: VendorChecksStatus }> {
    const manifest = await this.installsFor(vendor).install(vendor);
    this.changed();
    return { manifest, status: this.status() };
  }

  private provider(vendor: SessionVendor): AcpProviderConfig {
    return this.options.provider?.(vendor) ?? providerIn(this.options.home, ACP_PROVIDERS[vendor]);
  }

  private cliVersion(vendor: SessionVendor): string | undefined {
    try {
      return this.options.cliVersion?.(vendor);
    } catch {
      return undefined;
    }
  }

  /**
   * The vendors a run covers: the one named (refused, in words, when it
   * isn't installed), or every installed one.
   */
  private targets(vendor: SessionVendor | undefined): SessionVendor[] {
    if (vendor !== undefined) {
      if (!this.vendors.includes(vendor))
        throw new VendorNotInstalledError(`no such vendor here: ${vendor}`);
      const missing = this.missing(vendor);
      if (missing !== undefined) throw new VendorNotInstalledError(missing);
      return [vendor];
    }
    return this.vendors.filter((v) => this.missing(v) === undefined);
  }

  /** Queues a check (one vendor at a time); a vendor already queued or running shares it. */
  private enqueue(
    vendor: SessionVendor,
    reason: VendorCheckReason,
    by: 'human' | 'daemon',
  ): Pending {
    const already = this.pending.get(vendor);
    if (already !== undefined) return already;
    const done = this.chain.then(() => this.checkOne(vendor, reason, by));
    const pending: Pending = { vendor, reason, by, done };
    this.pending.set(vendor, pending);
    this.chain = done.catch(() => undefined);
    void done
      .catch((err) => this.options.onError?.(err))
      .finally(() => {
        if (this.pending.get(vendor) === pending) this.pending.delete(vendor);
        this.changed();
      });
    this.changed();
    return pending;
  }

  private async checkOne(
    vendor: SessionVendor,
    reason: VendorCheckReason,
    by: 'human' | 'daemon',
  ): Promise<VendorCheckResult> {
    if (this.stopped) throw new Error('the daemon is stopping: the check did not run');
    this.running = vendor;
    this.changed();
    const session = ulid();
    const installedCli = this.options.installedCli?.(vendor);
    const cliVersion = this.cliVersion(vendor);
    try {
      const result = await runVendorCheck({
        vendor,
        provider: this.provider(vendor),
        session,
        sessionDir: join(this.options.home, 'sessions', session),
        reason,
        by,
        ...(cliVersion !== undefined ? { cliVersion } : {}),
        ...(installedCli !== undefined ? { installedCli } : {}),
        ...(this.options.spawn !== undefined ? { spawn: this.options.spawn } : {}),
        ...(this.options.openTimeoutMs !== undefined
          ? { openTimeoutMs: this.options.openTimeoutMs }
          : {}),
        ...(this.options.promptTimeoutMs !== undefined
          ? { promptTimeoutMs: this.options.promptTimeoutMs }
          : {}),
        onSessionState: (state) => this.options.onSessionState?.(vendor, state, session),
        onSpawned: (spawned) => {
          if (this.stopped) {
            spawned.close();
            return;
          }
          this.live.add(spawned);
          spawned.on((event) => {
            if (event.type === 'exit') this.live.delete(spawned);
          });
        },
        ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      });
      this.latest.set(vendor, result);
      return result;
    } finally {
      this.running = undefined;
    }
  }

  /**
   * Check vendors / `agile vendors check`: queues every installed vendor
   * (or the one named) and resolves with their results once all are done.
   */
  async run(
    vendor: SessionVendor | undefined,
    options: { reason?: VendorCheckReason; by?: 'human' | 'daemon' } = {},
  ): Promise<VendorCheckResult[]> {
    const pendings = this.targets(vendor).map((v) =>
      this.enqueue(v, options.reason ?? 'manual', options.by ?? 'human'),
    );
    return Promise.all(pendings.map((p) => p.done));
  }

  /** As `run`, without waiting: the cockpit's Check shows the running state and polls. */
  start(
    vendor: SessionVendor | undefined,
    options: { reason?: VendorCheckReason; by?: 'human' | 'daemon' } = {},
  ): VendorChecksStatus {
    for (const v of this.targets(vendor)) {
      this.enqueue(v, options.reason ?? 'manual', options.by ?? 'human');
    }
    return this.status();
  }

  /**
   * The automatic trigger: T481 read these CLI versions (`reason: new_version`)
   * or installed one (`update`). A vendor whose latest check is on another
   * version (or that was never checked) is checked, at most once per
   * version, unless the home says `vendor_checks: manual`.
   */
  noteVersions(
    versions: ReadonlyArray<{ vendor: string; version: string }>,
    reason: 'update' | 'new_version',
  ): SessionVendor[] {
    if (this.mode() !== 'auto') return [];
    const started: SessionVendor[] = [];
    for (const { vendor, version } of versions) {
      if (!isSessionVendor(vendor) || !this.vendors.includes(vendor)) continue;
      const key = `${vendor}@${version}`;
      if (this.triggered.has(key)) continue;
      if (this.latest.get(vendor)?.cli_version === version) continue;
      if (this.missing(vendor) !== undefined) continue;
      this.triggered.add(key);
      this.enqueue(vendor, reason, 'daemon');
      started.push(vendor);
    }
    return started;
  }

  /**
   * The daemon stops: the running check's vendor is stopped (the check ends
   * with that in its errors) and nothing queued starts a vendor.
   */
  stop(): void {
    this.stopped = true;
    for (const spawned of this.live) {
      try {
        spawned.close();
      } catch {
        // Already gone.
      }
    }
    this.live.clear();
  }

  /** Every queued or running check (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending.values()].map((p) => p.done.catch(() => undefined)));
    }
  }
}

/** A check named a vendor that isn't installed here (HTTP 409, like Refresh). */
export class VendorNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VendorNotInstalledError';
  }
}

// ------------------------------------------------------------ RPC

/**
 * T489: `vendors.*` RPC for `agile vendors` (the table) and `agile vendors
 * check [vendor]` (runs the checks and waits for them). A run is the operator's.
 */
export function buildVendorCheckRpcMethods(
  service: VendorCheckService,
): Record<string, RpcMethodHandler> {
  const vendorOf = (params: unknown): SessionVendor | undefined => {
    if (params === undefined) return undefined;
    const p = requireObject(params);
    if (p.vendor === undefined) return undefined;
    if (typeof p.vendor !== 'string' || !isSessionVendor(p.vendor)) {
      throw new RpcParamError(`invalid "vendor": one of ${SESSION_VENDORS.join(', ')}`);
    }
    return p.vendor;
  };
  return {
    'vendors.status': () => service.status(),
    // T500: install a vendor's downloaded server (Antigravity's) and wait for it.
    'vendors.install': async (params) => {
      const vendor = vendorOf(params);
      if (vendor === undefined) throw new RpcParamError('missing "vendor"');
      try {
        return await service.install(vendor);
      } catch (err) {
        if (err instanceof VendorNotInstalledError) throw new RpcParamError(err.message);
        throw err;
      }
    },
    'vendors.check': async (params) => {
      const vendor = vendorOf(params);
      try {
        const results = await service.run(vendor, { reason: 'manual', by: 'human' });
        return { results, status: service.status() };
      } catch (err) {
        if (err instanceof VendorNotInstalledError) throw new RpcParamError(err.message);
        throw err;
      }
    },
  };
}
