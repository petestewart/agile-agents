/**
 * T481 (D50): how each vendor's CLI was installed and how it is updated.
 *
 * The install method is read from where the binary resolves (symlinks
 * followed), never guessed from the vendor:
 *
 *  - under a Homebrew prefix, in a `Cellar/<formula>/` or
 *    `Caskroom/<cask>/` tree: **brew** (`brew info --json=v2`, `brew upgrade`);
 *  - Claude Code's own installer (`~/.local/share/claude/…`,
 *    `~/.claude/local/…`): **native** (`claude update`; the newest version
 *    is unknown until it runs);
 *  - inside a global npm tree (`<prefix>/lib/node_modules/<pkg>`): **npm**
 *    (`npm view <pkg> version`, `npm install -g <pkg>@latest`);
 *  - anything else: **unknown**, reported in Settings with the path and
 *    "update it the way you installed it".
 *
 * `UPDATE_METHODS` is the one table (vendor + method → detect, newest,
 * update); a new installer is a new row. Every command is a fixed argv:
 * never a shell, never sudo.
 */

import {
  HARNESS_VENDOR,
  type HarnessId,
  type HarnessInstallMethod,
  type SessionVendor,
} from '@agile-agents/shared';
import { TYPESAFE_API_KEY_ENV } from '../classifier/jev';

// ---------------------------------------------------------------- running a command

export interface CommandResult {
  /** The exit code; `null` when it was killed or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** It ran past its timeout and was killed. */
  timedOut: boolean;
  /** It could not be started (the binary is gone, or not executable). */
  error?: string;
}

/** Runs one fixed argv (no shell) with a timeout. Injected, so tests never run a real CLI. */
export type CommandRunner = (
  argv: readonly string[],
  options: { timeoutMs: number },
) => Promise<CommandResult>;

/** What a command may print before the rest is dropped: only the first lines are ever read. */
const OUTPUT_MAX_CHARS = 64 * 1024;

/** Env names an updater never needs and never gets: the daemon's own secrets. */
const UPDATER_ENV_DROP: readonly string[] = [TYPESAFE_API_KEY_ENV];

/** The operator's environment without the daemon's own secrets. */
export function updaterEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !UPDATER_ENV_DROP.includes(name)) out[name] = value;
  }
  return out;
}

/**
 * The daemon's runner: `Bun.spawn` of the argv as given (no shell), with
 * the operator's own environment (an updater needs the real `HOME` and
 * `PATH`, as vendor sessions do) less the classifier key, stdin closed so
 * nothing can prompt, and SIGKILL at the timeout.
 */
export const bunCommandRunner: CommandRunner = async (argv, { timeoutMs }) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: updaterEnv(),
    });
  } catch (err) {
    return {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, timeoutMs);
  const read = (stream: unknown): Promise<string> =>
    new Response(stream as ReadableStream).text().catch(() => '');
  const outputs = Promise.all([read(proc.stdout), read(proc.stderr)]);
  const code = await proc.exited;
  clearTimeout(timer);
  // A grandchild may hold the pipes open after a kill: its output is not waited for.
  const [stdout, stderr] = await Promise.race([
    outputs,
    Bun.sleep(2_000).then(() => ['', ''] as [string, string]),
  ]);
  return {
    code: timedOut ? null : code,
    stdout: stdout.slice(0, OUTPUT_MAX_CHARS),
    stderr: stderr.slice(0, OUTPUT_MAX_CHARS),
    timedOut,
  };
};

/**
 * The runner a daemon under `bun test` gets when a test injects none: it
 * runs nothing, so no test ever reaches a real CLI, npm or the network.
 */
export const offlineCommandRunner: CommandRunner = async () => ({
  code: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  error: 'commands are not run under bun test',
});

// ---------------------------------------------------------------- versions

/** `x.y.z` with an optional pre-release, not inside a longer number (`v0.32.1` reads `0.32.1`). */
const VERSION_TOKEN = /(?<![\d.])(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)(?![\d])/;

/** The first semver-looking token in a command's output: `2.3.1 (Claude Code)` → `2.3.1`. */
export function parseVersion(text: string): string | undefined {
  return VERSION_TOKEN.exec(text)?.[1];
}

/** Semver order: `-1`, `0` or `1`. A pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { core: number[]; pre?: string } => {
    const [core = '', ...rest] = v.split('-');
    const pre = rest.length > 0 ? rest.join('-') : undefined;
    return {
      core: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      ...(pre !== undefined ? { pre } : {}),
    };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  const px = x.pre.split('.');
  const py = y.pre.split('.');
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    const l = px[i];
    const r = py[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const nl = /^\d+$/.test(l) ? Number(l) : undefined;
    const nr = /^\d+$/.test(r) ? Number(r) : undefined;
    if (nl !== undefined && nr !== undefined) {
      if (nl !== nr) return nl < nr ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------- the CLIs

export interface HarnessSpec {
  vendor: SessionVendor;
  /** Its name in words. */
  label: string;
  /** The command looked up on the daemon's PATH. */
  command: string;
  /**
   * `flag`: `<command> --version`. `package`: the `version` in its npm
   * package.json (pi-acp is an ACP server: started with a flag it would
   * wait on stdin, so it is never run to read its version).
   */
  version: 'flag' | 'package';
}

/** Each vendor's own CLI, as the operator installed it (and Pi's ACP adapter). */
export const HARNESSES: Record<HarnessId, HarnessSpec> = {
  claude: {
    vendor: HARNESS_VENDOR.claude,
    label: 'Claude Code',
    command: 'claude',
    version: 'flag',
  },
  codex: { vendor: HARNESS_VENDOR.codex, label: 'Codex', command: 'codex', version: 'flag' },
  gemini: {
    vendor: HARNESS_VENDOR.gemini,
    label: 'Gemini CLI',
    command: 'gemini',
    version: 'flag',
  },
  cursor: {
    vendor: HARNESS_VENDOR.cursor,
    label: 'Cursor Agent',
    command: 'cursor-agent',
    version: 'flag',
  },
  grok: { vendor: HARNESS_VENDOR.grok, label: 'Grok CLI', command: 'grok', version: 'flag' },
  pi: { vendor: HARNESS_VENDOR.pi, label: 'Pi', command: 'pi', version: 'flag' },
  'pi-acp': {
    vendor: HARNESS_VENDOR['pi-acp'],
    label: 'pi-acp (Pi’s ACP adapter)',
    command: 'pi-acp',
    version: 'package',
  },
};

// ---------------------------------------------------------------- install methods

/** Where a binary came from, read from its resolved path. */
export interface InstallInfo {
  method: HarnessInstallMethod;
  /** The Homebrew formula or cask, or the npm package. */
  package?: string;
  /** Homebrew: a cask rather than a formula. */
  cask?: boolean;
  /** Homebrew's prefix (`/opt/homebrew`), or npm's global prefix (`/usr/local`). */
  prefix?: string;
}

/** How the check reaches the tools it needs: a PATH lookup and a file test, injected for tests. */
export interface MethodTools {
  which: (command: string) => string | null;
  exists: (path: string) => boolean;
}

export interface UpdateMethod {
  /** The CLI it is for, or `*` for any. */
  vendor: HarnessId | '*';
  method: HarnessInstallMethod;
  /** The install this resolved path is, when it is this method's; else `undefined`. */
  detect(path: string): InstallInfo | undefined;
  /** The argv that prints the newest version, and how to read it; absent = unknown until it runs. */
  latest?: {
    argv(install: InstallInfo, tools: MethodTools): string[];
    parse(stdout: string): string | undefined;
  };
  /** The argv that updates it. `bin` is the CLI's own command, as found on PATH. */
  update(install: InstallInfo, bin: string, tools: MethodTools): string[];
}

const BREW_TREE =
  /^(\/opt\/homebrew|\/usr\/local|\/home\/linuxbrew\/\.linuxbrew)\/(Cellar|Caskroom)\/([^/]+)\//;

/** The `brew` of the prefix the CLI lives in (a daemon started by launchd may not have it on PATH). */
function brewOf(install: InstallInfo, tools: MethodTools): string {
  const own = install.prefix !== undefined ? `${install.prefix}/bin/brew` : undefined;
  if (own !== undefined && tools.exists(own)) return own;
  return tools.which('brew') ?? 'brew';
}

/** The `npm` of the prefix the package lives in, else the one on PATH. */
function npmOf(install: InstallInfo, tools: MethodTools): string {
  const own = install.prefix !== undefined ? `${install.prefix}/bin/npm` : undefined;
  if (own !== undefined && tools.exists(own)) return own;
  return tools.which('npm') ?? 'npm';
}

/** `brew info --json=v2`: a formula's stable version, or a cask's. */
function parseBrewInfo(stdout: string): string | undefined {
  try {
    const info = JSON.parse(stdout) as {
      formulae?: Array<{ versions?: { stable?: unknown } }>;
      casks?: Array<{ version?: unknown }>;
    };
    const stable = info.formulae?.[0]?.versions?.stable ?? info.casks?.[0]?.version;
    return typeof stable === 'string' ? parseVersion(stable) : undefined;
  } catch {
    return undefined;
  }
}

/** A global npm tree: `<prefix>/lib/node_modules/<pkg>/…`, `<pkg>` scoped or not. */
const NPM_GLOBAL_TREE = /^(.*)\/lib\/node_modules\/((?:@[^/]+\/)?[^/@]+)(?:\/|$)/;

/** Claude Code's own installer: the native build, or the older local install it still updates. */
const CLAUDE_NATIVE = [/\/\.local\/share\/claude\//, /\/\.claude\/local\//];

/**
 * vendor + method → detect, newest, update. Order is detection order: a
 * Homebrew formula may hold a `node_modules` tree (gemini-cli does), so
 * Homebrew is read first.
 */
export const UPDATE_METHODS: readonly UpdateMethod[] = [
  {
    vendor: '*',
    method: 'brew',
    detect(path) {
      const m = BREW_TREE.exec(path);
      if (!m) return undefined;
      return { method: 'brew', prefix: m[1], package: m[3], cask: m[2] === 'Caskroom' };
    },
    latest: {
      argv: (install, tools) => [
        brewOf(install, tools),
        'info',
        '--json=v2',
        ...(install.cask ? ['--cask'] : []),
        install.package ?? '',
      ],
      parse: parseBrewInfo,
    },
    update: (install, _bin, tools) => [
      brewOf(install, tools),
      'upgrade',
      ...(install.cask ? ['--cask'] : []),
      install.package ?? '',
    ],
  },
  {
    vendor: 'claude',
    method: 'native',
    detect: (path) =>
      CLAUDE_NATIVE.some((re) => re.test(path)) ? { method: 'native' } : undefined,
    // The newest version isn't known without asking the network; `claude update` finds it.
    update: (_install, bin) => [bin, 'update'],
  },
  {
    vendor: '*',
    method: 'npm',
    detect(path) {
      const m = NPM_GLOBAL_TREE.exec(path);
      if (!m) return undefined;
      return { method: 'npm', prefix: m[1], package: m[2] };
    },
    latest: {
      argv: (install, tools) => [npmOf(install, tools), 'view', install.package ?? '', 'version'],
      parse: (stdout) => parseVersion(stdout.trim()),
    },
    // `--prefix`: into the tree it came from, whichever npm is first on PATH.
    update: (install, _bin, tools) => [
      npmOf(install, tools),
      'install',
      '-g',
      ...(install.prefix !== undefined && install.prefix !== ''
        ? ['--prefix', install.prefix]
        : []),
      `${install.package ?? ''}@latest`,
    ],
  },
];

/** The first row whose vendor is this CLI (or any) and whose detect claims the path. */
export function detectInstall(
  harness: HarnessId,
  path: string,
  methods: readonly UpdateMethod[] = UPDATE_METHODS,
): { install: InstallInfo; method?: UpdateMethod } {
  for (const row of methods) {
    if (row.vendor !== '*' && row.vendor !== harness) continue;
    const install = row.detect(path);
    if (install !== undefined) return { install, method: row };
  }
  return { install: { method: 'unknown' } };
}

// ---------------------------------------------------------------- words

/** An argv as words to run by hand: `brew upgrade gemini-cli`. */
export function commandText(argv: readonly string[]): string {
  return argv
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

/** The first non-empty line of a command's output, trimmed and without a closing period. */
export function firstLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (line === undefined) return undefined;
  const clipped = line.length > 300 ? `${line.slice(0, 299)}…` : line;
  return clipped.replace(/[.\s]+$/, '');
}
