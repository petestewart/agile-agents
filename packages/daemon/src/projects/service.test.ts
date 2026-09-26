/**
 * T200: projects against a real temp state home — no git, no vendor.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcParamError } from '../gates/rpc';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { buildProjectRpcMethods } from './rpc';
import { ProjectService } from './service';

let home: string;
let store: StateStore;
let projects: ProjectService;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-projects-'));
  store = StateStore.open(runInit(home).stateRoot);
  projects = new ProjectService(store, new StreamService(store));
  await store.addRepo('shop-web', { path: home });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function events(): Array<{ kind: string; stream?: string; data: Record<string, unknown> }> {
  return readFileSync(join(home, 'log', 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe('ProjectService', () => {
  test('create writes the record and its root stream, and round-trips', async () => {
    const p = await projects.create({ name: 'Shop', repos: ['shop-web'] });
    expect(p.id).toMatch(/^P-[0-9A-HJKMNP-TV-Z]{26}$/);
    const root = store.getStream(p.root);
    expect(root.parent).toBeUndefined();
    expect(root.title).toBe('Shop');
    expect(readFileSync(join(home, 'projects', `${p.id}.yaml`), 'utf8')).toContain('name: Shop');
    expect(StateStore.open(home).getProject(p.id)).toEqual(p);
    expect(events().find((e) => e.kind === 'project_created')).toMatchObject({
      stream: p.root,
      data: { id: p.id, name: 'Shop', root: p.root, archived: false },
    });
  });

  test('names are unique case-insensitively, on create and rename', async () => {
    const a = await projects.create({ name: 'Shop' });
    await expect(projects.create({ name: 'shop' })).rejects.toThrow(/already exists/);
    const b = await projects.create({ name: 'Blog' });
    await expect(projects.update(b.id, { name: 'SHOP' })).rejects.toThrow(/already exists/);
    // Renaming to itself in another case is fine.
    expect((await projects.update(a.id, { name: 'SHOP' })).name).toBe('SHOP');
  });

  test('a refused create leaves no live orphan root', async () => {
    await projects.create({ name: 'Shop' });
    const before = store.listStreams().filter((s) => s.archived !== true).length;
    await expect(projects.create({ name: 'SHOP' })).rejects.toThrow();
    expect(store.listStreams().filter((s) => s.archived !== true).length).toBe(before);
  });

  test('unknown repos are refused', async () => {
    await expect(projects.create({ name: 'Shop', repos: ['nope'] })).rejects.toThrow(
      /unknown repo: nope/,
    );
  });

  test('update merges settings, null clears, and emits project_updated', async () => {
    const p = await projects.create({ name: 'Shop' });
    const u = await projects.update(p.id, {
      session: { vendor: 'claude', effort: 'high' },
      delivery: { mode: 'pr' },
      autonomy: { director: 'run' },
    });
    expect(u.session).toEqual({ vendor: 'claude', effort: 'high' });
    expect(u.autonomy).toEqual({ coordinator: 'advise', director: 'run' });
    const cleared = await projects.update(p.id, { delivery: null });
    expect(cleared.delivery).toBeUndefined();
    expect(cleared.root).toBe(p.root);
    expect(events().filter((e) => e.kind === 'project_updated').length).toBe(2);
  });

  test('archive hides from list unless asked', async () => {
    const p = await projects.create({ name: 'Shop' });
    await projects.archive(p.id);
    expect(projects.list()).toEqual([]);
    expect(projects.list({ include_archived: true }).map((x) => x.id)).toEqual([p.id]);
  });

  test('a corrupt project file is refused with its path and line', async () => {
    const p = await projects.create({ name: 'Shop' });
    const path = join(home, 'projects', `${p.id}.yaml`);
    writeFileSync(path, 'id: [unclosed\nname: Shop\n');
    expect(() => StateStore.open(home).getProject(p.id)).toThrow(
      new RegExp(`corrupt project file ${path}.*line \\d+`, 's'),
    );
  });
});

describe('project.* RPC', () => {
  test('bad params are -32602', async () => {
    const rpc = buildProjectRpcMethods(projects);
    await expect(async () => rpc['project.create']?.({ name: '' })).toThrow(RpcParamError);
    await expect(async () => rpc['project.get']?.({ id: 'x' })).toThrow(RpcParamError);
    await projects.create({ name: 'Shop' });
    await expect(async () => rpc['project.create']?.({ name: 'SHOP' })).toThrow(RpcParamError);
    const { projects: list } = (await rpc['project.list']?.({})) as { projects: unknown[] };
    expect(list.length).toBe(1);
  });
});
