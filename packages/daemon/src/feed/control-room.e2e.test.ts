/**
 * Playwright e2e for the control room SPA (T025 — design
 * agile-agents-design.md §17 "Control room"; ticket Validation Steps:
 * "Playwright against a seeded daemon"). Same Chromium discovery as
 * `feed.e2e.test.ts` (`resolveChromiumExecutable`, which throws rather than
 * skipping when no browser is installed) and the same `startDaemon` harness — this covers the render + the
 * read/write paths through `startDaemon`'s real wiring, `bus.send` included
 * (T025 review round 1 blocker 3: `daemon.ts` now passes its `Bus` into
 * `startHttpServer`, so chat/propose-edit are exercised for real here, not
 * pinned at their old 503).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type SpawnSessionOptions,
  type SpawnedSession,
  spawnSession,
} from '@agile-agents/acp-client';
import { type Browser, type Page, chromium } from 'playwright-core';
import { Bus } from '../bus';
import { type DaemonHandle, startDaemon } from '../daemon';
import { GateService } from '../gates';
import { runInit } from '../init';
import { QuestionService } from '../questions';
import { StateStore } from '../store';
import { resolveChromiumExecutable } from './chromium';

const executablePath = resolveChromiumExecutable();

const FAKE_AGENT_PATH = join(import.meta.dir, '..', 'runner', 'fake-agent.ts');

/**
 * T041: the offline stand-in for the resident EM's vendor — the same
 * `fake-agent.ts` subprocess `runner/fake-driver.ts`'s `createFakeSpawn`
 * uses, scripted to answer any prompt with one canned reply. No vendor
 * login, no `AGILE_LIVE`.
 */
function cannedEmSpawn(repo: string, reply: string): (opts: SpawnSessionOptions) => SpawnedSession {
  const scriptPath = join(repo, 'em-chat-script.json');
  writeFileSync(
    scriptPath,
    JSON.stringify({ steps: [{ type: 'agent_text', text: reply }, { type: 'end_turn' }] }),
  );
  return (opts: SpawnSessionOptions) =>
    spawnSession({
      ...opts,
      cmd: 'bun',
      args: [FAKE_AGENT_PATH],
      envOverrides: { ...opts.envOverrides, AGILE_FAKE_AGENT_SCRIPT: scriptPath },
    });
}

/**
 * Teardown budget for `browser.close()` — see `closeBrowserBounded`.
 * Measured: a close that works at all returns in 40-90 ms, here and in the
 * probe scripts; 10 s is two orders of magnitude of headroom for a loaded
 * machine.
 */
const BROWSER_CLOSE_BUDGET_MS = 10_000;

/**
 * QA round 1 deflake. `bun test packages/daemon/src/em packages/daemon/src/feed`
 * failed ~50% of runs (and 100% once the chat test was restructured), always
 * at the bun-test budget, never in isolation. Instrumenting every step of the
 * chat test under exactly that command located it precisely: every assertion
 * completes in well under a second (daemon up ~40 ms, both turns answered and
 * rendered by ~600 ms, pop-out route ~700 ms), the daemon stays responsive
 * throughout (`GET /api/chat/em` answers in 1 ms after the wedge), every page
 * closes in ~35 ms — and then `browser.close()` never returns. Bisecting the
 * `em` directory implicates `delegate`/`loop`/`assign` (git-subprocess-heavy
 * store tests), not the subprocess-spawning ones, and standalone probes
 * (30 spawned children, 50 `spawnSync` calls, a long-lived child spawned
 * before or after the launch) never reproduce it: this is the test process
 * failing to observe the Chromium child's exit, i.e. bun's harness, not
 * anything T041 ships and not a wait a bigger budget would fix.
 *
 * So teardown is bounded instead of unbounded: the assertions have all
 * passed by this point, and a `close()` that has not returned in
 * `BROWSER_CLOSE_BUDGET_MS` is left to bun's own end-of-run dangling-process
 * cleanup (it reports "killed N dangling process"), with a line on stderr so
 * it is never silent. Only this test needs it — the file's other tests each
 * launch and close their own browser without the `em` directory's load
 * behind them.
 */
async function closeBrowserBounded(browser: Browser | undefined): Promise<void> {
  if (!browser) return;
  const closed = await Promise.race([
    browser.close().then(() => true),
    Bun.sleep(BROWSER_CLOSE_BUDGET_MS).then(() => false),
  ]);
  if (!closed) {
    console.error(
      `control-room e2e: browser.close() did not return within ${BROWSER_CLOSE_BUDGET_MS}ms — leaving the process to bun's dangling-process cleanup (teardown only; every assertion passed)`,
    );
  }
}

/** Polls `GET /api/chat/em` until the thread has at least `count` entries (each EM turn appends one). Deadline-bounded so a stuck turn fails with a readable message rather than the bun-test budget. */
async function waitForThread(base: string, count: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const thread = (await (await fetch(`${base}/api/chat/em`)).json()) as unknown[];
    if (thread.length >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`chat thread never reached ${count} entries (last saw ${thread.length})`);
    }
    await Bun.sleep(50);
  }
}

/** Polls the rendered chat log for a line containing `text` (this package's tsconfig has no DOM lib, so `page.waitForFunction` is not available here). */
async function waitForChatText(page: Page, text: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await page.locator('.cr-chat-msg', { hasText: text }).count()) > 0) return;
    if (Date.now() > deadline) throw new Error(`chat log never showed ${JSON.stringify(text)}`);
    await page.waitForTimeout(100);
  }
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'agile-control-room-e2e-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '--allow-empty', '-m', 'initial commit'], { cwd: repo });
  return repo;
}

describe('control room SPA (Playwright e2e)', () => {
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
      // T039 (§17 "Control room v2"): the card takes a typed answer as well
      // as its buttons — the note rides along with the approve.
      await page.locator('[data-testid="hil-note"]').fill('yes, but only for the seed script');
      await page.locator('[data-testid="hil-approve"]').click();
      await hilItem.waitFor({ state: 'detached', timeout: 5000 });

      const onDisk = store.getEntity(
        `board/hil/${seeded.id}.yaml`,
        (v) => v as { status: string; decision: string; decided_by: string; note?: string },
      );
      expect(onDisk.status).toBe('resolved');
      expect(onDisk.decision).toBe('approve');
      expect(onDisk.decided_by).toBe('human');
      expect(onDisk.note).toBe('yes, but only for the seed script');

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
        // T041: the send now also runs a resident EM turn — point it at the
        // fake ACP transport so this offline test never tries to spawn a
        // real vendor (`test:integration` must pass with no vendor login).
        emChatSpawn: cannedEmSpawn(repo, 'ack'),
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

  // T032: a heartbeat-only `agent_put` (store.ts's `heartbeat()`, the
  // `data: {heartbeat: true}` shape) must NOT trigger `refreshAux`'s
  // six-endpoint refetch — before this fix, one arrived roughly every 30s
  // per live agent and re-pulled agents/tickets/oracle/kb/policy/snapshot
  // for no observable change every time. A real (non-heartbeat) `agent_put`
  // — e.g. `putAgent` registering a role change — must still refetch.
  test('a heartbeat burst causes zero /api/* refetches; a real agent_put still refetches', async () => {
    const repo = initRepo();
    let handle: DaemonHandle | undefined;
    const browser = await chromium.launch({ executablePath });

    try {
      const init = runInit(repo);
      const store = StateStore.open(init.stateRoot);
      const agentId = 'agent-heartbeat-e2e' as never;
      await store.putAgent(agentId, {
        vendor: 'claude',
        model: 'sonnet',
        last_seen: new Date(0).toISOString(),
      });

      handle = await startDaemon({
        cwd: repo,
        port: 0,
        socketPath: join(repo, '.agile-daemon.sock'),
      });

      const page = await browser.newPage();
      const apiRequests: string[] = [];
      page.on('request', (req) => {
        const path = new URL(req.url()).pathname;
        if (path.startsWith('/api/')) apiRequests.push(path);
      });

      await page.goto(`http://127.0.0.1:${handle.http.port}/control-room`);
      // Let the initial mount's own refreshAux (six requests) settle before
      // measuring — only requests from here on are attributable to events.
      await page.waitForTimeout(500);
      apiRequests.length = 0;

      // 20-heartbeat burst: each call advances `now` well past
      // HEARTBEAT_COALESCE_MS so every one actually writes and mints its
      // own `agent_put` (real 30s-apart beats), rather than being coalesced
      // away — this exercises the UI's event filter, not the store's
      // coalescing (that's `store.test.ts`'s job).
      let simulatedNow = Date.now();
      for (let i = 0; i < 20; i++) {
        simulatedNow += 40_000;
        const beatTime = simulatedNow;
        await store.heartbeat(agentId, {}, () => new Date(beatTime));
      }

      // Give the (debounced, 150ms) refresh path every chance to have fired
      // if it were going to.
      await page.waitForTimeout(800);
      expect(apiRequests).toEqual([]);

      // A real agent_put (role/registration change, not a heartbeat) still
      // triggers the refetch — the filter targets the heartbeat shape
      // specifically, it doesn't silently swallow every agent_put.
      await store.putAgent(agentId, {
        vendor: 'claude',
        model: 'sonnet',
        last_seen: new Date(simulatedNow).toISOString(),
        role: 'engineer',
      });

      const deadline = Date.now() + 5000;
      while (apiRequests.length === 0 && Date.now() < deadline) {
        await page.waitForTimeout(100);
      }
      expect(apiRequests.length).toBeGreaterThan(0);
    } finally {
      await browser.close();
      await handle?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);

  /**
   * T040 (§17 "Control room v2" → "Questions vs Decisions"): a pending
   * question is a Needs-you card, and answering it on the card marks it
   * answered for real — through the daemon's own `QuestionService`, not a
   * client-side state change.
   */
  test('an open question renders as a Needs-you card and answering it marks it answered', async () => {
    const repo = initRepo();
    let handle: DaemonHandle | undefined;
    const browser = await chromium.launch({ executablePath });

    try {
      const init = runInit(repo);
      const store = StateStore.open(init.stateRoot);
      const questions = new QuestionService(store);

      const seeded = await questions.raise({
        raised_by: 'eng-1',
        text: 'the contract contradicts the spec — which wins?',
      });

      handle = await startDaemon({
        cwd: repo,
        port: 0,
        socketPath: join(repo, '.agile-daemon.sock'),
      });

      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${handle.http.port}/control-room`);

      const card = page.locator(`.question-item[data-id="${seeded.id}"]`);
      await card.waitFor({ state: 'attached', timeout: 5000 });
      expect(await card.textContent()).toContain('which wins?');

      await card.click();
      await page
        .locator('[data-testid="question-answer"]')
        .fill('the spec wins — refine the ticket');
      await page.locator('[data-testid="question-reply"]').click();
      await card.waitFor({ state: 'detached', timeout: 5000 });

      const onDisk = store.getEntity(
        `board/questions/${seeded.id}.yaml`,
        (v) => v as { status: string; answer: string; resolved_as: string; answered_by: string },
      );
      expect(onDisk.status).toBe('answered');
      expect(onDisk.answer).toBe('the spec wins — refine the ticket');
      expect(onDisk.resolved_as).toBe('reply');
      expect(onDisk.answered_by).toBe('human');
      // The answer reached the engineer that raised it.
      expect(store.listEntities('bus/inbox/eng-1', (v) => v)).toHaveLength(1);
    } finally {
      await browser.close();
      await handle?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20000);

  /**
   * T041 acceptance, offline half: "in a live run, 'what is left on all
   * tickets' gets an answer in the panel within one turn; the pop-out window
   * and the in-page panel show the same thread". Driven through the fake ACP
   * transport, so the whole path — `POST /api/chat/em` -> resident EM turn ->
   * `chat_delta`/`chat_turn_end` on `/ws` -> bus thread -> `GET
   * /api/chat/em` — is real except for the vendor.
   */
  test('the chat panel answers within one turn, and the reply survives a reload and the pop-out route', async () => {
    const repo = initRepo();
    let handle: DaemonHandle | undefined;
    let browser: Browser | undefined;
    const reply = 'TKT-1001 is in review; TKT-1002 is unassigned.';

    try {
      runInit(repo);
      handle = await startDaemon({
        cwd: repo,
        port: 0,
        socketPath: join(repo, '.agile-daemon.sock'),
        emChatSpawn: cannedEmSpawn(repo, reply),
      });
      const base = `http://127.0.0.1:${handle.http.port}`;

      /**
       * QA round 1 deflake, part 1: the first turn goes over plain HTTP,
       * before Chromium exists. Two things come of it — the browser-driven
       * turn below then reuses an *already resident* session and spawns
       * nothing (which is what this ticket built, and is now asserted), and
       * the browser's life no longer straddles a vendor spawn, which is what
       * made the remaining failure mode reproducible enough to locate (see
       * `closeBrowserBounded`, part 2). It also buys a real assertion for
       * free: the panel must render a thread that existed before the page
       * did.
       */
      const warmup = await fetch(`${base}/api/chat/em`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'warm up the resident EM session' }),
      });
      expect(warmup.status).toBe(200);
      await waitForThread(base, 2);
      expect(handle.residentEm?.alive).toBe(true);

      browser = await chromium.launch({ executablePath });
      const page = await browser.newPage();
      await page.goto(`${base}/control-room`);

      // The panel renders the thread that already existed before this page
      // did — history comes from the bus (`GET /api/chat/em`), not from
      // anything this browser did.
      await waitForChatText(page, 'warm up the resident EM session');

      const textarea = page.locator('.cr-chat-input textarea');
      await textarea.waitFor({ state: 'attached', timeout: 5000 });
      await textarea.fill('what is left on all tickets');
      await page.locator('.cr-chat-input button').click();

      // One turn, answered in the panel — on the already-resident session.
      await waitForChatText(page, 'what is left on all tickets');
      await waitForThread(base, 4);
      await waitForChatText(page, reply);

      // A reload

      // A reload renders the same thread — it comes from the bus, not from
      // anything this page kept in memory.
      await page.reload();
      await waitForChatText(page, reply);
      expect(await page.locator('.cr-chat-msg[data-from="you"]').first().textContent()).toContain(
        'warm up the resident EM session',
      );

      // ... and so does the popped-out window's own route.
      const popout = await browser.newPage();
      await popout.goto(`${base}/control-room/chat`);
      await waitForChatText(popout, reply);
      expect(await popout.locator('[data-testid="chat-popout"]').count()).toBe(0);

      // The replies are real `em -> human` bus messages, not a UI-only
      // render: two turns, each answered, in order.
      const thread = (await (await fetch(`${base}/api/chat/em`)).json()) as Array<{
        from: string;
        body: string;
      }>;
      expect(thread.map((e) => e.from)).toEqual(['human', 'em', 'human', 'em']);
      expect(thread[2]?.body).toBe('what is left on all tickets');
      expect(thread[3]?.body).toBe(reply);
      // The browser-driven turn reused the resident session rather than
      // spawning a second one (the ticket's whole premise).
      expect(handle.residentEm?.alive).toBe(true);
    } finally {
      // Daemon first, then the browser (see `closeBrowserBounded`).
      await handle?.stop();
      await closeBrowserBounded(browser);
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60000);
});
