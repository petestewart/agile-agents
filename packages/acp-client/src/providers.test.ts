/**
 * Adapted from Terma's acp-providers.test.ts
 * (vendor/terma/src/__tests__/unit/acp-providers.test.ts): the registry is
 * configuration, and these tests are its contract — every provider must be
 * launchable through the identical generic path. There is deliberately no
 * per-provider behaviour to test.
 */
import { describe, expect, it } from 'bun:test';
import { ACP_PROVIDERS, isAcpProviderId, resolveAcpProvider } from './providers';

describe('ACP provider registry', () => {
  it('resolves claude by default', () => {
    expect(resolveAcpProvider(undefined).id).toBe('claude');
    expect(resolveAcpProvider('claude').id).toBe('claude');
  });

  it('rejects unknown provider ids loudly', () => {
    expect(() => resolveAcpProvider('copilot')).toThrow(/Unknown ACP provider: copilot/);
    // Prototype names must not resolve to anything.
    expect(() => resolveAcpProvider('toString')).toThrow(/Unknown ACP provider/);
  });

  it('recognises exactly the registered ids', () => {
    expect(isAcpProviderId('claude')).toBe(true);
    expect(isAcpProviderId('gemini')).toBe(true);
    expect(isAcpProviderId('cursor')).toBe(true);
    expect(isAcpProviderId('grok')).toBe(true);
    expect(isAcpProviderId('pi')).toBe(true);
    expect(isAcpProviderId('codex')).toBe(true);
    expect(isAcpProviderId('toString')).toBe(false);
    expect(isAcpProviderId('copilot')).toBe(false);
  });

  it('describes claude on the spike-pinned bridge, no auth round trip needed', () => {
    const claude = ACP_PROVIDERS.claude;
    expect(claude.command).toBe('npx');
    expect(claude.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp@0.75.1']);
    expect(claude.clientCapabilities._meta?.terminal_output).toBe(true);
    expect(claude.authMethods).toEqual([]);
    expect(claude.defaultModeId).toBe('default');
    expect(claude.requiresSandbox).toBeFalsy();
  });

  it('describes gemini with no vendor _meta capabilities and no verified loadSession, no mode (T027 round 2: §D reports none)', () => {
    const gemini = ACP_PROVIDERS.gemini;
    expect(gemini.command).toBe('gemini');
    expect(gemini.args).toEqual(['--experimental-acp']);
    expect(gemini.clientCapabilities._meta).toBeUndefined();
    expect(gemini.loadSession).toBe(false);
    expect(gemini.defaultModeId).toBeUndefined();
    expect(gemini.requiresSandbox).toBeFalsy();
  });

  it('describes cursor requiring the cursor_login authenticate method, defaultModeId "agent" (§C2: agent | plan | ask), not gated by tier 0', () => {
    const cursor = ACP_PROVIDERS.cursor;
    expect(cursor.command).toBe('cursor-agent');
    expect(cursor.args).toEqual(['acp']);
    expect(cursor.authMethods).toEqual(['cursor_login']);
    expect(cursor.loadSession).toBe(false);
    expect(cursor.defaultModeId).toBe('agent');
    // Cursor's ACP permission request fires for every exec (§C2/§C3) — tier
    // 2 already gates it, so unlike Grok/Codex it does not require tier 0.
    expect(cursor.requiresSandbox).toBeFalsy();
  });

  it('describes grok requiring the grok.com authenticate method, loadSession verified, no mode (§C2: "no modes"), requiresSandbox (§C3: ungated exec)', () => {
    const grok = ACP_PROVIDERS.grok;
    expect(grok.command).toBe('grok');
    expect(grok.args).toEqual(['agent', 'stdio']);
    expect(grok.authMethods).toEqual(['grok.com']);
    expect(grok.loadSession).toBe(true);
    // T027 review round 1 B1: Grok has no mode concept at all — sending
    // any `session/set_mode` (e.g. Claude's `'default'`) fails the whole
    // `ensureSession()` handshake for this vendor.
    expect(grok.defaultModeId).toBeUndefined();
    // T027 review round 1 B2: carried on the provider entry itself, not
    // only in `vendors.yaml`, so a bare `grok:` stanza can't opt out of it.
    expect(grok.requiresSandbox).toBe(true);
  });

  it('describes codex on codex-acp, no auth round trip needed, no client fs use, defaultModeId "agent" (§C2), requiresSandbox (§C3: never asks)', () => {
    const codex = ACP_PROVIDERS.codex;
    expect(codex.command).toBe('npx');
    expect(codex.args).toEqual(['-y', '@agentclientprotocol/codex-acp@1.10.0']);
    expect(codex.authMethods).toEqual([]);
    expect(codex.loadSession).toBe(true);
    // Advertised anyway (harmless), even though the spike found codex-acp
    // never calls it — matches every other provider's entry.
    expect(codex.clientCapabilities.fs).toEqual({ readTextFile: true, writeTextFile: true });
    expect(codex.defaultModeId).toBe('agent');
    expect(codex.requiresSandbox).toBe(true);
  });

  it('describes pi over pi-acp, no args, no auth round trip, loadSession verified', () => {
    const pi = ACP_PROVIDERS.pi;
    expect(pi.command).toBe('pi-acp');
    expect(pi.args).toEqual([]);
    expect(pi.authMethods).toEqual([]);
    expect(pi.loadSession).toBe(true);
  });

  it('freezes every entry so callers cannot rewrite shared config', () => {
    expect(Object.isFrozen(ACP_PROVIDERS)).toBe(true);
    expect(Object.isFrozen(ACP_PROVIDERS.claude)).toBe(true);
    expect(Object.isFrozen(ACP_PROVIDERS.claude.args)).toBe(true);
    expect(Object.isFrozen(ACP_PROVIDERS.claude.clientCapabilities)).toBe(true);
    expect(() => {
      // @ts-expect-error — deliberately mutating a frozen array to prove it throws in strict mode
      ACP_PROVIDERS.claude.args.push('--extra');
    }).toThrow();
  });
});
