/**
 * T300 (projects-design §12, §14.11, P16): the Director's record, thread and
 * session, driven by the fake agent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, type AcpProviderConfig } from '@agile-agents/acp-client';
import { DIRECTOR_NODE } from '@agile-agents/shared';
import { AttachService } from '../attach/service';
import { AutonomyService } from '../coordination/autonomy';
import { routeEvent } from '../events/router';
import { RoutedEventService } from '../events/service';
import { GateService } from '../gates/service';
import { InboxService } from '../inbox/service';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { QuestionService } from '../questions/service';
import type { FakeAgentScript } from '../runner/fake-agent';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { buildDirectorRpcMethods } from './rpc';
import { DirectorService, type DirectorServiceOptions } from './service';

const FAKE_AGENT_PATH = join(import.meta.dir, '..', 'runner', 'fake-agent.ts');

let home: string;
let scratch: string;
let store: StateStore;
let streams: StreamService;
let events: RoutedEventService;
let attach: AttachService;
let director: DirectorService;

function fakeProvider(script: FakeAgentScript): AcpProviderConfig {
  const path = join(scratch, 'script.json');
  writeFileSync(path, JSON.stringify(script));
  return {
    ...ACP_PROVIDERS.claude,
    command: 'bun',
    args: [FAKE_AGENT_PATH],
    envOverrides: { AGILE_FAKE_AGENT_SCRIPT: path },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not met in ${timeoutMs}ms`);
    await Bun.sleep(20);
  }
}

function build(script: FakeAgentScript, extra: Partial<DirectorServiceOptions> = {}): void {
  const provider = fakeProvider(script);
  director = new DirectorService({
    store,
    streams,
    events,
    home,
    provider: () => provider,
    ...extra,
  });
  attach = new AttachService({
    store,
    streams,
    home,
    events,
    deliveryDelayMs: 5,
    provider: () => provider,
    director: () => director,
  });
  director.setDelivery(attach.delivery);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-director-home-'));
  scratch = mkdtempSync(join(tmpdir(), 'agile-director-scratch-'));
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  events = new RoutedEventService(store);
});

afterEach(async () => {
  attach?.delivery.stop();
  await director?.stop();
  store.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe('T300: the Director', () => {
  test('director_request routes to the Director, not a node', () => {
    expect(routeEvent({ type: 'director_request' }, []).routing).toEqual([
      { node: DIRECTOR_NODE, because: 'self' },
    ]);
  });

  test('a human line reaches the Director and its reply lands on its thread', async () => {
    const log = join(scratch, 'prompts.jsonl');
    build({
      logFile: log,
      steps: [{ type: 'end_turn' }],
      turns: [
        [{ type: 'end_turn' }],
        [{ type: 'agent_text', text: 'Shop needs a tree: api and web.' }, { type: 'end_turn' }],
      ],
    });
    const { event } = await director.say('Shop needs sale prices.');
    expect(event.type).toBe('director_request');
    expect(event.routing).toEqual([{ node: DIRECTOR_NODE, because: 'self' }]);

    await waitFor(() => store.readDirectorThread().some((e) => e.by === 'director'));
    const thread = store.readDirectorThread();
    expect(thread[0]).toMatchObject({ by: 'human', kind: 'line', body: 'Shop needs sale prices.' });
    expect(thread.find((e) => e.by === 'director')?.body).toBe('Shop needs a tree: api and web.');

    // The record, the session dir's brief, and the digest the session was prompted with.
    const record = store.getDirector();
    expect(record?.thread).toBe('director');
    const session = record?.session;
    expect(session?.role).toBe('coordinator');
    const brief = readFileSync(join(home, 'sessions', session?.id ?? '', 'brief.md'), 'utf8');
    expect(brief).toContain('# You are the Director');
    expect(brief).toContain('Shop needs sale prices.');
    await waitFor(() => readFileSync(log, 'utf8').includes('The operator writes to you'));

    // Delivered, and the session lets go once nothing waits.
    await waitFor(() => events.pendingFor(DIRECTOR_NODE).length === 0);
    await waitFor(() => !director.view().live);
    await waitFor(() => store.getDirector()?.session?.status === 'stopped');
    expect(events.activityFor(DIRECTOR_NODE)[0]?.status).toBe('delivered');
  });

  test('director.say over RPC refuses an empty line', async () => {
    build({ steps: [{ type: 'end_turn' }] });
    const rpc = buildDirectorRpcMethods(director);
    await expect(Promise.resolve(rpc['director.say']?.({ body: '  ' }))).rejects.toThrow(
      'non-empty',
    );
  });

  test('T302: a stuck node yields a suggestion card and wakes the Director', async () => {
    let clock = new Date();
    const log = join(scratch, 'prompts.jsonl');
    const projects = new ProjectService(store, streams);
    const autonomy = new AutonomyService({ store, streams, projects, now: () => clock });
    const questions = new QuestionService(store, streams, { deliver: async () => {} });
    const inbox = new InboxService({
      streams,
      questions,
      gates: new GateService(store),
      proposals: autonomy,
    });
    build(
      {
        logFile: log,
        steps: [{ type: 'end_turn' }],
        turns: [
          [{ type: 'end_turn' }],
          [{ type: 'agent_text', text: 'Checkout looks stuck; restart it.' }, { type: 'end_turn' }],
        ],
      },
      { autonomy, inbox, now: () => clock },
    );
    const shop = await projects.create({ name: 'Shop' });
    const node = await streams.create('human', { title: 'Checkout', goal: 'g', project: shop.id });
    await streams.update('daemon', node.id, { agent: { status: 'working' } });

    // Not idle long enough yet.
    expect(await director.checkStuck()).toEqual([]);
    clock = new Date(clock.getTime() + 2 * 3_600_000);
    expect(await director.checkStuck()).toEqual([node.id]);
    // Once per episode.
    expect(await director.checkStuck()).toEqual([]);

    // The card: a Director restart_node proposal, in the inbox on the node.
    const [card] = autonomy.listOpen();
    expect(card).toMatchObject({
      principal: 'director',
      change: { action: 'restart_node', node: node.id },
    });
    expect(inbox.list().find((i) => i.kind === 'proposal')).toMatchObject({
      id: card?.id,
      stream: node.id,
    });

    // The Director is woken with the stuck node, and its brief carries the digest.
    await waitFor(() =>
      store.readDirectorThread().some((e) => e.by === 'director' && e.kind === 'line'),
    );
    await waitFor(() => readFileSync(log, 'utf8').includes('has been working with no activity'));
    const session = store.getDirector()?.session;
    const brief = readFileSync(join(home, 'sessions', session?.id ?? '', 'brief.md'), 'utf8');
    expect(brief).toContain('### Stuck (working, idle over 60 min)');
    expect(brief).toContain(`- Checkout (Shop) [${node.id}]: working, no activity for 1`);
    expect(brief).toContain('### Inbox (1 waiting on the operator)');
  });
});
