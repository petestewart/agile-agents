/**
 * T489 (D58): Choose leaves out a vendor whose last self-check says a model
 * pick doesn't take (it kept its own model, or refused the pick), and the
 * pick's why says so. No check on file: nothing changes. No classifier: the
 * rule decides (`start_cheap`: the cheapest balanced preset).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelPolicyPartial, SessionVendor, Stream } from '@agile-agents/shared';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { vendorsLeftOut } from '../runner/vendor-check';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { ModelPolicyService } from './policy';

let home: string;
let store: StateStore;
let streams: StreamService;
let projects = 0;

/** Cursor's grok-4.7 reads balanced (no profile), Claude's Opus strongest: the rule picks Cursor. */
const PRESETS = [
  { vendor: 'cursor' as const, model: 'grok-4.7' },
  { vendor: 'claude' as const, model: 'claude-opus-5-5' },
];
const FALLBACK = { vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' as const };

async function nodeUnder(policy: ModelPolicyPartial): Promise<Stream> {
  const project = await new ProjectService(store, streams).create({ name: `Shop ${++projects}` });
  await store.updateProject(project.id, (p) => ({ ...p, model_policy: policy }));
  const created = await streams.create('human', {
    title: 'Rename getUser',
    goal: 'Rename it and its call sites.',
    project: project.id,
  });
  return streams.get(created.id);
}

function service(leftOut?: Map<SessionVendor, string>): ModelPolicyService {
  return new ModelPolicyService({
    store,
    streams,
    ...(leftOut !== undefined ? { leftOut: () => leftOut } : {}),
  });
}

const KEPT = vendorsLeftOut({
  cursor: {
    vendor: 'cursor',
    label: 'Cursor',
    checked_at: '2026-09-30T09:00:00.000Z',
    logged_in: true,
    model: 'kept',
    effort: 'not_applicable',
    turn_tokens: false,
    resume: 'not_supported',
  },
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-routing-checks-'));
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
});

afterEach(async () => {
  await store.flush();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

describe('T489: Choose and the vendor self-check', () => {
  test('no check on file: the pick is unchanged', async () => {
    const stream = await nodeUnder({ mode: 'choose', presets: PRESETS });
    const { pick } = await service().pickForStart({ stream, fallback: FALLBACK });
    expect(pick).toMatchObject({ vendor: 'cursor', model: 'grok-4.7', how: 'rule' });
    expect(pick.why).not.toContain('left out');
    const empty = await service(new Map()).pickForStart({ stream, fallback: FALLBACK });
    expect(empty.pick).toEqual(pick);
  });

  test('a vendor whose last check kept its own model is left out of the candidates, and the why says so', async () => {
    const stream = await nodeUnder({ mode: 'choose', presets: PRESETS });
    const { pick } = await service(KEPT).pickForStart({ stream, fallback: FALLBACK });
    expect(pick).toMatchObject({ vendor: 'claude', model: 'claude-opus-5-5', how: 'rule' });
    expect(pick.why).toEndWith('; left out Cursor: its last check kept its own model');
    // Try it reads the same.
    const tried = await service(KEPT).tryTask({ text: 'Rename getUser', node: stream.id });
    expect(tried.pick.vendor).toBe('claude');
    expect(tried.pick.why).toContain('left out Cursor: its last check kept its own model');
  });

  test('never under Default, never for an explicit pick, and never when it would leave no preset', async () => {
    const byDefault = await nodeUnder({ mode: 'default', presets: PRESETS });
    const d = await service(KEPT).pickForStart({
      stream: byDefault,
      fallback: { vendor: 'cursor', model: 'grok-4.7', effort: 'low' },
    });
    expect(d.pick).toMatchObject({ vendor: 'cursor', model: 'grok-4.7' });
    expect(d.pick.why).not.toContain('left out');

    const chosen = await nodeUnder({ mode: 'choose', presets: PRESETS });
    const e = await service(KEPT).pickForStart({
      stream: chosen,
      fallback: FALLBACK,
      explicit: { vendor: 'cursor', model: 'grok-4.7', effort: 'low' },
    });
    expect(e.pick).toMatchObject({ vendor: 'cursor', how: 'explicit', why: 'your pick' });

    const onlyCursor = await nodeUnder({
      mode: 'choose',
      presets: [{ vendor: 'cursor', model: 'grok-4.7' }],
    });
    const o = await service(KEPT).pickForStart({ stream: onlyCursor, fallback: FALLBACK });
    expect(o.pick).toMatchObject({ vendor: 'cursor', model: 'grok-4.7' });
    expect(o.pick.why).not.toContain('left out');
  });
});
