/**
 * Playwright e2e for the control room SPA (T025 — design
 * agile-agents-design.md §17 "Control room"; ticket Validation Steps:
 * "Playwright against a seeded daemon"). Same Chromium-discovery pattern as
 * `feed.e2e.test.ts` (auto-skipped when no Chromium executable can be
 * found) and the same `startDaemon` harness — this covers the render + the
 * read/write paths through `startDaemon`'s real wiring, `bus.send` included
 * (T025 review round 1 blocker 3: `daemon.ts` now passes its `Bus` into
 * `startHttpServer`, so chat/propose-edit are exercised for real here, not
 * pinned at their old 503).
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { Bus } from '../bus';
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

  test('chat panel send lands a real fyi message on the em inbox and logs a message event', async () => {
    const repo = initRepo();
    let handle: DaemonHandle | undefined;
    const browser = await chromium.launch({ executablePath });

    try {
      const init = runInit(repo);
      const store = StateStore.open(init.stateRoot);
      const bus = new Bus(store, init.stateRoot);

      handle = await startDaemon({
        cwd: repo,
        port: 0,
        socketPath: join(repo, '.agile-daemon.sock'),
      });

      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${handle.http.port}/control-room`);

      const textarea = page.locator('.cr-chat-input textarea');
      await textarea.waitFor({ state: 'attached', timeout: 5000 });
      await textarea.fill('steer: reroute this ticket off openai');
      await page.locator('.cr-chat-input button').click();

      // No inline error — the message actually went through.
      const error = page.locator('.cr-chat-log', { hasText: 'bus not wired' });
      expect(await error.count()).toBe(0);

      // Real behaviour, not a UI-only optimistic append: the message is on
      // the em inbox on disk, sent as `human`, and a `message` event was
      // logged (ticket AC: "every write ... appears in the event log").
      const deadline = Date.now() + 5000;
      let inbox = bus.poll('em');
      while (
        !inbox.some((m) => m.body.includes('reroute this ticket off openai')) &&
        Date.now() < deadline
      ) {
        await page.waitForTimeout(100);
        inbox = bus.poll('em');
      }
      const delivered = inbox.find((m) => m.body.includes('reroute this ticket off openai'));
      expect(delivered?.from).toBe('human');
      expect(store.listEvents().some((e) => e.kind === 'message' && e.data.kind === 'fyi')).toBe(
        true,
      );
    } finally {
      await browser.close();
      await handle?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);

  test('propose-edit sends a real decision request to the architect, never writes the oracle directly', async () => {
    const repo = initRepo();
    let handle: DaemonHandle | undefined;
    const browser = await chromium.launch({ executablePath });

    try {
      const init = runInit(repo);
      const store = StateStore.open(init.stateRoot);
      const bus = new Bus(store, init.stateRoot);
      await store.putOracleEntry(
        {
          id: 'DEC-0001',
          title: 'Fixture decision',
          status: 'active',
          supersedes: [],
          depends: [],
          affects: [],
          decided: '2026-09-08',
          by: 'architect',
          rationale: 'fixture',
        },
        'Full decision body.',
      );

      handle = await startDaemon({
        cwd: repo,
        port: 0,
        socketPath: join(repo, '.agile-daemon.sock'),
      });

      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${handle.http.port}/control-room`);

      // The Oracle/KB list only renders once that tab is selected (Ops is
      // the default view, §17 "Layout direction").
      await page.getByRole('button', { name: 'Oracle / KB' }).click();
      await page.locator('[data-testid="oracle-item-DEC-0001"]').waitFor({
        state: 'attached',
        timeout: 5000,
      });
      await page.locator('[data-testid="oracle-item-DEC-0001"]').click();
      await page.locator('#propose-edit').fill('Widen the grace window to 60s.');
      await page.locator('[data-testid="propose-edit-submit"]').click();

      const deadline = Date.now() + 5000;
      let inbox = bus.poll('architect');
      while (!inbox.some((m) => m.body.includes('60s')) && Date.now() < deadline) {
        await page.waitForTimeout(100);
        inbox = bus.poll('architect');
      }
      const delivered = inbox.find((m) => m.body.includes('60s'));
      expect(delivered?.from).toBe('human');
      expect(delivered?.kind).toBe('decision');
      // Never a direct write — the oracle entry itself is untouched.
      expect(store.getOracleEntry('DEC-0001' as never).entry.title).toBe('Fixture decision');
    } finally {
      await browser.close();
      await handle?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);

  // T025 review round 1 blocker 4: dark mode fell back to UA
  // ButtonFace/ButtonText on every clickable surface.
  test('dark mode: panel headers, board cards, and inbox rows never fall back to a UA default colour', async () => {
    const repo = initRepo();
    let handle: DaemonHandle | undefined;
    const browser = await chromium.launch({ executablePath });

    try {
      const init = runInit(repo);
      const store = StateStore.open(init.stateRoot);
      const gates = new GateService(store);
      const seeded = await gates.request('unblock', {
        policy: { gates: { unblock: 'human' }, breaker_signals: [] },
        hilKind: 'unblock',
      });
      await store.putTicket({
        id: 'TKT-9102',
        title: 'Dark mode fixture ticket',
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

      const page = await browser.newPage({ colorScheme: 'dark' });
      await page.goto(`http://127.0.0.1:${handle.http.port}/control-room`);

      // `page.evaluate`'s callback runs in the browser, where `document`/
      // `getComputedStyle` exist — this file's own (non-DOM) tsconfig lib
      // does not know that, hence the loose `any` cast rather than a `dom`
      // lib change to a package that has no other browser-context code.
      const colorScheme = await page.evaluate(() => {
        // biome-ignore lint/suspicious/noExplicitAny: browser-context globals, see comment above
        const win = globalThis as any;
        return win.getComputedStyle(win.document.documentElement).colorScheme as string;
      });
      expect(colorScheme).toContain('dark');

      const hilItem = page.locator(`.hil-item[data-id="${seeded.id}"]`);
      await hilItem.waitFor({ state: 'attached', timeout: 5000 });
      // Board is open by default (`Panel defaultOpen`, §17) — the card and
      // its column header are already in the DOM.
      const boardCard = page.locator('[data-testid="ticket-card-TKT-9102"]');
      await boardCard.waitFor({ state: 'attached', timeout: 5000 });
      const boardHeader = page.getByRole('button', { name: /^Board/ });

      const UA_LIGHT_BG = 'rgb(239, 239, 239)';
      const UA_LIGHT_TEXT = 'rgb(0, 0, 0)';

      for (const locator of [boardHeader, hilItem, boardCard]) {
        const { bg, color } = await locator.evaluate((el) => {
          // biome-ignore lint/suspicious/noExplicitAny: browser-context globals, see comment above
          const cs = (globalThis as any).getComputedStyle(el);
          return { bg: cs.backgroundColor as string, color: cs.color as string };
        });
        expect(bg).not.toBe(UA_LIGHT_BG);
        expect(color).not.toBe(UA_LIGHT_TEXT);
      }
    } finally {
      await browser.close();
      await handle?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);

  // QA round 1 (REJECT): an external change (a ticket transitioned through
  // the store directly, not via this browser's own write) must reach the
  // Board without a manual reload.
  test('an external ticket transition through the store moves the Board card without a page reload', async () => {
    const repo = initRepo();
    let handle: DaemonHandle | undefined;
    const browser = await chromium.launch({ executablePath });

    try {
      const init = runInit(repo);
      const store = StateStore.open(init.stateRoot);
      await store.putTicket({
        id: 'TKT-9103',
        title: 'Live-refresh fixture ticket',
        status: 'draft',
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

      // Board is open by default (Panel `defaultOpen`).
      const card = page.locator('[data-testid="ticket-card-TKT-9103"]');
      await card.waitFor({ state: 'attached', timeout: 5000 });
      const initialColumn = await card.evaluate(
        (el) => el.parentElement?.firstElementChild?.textContent ?? '',
      );
      expect(initialColumn).toContain('DRAFT');

      // External change: no fetch/reload call from this test — the daemon's
      // own store is mutated directly, the way another agent's process
      // would, and the page must pick it up over its already-open /ws.
      await store.transitionTicket('TKT-9103', 'ready', { by: 'test' });

      const deadline = Date.now() + 5000;
      let column = initialColumn;
      while (column.includes('DRAFT') && Date.now() < deadline) {
        await page.waitForTimeout(100);
        column = await card.evaluate(
          (el) => el.parentElement?.firstElementChild?.textContent ?? '',
        );
      }
      expect(column).toContain('READY');
    } finally {
      await browser.close();
      await handle?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);
});
