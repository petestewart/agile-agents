/**
 * T367: the pure half of Settings → Repositories and the Add repository
 * dialog: reading a typed folder path into "list this folder, filtered by
 * this prefix", breadcrumbs, a clone URL's live preview (mirroring the
 * daemon's `resolveCloneSource` and `repoRemoteOf`, so what the preview
 * says is what the clone will do), and daemon errors made readable.
 */

import type { RepoRemote, RepoRemoteKind, RepoRemoteProtocol } from '@agile-agents/shared';

// ---------------------------------------------------------------- folder paths

/** What the folder list should show for what is typed: `dir`'s children starting with `prefix`. */
export interface TypedPath {
  /** The folder to list: absolute, `~` or `~/…`; `undefined` is the home folder. */
  dir: string | undefined;
  /** The part after the last `/`, for autocomplete (case-insensitive on the daemon). */
  prefix: string;
}

/**
 * `~/Pro` lists `~` for names starting with `Pro`; `~/Projects/` lists
 * `~/Projects`; a bare word (no slash) is looked up in the home folder.
 */
export function splitTypedPath(text: string): TypedPath {
  const t = text.trim();
  if (t === '') return { dir: undefined, prefix: '' };
  if (t === '~') return { dir: '~', prefix: '' };
  const slash = t.lastIndexOf('/');
  if (slash === -1) return { dir: undefined, prefix: t };
  const head = t.slice(0, slash).replace(/\/+$/, '');
  const dir = head === '' ? (t.startsWith('/') ? '/' : undefined) : head;
  return { dir, prefix: t.slice(slash + 1) };
}

/** `/home/pete/Projects` → `~/Projects` when `home` is `/home/pete`. */
export function tildify(path: string, home: string | undefined): string {
  if (!home || home === '/') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** `dir` + `/` + `name`, without doubling the root's slash. */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** The folder a path sits in; `/` for a top-level folder and for `/` itself. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash <= 0 ? '/' : trimmed.slice(0, slash);
}

/** A folder's own name: the last path segment. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || path;
}

export interface Crumb {
  label: string;
  path: string;
}

/**
 * The breadcrumb of an absolute folder: from `~` when it is under the home
 * folder (the path above home is noise), else from `/`.
 */
export function breadcrumbs(path: string, home: string | undefined): Crumb[] {
  const underHome =
    home !== undefined && home !== '/' && (path === home || path.startsWith(`${home}/`));
  const start = underHome ? home : '/';
  const crumbs: Crumb[] = [{ label: underHome ? '~' : '/', path: start }];
  const rest = path
    .slice(start.length)
    .split('/')
    .filter((s) => s.length > 0);
  let at = start;
  for (const segment of rest) {
    at = joinPath(at, segment);
    crumbs.push({ label: segment, path: at });
  }
  return crumbs;
}

// ---------------------------------------------------------------- clone sources

/** A clone URL read the way the daemon will read it. */
export interface RepoSource {
  kind: RepoRemoteKind;
  protocol: RepoRemoteProtocol;
  host?: string;
  /** GitHub's `acme`, GitLab's `group/sub`; absent for a local path. */
  owner?: string;
  /** The repo's name: the folder the clone makes and its default registry name. */
  name: string;
  /** What is shown: no userinfo on http(s), no password anywhere. */
  display: string;
}

export type RepoSourceResult = { ok: true; source: RepoSource } | { ok: false; reason: string };

const GITHUB_SHORTHAND = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
const REMOTE_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;
const SCP_LIKE = /^(?:([^@/]+)@)?(\[[^\]/]+\]|[^:/@[\]]+):(.*)$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PUBLIC_HOST = /^(github\.com|gitlab\.com|bitbucket\.org)\//i;

const KIND_BY_HOST: Record<string, RepoRemoteKind> = {
  'github.com': 'github',
  'ssh.github.com': 'github',
  'gitlab.com': 'gitlab',
  'altssh.gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'altssh.bitbucket.org': 'bitbucket',
};

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

/** A usable folder name, or undefined (the daemon refuses the same ones). */
function folderName(raw: string | undefined): string | undefined {
  if (raw === undefined || /[/\\]/.test(raw) || CONTROL_CHARS.test(raw)) return undefined;
  const name = raw.trim();
  return name.length > 0 && name !== '.' && name !== '..' && !name.startsWith('-')
    ? name
    : undefined;
}

const USAGE = 'Use an https or SSH URL, git@host:owner/repo, owner/repo, or a folder path';

interface Parsed {
  protocol: RepoRemoteProtocol;
  host?: string;
  segments: string[];
  display: string;
}

function parseAddress(text: string): Parsed | undefined {
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
      return { protocol: 'file', segments: segmentsOf(path), display: `file://${path}` };
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
      display: u.toString(),
    };
  }
  if (/^(\/|~|\.\.?(\/|$))/.test(text)) {
    return { protocol: 'file', segments: segmentsOf(text), display: text };
  }
  const scp = SCP_LIKE.exec(text);
  if (scp?.[2] !== undefined && scp[3] !== undefined) {
    const host = scp[2].replace(/^\[|\]$/g, '').toLowerCase();
    if (host.length === 0 || host.startsWith('-')) return undefined;
    const user = scp[1]?.split(':')[0];
    return {
      protocol: 'ssh',
      host,
      segments: segmentsOf(scp[3]),
      display: `${user ? `${user}@` : ''}${scp[2]}:${scp[3]}`,
    };
  }
  return { protocol: 'file', segments: segmentsOf(text), display: text };
}

/**
 * What the daemon's clone will make of `input`: GitHub's `owner/repo`
 * shorthand is https; `github.com/o/r` gets its scheme; a local repo must
 * be an absolute (or `~`) path. Empty input is `undefined` (nothing to say yet).
 */
export function parseRepoSource(input: string): RepoSourceResult | undefined {
  const text = input.trim();
  if (text === '') return undefined;
  if (CONTROL_CHARS.test(text) || REMOTE_HELPER.test(text) || text.startsWith('-')) {
    return { ok: false, reason: `Not a git URL. ${USAGE}.` };
  }
  const shorthand = GITHUB_SHORTHAND.exec(text);
  if (shorthand?.[1] && shorthand[2] && !shorthand[2].startsWith('.')) {
    const name = folderName(shorthand[2].replace(/\.git$/, ''));
    if (name) {
      return {
        ok: true,
        source: {
          kind: 'github',
          protocol: 'https',
          host: 'github.com',
          owner: shorthand[1],
          name,
          display: `https://github.com/${shorthand[1]}/${name}.git`,
        },
      };
    }
  }
  const url = PUBLIC_HOST.test(text) ? `https://${text}` : text;
  const parsed = parseAddress(url);
  if (parsed === undefined) return { ok: false, reason: `Not a git URL. ${USAGE}.` };
  if (parsed.protocol === 'file' && !/^(\/|~|file:\/\/)/.test(url)) {
    return {
      ok: false,
      reason: 'A folder on this machine must be an absolute path (or start with ~/).',
    };
  }
  const name = folderName(parsed.segments.at(-1));
  if (name === undefined) {
    return { ok: false, reason: 'Cannot tell the repository’s name from this URL.' };
  }
  const owner =
    parsed.protocol !== 'file' && parsed.segments.length >= 2
      ? parsed.segments.slice(0, -1).join('/')
      : undefined;
  return {
    ok: true,
    source: {
      kind: parsed.host !== undefined ? (KIND_BY_HOST[parsed.host] ?? 'other') : 'other',
      protocol: parsed.protocol,
      ...(parsed.host !== undefined ? { host: parsed.host } : {}),
      ...(owner ? { owner } : {}),
      name,
      display: parsed.display,
    },
  };
}

/** A `RepoIcon` remote for a preview (a local path shows as local, like a repo with no remote). */
export function sourceRemote(source: RepoSource): RepoRemote | undefined {
  if (source.protocol === 'file') return undefined;
  return {
    kind: source.kind,
    protocol: source.protocol,
    url: source.display,
    ...(source.owner ? { owner: source.owner } : {}),
    name: source.name,
  };
}

/**
 * True for text that is plainly a remote URL rather than a folder: a
 * `scheme://` (other than `file://`), `user@host:path`, or a public host
 * without its scheme. The local-folder field switches to cloning on these.
 */
export function looksLikeRepoUrl(text: string): boolean {
  const t = text.trim();
  if (t === '' || /\s/.test(t)) return false;
  const scheme = SCHEME.exec(t)?.[1]?.toLowerCase();
  if (scheme !== undefined) return scheme !== 'file';
  if (PUBLIC_HOST.test(t)) return true;
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/]/.test(t);
}

/** GitHub's `owner/repo` (a paste of it switches to cloning; typing it does not). */
export function looksLikeGithubShorthand(text: string): boolean {
  const m = GITHUB_SHORTHAND.exec(text.trim());
  return m?.[2] !== undefined && !m[2].startsWith('.');
}

/**
 * Where the daemon clones to when it is not told: next to the most
 * recently registered repo, else `~/Projects`, else home. The first of
 * these that exists wins (the dialog checks each with a folder listing).
 */
export function cloneParentCandidates(repos: ReadonlyArray<{ path: string }>): string[] {
  const last = repos.at(-1);
  const out = last !== undefined ? [parentPath(last.path)] : [];
  for (const dir of ['~/Projects', '~']) if (!out.includes(dir)) out.push(dir);
  return out;
}

// ---------------------------------------------------------------- display

/** GitHub's web page for a remote, when there is one. */
export function remoteWebUrl(remote: RepoRemote | undefined): string | undefined {
  if (!remote?.owner || !remote.name) return undefined;
  const host =
    remote.kind === 'github'
      ? 'github.com'
      : remote.kind === 'gitlab'
        ? 'gitlab.com'
        : remote.kind === 'bitbucket'
          ? 'bitbucket.org'
          : undefined;
  return host ? `https://${host}/${remote.owner}/${remote.name}` : undefined;
}

/** `owner/name` of a hosted remote, or undefined for a local-only repo or a file remote. */
export function remoteSlug(remote: RepoRemote | undefined): string | undefined {
  if (!remote || remote.protocol === 'file') return undefined;
  return remote.owner && remote.name ? `${remote.owner}/${remote.name}` : remote.name;
}

/** The daemon's RPC prefix (`state.repo_add: …`) is plumbing, not a message. */
export function cleanDaemonError(message: string): string {
  return message.replace(/^state\.[a-z_]+:\s*/, '');
}

export interface CloneErrorText {
  /** One line: what failed. */
  title: string;
  /** What to do about it, when there is something. */
  hint?: string;
  /** git's own last lines. */
  detail?: string;
}

/**
 * The daemon's clone refusal split for display: its first line (with the
 * fix it names after ` — `) and git's output. SSH trouble always gets a
 * hint, even when git's words are not ones the daemon recognised.
 */
export function describeCloneError(message: string): CloneErrorText {
  const [first = '', ...rest] = cleanDaemonError(message).split('\n');
  const detail = rest.join('\n').trim();
  let line = first.trim().replace(/:$/, '');
  let hint: string | undefined;
  const dash = line.indexOf(' — ');
  if (dash !== -1) {
    hint = line.slice(dash + 3).trim();
    line = line.slice(0, dash).trim();
  }
  if (hint) hint = hint.charAt(0).toUpperCase() + hint.slice(1);
  const all = `${first}\n${detail}`;
  if (!hint && /publickey|Host key verification|ssh: |Could not resolve hostname/i.test(all)) {
    hint =
      'Check that your SSH key works for this host (`ssh -T git@github.com` in a terminal), or use the https URL.';
  }
  if (!hint && /already exists and is not empty|already registered/.test(line)) {
    hint = 'Pick another name or destination folder.';
  }
  const title = line.charAt(0).toUpperCase() + line.slice(1);
  return { title, ...(hint ? { hint } : {}), ...(detail ? { detail } : {}) };
}
