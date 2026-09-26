/**
 * T362: a repo's remote, for the cockpit's repo icon and the clone route.
 *
 * `parseRemoteUrl` reads every address form git takes for a remote
 * (`https://`, `ssh://`, scp-like `git@host:o/r`, `file://`, a local path)
 * into a host, the path's segments and a display URL with credentials
 * removed. `RepoRemoteCache` answers "what is this repo's remote" for the
 * cockpit frame, which is pushed after every event batch: it never spawns
 * git on that path, only returns what it has and refreshes in the
 * background (TTL, and `invalidate` on repo add/set).
 */

import type {
  RepoEntry,
  RepoRemote,
  RepoRemoteKind,
  RepoRemoteProtocol,
} from '@agile-agents/shared';
import { networkGitEnv } from '../delivery/git';

export interface ParsedRemote {
  protocol: RepoRemoteProtocol;
  /** Lowercased; absent for a local path. */
  host?: string;
  /** The path's segments, the last with `.git` dropped. */
  segments: string[];
  /** The URL to show: no password anywhere, no userinfo at all on http(s)/git. */
  url: string;
}

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
/** `<transport>::<address>`: a remote helper (`ext::` runs a command). */
const REMOTE_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;
/** git's scp-like form: `[user@]host:path`, a colon before any slash. */
const SCP_LIKE = /^(?:([^@/]+)@)?(\[[^\]/]+\]|[^:/@[\]]+):(.*)$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function segmentsOf(path: string): string[] {
  const segments = path.split('/').filter((s) => s.length > 0 && s !== '.');
  const last = segments.at(-1);
  if (last !== undefined) {
    const bare = last.replace(/\.git$/, '');
    if (bare.length > 0) segments[segments.length - 1] = bare;
    else segments.pop();
  }
  return segments;
}

function decode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * One remote address, or undefined for a form git would not take as a
 * plain transport (a remote helper, an unknown scheme, control characters).
 */
export function parseRemoteUrl(raw: string): ParsedRemote | undefined {
  const text = raw.trim();
  if (text.length === 0 || CONTROL_CHARS.test(text) || REMOTE_HELPER.test(text)) return undefined;
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    let u: URL;
    try {
      u = new URL(text);
    } catch {
      return undefined;
    }
    if (scheme === 'file') {
      const path = decode(u.pathname);
      return { protocol: 'file', segments: segmentsOf(path), url: `file://${path}` };
    }
    const ssh = scheme === 'ssh' || scheme === 'git+ssh' || scheme === 'ssh+git';
    if (!ssh && !['https', 'http', 'git'].includes(scheme)) return undefined;
    const host = u.hostname.toLowerCase();
    if (host.length === 0 || host.startsWith('-')) return undefined;
    u.password = '';
    if (!ssh) u.username = '';
    return {
      protocol: ssh ? 'ssh' : 'https',
      host,
      segments: segmentsOf(decode(u.pathname)),
      url: u.toString(),
    };
  }
  // A path (absolute, home-relative or dot-relative) is local even with a colon in it.
  if (/^(\/|~|\.\.?(\/|$))/.test(text)) {
    return { protocol: 'file', segments: segmentsOf(text), url: text };
  }
  const scp = SCP_LIKE.exec(text);
  if (scp?.[2] !== undefined && scp[3] !== undefined) {
    const host = scp[2].replace(/^\[|\]$/g, '').toLowerCase();
    if (host.length === 0 || host.startsWith('-')) return undefined;
    // `user:pass@host:path` is not valid scp syntax, but never show a password anyway.
    const user = scp[1]?.split(':')[0];
    return {
      protocol: 'ssh',
      host,
      segments: segmentsOf(scp[3]),
      url: `${user ? `${user}@` : ''}${scp[2]}:${scp[3]}`,
    };
  }
  // A bare relative path (`../shared.git`, `mirror`): local to the repo.
  return { protocol: 'file', segments: segmentsOf(text), url: text };
}

const KIND_BY_HOST: Record<string, RepoRemoteKind> = {
  'github.com': 'github',
  'ssh.github.com': 'github',
  'gitlab.com': 'gitlab',
  'altssh.gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'altssh.bitbucket.org': 'bitbucket',
};

/**
 * The cockpit's view of a remote URL: the public hosts by name, everything
 * else (enterprise hosts too) `other`; undefined when it is not a plain transport.
 */
export function repoRemoteOf(url: string): RepoRemote | undefined {
  const parsed = parseRemoteUrl(url);
  if (parsed === undefined) return undefined;
  const { host, protocol, segments } = parsed;
  const name = segments.at(-1);
  const owner = protocol !== 'file' && segments.length >= 2 ? segments.slice(0, -1).join('/') : '';
  return {
    kind: host !== undefined ? (KIND_BY_HOST[host] ?? 'other') : 'other',
    protocol,
    url: parsed.url,
    ...(owner !== '' ? { owner } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

/** Userinfo removed from every `scheme://user:pass@` in free text (git's stderr), before it is shown. */
export function redactUserinfo(text: string): string {
  return text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]*@/g, '$1');
}

/** Reads one remote's URL; undefined when there is none or git fails. */
export type RemoteUrlReader = (repoPath: string, remote: string) => Promise<string | undefined>;

const REMOTE_READ_TIMEOUT_MS = 5000;

/**
 * `git remote get-url <remote>` with the operator's own git config (so an
 * `insteadOf` rewrite applies) and the network allow-list env (no daemon
 * secret reaches git). A missing path or remote is undefined, never a throw.
 */
export const readRemoteUrl: RemoteUrlReader = async (repoPath, remote) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(['git', 'remote', 'get-url', '--', remote], {
      cwd: repoPath,
      env: networkGitEnv(process.env),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: REMOTE_READ_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  } catch {
    return undefined; // the repo's folder is gone
  }
  const [out, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    proc.exited,
  ]);
  const url = out.trim();
  return code === 0 && url.length > 0 ? url : undefined;
};

export const REPO_REMOTE_TTL_MS = 60_000;

interface CachedRemote {
  value: RepoRemote | undefined;
  at: number;
}

export interface RepoRemoteCacheOptions {
  ttlMs?: number;
  now?: () => number;
  read?: RemoteUrlReader;
  /** Called when a background refresh changed a repo's remote (the cockpit re-pushes its frame). */
  onChange?: () => void;
}

/**
 * A repo's remote, per repo path and remote name (`entry.remote`, else
 * `origin`). `peek` is for the cockpit frame: it answers from the cache and
 * never waits on git; a missing or stale entry is refreshed in the
 * background, and `onChange` fires when that changed anything. `get` is for
 * `GET /api/repos`: it waits for a fresh value.
 */
export class RepoRemoteCache {
  private readonly cache = new Map<string, CachedRemote>();
  private readonly pending = new Map<string, Promise<RepoRemote | undefined>>();
  /** Bumped by `invalidate`: a read started before it never lands in the cache. */
  private generation = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly read: RemoteUrlReader;
  onChange: (() => void) | undefined;

  constructor(options: RepoRemoteCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? REPO_REMOTE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.read = options.read ?? readRemoteUrl;
    this.onChange = options.onChange;
  }

  private static key(entry: Pick<RepoEntry, 'path' | 'remote'>): string {
    return `${entry.path}\0${entry.remote ?? 'origin'}`;
  }

  private fresh(key: string): CachedRemote | undefined {
    const hit = this.cache.get(key);
    return hit !== undefined && this.now() - hit.at < this.ttlMs ? hit : undefined;
  }

  private async readOne(
    entry: Pick<RepoEntry, 'path' | 'remote'>,
  ): Promise<RepoRemote | undefined> {
    try {
      const url = await this.read(entry.path, entry.remote ?? 'origin');
      return url !== undefined ? repoRemoteOf(url) : undefined;
    } catch {
      return undefined;
    }
  }

  private refresh(entry: Pick<RepoEntry, 'path' | 'remote'>): Promise<RepoRemote | undefined> {
    const key = RepoRemoteCache.key(entry);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const generation = this.generation;
    // `.then` always runs after `run` is assigned and registered below.
    const run: Promise<RepoRemote | undefined> = this.readOne(entry).then((value) => {
      if (this.pending.get(key) === run) this.pending.delete(key);
      if (generation !== this.generation) return value;
      // Never read counts as "no remote": that is what a frame showed meanwhile.
      const before = this.cache.get(key)?.value;
      this.cache.set(key, { value, at: this.now() });
      if (JSON.stringify(before) !== JSON.stringify(value)) {
        try {
          this.onChange?.();
        } catch {
          // A failed re-push is the listener's problem, not the cache's.
        }
      }
      return value;
    });
    this.pending.set(key, run);
    return run;
  }

  /** The cached remote (possibly stale, undefined if never read); refreshes in the background when due. */
  peek(entry: Pick<RepoEntry, 'path' | 'remote'>): RepoRemote | undefined {
    const key = RepoRemoteCache.key(entry);
    if (this.fresh(key) === undefined) void this.refresh(entry);
    return this.cache.get(key)?.value;
  }

  /** A fresh remote: the cached one within the TTL, else read now. */
  async get(entry: Pick<RepoEntry, 'path' | 'remote'>): Promise<RepoRemote | undefined> {
    const hit = this.fresh(RepoRemoteCache.key(entry));
    return hit !== undefined ? hit.value : this.refresh(entry);
  }

  /** Starts a background read for every repo not already fresh (daemon start). */
  warm(entries: Iterable<Pick<RepoEntry, 'path' | 'remote'>>): void {
    for (const entry of entries) this.peek(entry);
  }

  /** Forgets one repo path (every remote name). */
  invalidate(path: string): void {
    this.generation += 1;
    for (const map of [this.cache, this.pending]) {
      for (const key of [...map.keys()]) if (key.startsWith(`${path}\0`)) map.delete(key);
    }
  }
}
