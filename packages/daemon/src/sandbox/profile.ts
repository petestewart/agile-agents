/** `buildSandboxProfile`: pure `(role, worktree, vendor) → SandboxProfile` (§14); each backend renders it its own way. */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SandboxProfile, SandboxProfileOptions } from './types';

/** Public registries an engineer needs; deliberately narrow (private ones go in `extraAllowedHosts`). */
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
 * Per-vendor login state paths relative to `$HOME`, so logins keep working
 * inside the sandbox. Only Claude's is confirmed by the spike; the rest
 * are the CLIs' conventional config dirs, pending a live check.
 */
export const VENDOR_LOGIN_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  claude: ['.claude', '.config/claude'],
  openai: ['.codex'],
  cursor: ['.cursor', '.config/cursor-agent'],
  gemini: ['.gemini', '.config/gemini'],
  grok: ['.grok', '.xai'],
});

/** Env var names preserved so API-key auth still works. */
export const VENDOR_LOGIN_ENV: Readonly<Record<string, readonly string[]>> = Object.freeze({
  claude: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  grok: ['XAI_API_KEY'],
  cursor: [],
});

/** §14 collapsed to what tier 0 sees: the engineer writes its worktree and reaches registries; a reviewer reads, no network. */
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
      // Only the engineer gets shared-git write access.
      gitPaths: opts.gitPaths,
    };
  }

  // Reviewer: read-only checkout, no network (§14).
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
