import { describe, it, expect } from "vitest";
import {
  ACP_PROVIDERS,
  isAcpProviderId,
  resolveAcpProvider,
} from "../../shared/acp-providers";

/**
 * The registry is configuration, and these tests are its contract: every
 * provider must be launchable through the identical generic path. There is
 * deliberately no per-provider behaviour to test — that absence is the point
 * of GH-43.
 */
describe("ACP provider registry", () => {
  it("resolves claude by default", () => {
    expect(resolveAcpProvider(undefined).id).toBe("claude");
    expect(resolveAcpProvider("claude").id).toBe("claude");
  });

  it("rejects unknown provider ids loudly", () => {
    expect(() => resolveAcpProvider("copilot")).toThrow(/Unknown ACP provider: copilot/);
    // Prototype names must not resolve to anything.
    expect(() => resolveAcpProvider("toString")).toThrow(/Unknown ACP provider/);
  });

  it("keeps the claude entry on the spike-pinned bridge", () => {
    const claude = ACP_PROVIDERS.claude;
    expect(claude.command).toBe("npx");
    expect(claude.args).toEqual(["-y", "@agentclientprotocol/claude-agent-acp@0.62.0"]);
    expect(claude.clientCapabilities._meta?.terminal_output).toBe(true);
  });

  it("describes gemini with no vendor _meta capabilities", () => {
    const gemini = ACP_PROVIDERS.gemini;
    expect(gemini.command).toBe("gemini");
    expect(gemini.args).toEqual(["--experimental-acp"]);
    // Gemini sends no vendor extensions; advertising none keeps the narrow
    // accessors degrading to null rather than special-casing the provider.
    expect(gemini.clientCapabilities._meta).toBeUndefined();
  });

  it("describes cursor on the vendor-documented launch line (unexecuted — see GH-112)", () => {
    const cursor = ACP_PROVIDERS.cursor;
    // cursor.com/docs/cli/acp: `cursor-agent acp` over stdio JSON-RPC. The
    // handshake has NOT been executed (ACC-00 spike env could not install the
    // CLI); until it is, no vendor _meta is advertised and loadSession stays
    // off so recovery never attempts a `session/load` blind.
    expect(cursor.transport).toBe("acp");
    expect(cursor.command).toBe("cursor-agent");
    expect(cursor.args).toEqual(["acp"]);
    expect(cursor.clientCapabilities._meta).toBeUndefined();
    expect(cursor.loadSession).toBe(false);
  });

  it("describes grok on the spike-verified launch line", () => {
    const grok = ACP_PROVIDERS.grok;
    // Verified by execution 2026-08-18 (Grok Build CLI 1.0.5): `grok agent
    // stdio`, initialize succeeds unauthenticated, agentCapabilities
    // advertised loadSession: true. Grok consumes no client _meta extensions.
    expect(grok.transport).toBe("acp");
    expect(grok.command).toBe("grok");
    expect(grok.args).toEqual(["agent", "stdio"]);
    expect(grok.clientCapabilities._meta).toBeUndefined();
    expect(grok.loadSession).toBe(true);
  });

  it("declares a transport on every provider — all ACP until Codex lands", () => {
    for (const provider of Object.values(ACP_PROVIDERS)) {
      // resolveAcpProvider rejects non-ACP transports at the spawn choke
      // point; every current entry must pass through it.
      expect(provider.transport).toBe("acp");
      expect(resolveAcpProvider(provider.id).id).toBe(provider.id);
    }
  });

  it("answers isAcpProviderId consistently with the registry", () => {
    for (const id of Object.keys(ACP_PROVIDERS)) {
      expect(isAcpProviderId(id)).toBe(true);
    }
    for (const id of ["copilot", "toString", "__proto__", ""]) {
      expect(isAcpProviderId(id)).toBe(false);
    }
  });

  it("is immutable at runtime — entries, nested config, and the registry itself", () => {
    const claude = ACP_PROVIDERS.claude as unknown as {
      command: string;
      args: string[];
      envOverrides: Record<string, string>;
      clientCapabilities: { fs: { readTextFile: boolean }; _meta?: Record<string, boolean> };
    };
    expect(() => { claude.command = "evil"; }).toThrow(TypeError);
    expect(() => { claude.args.push("evil"); }).toThrow(TypeError);
    expect(() => { claude.envOverrides.HOME = "/evil"; }).toThrow(TypeError);
    expect(() => { claude.clientCapabilities.fs.readTextFile = false; }).toThrow(TypeError);
    expect(() => { claude.clientCapabilities._meta!.terminal_output = false; }).toThrow(TypeError);
    // The container too: frozen entries alone would still allow replacing
    // `ACP_PROVIDERS.claude` wholesale or grafting a new id past
    // `resolveAcpProvider`.
    const registry = ACP_PROVIDERS as unknown as Record<string, unknown>;
    expect(() => { registry.claude = { command: "evil" }; }).toThrow(TypeError);
    expect(() => { registry.evil = { command: "evil" }; }).toThrow(TypeError);
  });

  it("rejects prototype-chain names as provider ids", () => {
    for (const name of ["__proto__", "constructor", "hasOwnProperty", ""]) {
      expect(() => resolveAcpProvider(name)).toThrow(/Unknown ACP provider/);
    }
  });

  it("gives every provider a complete, generic launch description", () => {
    for (const provider of Object.values(ACP_PROVIDERS)) {
      expect(provider.command.length).toBeGreaterThan(0);
      expect(Array.isArray(provider.args)).toBe(true);
      expect(provider.clientCapabilities.fs).toEqual({
        readTextFile: true,
        writeTextFile: true,
      });
      // Overrides, never a full env: a minimal env fails at spawn.
      expect(provider.envOverrides).not.toHaveProperty("PATH");
    }
  });
});
