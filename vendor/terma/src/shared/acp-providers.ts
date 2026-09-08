/**
 * Provider registry: how to launch each supported agent subprocess.
 *
 * Providers are config *per transport* — not config, full stop. Within one
 * transport this stays configuration, not code paths: the daemon, the tRPC
 * router and the renderer treat every provider of that transport
 * identically, and anything a provider needs beyond an entry here (a special
 * case in message handling, a bespoke method) is an adapter leaking in,
 * which is exactly what this registry exists to prevent. But the registry's
 * scope is no longer only ACP: Codex speaks `codex app-server` JSON-RPC, not
 * ACP (spec §12.2), so the contract carries a `transport` discriminant and
 * the "identical generic path" guarantee holds per transport — a non-ACP
 * transport translates to the internal ACP-shaped event format at the
 * daemon boundary (spec §6.4, "Option C"). A provider needing more than
 * config *within its transport* is still the leak this header warns about.
 *
 * Vendor `_meta` payloads stay behind the narrow accessors in `acp-types.ts`
 * and degrade to null when a provider does not send them.
 */

export type AcpProviderId = "claude" | "gemini" | "cursor" | "grok";

/**
 * How the daemon drives the provider's subprocess (always a subprocess —
 * importing a harness runtime into the daemon is prohibited, spec §6.5):
 *
 * - `"acp"` — Agent Client Protocol, newline-delimited JSON-RPC on stdio.
 * - `"app-server"` — Codex's `codex app-server` JSON-RPC surface (§12.2).
 *   No entry uses it yet; the member exists so adding Codex is a registry
 *   entry plus a daemon-boundary translator, not a contract rewrite.
 *
 * Widens again if pi re-enters scope (§12.3).
 */
export type AcpProviderTransport = "acp" | "app-server";

export interface AcpClientCapabilities {
  fs: { readTextFile: boolean; writeTextFile: boolean };
  /**
   * Vendor capability extensions, advertised per provider. Advertising an
   * extension a provider does not know is harmless (it ignores `_meta`), but
   * keeping it per-provider is what stops the constant from becoming a global
   * Claude-shaped default that every new provider inherits.
   */
  _meta?: Record<string, boolean>;
}

export interface AcpProviderConfig {
  id: AcpProviderId;
  label: string;
  /**
   * Which wire protocol the subprocess speaks (see `AcpProviderTransport`).
   * All current entries are `"acp"`; every spawn path that assumes ACP
   * framing must check this rather than assume it once an `"app-server"`
   * entry lands.
   */
  transport: AcpProviderTransport;
  command: string;
  args: readonly string[];
  /**
   * Env vars overridden on top of the full inherited daemon environment.
   * A minimal env fails at spawn (`resolveAgentEnv` requires PATH, bridges
   * need HOME for their credential stores), so isolation means *override*,
   * not replace. Both built-in providers currently inherit everything —
   * Claude's bridge and the Gemini CLI each read auth from the real HOME —
   * but the field is what a provider with its own HOME would set.
   */
  envOverrides: Readonly<Record<string, string>>;
  clientCapabilities: AcpClientCapabilities;
  /**
   * Whether the provider's agent advertises `loadSession` — required for
   * crash recovery, which restores a session via `session/load` (SPIKE Q5).
   * Set per provider only after verifying against the real bridge: a session
   * recovered on a provider without it would silently lose its history.
   */
  loadSession: boolean;
}

/** Deep-freeze one registry entry so no caller can rewrite shared config. */
function freezeProvider(config: AcpProviderConfig): AcpProviderConfig {
  Object.freeze(config.args);
  Object.freeze(config.envOverrides);
  Object.freeze(config.clientCapabilities.fs);
  if (config.clientCapabilities._meta) Object.freeze(config.clientCapabilities._meta);
  Object.freeze(config.clientCapabilities);
  return Object.freeze(config);
}

// The container is frozen too: frozen entries alone still let a caller
// replace `ACP_PROVIDERS.claude` wholesale (swapping the launch command for
// every future session) or graft new ids past `resolveAcpProvider`.
export const ACP_PROVIDERS: Record<AcpProviderId, AcpProviderConfig> = Object.freeze({
  claude: freezeProvider({
    id: "claude",
    label: "Claude Code",
    transport: "acp",
    // Pinned bridge, verified by the Phase 0 spike (roadmap/agent-gui/SPIKE.md).
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.62.0"],
    envOverrides: {},
    // `_meta.terminal_output` is a vendor extension — with it set, command
    // output arrives as structured terminal frames instead of a fenced code
    // block. Only ever read through `acpTerminalOutput()`.
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      _meta: { terminal_output: true },
    },
    // Verified by the Phase 0 spike (roadmap/native-orchestration/SPIKE.md Q5).
    loadSession: true,
  }),
  gemini: freezeProvider({
    id: "gemini",
    label: "Gemini CLI",
    transport: "acp",
    // `gemini --experimental-acp` completes the ACP initialize handshake
    // through the identical generic path (verified 2026-07-27 against CLI
    // 0.32.1 and 0.52.0). No `_meta` extensions are advertised: Gemini sends
    // none, and the narrow accessors return null for it.
    command: "gemini",
    args: ["--experimental-acp"],
    envOverrides: {},
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
    // Not yet verified against the Gemini CLI bridge; recovery flags its
    // sessions for manual restart instead of attempting a load blind.
    loadSession: false,
  }),
  cursor: freezeProvider({
    id: "cursor",
    label: "Cursor",
    transport: "acp",
    // `cursor-agent acp` per Cursor's own docs (cursor.com/docs/cli/acp):
    // native ACP over stdio JSON-RPC, `initialize` with protocolVersion 1,
    // auth via `cursor_login` after `cursor-agent login`. Vendor-documented
    // but NOT yet verified by execution — the ACC-00 spike environment could
    // not install the CLI (every Cursor distribution host egress-blocked; no
    // npm/PyPI/GitHub-releases distribution, and the npm `cursor-agent`
    // package is an unrelated squatter). Run
    // `node spike/acp-launch-line-spike.mjs cursor-agent acp` on a machine
    // with the CLI and feed capability quirks back into spec §12.1.
    command: "cursor-agent",
    args: ["acp"],
    envOverrides: {},
    // No vendor `_meta` extensions advertised until the handshake has been
    // executed; the narrow accessors degrade to null.
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
    // Unknown until the handshake runs; recovery flags its sessions for
    // manual restart instead of attempting a `session/load` blind.
    loadSession: false,
  }),
  grok: freezeProvider({
    id: "grok",
    label: "Grok CLI",
    transport: "acp",
    // `grok agent stdio` verified by execution in the ACC-00 spike
    // (2026-08-18, Grok Build CLI 1.0.5 via `npm i -g @xai-official/grok`):
    // ACP over newline-delimited JSON-RPC on stdio, `initialize` returns
    // protocolVersion 1 with full agentCapabilities *unauthenticated*, but
    // `session/new` before auth fails -32000 "Authentication required" with
    // a single `grok.com` OAuth authMethod — first-run users must complete
    // ACP `authenticate` (browser sign-in) before any session work; until an
    // auth flow exists the -32000 surfaces in the agent pane as the session
    // error. Quirks (spec §12.1): promptCapabilities `image: false,
    // audio: false` — never send image blocks (the composer only emits
    // text/resource_link today); xAI `_meta` extensions (`x.ai/hooks`,
    // `x.ai/fs_notify`) can be ignored.
    command: "grok",
    args: ["agent", "stdio"],
    envOverrides: {},
    // Grok sends its own `_meta` extensions but consumes none we advertise;
    // an empty set keeps the narrow accessors degrading to null.
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
    // Advertised `loadSession: true` at `initialize`, verified by execution
    // in the ACC-00 spike (2026-08-18) — the same evidence standard as the
    // Claude entry. `session/load` itself sits behind the auth wall, so
    // recovery of an unauthenticated session fails loudly, not silently.
    loadSession: true,
  }),
});

/** Whether `id` names a registry entry (own-property, prototype-safe). */
export function isAcpProviderId(id: string): id is AcpProviderId {
  return Object.hasOwn(ACP_PROVIDERS, id);
}

/**
 * Resolve a provider id (default `claude`) for the ACP spawn path, rejecting
 * unknown ids loudly. Every caller of this function frames ACP JSON-RPC, so
 * an entry on another transport is rejected here — one choke point instead
 * of a transport check at each spawn site.
 */
export function resolveAcpProvider(id?: string): AcpProviderConfig {
  const key = id ?? "claude";
  // Own-property check: a plain lookup would resolve inherited names like
  // "toString" to Object.prototype members instead of rejecting them.
  if (!Object.hasOwn(ACP_PROVIDERS, key)) {
    throw new Error(`Unknown ACP provider: ${key}`);
  }
  const provider = ACP_PROVIDERS[key as AcpProviderId];
  if (provider.transport !== "acp") {
    throw new Error(
      `Provider ${key} speaks ${provider.transport}, which no spawn path implements yet`,
    );
  }
  return provider;
}
