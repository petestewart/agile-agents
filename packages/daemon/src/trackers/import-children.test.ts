/** T323: import an epic's children — against the local Linear fake only. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { type FakeLinear, startFakeLinear } from './fake-linear';
import { createLinear } from './linear';
import { TrackerLinks } from './link';
import { buildTrackerRpcMethods } from './rpc';

let home: string;
let store: StateStore;
let streams: StreamService;
let linear: FakeLinear;
let links: TrackerLinks;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-importchildren-'));
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  linear = await startFakeLinear();
  const port = createLinear({ api_url: linear.apiUrl, token: linear.token });
  links = new TrackerLinks({ streams, configured: () => ['linear'], tracker: () => port });
});

afterEach(() => {
  linear.stop();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

describe('import children (T323)', () => {
  test('running it twice creates each child once; new issues are picked up', async () => {
    linear.addIssue({ key: 'SHOP-1', title: 'Checkout epic' });
    linear.addIssue({ key: 'SHOP-2', title: 'Cart', description: 'AC: totals', parent: 'SHOP-1' });
    linear.addIssue({ key: 'SHOP-3', title: 'Pay', parent: 'SHOP-1' });
    const epic = await streams.create('human', { title: 'Checkout', goal: 'tbd' });
    await links.link(epic.id, 'SHOP-1');

    const first = await links.importChildren(epic.id);
    expect(first.created.map((c) => c.external_link?.key).sort()).toEqual(['SHOP-2', 'SHOP-3']);
    for (const c of first.created) {
      expect(c.parent).toBe(epic.id);
      expect(c.agent.status).toBe('idle');
      expect(c.sessions).toEqual([]);
    }
    const cart = first.created.find((c) => c.external_link?.key === 'SHOP-2');
    expect(cart?.title).toBe('Cart');
    expect(cart?.goal).toContain('AC: totals');

    const second = await links.importChildren(epic.id);
    expect(second.created).toEqual([]);
    expect(second.skipped.sort()).toEqual(['SHOP-2', 'SHOP-3']);

    linear.addIssue({ key: 'SHOP-4', title: 'Receipt', parent: 'SHOP-1' });
    const rpc = buildTrackerRpcMethods(links);
    const third = (await rpc['node.import_children']?.({ id: epic.id })) as {
      created: { external_link?: { key: string } }[];
    };
    expect(third.created.map((c) => c.external_link?.key)).toEqual(['SHOP-4']);
    expect(streams.list().filter((s) => s.parent === epic.id)).toHaveLength(3);
  });

  test('an unlinked node is refused as a param error', async () => {
    const node = await streams.create('human', { title: 'x', goal: 'tbd' });
    await expect(links.importChildren(node.id)).rejects.toMatchObject({ kind: 'validation' });
    const rpc = buildTrackerRpcMethods(links);
    await expect(rpc['node.import_children']?.({ id: node.id })).rejects.toMatchObject({
      name: 'RpcParamError',
    });
  });
});
