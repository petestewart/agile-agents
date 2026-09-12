import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ticket, TicketId } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { HttpJiraClient, adfToText, textToAdf, toJqlTimestamp } from './client';
import { resolveJiraSettings } from './config';
import { type FakeJiraHandle, startFakeJira } from './fake-jira';
import { DEFAULT_STATUS_MAP, JIRA_LINK_REL_PATH, JiraSync, resolveField } from './jira';

let repo: string;
let stateRoot: string;
let store: StateStore;
let jira: FakeJiraHandle;
let clock: Date;

function now(): Date {
  return clock;
}

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function makeSync(): JiraSync {
  return new JiraSync({
    store,
    client: new HttpJiraClient({
      baseUrl: jira.baseUrl,
      email: 'pete@example.com',
      apiToken: 'token-123',
    }),
    now,
    onError: () => {},
  });
}

function seedTicket(id: string, overrides: Partial<Ticket> = {}): Promise<Ticket> {
  return store.putTicket(
    validateTicket({
      id,
      title: `Ticket ${id}`,
      status: 'ready',
      contract: {},
      history: [],
      ...overrides,
    }),
  );
}

beforeEach(() => {
  clock = new Date('2026-09-12T10:00:00.000Z');
  repo = mkdtempSync(join(tmpdir(), 'agile-sync-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
  jira = startFakeJira({ now });
});

afterEach(() => {
  jira.stop();
  store.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('link / unlink', () => {
  test('link records the project and unlink removes it', async () => {
    const sync = makeSync();
    expect(sync.status()).toEqual({ linked: false, mapped: 0 });

    const link = await sync.link('LED');
    expect(link.project).toBe('LED');
    expect(sync.status().linked).toBe(true);
    expect(sync.status().project).toBe('LED');

    const unlinked = await sync.unlink();
    expect(unlinked).toEqual({ unlinked: true, project: 'LED' });
    expect(sync.getLink()).toBeUndefined();
    expect(await sync.unlink()).toEqual({ unlinked: false });
  });

  test('re-linking the same project keeps the cursor and shadows', async () => {
    const sync = makeSync();
    await sync.link('LED');
    jira.put({
      key: 'LED-1',
      summary: 'Login',
      description: 'body',
      status: 'To Do',
      updated: clock.toISOString(),
    });
    await sync.tick();
    const before = sync.getLink();
    expect(before?.cursor).toBeDefined();

    const after = await sync.link('LED');
    expect(after.cursor).toBe(before?.cursor as string);
    expect(Object.keys(after.issues)).toEqual(['LED-1']);
  });

  test('tick on an unlinked repo is a no-op', async () => {
    const sync = makeSync();
    const pass = await sync.tick();
    expect(pass).toEqual({
      created: [],
      pulled: [],
      pushedFields: [],
      pushedStatus: [],
      errors: [],
    });
  });
});

describe('pull: Jira -> local', () => {
  test('an issue with no local mapping becomes a not-started local ticket', async () => {
    const sync = makeSync();
    await sync.link('LED');
    jira.put({
      key: 'LED-41',
      summary: 'Issue JWT on login',
      description: 'Sign a 24h token.',
      status: 'To Do',
      updated: clock.toISOString(),
    });

    const pass = await sync.tick();
    expect(pass.created).toHaveLength(1);

    const created = store.getTicket(pass.created[0] as TicketId);
    expect(created.status).toBe('draft');
    expect(created.title).toBe('Issue JWT on login');
    expect(created.description).toBe('Sign a 24h token.');
    expect(created.external?.jira).toBe('LED-41');
    // "contracts, rules and dependencies stay local" — a stub carries none.
    expect(created.contract.acceptance).toEqual([]);
    expect(created.oracle_refs).toEqual([]);
    expect(created.depends).toEqual([]);

    // Idempotent: a second pass over the same issue creates nothing new.
    const second = await sync.tick();
    expect(second.created).toEqual([]);
    expect(store.listTickets().filter((t) => t.external?.jira === 'LED-41')).toHaveLength(1);
  });

  test('a title/description edit in Jira updates the local ticket', async () => {
    const sync = makeSync();
    await sync.link('LED');
    jira.put({
      key: 'LED-42',
      summary: 'Old title',
      description: 'old body',
      status: 'To Do',
      updated: clock.toISOString(),
    });
    const pass1 = await sync.tick();
    const id = pass1.created[0] as TicketId;

    advance(60_000);
    jira.put({
      key: 'LED-42',
      summary: 'New title',
      description: 'new body',
      status: 'To Do',
      updated: clock.toISOString(),
    });

    const pass2 = await sync.tick();
    expect(pass2.pulled).toEqual([id]);
    const ticket = store.getTicket(id);
    expect(ticket.title).toBe('New title');
    expect(ticket.description).toBe('new body');
    // Contract and status are untouched by the pull.
    expect(ticket.status).toBe('draft');
  });

  test('the pull mints a ticket_put event — no new event kind needed', async () => {
    const sync = makeSync();
    await sync.link('LED');
    jira.put({
      key: 'LED-43',
      summary: 'A',
      description: '',
      status: 'To Do',
      updated: clock.toISOString(),
    });
    const pass = await sync.tick();
    const id = pass.created[0] as TicketId;
    const kinds = store
      .listEvents()
      .filter((e) => e.ticket === id)
      .map((e) => e.kind);
    expect(kinds).toContain('ticket_put');
  });
});

describe('push: local -> Jira', () => {
  test('a local status change transitions the Jira issue', async () => {
    const sync = makeSync();
    await sync.link('LED');
    jira.put({
      key: 'LED-44',
      summary: 'Ship it',
      description: '',
      status: 'To Do',
      updated: clock.toISOString(),
    });
    const created = (await sync.tick()).created[0] as TicketId;
    expect(jira.issues.get('LED-44')?.status).toBe('To Do');

    await store.transitionTicket(created, 'ready', { by: 'architect' });
    await store.transitionTicket(created, 'assigned', { by: 'em' });
    advance(60_000);
    const pass = await sync.tick();
    expect(pass.pushedStatus).toEqual(['LED-44']);
    expect(jira.issues.get('LED-44')?.status).toBe('In Progress');
  });

  test('a local title/description edit is pushed to the issue', async () => {
    const sync = makeSync();
    await sync.link('LED');
    jira.put({
      key: 'LED-45',
      summary: 'Jira title',
      description: 'jira body',
      status: 'To Do',
      updated: clock.toISOString(),
    });
    const id = (await sync.tick()).created[0] as TicketId;

    advance(60_000);
    await store.putTicket(
      validateTicket({ ...store.getTicket(id), title: 'Local title', description: 'local body' }),
    );

    const pass = await sync.tick();
    expect(pass.pushedFields).toEqual(['LED-45']);
    expect(jira.issues.get('LED-45')?.summary).toBe('Local title');
    expect(jira.issues.get('LED-45')?.description).toBe('local body');
    // And it stays pushed: the next pass sees no divergence at all.
    advance(60_000);
    const quiet = await sync.tick();
    expect(quiet.pushedFields).toEqual([]);
    expect(quiet.pulled).toEqual([]);
  });
});

describe('conflict rule', () => {
  test('Agile Agents wins on status: a status changed in Jira is re-asserted', async () => {
    const sync = makeSync();
    await sync.link('LED');
    jira.put({
      key: 'LED-46',
      summary: 'Auth',
      description: '',
      status: 'To Do',
      updated: clock.toISOString(),
    });
    const id = (await sync.tick()).created[0] as TicketId;
    await store.transitionTicket(id, 'ready', { by: 'architect' });

    // A human drags the card to Done in Jira.
    advance(60_000);
    jira.put({
      key: 'LED-46',
      summary: 'Auth',
      description: '',
      status: 'Done',
      updated: clock.toISOString(),
    });

    const pass = await sync.tick();
    expect(pass.pushedStatus).toEqual(['LED-46']);
    // Local status is untouched, and Jira is put back where the board says.
    expect(store.getTicket(id).status).toBe('ready');
    expect(jira.issues.get('LED-46')?.status).toBe('To Do');
  });

  test('last writer wins on title: the later Jira edit beats the earlier local one', async () => {
    const sync = makeSync();
    await sync.link('LED');
    jira.put({
      key: 'LED-47',
      summary: 'Base',
      description: 'base',
      status: 'To Do',
      updated: clock.toISOString(),
    });
    const id = (await sync.tick()).created[0] as TicketId;

    // Local edits first...
    advance(60_000);
    await store.putTicket(validateTicket({ ...store.getTicket(id), title: 'Local wrote' }));
    // ...but the daemon only observes it on the pass where Jira has already
    // been edited *later*, so the Jira write is the last writer.
    advance(60_000);
    jira.put({
      key: 'LED-47',
      summary: 'Jira wrote',
      description: 'base',
      status: 'To Do',
      updated: clock.toISOString(),
    });

    const pass = await sync.tick();
    expect(pass.pulled).toEqual([id]);
    expect(store.getTicket(id).title).toBe('Jira wrote');
    expect(jira.issues.get('LED-47')?.summary).toBe('Jira wrote');
  });

  test('last writer wins on title: the later local edit beats the earlier Jira one', async () => {
    const sync = makeSync();
    await sync.link('LED');
    jira.put({
      key: 'LED-48',
      summary: 'Base',
      description: 'base',
      status: 'To Do',
      updated: clock.toISOString(),
    });
    const id = (await sync.tick()).created[0] as TicketId;

    // Jira is edited, but the daemon does not pull yet.
    advance(60_000);
    const jiraEditedAt = clock.toISOString();
    jira.put({
      key: 'LED-48',
      summary: 'Jira wrote',
      description: 'base',
      status: 'To Do',
      updated: jiraEditedAt,
    });

    // The local side is edited after that, and *then* a pass runs.
    advance(60_000);
    await store.putTicket(validateTicket({ ...store.getTicket(id), title: 'Local wrote' }));

    const pass = await sync.tick();
    expect(pass.pushedFields).toEqual(['LED-48']);
    expect(pass.pulled).toEqual([]);
    expect(store.getTicket(id).title).toBe('Local wrote');
    expect(jira.issues.get('LED-48')?.summary).toBe('Local wrote');
  });

  test('resolveField: one-sided changes never consult the clock', () => {
    const base = { jiraUpdatedAt: '2026-01-01T00:00:00Z', localChangedAt: undefined };
    expect(resolveField({ jira: 'a', local: 'a', shadow: 'a', ...base })).toBe('none');
    expect(resolveField({ jira: 'b', local: 'a', shadow: 'a', ...base })).toBe('jira');
    expect(resolveField({ jira: 'a', local: 'b', shadow: 'a', ...base })).toBe('local');
    // No shadow: the mapping was just adopted, Jira is the authority.
    expect(resolveField({ jira: 'b', local: 'a', shadow: undefined, ...base })).toBe('jira');
  });
});

describe('credentials', () => {
  test('nothing under .agile/ ever contains the token or the base URL', async () => {
    const sync = makeSync();
    await sync.link('LED');
    jira.put({
      key: 'LED-49',
      summary: 'Secretless',
      description: '',
      status: 'To Do',
      updated: clock.toISOString(),
    });
    await sync.tick();

    // The client did authenticate — so the absence below is not vacuous.
    expect(jira.authHeaders.some((h) => h.startsWith('Basic '))).toBe(true);

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === '.git') continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(stateRoot);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('token-123');
      expect(text).not.toContain('pete@example.com');
      expect(text).not.toContain(jira.baseUrl);
    }
    // The link record itself holds only the project + shadows.
    const link = readFileSync(join(stateRoot, JIRA_LINK_REL_PATH), 'utf8');
    expect(link).toContain('project: LED');
  });

  test('resolveJiraSettings needs a base URL and both credentials', () => {
    expect(resolveJiraSettings({}, { env: {} })).toBeUndefined();
    expect(
      resolveJiraSettings({}, { env: { JIRA_BASE_URL: 'https://x', JIRA_EMAIL: 'a@b.c' } }),
    ).toBeUndefined();
    const settings = resolveJiraSettings(
      { jira: { projectKey: 'LED', pollIntervalMs: 1234 } },
      { env: { JIRA_BASE_URL: 'https://x', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't' } },
    );
    expect(settings).toEqual({
      baseUrl: 'https://x',
      email: 'a@b.c',
      apiToken: 't',
      projectKey: 'LED',
      pollIntervalMs: 1234,
    });
  });
});

describe('client encoding', () => {
  test('ADF round-trips plain text', () => {
    expect(adfToText(textToAdf('one\ntwo'))).toBe('one\ntwo');
    expect(adfToText(undefined)).toBe('');
    expect(adfToText({ type: 'doc', content: [] })).toBe('');
  });

  test('JQL timestamps are minute-granular Jira literals', () => {
    expect(toJqlTimestamp('2026-09-12T10:34:56.000Z')).toBe('2026/09/12 10:34');
  });

  test('an unavailable transition is reported per issue, not fatal to the pass', async () => {
    const sync = new JiraSync({
      store,
      client: new HttpJiraClient({
        baseUrl: jira.baseUrl,
        email: 'pete@example.com',
        apiToken: 'token-123',
      }),
      now,
      // A project whose workflow has no matching status at all.
      statusMap: { ...DEFAULT_STATUS_MAP, draft: 'Icebox' },
      onError: () => {},
    });
    await sync.link('LED');
    jira.put({
      key: 'LED-50',
      summary: 'Odd workflow',
      description: '',
      status: 'To Do',
      updated: clock.toISOString(),
    });
    const pass = await sync.tick();
    // No `Icebox` transition exists on the fake workflow: the failure is
    // reported per issue and the issue is still created locally.
    expect(pass.created).toHaveLength(1);
    expect(pass.errors.some((e) => e.includes('LED-50'))).toBe(true);
  });
});

describe('unlinked tickets', () => {
  test('a local ticket with no external mapping is never pushed', async () => {
    const sync = makeSync();
    await sync.link('LED');
    await seedTicket('TKT-0900');
    const pass = await sync.tick();
    expect(pass.pushedFields).toEqual([]);
    expect(pass.pushedStatus).toEqual([]);
    expect(sync.status().mapped).toBe(0);
  });
});
