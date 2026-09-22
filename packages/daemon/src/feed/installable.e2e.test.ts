/**
 * Playwright e2e for T165 step 1 (PLAN D15): the cockpit installs as its own
 * browser app. Asserts the manifest is served with its type and is valid,
 * the icons it names load as PNGs, the service worker registers and
 * controls `/`, Chromium reports no installability errors
 * (`Page.getInstallabilityErrors` over CDP), and the page opens on the inbox.
 * Same Chromium discovery as the sibling suites (fails loudly without one).
 */

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium } from 'playwright-core';
import { GateService } from '../gates';
import { type HttpServerHandle, startHttpServer } from '../http';
import { InboxService } from '../inbox';
import { runInit } from '../init';
import { QuestionService } from '../questions';
import { RulesService } from '../rules';
import { StateStore } from '../store';
import { StreamService } from '../streams';
import { resolveChromiumExecutable } from './chromium';

const executablePath = resolveChromiumExecutable();
let persistent: { context: BrowserContext; dir: string } | undefined;

afterAll(async () => {
  const p = persistent;
  persistent = undefined;
  if (!p) return;
  await Promise.race([p.context.close(), Bun.sleep(3_000)]);
  rmSync(p.dir, { recursive: true, force: true });
});

function startCockpit(): { http: HttpServerHandle; base: string; stop(): Promise<void> } {
  const home = mkdtempSync(join(tmpdir(), 'agile-installable-e2e-'));
  const init = runInit(home);
  const store = StateStore.open(init.stateRoot);
  const streams = new StreamService(store);
  const questions = new QuestionService(store, streams, { deliver: async () => {} });
  const gates = new GateService(store);
  const rules = new RulesService({ store, streams });
  const inbox = new InboxService({ streams, questions, gates, rules });
  const http = startHttpServer({
    port: 0,
    version: 'test',
    stateRoot: init.stateRoot,
    startedAt: Date.now(),
    store,
    gates,
    streams,
    questions,
    inbox,
    rules,
    feedPollIntervalMs: 50,
  });
  return {
    http,
    base: `http://127.0.0.1:${http.port}`,
    async stop() {
      await http.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('the daemon serves the manifest, icons and service worker with their types', async () => {
  const cockpit = startCockpit();
  try {
    const res = await fetch(`${cockpit.base}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/manifest+json');
    const manifest = (await res.json()) as {
      name: string;
      short_name: string;
      start_url: string;
      display: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
    };
    expect(manifest.name).toBe('Agile Cockpit');
    expect(manifest.short_name).toBe('agile');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    const sizes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(['192x192:any', '512x512:any', '512x512:maskable']);
    for (const icon of manifest.icons) {
      const img = await fetch(`${cockpit.base}${icon.src}`);
      expect(img.status).toBe(200);
      expect(img.headers.get('content-type')).toBe('image/png');
      const bytes = new Uint8Array(await img.arrayBuffer());
      expect([...bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
      const view = new DataView(bytes.buffer);
      const side = Number(icon.sizes.split('x')[0]);
      expect([view.getUint32(16), view.getUint32(20)]).toEqual([side, side]);
    }
    const sw = await fetch(`${cockpit.base}/sw.js`);
    expect(sw.status).toBe(200);
    expect(sw.headers.get('content-type')).toStartWith('text/javascript');
    // Vite rewrites index.html's links onto the /control-room/ prefix; that copy is typed too.
    const html = await (await fetch(`${cockpit.base}/`)).text();
    const href = html.match(/<link rel="manifest" href="([^"]+)"/)?.[1];
    expect(href).toBeDefined();
    const linked = await fetch(`${cockpit.base}${href}`);
    expect(linked.headers.get('content-type')).toBe('application/manifest+json');
  } finally {
    await cockpit.stop();
  }
});

test('Chromium reports the cockpit installable, the service worker controls it, and it opens on the inbox', async () => {
  const cockpit = startCockpit();
  // A persistent profile, not the default incognito-like context:
  // Chromium never offers install from incognito ("in-incognito").
  const dir = mkdtempSync(join(tmpdir(), 'agile-installable-profile-'));
  const context = await chromium.launchPersistentContext(dir, { executablePath });
  persistent = { context, dir };
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.goto(`${cockpit.base}/`);
    await page.locator('[data-testid="inbox-empty"]').waitFor({ state: 'visible' });

    // String expressions: the daemon's tsconfig has no DOM lib.
    const scope = await page.evaluate<string>('navigator.serviceWorker.ready.then((r) => r.scope)');
    expect(scope).toBe(`${cockpit.base}/`);
    // Pass-through: a reload is controlled by the worker and still live.
    await page.reload();
    expect(await page.evaluate<boolean>('navigator.serviceWorker.controller !== null')).toBe(true);
    await page.locator('[data-testid="inbox-empty"]').waitFor({ state: 'visible' });

    const cdp = await context.newCDPSession(page);
    const manifest = (await cdp.send('Page.getAppManifest')) as {
      url: string;
      errors: Array<{ message: string; critical: number }>;
    };
    expect(manifest.url).toContain('manifest.webmanifest');
    expect(manifest.errors).toEqual([]);
    const installability = (await cdp.send('Page.getInstallabilityErrors')) as {
      installabilityErrors: Array<{ errorId: string }>;
    };
    expect(installability.installabilityErrors).toEqual([]);
  } finally {
    await cockpit.stop();
  }
}, 60_000);
