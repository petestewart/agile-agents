import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ticket, TicketId } from '@agile-agents/shared';
import { validateTicket } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { HttpJiraClient, adfToText, textToAdf, toJqlTimestamp } from './client';
import { readLinkedProject, resolveJiraSettings, writeLinkedProject } from './config';
import { type FakeJiraHandle, startFakeJira } from './fake-jira';
import { DEFAULT_STATUS_MAP, JiraSync, resolveField } from './jira';

let repo: string;
let configPath: string;
let stateRoot: string;
let store: StateStore;
let jira: FakeJiraHandle;
let clock: Date;

function now(): Date {
  return clock;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function makeSync(overrides: Partial<ConstructorParameters<typeof JiraSync>[0]> = {}): JiraSync {
  return new JiraSync({
    store,
    client: new HttpJiraClient({
      baseUrl: jira.baseUrl,
      email: 'pete@example.com',
      apiToken: 'token-123',
    }),
    configPath,
    now,
    onError: () => {},
    ...overrides,
  });
}

/** Every file under `.agile/`, relative to the state root (git internals excluded). */
function stateFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === '.git') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(path.slice(stateRoot.length + 1));
    }
  };
  walk(stateRoot);
  return found.sort();
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
  configPath = join(repo, 'agile.config.yaml');
  store = StateStore.open(stateRoot);
  jira = startFakeJira({ now });
});

afterEach(() => {
  jira.stop();
  store.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('link / unlink', () => {
  test('link writes jira.project into agile.config.yaml and unlink removes it', async () => {
    const sync = makeSync();
    expect(sync.status()).toEqual({ linked: false, mapped: 0 });

    const linked = sync.link('LED');
    expect(linked).toMatchObject({ linked: true, project: 'LED', source: 'config' });
    expect(readFileSync(configPath, 'utf8')).toContain('project: LED');
    expect(readLinkedProject(configPath)).toBe('LED');

    expect(sync.unlink()).toEqual({ unlinked: true, project: 'LED' });
    expect(sync.linkedProject()).toBeUndefined();
    expect(sync.unlink()).toEqual({ unlinked: false });
  });

  test('link preserves every other key in agile.config.yaml and writes no credential', () => {
    writeFileSync(configPath, 'port: 4700\njira:\n  baseUrl: https://acme.atlassian.net\n');
    const sync = makeSync();
    sync.link('LED');
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('port: 4700');
    expect(text).toContain('baseUrl: https://acme.atlassian.net');
    expect(text).toContain('project: LED');
    expect(text).not.toContain('token-123');
    expect(text).not.toContain('pete@example.com');

    // Unlink drops only the project key.
    sync.unlink();
    const after = readFileSync(configPath, 'utf8');
    expect(after).toContain('port: 4700');
    expect(after).toContain('baseUrl: https://acme.atlassian.net');
    expect(after).not.toContain('project: LED');
  });

  test('an env-set project links without a config file and cannot be unlinked by writing one', () => {
    const sync = makeSync({ envProject: 'ENV' });
    expect(sync.status()).toMatchObject({ linked: true, project: 'ENV', source: 'env' });
    const result = sync.unlink();
    expect(result.unlinked).toBe(false);
    expect(result.note).toContain('JIRA_PROJECT_KEY');
  });

  test('a config project outranks the environment', () => {
    writeLinkedProject(configPath, 'LED');
    const sync = makeSync({ envProject: 'ENV' });
    expect(sync.linkedProject()).toBe('LED');
  });

  test('re-linking the same project keeps the per-ticket shadows and cursor', async () => {
    const sync = makeSync();
    sync.link('LED');
    jira.put({
      key: 'LED-1',
      summary: 'Login',
      description: 'body',
      status: 'To Do',
      updated: clock.toISOString(),
    });
    await sync.tick();
    const before = sync.status();
    expect(before.cursor).toBeDefined();
    expect(before.mapped).toBe(1);

    sync.link('LED');
    expect(sync.status()).toMatchObject({ cursor: before.cursor, mapped: 1 });
  });

  test('tick on an unlinked repo is a no-op', async () => {
    const sync = makeSync();
    const pass = await sync.tick();
    expect(pass).toEqual({
      created: [],
      pulled: [],
      pushedFields: [],
      pushedStatus: [],
      skipped: [],
      errors: [],
    });
  });
});

describe('pull: Jira -> local', () => {
  test('an issue with no local mapping becomes a not-started local ticket', async () => {
    const sync = makeSync();
    sync.link('LED');
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
    sync.link('LED');
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
    sync.link('LED');
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
    sync.link('LED');
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
    sync.link('LED');
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
    sync.link('LED');
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

  /**
   * QA round 1, finding 1: these two run on the **real wall clock** — real
   * `Date.now()` for the issue's `updated`, a real 200 ms gap, and the local
   * edit dated by its own `ticket_put` event in `log/events.jsonl`. The
   * synthetic-clock versions they replace could not have caught the bug:
   * `localChangedAt` used to be stamped at tick time, so the local side won
   * whichever order the edits really happened in.
   */
  test('last writer wins on title: a Jira edit made 200ms after the local one wins', async () => {
    const sync = makeSync({ now: () => new Date() });
    sync.link('LED');
    jira.put({
      key: 'LED-47',
      summary: 'Base',
      description: 'base',
      status: 'To Do',
      updated: new Date().toISOString(),
    });
    const id = (await sync.tick()).created[0] as TicketId;

    // Local edits first — dated by the `ticket_put` event this write mints.
    await store.putTicket(validateTicket({ ...store.getTicket(id), title: 'Local wrote' }));
    await sleep(200);
    // ...then Jira, genuinely later, in the same poll window.
    jira.put({
      key: 'LED-47',
      summary: 'Jira wrote',
      description: 'base',
      status: 'To Do',
      updated: new Date().toISOString(),
    });

    const pass = await sync.tick();
    expect(pass.pulled).toEqual([id]);
    expect(pass.pushedFields).toEqual([]);
    expect(store.getTicket(id).title).toBe('Jira wrote');
    expect(jira.issues.get('LED-47')?.summary).toBe('Jira wrote');
  });

  test('last writer wins on title: a local edit made 200ms after the Jira one wins', async () => {
    const sync = makeSync({ now: () => new Date() });
    sync.link('LED');
    jira.put({
      key: 'LED-48',
      summary: 'Base',
      description: 'base',
      status: 'To Do',
      updated: new Date().toISOString(),
    });
    const id = (await sync.tick()).created[0] as TicketId;

    // Jira edits first...
    jira.put({
      key: 'LED-48',
      summary: 'Jira wrote',
      description: 'base',
      status: 'To Do',
      updated: new Date().toISOString(),
    });
    await sleep(200);
    // ...then the local side, genuinely later.
    await store.putTicket(validateTicket({ ...store.getTicket(id), title: 'Local wrote' }));

    const pass = await sync.tick();
    expect(pass.pushedFields).toEqual(['LED-48']);
    expect(pass.pulled).toEqual([]);
    expect(store.getTicket(id).title).toBe('Local wrote');
    expect(jira.issues.get('LED-48')?.summary).toBe('Local wrote');
  });

  test('a status change is not a title edit: moving the board does not win a title conflict', async () => {
    const sync = makeSync({ now: () => new Date() });
    sync.link('LED');
    jira.put({
      key: 'LED-52',
      summary: 'Base',
      description: 'base',
      status: 'To Do',
      updated: new Date().toISOString(),
    });
    const id = (await sync.tick()).created[0] as TicketId;

    await store.putTicket(validateTicket({ ...store.getTicket(id), title: 'Local wrote' }));
    await sleep(200);
    jira.put({
      key: 'LED-52',
      summary: 'Jira wrote',
      description: 'base',
      status: 'To Do',
      updated: new Date().toISOString(),
    });
    // A local *status* transition after the Jira edit must not back-date the
    // title conflict in the local side's favour — `lastLocalEditAt` reads
    // `ticket_put` only, never `state_transition`.
    await sleep(50);
    await store.transitionTicket(id, 'ready', { by: 'architect' });

    await sync.tick();
    expect(store.getTicket(id).title).toBe('Jira wrote');
  });

  test("this sync's own shadow writes never count as a local edit", async () => {
    const sync = makeSync({ now: () => new Date() });
    sync.link('LED');
    jira.put({
      key: 'LED-53',
      summary: 'Base',
      description: 'base',
      status: 'To Do',
      updated: new Date().toISOString(),
    });
    const id = (await sync.tick()).created[0] as TicketId;
    // Several passes, each writing the shadow, and no local edit at all.
    await sync.tick();
    await sleep(50);
    jira.put({
      key: 'LED-53',
      summary: 'Jira wrote',
      description: 'base',
      status: 'To Do',
      updated: new Date().toISOString(),
    });
    const pass = await sync.tick();
    expect(pass.pulled).toEqual([id]);
    expect(store.getTicket(id).title).toBe('Jira wrote');
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

describe('state placement', () => {
  test('a full sync pass creates nothing under .agile/ except ticket files', async () => {
    const sync = makeSync();
    sync.link('LED');
    const before = new Set(stateFiles());

    jira.put({
      key: 'LED-60',
      summary: 'New from Jira',
      description: 'body',
      status: 'To Do',
      updated: clock.toISOString(),
    });
    const pass = await sync.tick();
    expect(pass.created).toHaveLength(1);

    // A local edit and a status change, so the pass exercises both pushes too.
    const id = pass.created[0] as TicketId;
    advance(60_000);
    await store.putTicket(validateTicket({ ...store.getTicket(id), title: 'Local title' }));
    await store.transitionTicket(id, 'ready', { by: 'architect' });
    await sync.tick();

    const created = stateFiles().filter((rel) => !before.has(rel));
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((rel) => rel.startsWith('tickets/'))).toBe(true);
    // Specifically: no sync artifact of its own.
    expect(stateFiles().some((rel) => rel.startsWith('sync/'))).toBe(false);
  });

  test('the shadow rides on the ticket, under external', async () => {
    const sync = makeSync();
    sync.link('LED');
    jira.put({
      key: 'LED-61',
      summary: 'Shadowed',
      description: 'body',
      status: 'To Do',
      updated: clock.toISOString(),
    });
    const id = (await sync.tick()).created[0] as TicketId;
    const ticket = store.getTicket(id);
    expect(ticket.external?.jira).toBe('LED-61');
    expect(ticket.external?.jira_synced).toMatchObject({
      title: 'Shadowed',
      description: 'body',
      updated_at: clock.toISOString(),
      status: 'To Do',
    });
  });
});

describe('cursor and skipped tickets (QA round 1, finding 2)', () => {
  test('a shadow timestamp ahead of the daemon clock does not blind the ticket', async () => {
    const sync = makeSync({ now: () => new Date() });
    sync.link('LED');
    // A Jira server whose clock runs ahead stamps `updated` in our future.
    const skewed = new Date(Date.now() + 10 * 60_000).toISOString();
    await store.putTicket(
      validateTicket({
        id: 'TKT-0700',
        title: 'Skewed',
        status: 'draft',
        contract: {},
        history: [],
        external: {
          jira: 'LED-70',
          jira_synced: {
            title: 'Skewed',
            description: '',
            updated_at: skewed,
            status: 'To Do',
          },
        },
      }),
    );
    // A perfectly ordinary, present-tense Jira edit.
    jira.put({
      key: 'LED-70',
      summary: 'Edited in Jira',
      description: '',
      status: 'Done',
      updated: new Date().toISOString(),
    });

    const pass = await sync.tick();
    // Unclamped, the cursor would be 10 minutes in the future and this issue
    // would never match `updated >= cursor` again.
    expect(pass.pulled).toEqual(['TKT-0700']);
    expect(store.getTicket('TKT-0700').title).toBe('Edited in Jira');
    // ...and the status assertion comes back to life with it.
    expect(pass.pushedStatus).toEqual(['LED-70']);
    expect(jira.issues.get('LED-70')?.status).toBe('To Do');
    expect(pass.errors).toEqual([]);
  });

  test('status reported by the pull, not the stale shadow, drives re-assertion', async () => {
    const sync = makeSync({ now: () => new Date() });
    sync.link('LED');
    // Shadow claims the issue is already where the local status maps to...
    await store.putTicket(
      validateTicket({
        id: 'TKT-0701',
        title: 'Drifted',
        status: 'draft',
        contract: {},
        history: [],
        external: {
          jira: 'LED-71',
          jira_synced: {
            title: 'Drifted',
            description: '',
            updated_at: new Date(Date.now() - 60_000).toISOString(),
            status: 'To Do',
          },
        },
      }),
    );
    // ...but Jira actually holds something else.
    jira.put({
      key: 'LED-71',
      summary: 'Drifted',
      description: '',
      status: 'Done',
      updated: new Date().toISOString(),
    });

    const pass = await sync.tick();
    expect(pass.pushedStatus).toEqual(['LED-71']);
    expect(jira.issues.get('LED-71')?.status).toBe('To Do');
  });

  test('a mapped ticket with no shadow is reported as skipped, not silently ignored', async () => {
    const sync = makeSync();
    sync.link('LED');
    await store.putTicket(
      validateTicket({
        id: 'TKT-0702',
        title: 'Hand-mapped',
        status: 'draft',
        contract: {},
        history: [],
        external: { jira: 'LED-72' },
      }),
    );

    const pass = await sync.tick();
    expect(pass.errors).toEqual([]);
    expect(pass.skipped).toHaveLength(1);
    expect(pass.skipped[0]).toMatchObject({ ticket: 'TKT-0702', key: 'LED-72' });
    expect(pass.skipped[0]?.reason).toMatch(/no sync shadow yet/);
    // Nothing was pushed on a guess.
    expect(pass.pushedFields).toEqual([]);
    expect(pass.pushedStatus).toEqual([]);
  });
});

describe('credentials', () => {
  test('nothing under .agile/ ever contains the token or the base URL', async () => {
    const sync = makeSync();
    sync.link('LED');
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

    for (const rel of stateFiles()) {
      const text = readFileSync(join(stateRoot, rel), 'utf8');
      expect(text).not.toContain('token-123');
      expect(text).not.toContain('pete@example.com');
      expect(text).not.toContain(jira.baseUrl);
    }
    // The link lives in the host-local config file, not under `.agile/`.
    expect(readLinkedProject(configPath)).toBe('LED');
  });

  test('resolveJiraSettings needs a base URL and both credentials', () => {
    expect(resolveJiraSettings({}, { env: {} })).toBeUndefined();
    expect(
      resolveJiraSettings({}, { env: { JIRA_BASE_URL: 'https://x', JIRA_EMAIL: 'a@b.c' } }),
    ).toBeUndefined();
    const settings = resolveJiraSettings(
      { jira: { project: 'LED', pollIntervalMs: 1234 } },
      { env: { JIRA_BASE_URL: 'https://x', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't' } },
    );
    expect(settings).toEqual({
      baseUrl: 'https://x',
      email: 'a@b.c',
      apiToken: 't',
      project: 'LED',
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
    // A project whose workflow has no matching status at all.
    const sync = makeSync({ statusMap: { ...DEFAULT_STATUS_MAP, draft: 'Icebox' } });
    sync.link('LED');
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
    sync.link('LED');
    await seedTicket('TKT-0900');
    const pass = await sync.tick();
    expect(pass.pushedFields).toEqual([]);
    expect(pass.pushedStatus).toEqual([]);
    expect(sync.status().mapped).toBe(0);
  });
});
