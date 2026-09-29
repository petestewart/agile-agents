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
  SESSION_VENDORS,
  type SessionVendor,
  VENDOR_MODELS_MAX,
  type VendorModel,
  VendorModelSchema,
  type VendorModels,
  VendorModelsSchema,
  isSessionVendor,
  ulid,
} from '@agile-agents/shared';
import { SESSION_STATE_FILE, saveSessionState } from './session';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** A vendor's model option as its reply carried it. */
export interface VendorModelOption {
  /** The config option's id (`model`): what `session/set_config_option` takes. Absent for a `models` list. */
  configId?: string;
  /** The model the session runs now. */
  current?: string;
  options: VendorModel[];
}

/** One option entry, if it parses (a value, and a name, else the value). */
function modelEntry(value: unknown, name: unknown, description: unknown): VendorModel | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = VendorModelSchema.safeParse({
    value,
    name: typeof name === 'string' && name.trim() !== '' ? name.slice(0, 200) : value.slice(0, 200),
    ...(typeof description === 'string' && description !== ''
      ? { description: description.slice(0, 300) }
      : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/** A select's options, flattening ACP's grouped form (`{group, name, options: [...]}`). */
function selectOptions(list: unknown): VendorModel[] {
  const out: VendorModel[] = [];
  const seen = new Set<string>();
  const add = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (out.length >= VENDOR_MODELS_MAX) return;
      const o = asRecord(item);
      if (o === null) continue;
      if (Array.isArray(o.options) && o.value === undefined) {
        add(o.options);
        continue;
      }
      const entry = modelEntry(o.value, o.name, o.description);
      if (entry === undefined || seen.has(entry.value)) continue;
      seen.add(entry.value);
      out.push(entry);
    }
  };
  add(list);
  return out;
}

/**
 * The model option of a `session/new`/`session/load` reply (or a saved
 * session-state file): `configOptions`' model entry when it lists models,
 * else ACP's `models`. `undefined` when the reply names no list.
 */
export function vendorModelOption(state: unknown): VendorModelOption | undefined {
  const s = asRecord(state);
  if (s === null) return undefined;
  if (Array.isArray(s.configOptions)) {
    for (const item of s.configOptions) {
      const o = asRecord(item);
      if (o === null || (o.category !== 'model' && o.id !== 'model')) continue;
      const options = selectOptions(o.options);
      if (options.length === 0) continue;
      const current = typeof o.currentValue === 'string' ? o.currentValue : undefined;
      return {
        ...(typeof o.id === 'string' ? { configId: o.id } : {}),
        ...(current !== undefined && current !== '' ? { current } : {}),
        options,
      };
    }
  }
  const models = asRecord(s.models);
  if (models !== null && Array.isArray(models.availableModels)) {
    const options: VendorModel[] = [];
    for (const item of models.availableModels) {
      if (options.length >= VENDOR_MODELS_MAX) break;
      const m = asRecord(item);
      const entry = modelEntry(m?.modelId, m?.name, m?.description);
      if (entry !== undefined && !options.some((o) => o.value === entry.value)) options.push(entry);
    }
    if (options.length > 0) {
      const current =
        typeof models.currentModelId === 'string' && models.currentModelId !== ''
          ? models.currentModelId
          : undefined;
      return { ...(current !== undefined ? { current } : {}), options };
    }
  }
  return undefined;
}

/** A model's name in its vendor's list, else its id. */
export function modelNameIn(option: VendorModelOption | undefined, value: string): string {
  return option?.options.find((o) => o.value === value)?.name ?? value;
}

/** The catalog entry a reply makes, if it names a list and fits the schema. */
function entryOf(state: unknown, at: string, session: string | undefined): VendorModels | undefined {
  const option = vendorModelOption(state);
  if (option === undefined) return undefined;
  const parsed = VendorModelsSchema.safeParse({
    options: option.options,
    ...(option.current !== undefined ? { current: option.current } : {}),
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
    const run = probeVendorState({
      provider,
      sessionDir: join(this.options.home, 'sessions', session),
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

export interface ProbeOptions {
  provider: AcpProviderConfig;
  /** Created if missing: the vendor's cwd, its stderr.log and its session-state.json. */
  sessionDir: string;
  spawn?: typeof defaultSpawnSession;
  timeoutMs?: number;
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
    envOverrides: { ...provider.envOverrides },
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
          () => reject(new Error(`no answer in ${Math.round((opts.timeoutMs ?? REFRESH_TIMEOUT_MS) / 1000)} s`)),
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
