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
    expect(isAcpProviderId('toString')).toBe(false);
    expect(isAcpProviderId('codex')).toBe(false);
  });

  it('describes claude on the spike-pinned bridge, no auth round trip needed', () => {
    const claude = ACP_PROVIDERS.claude;
    expect(claude.command).toBe('npx');
    expect(claude.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp@0.75.1']);
    expect(claude.clientCapabilities._meta?.terminal_output).toBe(true);
    expect(claude.authMethods).toEqual([]);
  });

  it('describes gemini with no vendor _meta capabilities and no verified loadSession', () => {
    const gemini = ACP_PROVIDERS.gemini;
    expect(gemini.command).toBe('gemini');
    expect(gemini.args).toEqual(['--experimental-acp']);
    expect(gemini.clientCapabilities._meta).toBeUndefined();
    expect(gemini.loadSession).toBe(false);
  });

  it('describes cursor requiring the cursor_login authenticate method', () => {
    const cursor = ACP_PROVIDERS.cursor;
    expect(cursor.command).toBe('cursor-agent');
    expect(cursor.args).toEqual(['acp']);
    expect(cursor.authMethods).toEqual(['cursor_login']);
    expect(cursor.loadSession).toBe(false);
  });

  it('describes grok requiring the grok.com authenticate method, loadSession verified', () => {
    const grok = ACP_PROVIDERS.grok;
    expect(grok.command).toBe('grok');
    expect(grok.args).toEqual(['agent', 'stdio']);
    expect(grok.authMethods).toEqual(['grok.com']);
    expect(grok.loadSession).toBe(true);
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
