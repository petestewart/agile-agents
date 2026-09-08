/**
 * Provider registry: how to launch each supported agent subprocess, and what
 * to advertise for it at `initialize`.
 *
 * Config *per vendor*, not a code path — `spawnSession` treats every entry
 * identically (design/agile-agents-design.md §8). A provider needing more
 * than an entry here is an adapter leaking into the registry, which is
 * exactly what this file exists to prevent.
 *
 * Provenance: lifted from Terma (vendor/terma/src/shared/acp-providers.ts)
 * and adapted — Terma/Electron naming removed, versions/commands refreshed
 * to the ones design/spike-findings.md measured, and `authMethods` added
 * (Cursor/Grok require ACP `authenticate` before `session/new` — §C, §D).
 */
import type { AcpClientCapabilities } from './types';

export type AcpProviderId = 'claude' | 'gemini' | 'cursor' | 'grok';

export interface AcpProviderConfig {
  id: AcpProviderId;
  label: string;
  command: string;
  args: readonly string[];
  /**
   * Env vars overridden on top of the full inherited environment. A minimal
   * env fails at spawn (the agent needs `PATH`, and most bridges need `HOME`
   * for their credential stores), so isolation means *override*, not
   * replace.
   */
  envOverrides: Readonly<Record<string, string>>;
  clientCapabilities: AcpClientCapabilities;
  /**
   * Whether the provider's agent advertises `loadSession` — required for
   * `session/load` recovery (design/spike-findings.md §C: Claude and Grok
   * verified true; Gemini and Cursor not yet verified, so false here rather
   * than a blind guess).
   */
  loadSession: boolean;
  /**
   * ACP `authenticate` method ids this provider requires before `session/new`
   * will succeed — empty when the agent authenticates itself out of band
   * (Claude Code inherits `claude login`; spike-findings.md §C confirms no
   * ACP `authenticate` round trip is needed). Cursor and Grok both gate
   * `session/new` behind `authenticate` (§C2, §D).
   */
  authMethods: readonly string[];
}

/** Deep-freeze one registry entry so no caller can rewrite shared config. */
function freezeProvider(config: AcpProviderConfig): AcpProviderConfig {
  Object.freeze(config.args);
  Object.freeze(config.envOverrides);
  Object.freeze(config.authMethods);
  Object.freeze(config.clientCapabilities.fs);
  if (config.clientCapabilities._meta) Object.freeze(config.clientCapabilities._meta);
  Object.freeze(config.clientCapabilities);
  return Object.freeze(config);
}

// The container is frozen too: frozen entries alone still let a caller
// replace `ACP_PROVIDERS.claude` wholesale or graft new ids past
// `resolveAcpProvider`.
export const ACP_PROVIDERS: Record<AcpProviderId, AcpProviderConfig> = Object.freeze({
  claude: freezeProvider({
    id: 'claude',
    label: 'Claude Code',
    // Zed-maintained ACP bridge over Claude Code, measured in
    // design/spike-findings.md §A-§C against 0.75.1 / Claude Code 2.1.263.
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp@0.75.1'],
    envOverrides: {},
    // `_meta.terminal_output` is a vendor extension — advertising it makes
    // command output arrive as structured terminal frames. Only ever read
    // through a narrow accessor by a caller that wants it; harmless if ignored.
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      _meta: { terminal_output: true },
    },
    loadSession: true,
    // Ambient login (`claude login`, or ANTHROPIC_API_KEY) — no ACP
    // `authenticate` round trip needed (spike-findings.md §C, §C2).
    authMethods: [],
  }),
  gemini: freezeProvider({
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    args: ['--experimental-acp'],
    envOverrides: {},
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
    // Not verified against the Gemini CLI bridge (spike-findings.md §D:
    // "handshake only"); recovery should flag its sessions for manual
    // restart instead of attempting a load blind.
    loadSession: false,
    authMethods: [],
  }),
  cursor: freezeProvider({
    id: 'cursor',
    label: 'Cursor',
    command: 'cursor-agent',
    args: ['acp'],
    envOverrides: {},
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
    // Unverified — recovery flags for manual restart rather than a blind load.
    loadSession: false,
    // `cursor-agent login` completes out of band, but `session/new` still
    // requires the ACP `authenticate(cursor_login)` round trip first
    // (spike-findings.md §C2).
    authMethods: ['cursor_login'],
  }),
  grok: freezeProvider({
    id: 'grok',
    label: 'Grok CLI',
    command: 'grok',
    args: ['agent', 'stdio'],
    envOverrides: {},
    // Grok sends its own `_meta` extensions but consumes none advertised
    // here; an empty set keeps a narrow accessor degrading to null.
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
    // Verified by execution (spike-findings.md §D, §C2): `session/new`
    // before auth fails -32000 with a single `grok.com` OAuth authMethod.
    loadSession: true,
    authMethods: ['grok.com'],
  }),
});

/** Whether `id` names a registry entry (own-property, prototype-safe). */
export function isAcpProviderId(id: string): id is AcpProviderId {
  return Object.hasOwn(ACP_PROVIDERS, id);
}

/**
 * Resolve a provider id (default `claude`) to its registry entry, rejecting
 * unknown ids loudly.
 */
export function resolveAcpProvider(id?: string): AcpProviderConfig {
  const key = id ?? 'claude';
  // Own-property check: a plain lookup would resolve inherited names like
  // "toString" to Object.prototype members instead of rejecting them.
  if (!Object.hasOwn(ACP_PROVIDERS, key)) {
    throw new Error(`Unknown ACP provider: ${key}`);
  }
  return ACP_PROVIDERS[key as AcpProviderId];
}
