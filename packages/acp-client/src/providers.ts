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

export type AcpProviderId = 'claude' | 'gemini' | 'cursor' | 'grok' | 'codex';

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
  /**
   * ACP `session/set_mode` id to request right after `session/new`, or
   * `undefined` when the vendor has no mode concept at all
   * (design/spike-findings.md §C2: Grok — "no modes"; §D: Gemini reports
   * none either). `runner/session.ts` omits `SpawnSessionOptions.modeId`
   * entirely when this is `undefined`, so `ensureSession()` never sends
   * `session/set_mode` for such a vendor (T027 review round 1 B1: sending
   * `'default'` — a *Claude*-only mode id — to Cursor/Grok/Codex fails the
   * whole `ensureSession()`, and therefore the first prompt, since none of
   * them has a `'default'` mode). Vendor mode sets, per spike-findings.md
   * §C2: Cursor `agent | plan | ask`, Codex `read-only | agent |
   * agent-full-access`, Claude `default | acceptEdits | plan | auto |
   * bypassPermissions`.
   */
  defaultModeId?: string;
  /**
   * `true` when this vendor's bridge is measured to gate exec at **no**
   * tier — not ACP permission, not a hook, not client fs
   * (design/spike-findings.md §C3's final matrix: Codex "codex-acp never
   * asks, regardless of mode or approval policy"; Grok's exec is entirely
   * ungated, only its client-fs reads/writes are gated). `Runner.spawn`
   * (T027 review round 1 B2) ORs this with `VendorConfig.requires_sandbox`
   * from `vendors.yaml` rather than trusting the yaml field alone, so the
   * tier-0 refusal (design §6: "a vendor with ungated exec ... is an
   * engineer only inside a tier-0 sandbox") cannot be silently opted out of
   * by an operator's `vendors.yaml` simply omitting the field (its schema
   * default is `false`, and design §8's own example yaml never sets it at
   * all). Defaults `undefined`/falsy for every vendor whose exec tier 2
   * actually gates (Claude, Cursor per §C2 — "raises a permission request
   * for every exec").
   */
  requiresSandbox?: boolean;
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
    // Modes at 0.75.1 (§C): `default, acceptEdits, plan, auto,
    // bypassPermissions` — `default` is what tier 2 needs to see edits/exec
    // (§6: "Engineers run in `default` mode so tier 2 sees edits/exec").
    defaultModeId: 'default',
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
    // No `defaultModeId` — spike-findings.md §D: "reports no modes";
    // `session.ts` omits `session/set_mode` entirely for this vendor.
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
    // Modes `agent | plan | ask` (§C2). `agent` is the default an
    // engineer/QA session runs in; a reviewer instead gets `ask`
    // (`permissions/vendor-modes.ts`'s `cursorModeIdFor`, §C3's "useful for
    // reviewers as a nudge, not a gate" — additive to, never a substitute
    // for, tier 2's own exec-request gating).
    defaultModeId: 'agent',
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
    // Verified by execution (spike-findings.md §D, §C2 confirm loadSession
    // and the auth requirement generally); the specific -32000/`grok.com`
    // shape is recorded in vendor/terma/src/shared/acp-providers.ts, not in
    // spike-findings.md itself.
    loadSession: true,
    authMethods: ['grok.com'],
    // No `defaultModeId` — spike-findings.md §C2: Grok has "no modes";
    // `session.ts` omits `session/set_mode` entirely for this vendor
    // (T027 review round 1 B1 — sending a Claude mode id like `'default'`
    // here fails `session/new`'s handshake outright).
    // Grok's exec is entirely ungated at every tier (§C3) — only its
    // client-fs reads/writes are gated (`permissions/vendor-fs.ts`) — so it
    // is an engineer only inside a tier-0 sandbox (design §6).
    requiresSandbox: true,
  }),
  codex: freezeProvider({
    id: 'codex',
    label: 'Codex',
    // `@agentclientprotocol/codex-acp` 1.10.0 (design/spike-findings.md §D,
    // §C2, §C3): raises **zero** permission requests in `agent`,
    // `read-only`, or `agent-full-access`, and stays that way under every
    // `approval_policy` tested — "codex-acp never asks, regardless of mode
    // or approval policy. If Codex needs approvals its adapter is the
    // native `codex app-server` (which has approval request kinds)".
    // Neither ACP permission (tier 2) nor a hook (tier 1) can gate this
    // vendor, so a Codex engineer is routed through tier-0 sandbox only
    // (`VendorConfig.requires_sandbox: true`, §6) plus tier-3 observation —
    // never spawned unsandboxed (`Runner.spawn`/`wrapAgentCommand` fail
    // closed on `requires_sandbox` with no backend, T026).
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp@1.10.0'],
    envOverrides: {},
    // codex-acp never calls client `fs/*` (spike: "Codex reads files via
    // shell (`sed -n`) rather than a read tool, so even a read gate would
    // have to be an exec gate") — advertised anyway, harmless if unused,
    // matching every other provider's entry here.
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
    // Verified by execution (spike-findings.md §C2: "session/load restores
    // context").
    loadSession: true,
    // Ambient ChatGPT login (`codex login`), out of band — spike-findings.md
    // §D: "needs ChatGPT login on a real machine", never an ACP
    // `authenticate` round trip (unlike Cursor/Grok, no -32000/auth error
    // was ever observed for codex-acp in any spike run).
    authMethods: [],
    // Modes `read-only | agent | agent-full-access` (§C2) — `agent` is what
    // an engineer needs (write access); irrelevant to gating either way
    // since codex-acp "raises zero permission requests in agent and
    // read-only" alike (§C2/§C3), so mode never affects enforcement here.
    defaultModeId: 'agent',
    // codex-acp "raises zero permission requests ... regardless of mode or
    // approval policy" (§C3) — no tier 1/2 gate exists for this vendor at
    // all, so it is an engineer only inside a tier-0 sandbox (design §6).
    requiresSandbox: true,
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
