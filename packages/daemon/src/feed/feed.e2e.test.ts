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
import { ulid } from '@agile-agents/shared';
import { type Browser, type Page, chromium } from 'playwright-core';
import { type DaemonHandle, startDaemon } from '../daemon';
import { GateService } from '../gates';
import { runInit } from '../init';
import { StateStore } from '../store';
import {
  BROWSER_ATTEMPTS,
  BROWSER_READY_BUDGET_MS,
  acquireBrowserPage,
  resolveChromiumExecutable,
  runWithinBudget,
} from './chromium';

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

/**
 * T047: the bounded browser acquisition all three e2e suites share
 * (`acquireBrowserPage` in `./chromium`, where the measurements and the
 * ownership rules live once instead of drifting across three near-identical
 * copies). Short version: a `chromium.launch()` in a whole-suite `bun test`
 * can simply never return, `launch()`'s own timeout does not fire, and a
 * launch that *does* return can hand back an already wedged browser — so
 * launch and first page go under one budget, and only a browser that has
 * actually produced a page is ever cached.
 */
/**
 * Every page in this file: one place to install the action/navigation
 * timeout above. Unlike its two sibling suites this file keeps a browser per
 * test rather than sharing one, so each call launches its own and the caller
 * closes it in `teardown`.
 */
async function openPage(): Promise<{ browser: Browser; page: Page }> {
  const acquired = await acquireBrowserPage({
    label: 'feed e2e',
    launch: () => chromium.launch({ executablePath }),
    openPage: (browser) => browser.newPage(),
  });
  acquired.page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  acquired.page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
  return acquired;
}

/**
 * T047 review round 1: how long a body may take before it is treated as
 * wedged rather than slow, and the per-test budget that has to hold two of
 * them. `BODY_BUDGET_MS` sits above the worst *legitimate* body — a full
 * `BROWSER_ATTEMPTS` acquisition sweep plus one page action running out its
 * `PAGE_TIMEOUT_MS` — so a genuinely failing body always surfaces its own
 * error first and only a body making no progress at all is retried.
 * See `browserTest` for what is being defended against.
 */
const BODY_BUDGET_MS = PAGE_TIMEOUT_MS + BROWSER_READY_BUDGET_MS * BROWSER_ATTEMPTS + 5_000;

/** Every test in this file: room for a wedged body, its retry, and slack. */
const TEST_BUDGET_MS = BODY_BUDGET_MS * 2 + 5_000;

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

/**
 * A browser-driven test that survives its browser going quiet underneath it.
 *
 * Two failure modes, one recovery. The browser can be *killed* from outside
 * this file (bun's dangling-process cleanup — the `isBrowserGoneError` case
 * above, which fails fast and loudly), or it can stay alive and simply stop
 * answering. T047 review round 1 measured the second one directly: a watchdog
 * inside the body logged `isConnected() === true` on every 5 s tick for the
 * whole 60 s the test was stuck, and the body was still running a minute
 * after bun had failed the test and moved on — bun's per-test timeout cancels
 * nothing. So a wedge is invisible to `isConnected()`, invisible to
 * `isBrowserGoneError`, and invisible to `PAGE_TIMEOUT_MS` (the calls that
 * hang are often ones that take no timeout at all: `waitForTimeout`,
 * `locator.count()`, `evaluate`). Bounding the body is the only bound test
 * code has. Which suite gets hit moves between runs, so this is not one bad
 * wait in one test to rewrite.
 *
 * Re-running a body from the top is safe by this file's own design: every
 * body makes its own repo, daemon and page and cleans all three up in its own
 * `finally`. An abandoned body keeps running — nothing can cancel it — but it
 * only ever touches its own temp repo and then tidies itself away.
 */
function browserTest(name: string, body: () => Promise<void>, timeoutMs: number): void {
  test(
    name,
    async () => {
      const retry = async (reason: string): Promise<void> => {
        console.error(
          `feed e2e: "${name}" ${reason} — replacing the browser and running it once more`,
        );
        // Each body launches and closes its own browser.
        const second = await runWithinBudget(body, BODY_BUDGET_MS);
        if (!second.done) {
          throw new Error(
            `feed e2e: "${name}" made no progress for ${BODY_BUDGET_MS}ms twice over, on two different browsers — the page is wedged, not slow`,
          );
        }
      };

      try {
        const first = await runWithinBudget(body, BODY_BUDGET_MS);
        if (first.done) return;
        await retry(
          `made no progress for ${BODY_BUDGET_MS}ms on a browser still reporting connected`,
        );
      } catch (err) {
        if (!isBrowserGoneError(err)) throw err;
        await retry(
          `lost its browser mid-test (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
        );
      }
    },
    timeoutMs,
  );
}

/** Per-test teardown: this test's page context first (so its `/ws` client is not left reconnecting against a dead port), then the browser, bounded. */
async function teardown(
  browser: Browser | undefined,
  pages: Array<Page | undefined>,
): Promise<void> {
  await Promise.allSettled(
    pages.filter((p): p is Page => p !== undefined).map((p) => p.context().close()),
  );
  // T047: `openPage` can fail before a browser exists at all.
  if (!browser) return;
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

/**
 * T111: the daemon's state lives in `$AGILE_HOME`, never inside the repo.
 * Each test gets a fresh temp home and points `AGILE_HOME` at it so the
 * daemon it starts (via `discoverConfig`) opens the same home this test
 * seeded.
 */
function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'agile-e2e-home-'));
  process.env.AGILE_HOME = home;
  return home;
}
