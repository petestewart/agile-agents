/**
 * `buildSandboxProfile` — pure `(role, worktree, vendor) -> SandboxProfile`
 * (T026 — design §14 "Permissions per role" for the read/write/network
 * matrix; §6 for the tier-0 mandate itself). No IO, no backend awareness:
 * `sandbox-exec.ts` and `container.ts` each render this same profile their
 * own way.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SandboxProfile, SandboxProfileOptions } from './types';

/**
 * Public package registries an engineer needs to install/build (ticket
 * scope: "no network for engineers except allow-listed registries").
 * Deliberately narrow — a project needing a private registry passes it via
 * `extraAllowedHosts`, logged wherever the caller renders that policy, per
 * CLAUDE.md's "no new dependency without a DEC" spirit (§14 "Never without
 * a human": "installing a *new* dependency").
 */
export const DEFAULT_REGISTRY_ALLOWLIST: readonly string[] = Object.freeze([
  // npm / bun (bun's default registry is npm's)
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  // PyPI
  'pypi.org',
  'files.pythonhosted.org',
  // crates.io
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  // GitHub — package managers resolve some deps (git deps, releases) here
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  // Deno/JSR, increasingly common in the same toolchains
  'deno.land',
  'jsr.io',
]);

/**
 * Best-effort per-vendor login state paths, relative to `$HOME` — "vendor
 * logins must keep working inside the sandbox" (ticket scope). Verified
 * against `design/spike-findings.md` only for Claude ("ambient login
 * (`claude login`, or `ANTHROPIC_API_KEY`)" — `acp-client/src/providers.ts`);
 * the others are the vendor CLIs' documented/conventional config
 * directories, **not** independently confirmed by a spike run on this
 * machine (no vendor logins are available in this container — see
 * CLAUDE.md "Cloud sessions"). Flagged in the pipeline report for live
 * verification alongside T027.
 */
export const VENDOR_LOGIN_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  claude: ['.claude', '.config/claude'],
  openai: ['.codex'],
  cursor: ['.cursor', '.config/cursor-agent'],
  gemini: ['.gemini', '.config/gemini'],
  grok: ['.grok', '.xai'],
});

/** Env var names worth preserving verbatim so API-key auth still works when a vendor doesn't rely on a login directory. */
export const VENDOR_LOGIN_ENV: Readonly<Record<string, readonly string[]>> = Object.freeze({
  claude: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  grok: ['XAI_API_KEY'],
  cursor: [],
});

/**
 * §14 matrix, collapsed to what tier 0 can actually see (fs + network, no
 * per-file granularity): engineer writes its own worktree and reaches
 * package registries; reviewer and QA get a read-only checkout and no
 * network. QA's "own test files in the env" and "env base URL" cells need a
 * finer-grained mount than this pass renders (documented in the pipeline
 * report as a v0 gap, not silently dropped).
 */
export function buildSandboxProfile(opts: SandboxProfileOptions): SandboxProfile {
  const home = opts.homeDir ?? homedir();
  const loginRelPaths = VENDOR_LOGIN_PATHS[opts.vendor] ?? [];
  const loginPaths = loginRelPaths.map((rel) => join(home, rel));
  const loginEnvPassthrough = VENDOR_LOGIN_ENV[opts.vendor] ?? [];

  if (opts.role === 'engineer') {
    return {
      role: opts.role,
      worktreePath: opts.worktreePath,
      worktreeWritable: true,
      network: 'allowlist',
      allowedHosts: [...DEFAULT_REGISTRY_ALLOWLIST, ...(opts.extraAllowedHosts ?? [])],
      loginPaths,
      loginEnvPassthrough,
      homeDir: home,
      loginRelPaths,
      socketPath: opts.socketPath,
      // Round 2 B4: only the engineer gets shared-git write access —
      // reviewer/QA stay read-only there even if a caller passed `gitPaths`.
      gitPaths: opts.gitPaths,
    };
  }

  // reviewer / qa: read-only checkout, no network (§14).
  return {
    role: opts.role,
    worktreePath: opts.worktreePath,
    worktreeWritable: false,
    network: 'none',
    allowedHosts: [],
    loginPaths,
    loginEnvPassthrough,
    homeDir: home,
    loginRelPaths,
    socketPath: opts.socketPath,
  };
}
