import { describe, expect, it } from 'bun:test';
import { GATE_ENV_VAR } from './agile-extension';
import { readAgileExtensionSource } from './source';

describe('readAgileExtensionSource', () => {
  it('reads agile-extension.ts as a sibling of this module, containing the gate env var name', () => {
    const source = readAgileExtensionSource();
    expect(source).toContain(GATE_ENV_VAR);
    expect(source).toContain('createAgileExtension');
  });
});
