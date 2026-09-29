/**
 * T467 (D46): each vendor's model list, as the vendor itself reported it.
 *
 * Every session already keeps its vendor's `session/new` (or
 * `session/load`) reply in `<home>/sessions/<id>/session-state.json`
 * (T467a/b, `SESSION_STATE_FILE`). A vendor's list is the model option of
 * its most recent reply: the `configOptions` entry with `category: "model"`
 * (Claude, Codex, Cursor and Grok all send one, LIVE-CHECKLIST §12), else
 * ACP's `models.availableModels` (Codex's `models` lists model × effort
 * pairs, so it is only the fallback).
 *
 * The catalog is read once at start-up, newest session first, and then
 * kept up to date in memory as sessions open (`record`); a request never
 * scans the home. No new file: the session-state files are the record. A
 * file names its vendor (`vendor`, from T467 on); an older one is mapped
 * through the session records (`vendorOfSession`).
 *
 * `refresh` asks a vendor that hasn't run yet: it spawns it with no
 * prompt, lets `session/new` answer, and stops it. No node, no repo.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACP_PROVIDERS,
  type AcpProviderConfig,
  type AgentEvent,
  AuthRequiredError,
  type SpawnSessionOptions,
  type SpawnedSession,
  spawnSession as defaultSpawnSession,
} from '@agile-agents/acp-client';
import {
  SESSION_MODEL_MAX_CHARS,
  SESSION_VENDORS,
  type SessionVendor,
  type VendorModels,
  VendorModelsSchema,
  isSessionVendor,
  ulid,
} from '@agile-agents/shared';
import { withoutDaemonSecrets } from '../secret-env';
import type { InstalledCli } from './installed-cli';
import { SESSION_STATE_FILE, saveSessionState } from './session';
import { asRecord, vendorModelOption } from './vendor-models';

/** The catalog entry a reply makes, if it names a list and fits the schema. */
function entryOf(
  state: unknown,
  at: string,
  session: string | undefined,
): VendorModels | undefined {
  const option = vendorModelOption(state);
  if (option === undefined) return undefined;
  const parsed = VendorModelsSchema.safeParse({
    options: option.options,
    // An id past the cap is never cut (a cut id names another model): it is left out.
    ...(option.current !== undefined && option.current.length <= SESSION_MODEL_MAX_CHARS
      ? { current: option.current }
      : {}),
    at,
    ...(session !== undefined ? { session } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/** At most this many session-state files are read at start-up, newest first. */
const LOAD_MAX_FILES = 500;
/** How long a Refresh waits for the vendor to answer `session/new`. */
const REFRESH_TIMEOUT_MS = 60_000;

export interface ModelCatalogOptions {
  /** The state home: `<home>/sessions/<id>/session-state.json`. */
  home: string;
  /** A session's vendor from its record, for a file written before it named its vendor. */
  vendorOfSession?: (sessionId: string) => string | undefined;
  /** Test seam: a fake `spawnSession` (Refresh). */
  spawn?: typeof defaultSpawnSession;
  /** Test seam: the provider a vendor maps to (the fake-agent transport). */
  provider?: (vendor: SessionVendor) => AcpProviderConfig;
  /** T480 (D49): the installed CLI a vendor's bridge runs (read at each Refresh). */
  installedCli?: (vendor: SessionVendor) => InstalledCli | undefined;
  now?: () => Date;
}

export class ModelCatalog {
  private readonly byVendor = new Map<SessionVendor, VendorModels>();
  private readonly refreshing = new Map<SessionVendor, Promise<VendorModels | undefined>>();

  constructor(private readonly options: ModelCatalogOptions) {}

  /**
   * Reads the newest session-state files until every vendor has a list (or
   * `LOAD_MAX_FILES` were read). Session ids are ULIDs, so the directory
   * names sort by age. A file that doesn't parse is skipped: it is a log,
   * not state.
   */
  load(): this {
    const root = join(this.options.home, 'sessions');
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return this;
    }
    names.sort().reverse();
    let read = 0;
    for (const name of names) {
      if (this.byVendor.size === SESSION_VENDORS.length || read >= LOAD_MAX_FILES) break;
      const file = join(root, name, SESSION_STATE_FILE);
      if (!existsSync(file)) continue;
      read += 1;
      let state: Record<string, unknown> | null;
      try {
        state = asRecord(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        continue;
      }
      if (state === null) continue;
      const vendor =
        typeof state.vendor === 'string' ? state.vendor : this.options.vendorOfSession?.(name);
      if (vendor === undefined || !isSessionVendor(vendor)) continue;
      if (this.byVendor.has(vendor)) continue;
      const at = typeof state.at === 'string' ? state.at : '';
      const entry = entryOf(state, at || '1970-01-01T00:00:00.000Z', name);
      if (entry !== undefined) this.byVendor.set(vendor, entry);
    }
    return this;
  }

  /** A reply a session just got (`_agile/session_state`, as saved): the vendor's list if it names one. */
  record(vendor: string, state: unknown, session?: string): void {
    if (!isSessionVendor(vendor)) return;
    const s = asRecord(state);
    const at =
      typeof s?.at === 'string' ? s.at : (this.options.now?.() ?? new Date()).toISOString();
    const entry = entryOf(state, at, session);
    if (entry !== undefined) this.byVendor.set(vendor, entry);
  }

  get(vendor: SessionVendor): VendorModels | undefined {
    return this.byVendor.get(vendor);
  }

  /** Every vendor's list that is known. */
  all(): Partial<Record<SessionVendor, VendorModels>> {
    return Object.fromEntries(this.byVendor) as Partial<Record<SessionVendor, VendorModels>>;
  }

  /**
   * Refresh: start `vendor` with no prompt, let its `session/new` answer
   * (it is kept in a session dir of its own, as any session's is), stop
   * it. Resolves with the vendor's list, or `undefined` when its reply
   * named none; rejects with why when it could not start or answer.
   * Concurrent refreshes of one vendor share one spawn.
   */
  refresh(vendor: SessionVendor): Promise<VendorModels | undefined> {
    const running = this.refreshing.get(vendor);
    if (running !== undefined) return running;
    const provider = this.options.provider?.(vendor) ?? ACP_PROVIDERS[vendor];
    const session = ulid();
    const installedCli = this.options.installedCli?.(vendor);
    const run = probeVendorState({
      provider,
      sessionDir: join(this.options.home, 'sessions', session),
      ...(installedCli !== undefined ? { installedCli } : {}),
      ...(this.options.spawn !== undefined ? { spawn: this.options.spawn } : {}),
    })
      .then((state) => {
        this.record(vendor, state, session);
        return state === undefined ? undefined : this.byVendor.get(vendor);
      })
      .finally(() => {
        this.refreshing.delete(vendor);
      });
    this.refreshing.set(vendor, run);
    return run;
  }
}

/**
 * T467: a session's vendor from the node records, for a session-state file
 * written before files named their vendor. Built on first use (the
 * catalog's start-up read), not per request.
 */
export function sessionVendorIndex(streams: {
  list(options: { include_archived: boolean }): ReadonlyArray<{
    sessions: ReadonlyArray<{ id: string; vendor: string }>;
  }>;
}): (sessionId: string) => string | undefined {
  let index: Map<string, string> | undefined;
  return (sessionId) => {
    if (index === undefined) {
      index = new Map();
      for (const stream of streams.list({ include_archived: true })) {
        for (const session of stream.sessions) index.set(session.id, session.vendor);
      }
    }
    return index.get(sessionId);
  };
}

export interface ProbeOptions {
  provider: AcpProviderConfig;
  /** Created if missing: the vendor's cwd, its stderr.log and its session-state.json. */
  sessionDir: string;
  spawn?: typeof defaultSpawnSession;
  timeoutMs?: number;
  /** T480 (D49): the installed CLI the bridge runs, so the list is that CLI's. */
  installedCli?: InstalledCli;
}

/**
 * T467: opens one ACP session on `provider` without prompting it and
 * returns its `session/new` reply as saved (`session-state.json`), then
 * stops the vendor. Authenticates first where the vendor asks for it
 * (Cursor, Grok). No hooks, no MCP servers, no tools: nothing runs.
 */
export async function probeVendorState(opts: ProbeOptions): Promise<Record<string, unknown>> {
  const { provider, sessionDir } = opts;
  mkdirSync(sessionDir, { recursive: true });
  const stderrPath = join(sessionDir, 'stderr.log');
  const spawnOptions: SpawnSessionOptions = {
    cmd: provider.command,
    args: [...provider.args],
    cwd: sessionDir,
    // T486: the daemon's own env, less its secrets (the classifier key).
    env: withoutDaemonSecrets(),
    envOverrides: { ...provider.envOverrides, ...(opts.installedCli?.env ?? {}) },
    clientCapabilities: provider.clientCapabilities,
    mcpServers: [],
    onStderr: (chunk) => {
      try {
        appendFileSync(stderrPath, chunk);
      } catch {
        // Diagnostics only.
      }
    },
  };
  const spawned: SpawnedSession = (opts.spawn ?? defaultSpawnSession)(spawnOptions);
  let state: Record<string, unknown> | undefined;
  let failure: string | undefined;
  const unsubscribe = spawned.on((event: AgentEvent) => {
    if (event.type === 'error') failure = event.message;
    if (event.type === 'exit' && failure === undefined) {
      failure = `the agent exited (code ${event.exitCode}) before it answered`;
    }
    if (event.type !== 'event') return;
    const frame = event.event;
    if (frame.acp === 'notification' && frame.message.method === '_agile/session_state') {
      state = saveSessionState(sessionDir, asRecord(frame.message.params), provider.id);
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const open = async (): Promise<void> => {
      try {
        await spawned.open();
      } catch (err) {
        if (!(err instanceof AuthRequiredError) || provider.authMethods.length === 0) throw err;
        let lastErr: unknown = err;
        for (const methodId of provider.authMethods) {
          try {
            await spawned.authenticate(methodId);
            await spawned.open();
            return;
          } catch (retryErr) {
            lastErr = retryErr;
          }
        }
        throw lastErr;
      }
    };
    await Promise.race([
      open(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `no answer in ${Math.round((opts.timeoutMs ?? REFRESH_TIMEOUT_MS) / 1000)} s`,
              ),
            ),
          opts.timeoutMs ?? REFRESH_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`${provider.label} did not open a session: ${failure ?? why}`.slice(0, 500));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    try {
      spawned.close();
    } catch {
      // Already gone.
    }
  }
  if (state === undefined) {
    throw new Error(`${provider.label} opened a session but sent no reply to keep`);
  }
  return state;
}
