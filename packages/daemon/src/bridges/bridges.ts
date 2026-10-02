/**
 * T500: ACP servers the daemon downloads into the home (Antigravity's
 * `agy_acp_server`), where every other vendor's is on PATH or behind `npx`.
 *
 * The pin (version, one HTTPS URL per platform, the server's file name and
 * argv) is the provider registry's (`ANTIGRAVITY_BRIDGE` in
 * `@agile-agents/acp-client`); it moves by a code change, like the npx pins.
 * An install is one folder, `<home>/bridges/<name>/<version>/`:
 *
 *  1. the archive is fetched from the pinned URL only, over HTTPS, into a
 *     temp file in that folder (a leftover is swept with the store's other
 *     temp files at the next start);
 *  2. its SHA-256 is taken; a version already installed with another hash is
 *     refused, in words, and the install is left as it was;
 *  3. the temp file is renamed to the archive's own name and unpacked there
 *     with a fixed argv (`unzip -q -o <archive> -d <folder>`), never a shell;
 *  4. the server must be a plain file at the folder's top level; it is made
 *     executable. It is never run here;
 *  5. `manifest.yaml` is written last, through the store's validating write
 *     (`BridgeManifestSchema`): no manifest, no install.
 *
 * Install is the operator's (Settings → Agents → Vendors → Install, or
 * `agile vendors install antigravity`), never automatic. The downloader and
 * the unzip are seams: tests pass fakes, so nothing is fetched or run.
 *
 * A session, a self-check or a model Refresh runs the provider through
 * `providerIn(home, provider)`: the server's full path in the home and its
 * platform's argv. `missingBridge` names the fix when it isn't installed.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  type AcpBridgeArtifact,
  type AcpBridgePin,
  type AcpBridgePlatform,
  type AcpProviderConfig,
  acpBridgePlatform,
} from '@agile-agents/acp-client';
import {
  BRIDGES_DIR,
  BRIDGE_MANIFEST_FILE,
  type BridgeManifest,
  type SessionVendor,
  type VendorInstallView,
  validateBridgeManifest,
} from '@agile-agents/shared';
import { parse as parseYaml } from 'yaml';
import { type CommandRunner, bunCommandRunner } from '../harness/methods';

// ---------------------------------------------------------------- where it lives

/** The host as Node names it. */
export interface BridgeHost {
  platform: string;
  arch: string;
}

const thisHost = (): BridgeHost => ({ platform: process.platform, arch: process.arch });

/** A pin's name and version are folder names: nothing that could climb out of `bridges/`. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkedPin(pin: AcpBridgePin): AcpBridgePin {
  if (!SAFE_SEGMENT.test(pin.name) || !SAFE_SEGMENT.test(pin.version)) {
    throw new Error(`a bridge pin names an unsafe folder: ${pin.name}/${pin.version}`);
  }
  return pin;
}

/** `bridges/<name>/<version>`, relative to the home (the store's paths are). */
export function bridgeRelDir(pin: AcpBridgePin): string {
  const p = checkedPin(pin);
  return `${BRIDGES_DIR}/${p.name}/${p.version}`;
}

/** `<home>/bridges/<name>/<version>/`: one install. */
export function bridgeDir(home: string, pin: AcpBridgePin): string {
  return join(home, bridgeRelDir(pin));
}

/** This host's platform as the registry names it, and its archive, if the pin has one. */
export function bridgeArtifact(
  pin: AcpBridgePin,
  host: BridgeHost = thisHost(),
): { platform: AcpBridgePlatform; artifact: AcpBridgeArtifact } | undefined {
  const platform = acpBridgePlatform(host.platform, host.arch);
  const artifact = platform !== undefined ? pin.artifacts[platform] : undefined;
  return platform !== undefined && artifact !== undefined ? { platform, artifact } : undefined;
}

/**
 * The provider a session runs: for a downloaded bridge, the server's full
 * path in the home and its platform's argv; any other provider as it is.
 * A host with no build keeps the bare file name (`missingBridge` says why).
 */
export function providerIn(
  home: string,
  provider: AcpProviderConfig,
  host: BridgeHost = thisHost(),
): AcpProviderConfig {
  const pin = provider.bridge;
  if (pin === undefined) return provider;
  const found = bridgeArtifact(pin, host);
  if (found === undefined) return provider;
  return {
    ...provider,
    command: join(bridgeDir(home, pin), found.artifact.command),
    args: [...found.artifact.args],
  };
}

/** The ticket's words for a bridge that isn't installed: what to do about it. */
export function bridgeNotInstalledWords(label: string): string {
  return `${label} can't start: its ACP server isn't installed. Install it in Settings → Agents → Vendors.`;
}

function noBuildWords(label: string, host: BridgeHost): string {
  return `${label} can't start: its ACP server has no build for this computer (${host.platform} ${host.arch}).`;
}

/**
 * Why a downloaded bridge can't start, or `undefined` when it can: the
 * provider must be resolved (`providerIn`) to a server that is there, beside
 * its manifest. Other providers: `undefined` (PATH is `missingVendorCommand`'s).
 */
export function missingBridge(
  provider: Pick<AcpProviderConfig, 'label' | 'command' | 'bridge'>,
  host: BridgeHost = thisHost(),
): string | undefined {
  const pin = provider.bridge;
  if (pin === undefined) return undefined;
  if (bridgeArtifact(pin, host) === undefined) return noBuildWords(provider.label, host);
  if (!isAbsolute(provider.command)) return bridgeNotInstalledWords(provider.label);
  const installed =
    isPlainFile(provider.command) &&
    existsSync(join(dirname(provider.command), BRIDGE_MANIFEST_FILE));
  return installed ? undefined : bridgeNotInstalledWords(provider.label);
}

function isPlainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The install's manifest, or `undefined` when there is none. A manifest that
 * doesn't validate is refused with its path, never treated as absent.
 */
export function readBridgeManifest(home: string, pin: AcpBridgePin): BridgeManifest | undefined {
  const path = join(bridgeDir(home, pin), BRIDGE_MANIFEST_FILE);
  if (!existsSync(path)) return undefined;
  try {
    return validateBridgeManifest(parseYaml(readFileSync(path, 'utf8')));
  } catch (err) {
    throw new Error(
      `corrupt bridge manifest ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------- the seams

/** Fetches `url` into the file `dest`. Rejects on any failure. */
export type BridgeDownloader = (url: string, dest: string) => Promise<void>;
/** Unpacks the zip `archive` into the folder `dir`. Rejects on any failure. */
export type BridgeUnzipper = (archive: string, dir: string) => Promise<void>;

/** The largest archive a download keeps (the registry's are tens of MB). */
export const BRIDGE_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
/** How long an unzip may take. */
const UNZIP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The daemon's downloader: the URL as pinned, HTTPS only, no redirect
 * followed (a redirect fails the install rather than fetching from
 * somewhere else), streamed to `dest`.
 */
export const httpsDownload: BridgeDownloader = async (url, dest) => {
  if (!url.startsWith('https://')) throw new Error(`refusing a download that isn't HTTPS: ${url}`);
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok || res.body === null) {
    throw new Error(`the server answered ${res.status} ${res.statusText}`.trim());
  }
  const length = Number(res.headers.get('content-length') ?? '0');
  if (length > BRIDGE_DOWNLOAD_MAX_BYTES) {
    throw new Error(`the archive is ${length} bytes, more than this app accepts`);
  }
  await Bun.write(dest, res);
};

/** The daemon's unzip: `unzip -q -o <archive> -d <dir>`, a fixed argv, no shell. */
export function systemUnzip(run: CommandRunner = bunCommandRunner): BridgeUnzipper {
  return async (archive, dir) => {
    const res = await run(['unzip', '-q', '-o', archive, '-d', dir], {
      timeoutMs: UNZIP_TIMEOUT_MS,
    });
    if (res.code === 0) return;
    if (res.error !== undefined) {
      throw new Error(`\`unzip\` could not run (${res.error}): install it, then try again`);
    }
    const why = (res.stderr || res.stdout).trim().split('\n')[0] ?? '';
    throw new Error(
      res.timedOut
        ? '`unzip` took too long and was stopped'
        : `\`unzip\` exited with code ${res.code ?? 'none'}${why ? `: ${why}` : ''}`,
    );
  };
}

// ---------------------------------------------------------------- one install

/** A re-download of an installed version came with another hash: refused. */
export class BridgeHashMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeHashMismatchError';
  }
}

/** The vendor has nothing to install, or this host has no build: refused in words. */
export class BridgeNotInstallableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeNotInstallableError';
  }
}

export interface InstallBridgeOptions {
  home: string;
  /** The manifest is written through the validating store. */
  store: {
    putEntity<T>(relPath: string, validator: (input: unknown) => T, data: unknown): Promise<T>;
  };
  vendor: SessionVendor;
  /** The registry's entry (its `bridge` is the pin). */
  provider: AcpProviderConfig;
  download?: BridgeDownloader;
  unzip?: BridgeUnzipper;
  host?: BridgeHost;
  now?: () => Date;
}

/** A file's SHA-256 in lowercase hex, streamed. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
}

/**
 * Installs one vendor's pinned bridge for this host and returns its manifest.
 * A version already installed whose download matches is kept as it is (a
 * running server is never overwritten); one whose download doesn't match is
 * refused with `BridgeHashMismatchError`.
 */
export async function installBridge(opts: InstallBridgeOptions): Promise<BridgeManifest> {
  const { home, provider } = opts;
  const label = provider.label;
  const pin = provider.bridge;
  if (pin === undefined) {
    throw new BridgeNotInstallableError(
      `${label} isn't installed by this app: install its command-line tool yourself.`,
    );
  }
  const host = opts.host ?? thisHost();
  const found = bridgeArtifact(pin, host);
  if (found === undefined) throw new BridgeNotInstallableError(noBuildWords(label, host));
  const { platform, artifact } = found;
  if (!artifact.url.startsWith('https://')) {
    throw new BridgeNotInstallableError(`${label}'s pinned download isn't HTTPS: ${artifact.url}`);
  }
  const archiveName = basename(new URL(artifact.url).pathname);
  if (!SAFE_SEGMENT.test(archiveName) || !SAFE_SEGMENT.test(artifact.command)) {
    throw new BridgeNotInstallableError(`${label}'s pin names an unsafe file`);
  }
  const dir = bridgeDir(home, pin);
  const before = readBridgeManifest(home, pin);
  mkdirSync(dir, { recursive: true });

  // 1. Into a temp file beside the install (the store's marker: swept if we die here).
  const tmp = join(dir, `.${archiveName}.tmp-${Date.now()}-${randomBytes(4).toString('hex')}`);
  const discard = () => rmSync(tmp, { force: true });
  try {
    await (opts.download ?? httpsDownload)(artifact.url, tmp);
  } catch (err) {
    discard();
    throw new Error(`Downloading ${label}'s ACP server failed: ${messageOf(err)}`);
  }

  // 2. Its hash, against what is installed.
  let sha256: string;
  let size: number;
  try {
    size = statSync(tmp).size;
    if (size === 0) throw new Error('the download was empty');
    if (size > BRIDGE_DOWNLOAD_MAX_BYTES) throw new Error(`the download is ${size} bytes`);
    sha256 = await sha256File(tmp);
  } catch (err) {
    discard();
    throw new Error(`Downloading ${label}'s ACP server failed: ${messageOf(err)}`);
  }
  if (before !== undefined && before.version === pin.version && before.sha256 !== sha256) {
    discard();
    throw new BridgeHashMismatchError(
      `Refused: ${label}'s ACP server ${pin.version} downloaded with SHA-256 ${sha256}, but the copy installed here on ${before.installed_at.slice(0, 10)} has ${before.sha256}. The same version should never change, so the install was left as it was. Report it before trusting either copy.`,
    );
  }
  const commandPath = join(dir, artifact.command);
  if (before !== undefined && before.sha256 === sha256 && isPlainFile(commandPath)) {
    // The same archive, already unpacked: nothing to replace (a running server stays put).
    discard();
    return before;
  }

  // 3. Under its own name, then unpacked with a fixed argv.
  const archivePath = join(dir, archiveName);
  try {
    renameSync(tmp, archivePath);
  } catch (err) {
    discard();
    throw new Error(`Installing ${label}'s ACP server failed: ${messageOf(err)}`);
  }
  try {
    await (opts.unzip ?? systemUnzip())(archivePath, dir);
  } catch (err) {
    throw new Error(`Unpacking ${label}'s ACP server failed: ${messageOf(err)}`);
  }

  // 4. The server: a plain file at the top, made executable, never run here.
  if (!isPlainFile(commandPath)) {
    throw new Error(
      `Installing ${label}'s ACP server failed: the archive held no ${artifact.command} at its top level.`,
    );
  }
  chmodSync(commandPath, 0o755);

  // 5. The manifest, last, through the validating store.
  const manifest: BridgeManifest = {
    vendor: opts.vendor,
    registry_id: pin.registryId,
    version: pin.version,
    platform,
    url: artifact.url,
    archive: archiveName,
    sha256,
    size,
    command: artifact.command,
    installed_at: (opts.now ?? (() => new Date()))().toISOString(),
    by: 'human',
  };
  return opts.store.putEntity(
    `${bridgeRelDir(pin)}/${BRIDGE_MANIFEST_FILE}`,
    validateBridgeManifest,
    manifest,
  );
}

// ---------------------------------------------------------------- the service

export interface BridgeInstallServiceOptions {
  home: string;
  store: InstallBridgeOptions['store'];
  /** The registry entry a vendor maps to (default `ACP_PROVIDERS`). */
  provider: (vendor: SessionVendor) => AcpProviderConfig;
  download?: BridgeDownloader;
  unzip?: BridgeUnzipper;
  host?: BridgeHost;
  now?: () => Date;
  /** An install started or finished. */
  onChange?: () => void;
  onError?: (err: unknown) => void;
}

/**
 * The installs the operator asks for: at most one per vendor at a time (a
 * second ask shares it), with the last failure kept, in words, for Settings.
 */
export class BridgeInstallService {
  private readonly running = new Map<SessionVendor, Promise<BridgeManifest>>();
  private readonly failed = new Map<SessionVendor, string>();

  constructor(private readonly options: BridgeInstallServiceOptions) {}

  /** Whether the vendor's server is one this app downloads. */
  installable(vendor: SessionVendor): boolean {
    return this.options.provider(vendor).bridge !== undefined;
  }

  /** The provider a session of `vendor` runs (its server's full path, for a bridge). */
  resolved(vendor: SessionVendor): AcpProviderConfig {
    return providerIn(this.options.home, this.options.provider(vendor), this.options.host);
  }

  /** Why the vendor's bridge can't start, or `undefined` (and for a vendor with none). */
  missing(vendor: SessionVendor): string | undefined {
    return missingBridge(this.resolved(vendor), this.options.host);
  }

  /** What Settings and `agile vendors` show for a downloaded bridge; `undefined` for any other vendor. */
  view(vendor: SessionVendor): VendorInstallView | undefined {
    const pin = this.options.provider(vendor).bridge;
    if (pin === undefined) return undefined;
    const found = bridgeArtifact(pin, this.options.host);
    let manifest: BridgeManifest | undefined;
    let error = this.failed.get(vendor);
    try {
      manifest = readBridgeManifest(this.options.home, pin);
    } catch (err) {
      error = messageOf(err);
    }
    return {
      version: pin.version,
      ...(found !== undefined ? { platform: found.platform } : {}),
      ...(manifest !== undefined ? { manifest } : {}),
      installing: this.running.has(vendor),
      ...(error !== undefined ? { error } : {}),
    };
  }

  /** Installs (or shares the install running now) and resolves with the manifest. */
  install(vendor: SessionVendor): Promise<BridgeManifest> {
    const already = this.running.get(vendor);
    if (already !== undefined) return already;
    if (!this.installable(vendor)) {
      return Promise.reject(
        new BridgeNotInstallableError(
          `${this.options.provider(vendor).label} isn't installed by this app: install its command-line tool yourself.`,
        ),
      );
    }
    this.failed.delete(vendor);
    const run = installBridge({
      home: this.options.home,
      store: this.options.store,
      vendor,
      provider: this.options.provider(vendor),
      ...(this.options.download !== undefined ? { download: this.options.download } : {}),
      ...(this.options.unzip !== undefined ? { unzip: this.options.unzip } : {}),
      ...(this.options.host !== undefined ? { host: this.options.host } : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
    })
      .catch((err: unknown) => {
        this.failed.set(vendor, messageOf(err));
        throw err;
      })
      .finally(() => {
        this.running.delete(vendor);
        this.changed();
      });
    this.running.set(vendor, run);
    this.changed();
    return run;
  }

  /** As `install`, without waiting: the cockpit shows the running state and polls. */
  start(vendor: SessionVendor): void {
    if (!this.installable(vendor)) {
      throw new BridgeNotInstallableError(
        `${this.options.provider(vendor).label} isn't installed by this app: install its command-line tool yourself.`,
      );
    }
    void this.install(vendor).catch((err) => this.options.onError?.(err));
  }

  /** Whether any install runs. */
  busy(): boolean {
    return this.running.size > 0;
  }

  /** Every install running now (tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.running.values()].map((p) => p.catch(() => undefined)));
  }

  private changed(): void {
    try {
      this.options.onChange?.();
    } catch (err) {
      this.options.onError?.(err);
    }
  }
}
