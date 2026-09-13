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
import { type Browser, type Page, chromium } from 'playwright-core';
import { type DaemonHandle, startDaemon } from '../daemon';
import { GateService } from '../gates';
import { runInit } from '../init';
import { StateStore } from '../store';
import { resolveChromiumExecutable } from './chromium';

const executablePath = resolveChromiumExecutable();

/**
 * QA round 1 (T043): the same three teardown/timeout guards
 * `control-room.e2e.test.ts` carries, for the same measured reason — this
 * file is scheduled alongside it by the tickets' own validation step
 * (`bun test packages/daemon/src/feed`), and under that contention an
 * unbounded `browser.close()` on a page still reconnecting to a stopped
 * daemon is what wedges the run. `playwright-core` used without the
 * Playwright test runner defaults every action timeout to 0 (wait forever),
 * so `openPage` installs a real one.
 */
const PAGE_TIMEOUT_MS = 20_000;

/** Every page in this file: one place to install the action/navigation timeout above. */
async function openPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
  return page;
}

/** Matching `control-room.e2e.test.ts`: a browser close that has not returned in this budget is left to bun's dangling-process cleanup. Teardown only — every assertion has passed by then. */
const BROWSER_CLOSE_BUDGET_MS = 10_000;

/**
 * Same browser-loss retry as `control-room.e2e.test.ts` (see the long note on
 * its `browserTest`): under `bun test packages/daemon/src/feed` this file's
 * Chromium can be killed from outside it by bun's own dangling-process
 * cleanup, and the test running at that moment fails in under a second with
 * `Target page, context or browser has been closed`. Each body makes its own
 * repo, daemon, browser and page and cleans them up in its own `finally`, so
 * re-running one from the top is safe.
 */
function isBrowserGoneError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Target (page, context or browser|closed)|browser has been closed|has been closed/i.test(
    message,
  );
}

function browserTest(name: string, body: () => Promise<void>, timeoutMs: number): void {
  test(
    name,
    async () => {
      try {
        await body();
      } catch (err) {
        if (!isBrowserGoneError(err)) throw err;
        console.error(
          `feed e2e: "${name}" lost its browser mid-test — retrying once from a clean repo/daemon/browser`,
        );
        await body();
      }
    },
    timeoutMs,
  );
}

/** Per-test teardown: this test's page context first (so its `/ws` client is not left reconnecting against a dead port), then the browser, bounded. */
async function teardown(browser: Browser, pages: Array<Page | undefined>): Promise<void> {
  await Promise.allSettled(
    pages.filter((p): p is Page => p !== undefined).map((p) => p.context().close()),
  );
  const closed = await Promise.race([
    browser.close().then(() => true),
    Bun.sleep(BROWSER_CLOSE_BUDGET_MS).then(() => false),
  ]);
  if (!closed) {
    console.error(
      `feed e2e: browser.close() did not return within ${BROWSER_CLOSE_BUDGET_MS}ms — left to bun's dangling-process cleanup (teardown only; every assertion passed)`,
    );
  }
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'agile-feed-e2e-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '--allow-empty', '-m', 'initial commit'], { cwd: repo });
  return repo;
}

describe('feed page (Playwright e2e)', () => {
  browserTest(
    'shows a live event within 1s and Approve resolves a real hil_request on disk',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;
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

        page = await openPage(browser);
        await page.goto(`http://127.0.0.1:${handle.http.port}/feed`);

        // The seeded HIL request renders from the initial snapshot.
        const hilItem = page.locator(`.hil-item[data-id="${seeded.id}"]`);
        await hilItem.waitFor({ state: 'attached', timeout: PAGE_TIMEOUT_MS });
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
        await hilItem.waitFor({ state: 'detached', timeout: PAGE_TIMEOUT_MS });

        const onDisk = store.getEntity(
          `board/hil/${seeded.id}.yaml`,
          (v) => v as { status: string; decision: string; decided_by: string },
        );
        expect(onDisk.status).toBe('resolved');
        expect(onDisk.decision).toBe('approve');
        expect(onDisk.decided_by).toBe('human');
      } finally {
        await teardown(browser, [page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    30000,
  );

  browserTest(
    'a slow /api/snapshot HTTP fallback does not clobber a live event received first (review nit)',
    async () => {
      const repo = initRepo();
      let handle: DaemonHandle | undefined;
      let page: Page | undefined;
      const browser = await chromium.launch({ executablePath });

      try {
        const init = runInit(repo);
        const store = StateStore.open(init.stateRoot);

        handle = await startDaemon({
          cwd: repo,
          port: 0,
          socketPath: join(repo, '.agile-daemon.sock'),
        });

        page = await openPage(browser);
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
        await teardown(browser, [page]);
        await handle?.stop();
        rmSync(repo, { recursive: true, force: true });
      }
    },
    30000,
  );
});
