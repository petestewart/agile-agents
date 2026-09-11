/**
 * Playwright e2e for the feed page (T020 Validation Steps: "Playwright test
 * against a running daemon with synthetic events"; acceptance: "Page shows
 * live events within 1 s; approve button resolves a real `hil_request`").
 *
 * Runs under plain `bun test`. The Chromium binary is discovered by
 * `resolveChromiumExecutable` (`./chromium`), which throws when there is
 * none — this file fails loudly rather than skipping, because a skipped SPA
 * suite reported as green is a false green. A root `test:e2e` script runs
 * just this file.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { type DaemonHandle, startDaemon } from '../daemon';
import { GateService } from '../gates';
import { runInit } from '../init';
import { StateStore } from '../store';
import { resolveChromiumExecutable } from './chromium';

const executablePath = resolveChromiumExecutable();

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'agile-feed-e2e-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '--allow-empty', '-m', 'initial commit'], { cwd: repo });
  return repo;
}

describe('feed page (Playwright e2e)', () => {
  test('shows a live event within 1s and Approve resolves a real hil_request on disk', async () => {
    const repo = initRepo();
    let handle: DaemonHandle | undefined;
    const browser = await chromium.launch({ executablePath });

    try {
      const init = runInit(repo);
      const store = StateStore.open(init.stateRoot);
      const gates = new GateService(store);

      // Seed one open HIL request before the daemon (and the page) ever
      // starts, so the page's initial snapshot already carries it.
      const seeded = await gates.request('unblock', {
        policy: { gates: { unblock: 'human' }, breaker_signals: [] },
        hilKind: 'unblock',
      });
      expect(seeded.status).toBe('pending');

      handle = await startDaemon({
        cwd: repo,
        port: 0,
        socketPath: join(repo, '.agile-daemon.sock'),
      });

      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${handle.http.port}/feed`);

      // The seeded HIL request renders from the initial snapshot.
      const hilItem = page.locator(`.hil-item[data-id="${seeded.id}"]`);
      await hilItem.waitFor({ state: 'attached', timeout: 5000 });
      expect(await hilItem.textContent()).toContain('unblock');

      // A synthetic event, appended after the page is live, must show up
      // in the feed within 1s (T020 acceptance criterion).
      const ticketId = 'TKT-9001';
      const start = Date.now();
      await store.putTicket({
        id: ticketId,
        title: 'Synthetic e2e event',
        status: 'draft',
        contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
        depends: [],
        oracle_refs: [],
        kb_refs: [],
        history: [],
        security: false,
      });

      const eventRow = page.locator('#events-body tr', { hasText: ticketId });
      await eventRow.waitFor({ state: 'attached', timeout: 1000 });
      const latencyMs = Date.now() - start;
      expect(latencyMs).toBeLessThan(1000);
      // Recorded for the pipeline report.
      console.log(`feed.e2e: live event latency ${latencyMs}ms`);
      expect(await eventRow.textContent()).toContain('ticket_put');

      // Approve resolves the real hil_request the daemon's GateService owns.
      await hilItem.locator('button.approve').click();
      await hilItem.waitFor({ state: 'detached', timeout: 5000 });

      const onDisk = store.getEntity(
        `board/hil/${seeded.id}.yaml`,
        (v) => v as { status: string; decision: string; decided_by: string },
      );
      expect(onDisk.status).toBe('resolved');
      expect(onDisk.decision).toBe('approve');
      expect(onDisk.decided_by).toBe('human');
    } finally {
      await browser.close();
      await handle?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);

  test('a slow /api/snapshot HTTP fallback does not clobber a live event received first (review nit)', async () => {
    const repo = initRepo();
    let handle: DaemonHandle | undefined;
    const browser = await chromium.launch({ executablePath });

    try {
      const init = runInit(repo);
      const store = StateStore.open(init.stateRoot);

      handle = await startDaemon({
        cwd: repo,
        port: 0,
        socketPath: join(repo, '.agile-daemon.sock'),
      });

      const page = await browser.newPage();
      // Delay the page's own /api/snapshot fetch well past when the WS
      // snapshot + a live event will have already arrived, reproducing
      // the race the review nit named: without the `liveDataApplied`
      // guard, this stale fetch resolving late would overwrite the
      // WS-sourced state and drop the live event from the DOM.
      await page.route('**/api/snapshot', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
      });

      await page.goto(`http://127.0.0.1:${handle.http.port}/feed`);

      const ticketId = 'TKT-9002';
      await store.putTicket({
        id: ticketId,
        title: 'Race guard e2e event',
        status: 'draft',
        contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
        depends: [],
        oracle_refs: [],
        kb_refs: [],
        history: [],
        security: false,
      });

      const eventRow = page.locator('#events-body tr', { hasText: ticketId });
      // Arrives over the WS well within 1s, long before the delayed HTTP
      // fallback below resolves.
      await eventRow.waitFor({ state: 'attached', timeout: 1000 });

      // Give the delayed /api/snapshot fetch time to resolve and (pre-fix)
      // clobber the row.
      await page.waitForTimeout(2000);
      expect(await eventRow.count()).toBeGreaterThan(0);
    } finally {
      await browser.close();
      await handle?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);
});
