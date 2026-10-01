/**
 * T500: a downloaded ACP server (Antigravity's `agy_acp_server`). Every
 * download and unzip here is a fake: nothing is fetched, no archive is
 * really unpacked, and the server is never run.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, ANTIGRAVITY_BRIDGE } from '@agile-agents/acp-client';
import { BRIDGE_MANIFEST_FILE, BridgeManifestSchema } from '@agile-agents/shared';
import { parse as parseYaml } from 'yaml';
import type { CommandRunner } from '../harness/methods';
import { runInit } from '../init';
import { missingVendorCommand } from '../runner/session';
import { StateStore } from '../store';
import {
  BridgeHashMismatchError,
  BridgeInstallService,
  BridgeNotInstallableError,
  type BridgeUnzipper,
  bridgeDir,
  bridgeNotInstalledWords,
  httpsDownload,
  installBridge,
  missingBridge,
  providerIn,
  readBridgeManifest,
  systemUnzip,
} from './bridges';

const LINUX = { platform: 'linux', arch: 'x64' };
const MISSING =
  "Antigravity can't start: its ACP server isn't installed. Install it in Settings → Agents → Vendors.";

let home: string;
let store: StateStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-bridges-'));
  store = StateStore.open(runInit(home).stateRoot);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const antigravity = ACP_PROVIDERS.antigravity;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** A downloader that writes `body` and records what it was asked for. */
function fakeDownload(body: string, urls: string[] = []) {
  return async (url: string, dest: string) => {
    urls.push(url);
    writeFileSync(dest, body);
  };
}

/** An "unzip" that drops a server file into the folder, as the real archive would. */
function fakeUnzip(
  calls: Array<[string, string]> = [],
  file = 'agy_acp_server.par',
): BridgeUnzipper {
  return async (archive, dir) => {
    calls.push([archive, dir]);
    writeFileSync(join(dir, file), `#!/bin/sh\n# fake server unpacked from ${archive}\n`);
  };
}

describe('the provider resolves to the server in the home, per platform', () => {
  test('linux: the .par with --uid=, under bridges/antigravity/1.2.1', () => {
    const p = providerIn(home, antigravity, LINUX);
    expect(p.command).toBe(join(home, 'bridges', 'antigravity', '1.2.1', 'agy_acp_server.par'));
    expect(p.args).toEqual(['--uid=']);
    expect(providerIn(home, antigravity, { platform: 'linux', arch: 'arm64' }).args).toEqual([
      '--uid=',
    ]);
    // The registry's entry is left as it was.
    expect(antigravity.command).toBe('agy_acp_server.par');
  });

  test('macOS: the .par with no args; Windows: the .exe', () => {
    for (const arch of ['arm64', 'x64']) {
      const mac = providerIn(home, antigravity, { platform: 'darwin', arch });
      expect(mac.command).toBe(join(bridgeDir(home, ANTIGRAVITY_BRIDGE), 'agy_acp_server.par'));
      expect(mac.args).toEqual([]);
      const win = providerIn(home, antigravity, { platform: 'win32', arch });
      expect(win.command).toBe(join(bridgeDir(home, ANTIGRAVITY_BRIDGE), 'agy_acp_server.exe'));
      expect(win.args).toEqual([]);
    }
  });

  test('a host with no build keeps the bare name and says so; other vendors are untouched', () => {
    const odd = { platform: 'freebsd', arch: 'x64' };
    const p = providerIn(home, antigravity, odd);
    expect(p.command).toBe('agy_acp_server.par');
    expect(missingBridge(p, odd)).toBe(
      "Antigravity can't start: its ACP server has no build for this computer (freebsd x64).",
    );
    expect(providerIn(home, ACP_PROVIDERS.claude, LINUX)).toBe(ACP_PROVIDERS.claude);
    expect(missingBridge(ACP_PROVIDERS.claude, LINUX)).toBeUndefined();
  });
});

describe('a missing install names the fix', () => {
  test('nothing installed: the ticket’s words, from missingVendorCommand too (never a PATH lookup)', () => {
    expect(bridgeNotInstalledWords('Antigravity')).toBe(MISSING);
    const p = providerIn(home, antigravity, LINUX);
    expect(missingBridge(p, LINUX)).toBe(MISSING);
    // Unresolved (still the bare name): the same words.
    expect(missingBridge(antigravity, LINUX)).toBe(MISSING);
    if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) {
      let looked = false;
      const which = () => {
        looked = true;
        return '/usr/bin/agy_acp_server.par';
      };
      expect(missingVendorCommand(providerIn(home, antigravity), which)).toBe(MISSING);
      expect(looked).toBe(false);
    }
  });

  test('a server with no manifest beside it is not an install', async () => {
    await installBridge({
      home,
      store,
      vendor: 'antigravity',
      provider: antigravity,
      host: LINUX,
      download: fakeDownload('zip-1'),
      unzip: fakeUnzip(),
    });
    const p = providerIn(home, antigravity, LINUX);
    expect(missingBridge(p, LINUX)).toBeUndefined();
    rmSync(join(bridgeDir(home, ANTIGRAVITY_BRIDGE), BRIDGE_MANIFEST_FILE));
    expect(missingBridge(p, LINUX)).toBe(MISSING);
  });
});

describe('install', () => {
  test('fetches the pinned URL only, keeps the archive, unpacks it, makes the server executable, and writes the manifest last through the store', async () => {
    const urls: string[] = [];
    const unzips: Array<[string, string]> = [];
    const manifest = await installBridge({
      home,
      store,
      vendor: 'antigravity',
      provider: antigravity,
      host: LINUX,
      download: fakeDownload('zip-bytes-1', urls),
      unzip: fakeUnzip(unzips),
      now: () => new Date('2026-10-01T12:00:00.000Z'),
    });
    const dir = bridgeDir(home, ANTIGRAVITY_BRIDGE);
    expect(urls).toEqual([
      'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-x86_64.zip',
    ]);
    expect(unzips).toEqual([[join(dir, 'agy-acp-server-1.2.1-linux-x86_64.zip'), dir]]);
    expect(manifest).toEqual({
      vendor: 'antigravity',
      registry_id: 'antigravity-acp',
      version: '1.2.1',
      platform: 'linux-x86_64',
      url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-x86_64.zip',
      archive: 'agy-acp-server-1.2.1-linux-x86_64.zip',
      sha256: sha('zip-bytes-1'),
      size: 'zip-bytes-1'.length,
      command: 'agy_acp_server.par',
      installed_at: '2026-10-01T12:00:00.000Z',
      by: 'human',
    });
    // On disk: the manifest (valid YAML), the archive, the executable server, no temp file.
    const onDisk = BridgeManifestSchema.parse(
      parseYaml(readFileSync(join(dir, BRIDGE_MANIFEST_FILE), 'utf8')),
    );
    expect(onDisk).toEqual(manifest);
    expect(readBridgeManifest(home, ANTIGRAVITY_BRIDGE)).toEqual(manifest);
    expect(readFileSync(join(dir, 'agy-acp-server-1.2.1-linux-x86_64.zip'), 'utf8')).toBe(
      'zip-bytes-1',
    );
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'agy_acp_server.par')).mode & 0o111).toBe(0o111);
    }
    expect(readdirSync(dir).filter((n) => n.startsWith('.'))).toEqual([]);
    // Through the validating store: its event records the write.
    const put = store
      .listEvents()
      .filter((e) => e.kind === 'entity_put')
      .at(-1);
    expect(put?.data).toEqual({ relPath: `bridges/antigravity/1.2.1/${BRIDGE_MANIFEST_FILE}` });
  });

  test('the same version downloaded again with another hash is refused and the install is left as it was', async () => {
    const first = await installBridge({
      home,
      store,
      vendor: 'antigravity',
      provider: antigravity,
      host: LINUX,
      download: fakeDownload('zip-bytes-1'),
      unzip: fakeUnzip(),
    });
    const dir = bridgeDir(home, ANTIGRAVITY_BRIDGE);
    const server = readFileSync(join(dir, 'agy_acp_server.par'), 'utf8');
    const unzips: Array<[string, string]> = [];
    const again = installBridge({
      home,
      store,
      vendor: 'antigravity',
      provider: antigravity,
      host: LINUX,
      download: fakeDownload('zip-bytes-TAMPERED'),
      unzip: fakeUnzip(unzips),
    });
    await expect(again).rejects.toBeInstanceOf(BridgeHashMismatchError);
    await expect(again).rejects.toThrow(
      new RegExp(
        `Refused: Antigravity's ACP server 1\\.2\\.1 downloaded with SHA-256 ${sha('zip-bytes-TAMPERED')}, but the copy installed here on \\d{4}-\\d{2}-\\d{2} has ${first.sha256}`,
      ),
    );
    expect(unzips).toEqual([]);
    expect(readBridgeManifest(home, ANTIGRAVITY_BRIDGE)).toEqual(first);
    expect(readFileSync(join(dir, 'agy-acp-server-1.2.1-linux-x86_64.zip'), 'utf8')).toBe(
      'zip-bytes-1',
    );
    expect(readFileSync(join(dir, 'agy_acp_server.par'), 'utf8')).toBe(server);
    expect(readdirSync(dir).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  test('the same archive again keeps what is installed (a running server is never overwritten)', async () => {
    const first = await installBridge({
      home,
      store,
      vendor: 'antigravity',
      provider: antigravity,
      host: LINUX,
      download: fakeDownload('zip-bytes-1'),
      unzip: fakeUnzip(),
      now: () => new Date('2026-10-01T12:00:00.000Z'),
    });
    const unzips: Array<[string, string]> = [];
    const again = await installBridge({
      home,
      store,
      vendor: 'antigravity',
      provider: antigravity,
      host: LINUX,
      download: fakeDownload('zip-bytes-1'),
      unzip: fakeUnzip(unzips),
      now: () => new Date('2026-10-02T12:00:00.000Z'),
    });
    expect(again).toEqual(first);
    expect(unzips).toEqual([]);
  });

  test('an archive without the server at its top fails, and leaves no manifest', async () => {
    const run = installBridge({
      home,
      store,
      vendor: 'antigravity',
      provider: antigravity,
      host: LINUX,
      download: fakeDownload('zip-bytes-1'),
      unzip: fakeUnzip([], 'something_else'),
    });
    await expect(run).rejects.toThrow(
      "Installing Antigravity's ACP server failed: the archive held no agy_acp_server.par at its top level.",
    );
    expect(existsSync(join(bridgeDir(home, ANTIGRAVITY_BRIDGE), BRIDGE_MANIFEST_FILE))).toBe(false);
    expect(missingBridge(providerIn(home, antigravity, LINUX), LINUX)).toBe(MISSING);
  });

  test('a failed or empty download leaves nothing behind', async () => {
    const failing = installBridge({
      home,
      store,
      vendor: 'antigravity',
      provider: antigravity,
      host: LINUX,
      download: async (_url, dest) => {
        writeFileSync(dest, 'partial');
        throw new Error('connection reset');
      },
      unzip: fakeUnzip(),
    });
    await expect(failing).rejects.toThrow(
      "Downloading Antigravity's ACP server failed: connection reset",
    );
    const empty = installBridge({
      home,
      store,
      vendor: 'antigravity',
      provider: antigravity,
      host: LINUX,
      download: fakeDownload(''),
      unzip: fakeUnzip(),
    });
    await expect(empty).rejects.toThrow('the download was empty');
    expect(readdirSync(bridgeDir(home, ANTIGRAVITY_BRIDGE))).toEqual([]);
  });

  test('a vendor with nothing to download, or a host with no build, is refused in words', async () => {
    await expect(
      installBridge({
        home,
        store,
        vendor: 'gemini',
        provider: ACP_PROVIDERS.gemini,
        download: fakeDownload('x'),
        unzip: fakeUnzip(),
      }),
    ).rejects.toBeInstanceOf(BridgeNotInstallableError);
    await expect(
      installBridge({
        home,
        store,
        vendor: 'antigravity',
        provider: antigravity,
        host: { platform: 'aix', arch: 'ppc64' },
        download: fakeDownload('x'),
        unzip: fakeUnzip(),
      }),
    ).rejects.toThrow('has no build for this computer (aix ppc64)');
  });

  test('a manifest that does not validate is refused with its path, never treated as absent', () => {
    const path = join(bridgeDir(home, ANTIGRAVITY_BRIDGE), BRIDGE_MANIFEST_FILE);
    rmSync(bridgeDir(home, ANTIGRAVITY_BRIDGE), { recursive: true, force: true });
    require('node:fs').mkdirSync(bridgeDir(home, ANTIGRAVITY_BRIDGE), { recursive: true });
    writeFileSync(path, 'vendor: antigravity\nsha256: nope\n');
    expect(() => readBridgeManifest(home, ANTIGRAVITY_BRIDGE)).toThrow(
      `corrupt bridge manifest ${path}`,
    );
  });
});

describe('the production seams, without the network or a real unzip', () => {
  test('unzip is one fixed argv, never a shell; a failure reads in words', async () => {
    const seen: Array<readonly string[]> = [];
    const ok: CommandRunner = async (argv) => {
      seen.push(argv);
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    await systemUnzip(ok)('/h/bridges/a/1/x.zip', '/h/bridges/a/1');
    expect(seen).toEqual([['unzip', '-q', '-o', '/h/bridges/a/1/x.zip', '-d', '/h/bridges/a/1']]);
    const bad: CommandRunner = async () => ({
      code: 9,
      stdout: '',
      stderr: 'End-of-central-directory signature not found.\nmore',
      timedOut: false,
    });
    await expect(systemUnzip(bad)('/a.zip', '/d')).rejects.toThrow(
      '`unzip` exited with code 9: End-of-central-directory signature not found.',
    );
    const gone: CommandRunner = async () => ({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: 'ENOENT',
    });
    await expect(systemUnzip(gone)('/a.zip', '/d')).rejects.toThrow('`unzip` could not run');
  });

  test('the downloader refuses anything but HTTPS before any request', async () => {
    await expect(httpsDownload('http://dl.google.com/x.zip', join(home, 'x'))).rejects.toThrow(
      "refusing a download that isn't HTTPS",
    );
    expect(existsSync(join(home, 'x'))).toBe(false);
  });
});

describe('BridgeInstallService', () => {
  test('the view before and after; a failure is kept in words; a second ask shares the install', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let downloads = 0;
    let changes = 0;
    const service = new BridgeInstallService({
      home,
      store,
      provider: (v) => ACP_PROVIDERS[v],
      host: LINUX,
      download: async (_url, dest) => {
        downloads++;
        await gate;
        writeFileSync(dest, 'zip-bytes-1');
      },
      unzip: fakeUnzip(),
      onChange: () => {
        changes++;
      },
    });
    expect(service.view('claude')).toBeUndefined();
    expect(service.installable('antigravity')).toBe(true);
    expect(service.installable('gemini')).toBe(false);
    expect(service.view('antigravity')).toEqual({
      version: '1.2.1',
      platform: 'linux-x86_64',
      installing: false,
    });
    expect(service.missing('antigravity')).toBe(MISSING);
    const one = service.install('antigravity');
    const two = service.install('antigravity');
    expect(two).toBe(one);
    expect(service.view('antigravity')?.installing).toBe(true);
    expect(service.busy()).toBe(true);
    release();
    const manifest = await one;
    expect(downloads).toBe(1);
    expect(changes).toBeGreaterThanOrEqual(2);
    expect(service.view('antigravity')).toEqual({
      version: '1.2.1',
      platform: 'linux-x86_64',
      manifest,
      installing: false,
    });
    expect(service.missing('antigravity')).toBeUndefined();
    expect(service.resolved('antigravity').command).toBe(
      join(bridgeDir(home, ANTIGRAVITY_BRIDGE), 'agy_acp_server.par'),
    );
    expect(() => service.start('gemini')).toThrow(BridgeNotInstallableError);
  });

  test('a refused reinstall is shown on the row and the install stays', async () => {
    let body = 'zip-bytes-1';
    const service = new BridgeInstallService({
      home,
      store,
      provider: (v) => ACP_PROVIDERS[v],
      host: LINUX,
      download: async (_url, dest) => writeFileSync(dest, body),
      unzip: fakeUnzip(),
    });
    const first = await service.install('antigravity');
    body = 'zip-bytes-2';
    service.start('antigravity');
    await service.settled();
    const view = service.view('antigravity');
    expect(view?.manifest).toEqual(first);
    expect(view?.error).toStartWith(
      "Refused: Antigravity's ACP server 1.2.1 downloaded with SHA-256",
    );
  });
});
