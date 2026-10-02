/**
 * T481 (**D50**): `HarnessUpdateService` keeps each vendor's own CLI up to
 * date, in the mode Settings picks (`harness_updates` in config.yaml):
 *
 *  - **Off**: no check and no command, not even `--version`.
 *  - **Alert** (the default): a check at daemon start (off the start path)
 *    and every 24 h, plus Check now. A CLI with a newer version is a Needs
 *    me item, "Claude Code 2.3.1 is available (you have 2.2.9)", with
 *    Update and Dismiss (remembered for that version). A method that can
 *    only update, not tell the newest version (`claude update`), offers
 *    Update only when you ask (Check now), so nothing nags daily.
 *  - **Auto**: the update runs in the background; a success is a
 *    `harness_updated` line in Events, a failure a Needs me item with the
 *    command to run by hand. A version that failed is not tried again on
 *    its own (a permission error stays a permission error).
 *
 * Updates run one at a time, as a fixed argv (never a shell, never sudo)
 * with a timeout. Running sessions are untouched: the next start uses the
 * new version (T495: a resting session whose CLI changed on disk, by this
 * service or by hand, starts again, resumed, at its next message). The last result per CLI is held in memory; the mode and the
 * dismissed versions are in the home config, written through the store.
 * Bridges (Claude's and Codex's npx ACP bridges) are shown with their
 * pinned and newest versions, and never installed: they move by a code
 * change.
 */

import { realpathSync } from 'node:fs';
import {
  DEFAULT_HARNESS_UPDATE_MODE,
  HARNESS_IDS,
  type HarnessBridgeStatus,
  type HarnessId,
  type HarnessStatus,
  type HarnessUpdateMode,
  type HarnessUpdateResult,
  type HarnessUpdatesConfig,
  type HarnessUpdatesInput,
  type HarnessUpdatesStatus,
  type HomeConfig,
  type InboxItem,
  ROUTED_EVENT_STRING_MAX,
  type SessionVendor,
  harnessModeOf,
  inboxContext,
  inboxDetail,
} from '@agile-agents/shared';
import type { RoutedEventService } from '../events';
import {
  type CommandResult,
  type CommandRunner,
  HARNESSES,
  type InstallInfo,
  type MethodTools,
  type UpdateMethod,
  commandText,
  compareVersions,
  detectInstall,
  firstLine,
  parseVersion,
} from './methods';

/** The daily check. */
export const HARNESS_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The first check, after the daemon has started (never on the start path). */
export const HARNESS_START_DELAY_MS = 10_000;
/** `--version`, `npm view`, `brew info`. */
export const HARNESS_CHECK_TIMEOUT_MS = 30_000;
/** An update: `npm install -g`, `brew upgrade`, `claude update`. */
export const HARNESS_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

/** An ACP bridge the code pins (`@agentclientprotocol/claude-agent-acp@0.84.0`). */
export interface HarnessBridge {
  vendor: SessionVendor;
  label: string;
  package: string;
  pinned: string;
}

/** The npx bridges in the provider registry, read from their pinned `<pkg>@<version>` arg. */
export function bridgesOf(
  providers: Readonly<
    Record<string, { id: string; label: string; command: string; args: readonly string[] }>
  >,
): HarnessBridge[] {
  const out: HarnessBridge[] = [];
  for (const provider of Object.values(providers)) {
    if (provider.command !== 'npx') continue;
    for (const arg of provider.args) {
      const m = /^((?:@[^/@]+\/)?[^/@]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(arg);
      if (!m) continue;
      out.push({
        vendor: provider.id as SessionVendor,
        label: `${provider.label} bridge`,
        package: m[1] as string,
        pinned: m[2] as string,
      });
    }
  }
  return out;
}

export interface HarnessUpdateDeps {
  store: {
    getHomeConfig(): HomeConfig;
    setHarnessUpdateMode(
      mode: HarnessUpdateMode | null,
      vendor: SessionVendor | undefined,
      options?: { by?: string },
    ): Promise<HomeConfig>;
    setHarnessUpdateDismissed(
      harness: HarnessId,
      version: string | undefined,
      options?: { by?: string },
    ): Promise<HomeConfig>;
  };
  /** Runs one argv. Tests inject a fake; nothing real runs there. */
  run: CommandRunner;
  /** A PATH lookup (default `Bun.which`). */
  which?: (command: string) => string | null;
  /** Follows symlinks (default `realpathSync`). */
  realpath?: (path: string) => string;
  exists?: (path: string) => boolean;
  /** Where a `harness_updated` line is recorded (Events). */
  events?: Pick<RoutedEventService, 'emit'>;
  bridges?: readonly HarnessBridge[];
  /** The CLIs checked (default all of `HARNESS_IDS`). */
  harnesses?: readonly HarnessId[];
  now?: () => Date;
  intervalMs?: number;
  startDelayMs?: number;
  checkTimeoutMs?: number;
  updateTimeoutMs?: number;
  onError?: (err: unknown) => void;
  /**
   * T489 (D58): the vendor CLI versions a check read (`check`), or the one an
   * update installed (`update`): the vendor self-check runs for a version it
   * has none for.
   */
  onVersions?: (
    versions: Array<{ vendor: SessionVendor; version: string }>,
    reason: 'check' | 'update',
  ) => void;
}

/** What one CLI's last check found, and what happened to its last update. */
interface Entry {
  found: boolean;
  checked_at: string;
  /** The command as found on PATH, and where it resolves. */
  bin?: string;
  path?: string;
  install?: InstallInfo;
  method?: UpdateMethod;
  version?: string;
  latest?: string;
  error?: string;
  updating?: boolean;
  last_update?: { ok: boolean; message: string; at: string };
  /** An update that failed: its words, and the version it was for. It stays a Needs me item until dismissed. */
  failure?: { version?: string; message: string; at: string };
  /** Check now found a method that can update but can't tell the newest version: offer Update once. */
  offer?: string;
}

/** An update refused because one is already running for that CLI. */
export class HarnessBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessBusyError';
  }
}

const clip = (text: string): string =>
  text.length > ROUTED_EVENT_STRING_MAX ? `${text.slice(0, ROUTED_EVENT_STRING_MAX - 1)}…` : text;

export class HarnessUpdateService {
  private readonly entries = new Map<HarnessId, Entry>();
  private readonly bridgeLatest = new Map<
    string,
    { latest?: string; error?: string; at: string }
  >();
  private checking: Promise<void> | undefined;
  private checkedAt: string | undefined;
  /** Updates run one at a time (two `brew upgrade`s fight over brew's lock). */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly background = new Set<Promise<unknown>>();
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private dailyTimer: ReturnType<typeof setInterval> | undefined;
  private readonly tools: MethodTools;
  /** Called after anything Needs me or Settings shows changed (the HTTP server re-pushes the frame). */
  onChange: (() => void) | undefined;

  constructor(private readonly deps: HarnessUpdateDeps) {
    this.tools = {
      which: deps.which ?? ((command) => Bun.which(command)),
      exists:
        deps.exists ??
        ((path) => {
          try {
            realpathSync(path);
            return true;
          } catch {
            return false;
          }
        }),
    };
  }

  private get ids(): readonly HarnessId[] {
    return this.deps.harnesses ?? HARNESS_IDS;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private config(): HarnessUpdatesConfig | undefined {
    try {
      return this.deps.store.getHomeConfig().harness_updates;
    } catch (err) {
      // A config.yaml that doesn't validate is refused with its path wherever it is read.
      this.deps.onError?.(err);
      return undefined;
    }
  }

  private changed(): void {
    try {
      this.onChange?.();
    } catch (err) {
      this.deps.onError?.(err);
    }
  }

  /** The check at start (after a short delay, off the start path) and then every 24 h; timers never hold the process. */
  start(): void {
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      void this.check('scheduled').catch((err) => this.deps.onError?.(err));
    }, this.deps.startDelayMs ?? HARNESS_START_DELAY_MS);
    this.startTimer.unref?.();
    this.dailyTimer = setInterval(() => {
      void this.check('scheduled').catch((err) => this.deps.onError?.(err));
    }, this.deps.intervalMs ?? HARNESS_CHECK_INTERVAL_MS);
    this.dailyTimer.unref?.();
  }

  stop(): void {
    if (this.startTimer !== undefined) clearTimeout(this.startTimer);
    if (this.dailyTimer !== undefined) clearInterval(this.dailyTimer);
    this.startTimer = undefined;
    this.dailyTimer = undefined;
  }

  /** Every background update started by a check (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
  }

  // ------------------------------------------------------------ the check

  /**
   * Reads each CLI whose mode isn't Off: where it resolves, its version,
   * the newest one. `manual` is Check now: a method that can only update
   * (not tell the newest version) is then offered as an Update. In Auto,
   * the updates start in the background once the check is done.
   */
  async check(reason: 'scheduled' | 'manual' = 'manual'): Promise<HarnessUpdatesStatus> {
    if (this.checking !== undefined) {
      await this.checking;
      return this.status();
    }
    this.checking = this.checkNow(reason).finally(() => {
      this.checking = undefined;
    });
    this.changed();
    await this.checking;
    return this.status();
  }

  private async checkNow(reason: 'scheduled' | 'manual'): Promise<void> {
    const config = this.config();
    const at = this.now();
    await Promise.all(
      this.ids.map(async (id) => {
        if (harnessModeOf(config, id) === 'off') return;
        const entry = await this.read(id, at);
        if (
          reason === 'manual' &&
          entry.found &&
          entry.method !== undefined &&
          entry.method.latest === undefined
        ) {
          entry.offer = at;
        }
      }),
    );
    await Promise.all(
      (this.deps.bridges ?? []).map(async (bridge) => {
        if (modeOfVendor(config, bridge.vendor) === 'off') return;
        const npm = this.tools.which('npm');
        if (npm === null) {
          this.bridgeLatest.set(bridge.package, { error: 'npm is not on the daemon’s PATH', at });
          return;
        }
        const res = await this.runCheck([npm, 'view', bridge.package, 'version']);
        const latest = res.code === 0 ? parseVersion(res.stdout.trim()) : undefined;
        this.bridgeLatest.set(bridge.package, {
          ...(latest !== undefined
            ? { latest }
            : { error: `couldn’t read the newest version (${failureLine(res)})` }),
          at,
        });
      }),
    );
    this.checkedAt = at;
    this.changed();
    this.noteVersions(
      this.ids.flatMap((id) => {
        const version = this.entries.get(id)?.version;
        return version !== undefined ? [{ id, version }] : [];
      }),
      'check',
    );
    const autos = this.ids.filter(
      (id) => harnessModeOf(config, id) === 'auto' && this.wantsAuto(id, config),
    );
    if (autos.length > 0) {
      const job = (async () => {
        for (const id of autos) await this.update(id, { by: 'daemon' });
      })().catch((err) => this.deps.onError?.(err));
      this.background.add(job);
      void job.finally(() => this.background.delete(job));
    }
  }

  /** Whether Auto should update this CLI now: a newer version not dismissed and not already failed. */
  private wantsAuto(id: HarnessId, config: HarnessUpdatesConfig | undefined): boolean {
    const e = this.entries.get(id);
    if (e === undefined || !e.found || e.method === undefined || e.updating === true) return false;
    // An update-only method (`claude update`): run it on each check, unless it failed.
    if (e.method.latest === undefined) return e.failure === undefined && e.version !== undefined;
    if (e.latest === undefined || e.version === undefined) return false;
    if (compareVersions(e.version, e.latest) >= 0) return false;
    if (config?.dismissed?.[id] === e.latest) return false;
    return e.failure?.version !== e.latest;
  }

  private runCheck(argv: readonly string[]): Promise<CommandResult> {
    return this.deps.run(argv, {
      timeoutMs: this.deps.checkTimeoutMs ?? HARNESS_CHECK_TIMEOUT_MS,
    });
  }

  /** One CLI: found on PATH, its install method, its version and the newest one. */
  private async read(id: HarnessId, at: string): Promise<Entry> {
    const spec = HARNESSES[id];
    const before = this.entries.get(id);
    const keep = {
      ...(before?.updating ? { updating: true } : {}),
      ...(before?.last_update ? { last_update: before.last_update } : {}),
      ...(before?.failure ? { failure: before.failure } : {}),
    };
    const bin = this.tools.which(spec.command);
    if (bin === null) {
      const entry: Entry = { found: false, checked_at: at };
      this.entries.set(id, entry);
      return entry;
    }
    let path = bin;
    try {
      path = (this.deps.realpath ?? realpathSync)(bin);
    } catch {
      // A dangling link: read where it points to as the command itself.
    }
    const { install, method } = detectInstall(id, path);
    const errors: string[] = [];
    const version = await this.readVersion(bin, errors);
    let latest: string | undefined;
    if (method?.latest !== undefined) {
      const res = await this.runCheck(method.latest.argv(install, this.tools));
      latest = res.code === 0 ? method.latest.parse(res.stdout) : undefined;
      if (latest === undefined)
        errors.push(`couldn’t read the newest version (${failureLine(res)})`);
    }
    const entry: Entry = {
      found: true,
      checked_at: at,
      bin,
      path,
      install,
      ...(method !== undefined ? { method } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(latest !== undefined ? { latest } : {}),
      ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
      ...keep,
    };
    // A failure for a version that is no longer the newest is history, not an item.
    if (
      entry.failure !== undefined &&
      entry.failure.version !== undefined &&
      latest !== undefined &&
      entry.failure.version !== latest
    ) {
      entry.failure = undefined;
    }
    this.entries.set(id, entry);
    return entry;
  }

  private async readVersion(bin: string, errors: string[]): Promise<string | undefined> {
    const res = await this.runCheck([bin, '--version']);
    const version =
      res.code === 0 ? (parseVersion(res.stdout) ?? parseVersion(res.stderr)) : undefined;
    if (version === undefined) errors.push(`couldn’t read its version (${failureLine(res)})`);
    return version;
  }

  // ------------------------------------------------------------ update and dismiss

  /**
   * Runs the CLI's update command (one at a time, with the timeout) and says
   * what happened in words: "Updated Claude Code to 2.3.1", or "Couldn't
   * update Claude Code: <first line>. Run: <command>". A failure stays a
   * Needs me item until dismissed or a later update succeeds.
   */
  async update(id: HarnessId, options: { by: 'human' | 'daemon' }): Promise<HarnessUpdateResult> {
    const label = HARNESSES[id].label;
    let entry = this.entries.get(id);
    if (entry === undefined) entry = await this.read(id, this.now());
    if (!entry.found || entry.bin === undefined) {
      return this.settle(id, {
        ok: false,
        message: `Couldn’t update ${label}: \`${HARNESSES[id].command}\` isn’t on the daemon’s PATH`,
      });
    }
    if (entry.method === undefined) {
      return { ok: false, message: manualText(label, entry.path), status: this.statusOf(id) };
    }
    if (entry.updating === true) throw new HarnessBusyError(`${label} is already updating`);
    entry.updating = true;
    this.changed();
    const job = this.queue.then(() => this.runUpdate(id, options.by));
    this.queue = job.catch(() => undefined);
    try {
      return await job;
    } finally {
      const after = this.entries.get(id);
      if (after !== undefined) after.updating = false;
      this.changed();
    }
  }

  private async runUpdate(id: HarnessId, by: 'human' | 'daemon'): Promise<HarnessUpdateResult> {
    const label = HARNESSES[id].label;
    const entry = this.entries.get(id) as Entry;
    const method = entry.method as UpdateMethod;
    const install = entry.install as InstallInfo;
    const argv = method.update(install, entry.bin as string, this.tools);
    const command = commandText(argv);
    const from = entry.version;
    const target = entry.latest;
    const timeoutMs = this.deps.updateTimeoutMs ?? HARNESS_UPDATE_TIMEOUT_MS;
    const res = await this.deps.run(argv, { timeoutMs });
    if (res.timedOut || res.error !== undefined || res.code !== 0) {
      const why = res.timedOut
        ? `it ran longer than ${durationWords(timeoutMs)} and was stopped`
        : failureLine(res);
      const message = `Couldn’t update ${label}: ${why}. Run: ${command}`;
      entry.failure = {
        ...(target !== undefined ? { version: target } : {}),
        message,
        at: this.now(),
      };
      entry.offer = undefined;
      return this.settle(id, { ok: false, message });
    }
    // It worked: read the version it is at now.
    const errors: string[] = [];
    const to = await this.readVersion(entry.bin as string, errors);
    const printed = firstLine(res.stdout);
    let message: string;
    if (to !== undefined && to !== from) message = `Updated ${label} to ${to}`;
    else if (to !== undefined)
      message = `${label} is at ${to}${printed !== undefined ? ` (it said: ${printed})` : ''}`;
    else message = `Updated ${label}${printed !== undefined ? ` (it said: ${printed})` : ''}`;
    if (to !== undefined) entry.version = to;
    entry.failure = undefined;
    entry.offer = undefined;
    if (to !== undefined && to !== from) {
      this.noteVersions([{ id, version: to }], 'update');
      await this.deps.events
        ?.emit({
          type: 'harness_updated',
          payload: {
            harness: id,
            label,
            ...(from !== undefined ? { from } : {}),
            to,
            summary: clip(message),
          },
          by,
          routing: [],
        })
        .catch((err) => this.deps.onError?.(err));
    }
    return this.settle(id, { ok: true, message });
  }

  /** T489: hands the vendor CLIs' versions to `onVersions`. */
  private noteVersions(
    versions: Array<{ id: HarnessId; version: string }>,
    reason: 'check' | 'update',
  ): void {
    const vendors = versions.map((v) => ({
      vendor: HARNESSES[v.id].vendor,
      version: v.version,
    }));
    if (vendors.length === 0 || this.deps.onVersions === undefined) return;
    try {
      this.deps.onVersions(vendors, reason);
    } catch (err) {
      this.deps.onError?.(err);
    }
  }

  private settle(id: HarnessId, result: { ok: boolean; message: string }): HarnessUpdateResult {
    const entry = this.entries.get(id);
    if (entry !== undefined) {
      entry.last_update = { ...result, at: this.now() };
      entry.updating = false;
    }
    return { ...result, status: this.statusOf(id) };
  }

  /**
   * Dismiss: the item goes until a newer version is out (the version it
   * offered is kept in the home config). A failed update's item goes too.
   */
  async dismiss(id: HarnessId): Promise<HarnessStatus> {
    const entry = this.entries.get(id);
    const version = entry?.failure?.version ?? entry?.latest;
    if (entry !== undefined) {
      entry.failure = undefined;
      entry.offer = undefined;
    }
    if (version !== undefined) {
      await this.deps.store.setHarnessUpdateDismissed(id, version, { by: 'human' });
    }
    this.changed();
    return this.statusOf(id);
  }

  /** Settings' Off/Alert/Auto, the home's or one vendor's. */
  async setMode(input: HarnessUpdatesInput): Promise<HarnessUpdatesStatus> {
    await this.deps.store.setHarnessUpdateMode(input.mode, input.vendor, { by: 'human' });
    this.changed();
    return this.status();
  }

  // ------------------------------------------------------------ what Settings and Needs me read

  status(): HarnessUpdatesStatus {
    const config = this.config();
    const bridges: HarnessBridgeStatus[] = (this.deps.bridges ?? []).map((b) => {
      const seen = this.bridgeLatest.get(b.package);
      return {
        vendor: b.vendor,
        label: b.label,
        package: b.package,
        pinned: b.pinned,
        ...(seen?.latest !== undefined ? { latest: seen.latest } : {}),
        ...(seen?.error !== undefined ? { error: seen.error } : {}),
        ...(seen !== undefined ? { checked_at: seen.at } : {}),
      };
    });
    return {
      mode: config?.mode ?? DEFAULT_HARNESS_UPDATE_MODE,
      vendors: { ...(config?.vendors ?? {}) },
      harnesses: this.ids.map((id) => this.statusOf(id, config)),
      bridges,
      checking: this.checking !== undefined,
      ...(this.checkedAt !== undefined ? { checked_at: this.checkedAt } : {}),
    };
  }

  statusOf(id: HarnessId, config = this.config()): HarnessStatus {
    const spec = HARNESSES[id];
    const e = this.entries.get(id);
    const behind =
      e?.version !== undefined &&
      e.latest !== undefined &&
      compareVersions(e.version, e.latest) < 0;
    const command =
      e?.method !== undefined && e.install !== undefined && e.bin !== undefined
        ? commandText(e.method.update(e.install, e.bin, this.tools))
        : undefined;
    const dismissed = config?.dismissed?.[id];
    return {
      id,
      vendor: spec.vendor,
      label: spec.label,
      mode: harnessModeOf(config, id),
      found: e?.found === true,
      ...(e?.path !== undefined ? { path: e.path } : {}),
      ...(e?.install !== undefined ? { method: e.install.method } : {}),
      ...(e?.install?.package !== undefined ? { package: e.install.package } : {}),
      ...(e?.version !== undefined ? { version: e.version } : {}),
      ...(e?.latest !== undefined ? { latest: e.latest } : {}),
      behind,
      can_update: e?.found === true && e.method !== undefined,
      ...(command !== undefined ? { command } : {}),
      ...(e?.found === true && e.method === undefined
        ? { manual: manualText(spec.label, e.path) }
        : {}),
      ...(e?.checked_at !== undefined ? { checked_at: e.checked_at } : {}),
      ...(e?.error !== undefined ? { error: e.error } : {}),
      ...(e?.updating === true ? { updating: true } : {}),
      ...(e?.last_update !== undefined ? { last_update: e.last_update } : {}),
      ...(dismissed !== undefined ? { dismissed } : {}),
    };
  }

  /** The Needs me items: a CLI behind (Alert), an offered Update (Check now), or a failed update. */
  inboxItems(): InboxItem[] {
    const config = this.config();
    const items: InboxItem[] = [];
    for (const id of this.ids) {
      const e = this.entries.get(id);
      const mode = harnessModeOf(config, id);
      if (e === undefined || !e.found || mode === 'off' || e.updating === true) continue;
      const label = HARNESSES[id].label;
      let text: string | undefined;
      let ts = e.checked_at;
      let failed = false;
      if (e.failure !== undefined) {
        text = e.failure.message;
        ts = e.failure.at;
        failed = true;
      } else if (mode === 'alert' && e.version !== undefined && e.latest !== undefined) {
        if (compareVersions(e.version, e.latest) < 0 && config?.dismissed?.[id] !== e.latest) {
          text = `${label} ${e.latest} is available (you have ${e.version})`;
        }
      } else if (mode === 'alert' && e.offer !== undefined && e.method !== undefined) {
        ts = e.offer;
        const command =
          e.install !== undefined && e.bin !== undefined
            ? commandText(e.method.update(e.install, e.bin, this.tools))
            : undefined;
        text =
          `${label} ${e.version ?? ''} may have an update: its own installer checks when you press Update${
            command !== undefined ? ` (\`${command}\`)` : ''
          }`.replace(/ {2,}/g, ' ');
      }
      if (text === undefined) continue;
      const detail = inboxDetail(text);
      items.push({
        kind: 'harness_update',
        id: `harness:${id}`,
        stream_path: [],
        ts,
        context: inboxContext(text),
        ...(detail !== undefined ? { detail } : {}),
        harness: { id, label, ...(failed ? { failed: true as const } : {}) },
      });
    }
    return items;
  }
}

/** A bridge's mode: its vendor's. */
function modeOfVendor(
  config: HarnessUpdatesConfig | undefined,
  vendor: SessionVendor,
): HarnessUpdateMode {
  return config?.vendors?.[vendor] ?? config?.mode ?? DEFAULT_HARNESS_UPDATE_MODE;
}

/** What a failed command said, in one line. */
function failureLine(res: CommandResult): string {
  if (res.timedOut) return 'it took too long and was stopped';
  if (res.error !== undefined) return firstLine(res.error) ?? 'it could not start';
  return (
    firstLine(res.stderr) ??
    firstLine(res.stdout) ??
    (res.code === 0 ? 'it printed no version' : `it exited with code ${res.code ?? 'none'}`)
  );
}

/** A method this app can't check or update: say so, with where the binary is. */
export function manualText(label: string, path: string | undefined): string {
  return `Can’t check ${label} automatically; update it the way you installed it${
    path !== undefined ? ` (${path})` : ''
  }.`;
}

function durationWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${Math.max(1, Math.round(ms / 1000))} seconds`;
}
