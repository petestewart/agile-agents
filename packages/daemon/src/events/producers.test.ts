/** T244: the stream-transition producers, payload trimming and summaries (projects-design §15). */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ROUTED_EVENT_PAYLOAD_MAX,
  type RoutedEvent,
  validateRoutedEvent,
} from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { type EmitRouted, emitTransitions, makeEmitter, summarize, trimFiles } from './producers';
import { RoutedEventService } from './service';

let home: string;
let store: StateStore;
let streams: StreamService;
let emitted: RoutedEvent[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-producers-'));
  store = StateStore.open(runInit(home).stateRoot);
  emitted = [];
  const ref: { base?: EmitRouted } = {};
  const emit: EmitRouted = async (input) => {
    const e = await ref.base?.(input);
    if (e) emitted.push(e);
    return e;
  };
  streams = new StreamService(store, { onUpdated: emitTransitions(emit) });
  ref.base = makeEmitter(new RoutedEventService(store), streams);
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const routed = (e: RoutedEvent | undefined) => e?.routing.map((r) => [r.node, r.because]);

describe('stream-transition producers (T244)', () => {
  test('child_status reaches every ancestor when a child blocks, with its progress line', async () => {
    const root = await streams.create('human', { title: 'Shop', goal: 'g' });
    const mid = await streams.create('human', { title: 'Sale', goal: 'g', parent: root.id });
    const child = await streams.create('human', { title: 'api part', goal: 'g', parent: mid.id });
    await streams.update('agent', child.id, { agent: { progress: 'waiting on the schema' } });
    expect(emitted).toEqual([]);
    await streams.update('daemon', child.id, { agent: { status: 'blocked' } });
    expect(emitted.map((e) => e.type)).toEqual(['child_status']);
    const e = emitted[0];
    expect(routed(e)).toEqual([
      [mid.id, 'ancestor'],
      [root.id, 'ancestor'],
    ]);
    expect(summarize(e as RoutedEvent, mid.id)).toBe(
      'Child api part is blocked: waiting on the schema.',
    );
    // Same status again: nothing new.
    await streams.update('daemon', child.id, { agent: { status: 'blocked' } });
    expect(emitted).toHaveLength(1);
  });

  test('child_status falls back when there is no progress line; a question reads as asking', async () => {
    const root = await streams.create('human', { title: 'Shop', goal: 'g' });
    const child = await streams.create('human', { title: 'web', goal: 'g', parent: root.id });
    await streams.update('daemon', child.id, { agent: { status: 'question' } });
    expect(summarize(emitted[0] as RoutedEvent, root.id)).toBe(
      'Child web is asking: no progress line.',
    );
  });

  test('dependency_satisfied when a repo-less node that others wait on is closed', async () => {
    const target = await streams.create('human', { title: 'Decide the API', goal: 'g' });
    const waiter = await streams.create('human', { title: 'Build it', goal: 'g' });
    await streams.wait('human', waiter.id, target.id);
    await streams.close('human', target.id);
    const e = emitted.find((x) => x.type === 'dependency_satisfied');
    expect(routed(e)).toEqual([[waiter.id, 'waits_on']]);
    expect(e?.payload).toMatchObject({ node: target.id, outcome: 'closed' });
    expect(summarize(e as RoutedEvent, waiter.id)).toBe(
      'Decide the API closed; your wait on it has cleared.',
    );
  });
});

describe('payload trimming', () => {
  test('a long file list stays under the payload cap and validates', () => {
    const files = Array.from({ length: 500 }, (_, i) => `src/${'deep/'.repeat(40)}file-${i}.ts`);
    const trimmed = trimFiles(files);
    expect(trimmed.length).toBeGreaterThan(0);
    expect(trimmed.length).toBeLessThanOrEqual(20);
    const payload = { repo: 'api', files: trimmed };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(ROUTED_EVENT_PAYLOAD_MAX);
    expect(() =>
      validateRoutedEvent({
        id: 'E-01J9AAAAAAAAAAAAAAAAAAAAAA',
        type: 'sync_conflict',
        payload,
        by: 'daemon',
        at: new Date().toISOString(),
        routing: [],
      }),
    ).not.toThrow();
  });
});
