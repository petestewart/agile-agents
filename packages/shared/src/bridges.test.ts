import { describe, expect, test } from 'bun:test';
import {
  BRIDGES_DIR,
  BRIDGE_MANIFEST_FILE,
  BridgeManifestSchema,
  VendorInstallInputSchema,
  validateBridgeManifest,
} from './bridges';

const good = {
  vendor: 'antigravity',
  registry_id: 'antigravity-acp',
  version: '1.2.1',
  platform: 'linux-x86_64',
  url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-x86_64.zip',
  archive: 'agy-acp-server-1.2.1-linux-x86_64.zip',
  sha256: 'a'.repeat(64),
  size: 1234,
  command: 'agy_acp_server.par',
  installed_at: '2026-10-01T12:00:00.000Z',
  by: 'human',
};

const refused = (patch: Record<string, unknown>) =>
  BridgeManifestSchema.safeParse({ ...good, ...patch }).success === false;

describe('T500 bridge manifest', () => {
  test('lives in <home>/bridges/<name>/<version>/manifest.yaml', () => {
    expect(BRIDGES_DIR).toBe('bridges');
    expect(BRIDGE_MANIFEST_FILE).toBe('manifest.yaml');
  });

  test('a good manifest validates as it is', () => {
    expect<unknown>(validateBridgeManifest(good)).toEqual(good);
  });

  test('strict: an unknown key, an http URL, a bad hash, a path for a file, an unknown platform are refused', () => {
    expect(() => validateBridgeManifest({ ...good, extra: 1 })).toThrow(/BridgeManifest/);
    expect(refused({ url: 'http://dl.google.com/x.zip' })).toBe(true);
    expect(refused({ sha256: 'A'.repeat(64) })).toBe(true);
    expect(refused({ sha256: 'abc' })).toBe(true);
    expect(refused({ command: '../agy_acp_server.par' })).toBe(true);
    expect(refused({ archive: 'a/b.zip' })).toBe(true);
    expect(refused({ platform: 'linux-ppc64' })).toBe(true);
    expect(refused({ vendor: 'copilot' })).toBe(true);
    expect(refused({ size: 0 })).toBe(true);
    expect(refused({ by: 'daemon' })).toBe(true);
  });

  test('the install input names one session vendor, nothing else', () => {
    expect(VendorInstallInputSchema.parse({ vendor: 'antigravity' })).toEqual({
      vendor: 'antigravity',
    });
    expect(VendorInstallInputSchema.safeParse({}).success).toBe(false);
    expect(VendorInstallInputSchema.safeParse({ vendor: 'antigravity', url: 'x' }).success).toBe(
      false,
    );
  });
});
