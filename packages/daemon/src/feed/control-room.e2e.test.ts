/**
 * Playwright e2e for the control room SPA (T025 — design
 * agile-agents-design.md §17 "Control room"; ticket Validation Steps:
 * "Playwright against a seeded daemon"). Same Chromium-discovery pattern as
 * `feed.e2e.test.ts` (auto-skipped when no Chromium executable can be
 * found) and the same `startDaemon` harness — this covers the render + the
 * read/write paths that go through `startDaemon`'s real wiring (everything
 * except `bus.send`: `daemon.ts` does not yet pass a `Bus` into
 * `startHttpServer`, so the chat/propose-edit routes 503 by design here —
 * see `.pipeline-report.md`).
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { type DaemonHandle, startDaemon } from '../daemon';
import { GateService } from '../gates';
import { runInit } from '../init';
import { StateStore } from '../store';

function findChromiumExecutable(): string | undefined {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (override && existsSync(override)) return override;

  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(browsersPath)) return undefined;

  const candidates = readdirSync(browsersPath).filter((name) => name.startsWith('chromium-'));
  for (const dir of candidates) {
    const candidate = join(browsersPath, dir, 'chrome-linux', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const executablePath = findChromiumExecutable();
const maybeDescribe = executablePath ? describe : describe.skip;

if (!executablePath) {
  console.warn('control-room.e2e.test: no Chromium executable found — skipping Playwright e2e.');
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'agile-control-room-e2e-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '--allow-empty', '-m', 'initial commit'], { cwd: repo });
  return repo;
}

maybeDescribe('control room SPA (Playwright e2e)', () => {
  test('renders Needs You from a seeded hil_request, approves it for real, and reflects a live halt', async () => {
    const repo = initRepo();
    let handle: DaemonHandle | undefined;
    const browser = await chromium.launch({ executablePath });

    try {
      const init = runInit(repo);
      const store = StateStore.open(init.stateRoot);
      const gates = new GateService(store);

      // Seed one open HIL request and one ticket before the daemon (and the
      // page) ever start, so the page's initial reads already carry them.
      const seeded = await gates.request('unblock', {
        policy: { gates: { unblock: 'human' }, breaker_signals: [] },
        hilKind: 'unblock',
      });
      await store.putTicket({
        id: 'TKT-9101',
        title: 'Control room e2e fixture ticket',
        status: 'ready',
        contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
        depends: [],
        oracle_refs: [],
        kb_refs: [],
        history: [],
        security: false,
      });

      handle = await startDaemon({
        cwd: repo,
        port: 0,
        socketPath: join(repo, '.agile-daemon.sock'),
      });

      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${handle.http.port}/control-room`);

      // "Needs you" inbox renders the seeded hil_request (§17 "Attention
      // queue": one line per item, deadline, approve/delegate).
      const hilItem = page.locator(`.hil-item[data-id="${seeded.id}"]`);
      await hilItem.waitFor({ state: 'attached', timeout: 5000 });
      expect(await hilItem.textContent()).toContain('unblock');

      // Board renders the seeded ticket from GET /api/tickets (a T025 read
      // endpoint that did not exist before this ticket).
      const ticketCard = page.locator('[data-testid="ticket-card-TKT-9101"]');
      await ticketCard.waitFor({ state: 'attached', timeout: 5000 });

      // Detail-on-click: approve resolves the real hil_request the daemon's
      // GateService owns (never a client-side-only state change).
      await hilItem.click();
      await page.locator('[data-testid="hil-approve"]').click();
      await hilItem.waitFor({ state: 'detached', timeout: 5000 });

      const onDisk = store.getEntity(
        `board/hil/${seeded.id}.yaml`,
        (v) => v as { status: string; decision: string; decided_by: string },
      );
      expect(onDisk.status).toBe('resolved');
      expect(onDisk.decision).toBe('approve');
      expect(onDisk.decided_by).toBe('human');

      // The Halt button (§17 "a Halt button that writes a global halt file
      // ... no explanation needed") creates a real halt via createHalt —
      // reflected back through the live /ws snapshot into the sprint strip.
      await page.locator('[data-testid="halt-btn"]').click();
      const haltCount = page.locator('[data-testid="halt-count"]');
      const deadline = Date.now() + 5000;
      let text = await haltCount.textContent();
      while (text !== '1' && Date.now() < deadline) {
        await page.waitForTimeout(100);
        text = await haltCount.textContent();
      }
      expect(text).toBe('1');
      expect(store.listHalts()).toHaveLength(1);
      expect(store.listHalts()[0]?.raised_by).toBe('human');
    } finally {
      await browser.close();
      await handle?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);

  test('chat panel 503s gracefully — daemon.ts does not wire a Bus into startHttpServer yet (documented gap)', async () => {
    const repo = initRepo();
    let handle: DaemonHandle | undefined;
    const browser = await chromium.launch({ executablePath });

    try {
      runInit(repo);
      handle = await startDaemon({
        cwd: repo,
        port: 0,
        socketPath: join(repo, '.agile-daemon.sock'),
      });

      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${handle.http.port}/control-room`);

      const textarea = page.locator('.cr-chat-input textarea');
      await textarea.waitFor({ state: 'attached', timeout: 5000 });
      await textarea.fill('steer: reroute this ticket');
      await page.locator('.cr-chat-input button').click();

      // The panel surfaces the 503 as an inline error rather than pretending
      // the message was delivered.
      const error = page.locator('.cr-chat-log', { hasText: 'bus not wired' });
      await error.waitFor({ state: 'attached', timeout: 5000 });
    } finally {
      await browser.close();
      await handle?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);
});
