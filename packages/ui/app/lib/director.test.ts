/**
 * T368: the Director page's words. Plain `bun test`, no DOM.
 */

import { describe, expect, test } from 'bun:test';
import type { AutonomyProposal } from '@agile-agents/shared';
import {
  DIRECTOR_AUTONOMY,
  directorHint,
  directorState,
  draftActionLabel,
  draftHeading,
  draftParts,
} from './director';

const session = (status: string) => ({ status, vendor: 'claude', model: 'claude-opus-5-5' });

describe('directorState', () => {
  test('no session yet: the first message starts it', () => {
    const s = directorState(undefined, false);
    expect(s).toEqual({
      text: 'Not started — your first message starts it.',
      working: false,
      live: false,
    });
  });

  test('a turn in flight is Working; a live idle session is Ready', () => {
    expect(directorState(session('running'), true)).toMatchObject({
      text: 'Claude Opus 5.5 · Working',
      working: true,
    });
    expect(directorState(session('starting'), true).working).toBe(true);
    expect(directorState(session('idle'), true)).toMatchObject({
      text: 'Claude Opus 5.5 · Ready',
      working: false,
      live: true,
    });
  });

  test('an ended session sleeps until a message or an event', () => {
    expect(directorState(session('stopped'), false).text).toBe(
      'Claude Opus 5.5 · Asleep — a message or an event wakes it',
    );
    expect(directorState(session('error'), false).text).toContain('error');
  });

  test('the composer hint follows the state', () => {
    expect(directorHint(directorState(session('running'), true))).toMatch(/^Queued/);
    expect(directorHint(directorState(session('idle'), true))).toBe('Goes to the Director now.');
    expect(directorHint(directorState(undefined, false))).toMatch(/^Wakes/);
  });
});

describe('drafts', () => {
  const tree = {
    project: 'P-01ARZ3NDEKTSV4RRFFQ69G5FAV',
    title: 'Show sale prices',
    goal: 'g',
    parts: [
      { title: 'api: add salePrice', goal: 'a', repo: 'api' },
      { title: 'web: show salePrice', goal: 'b', after: [0] },
    ],
  };
  const names = (id: string) => (id === tree.project ? 'Shop' : undefined);
  const titles = (id: string) => (id === 'N1' ? 'Changelog' : undefined);

  test('the button says what it does', () => {
    expect(draftActionLabel({ action: 'create_tree' })).toBe('Create');
    expect(draftActionLabel({ action: 'create_project' })).toBe('Create');
    expect(draftActionLabel({ action: 'start_node' })).toBe('Start');
    expect(draftActionLabel({ action: 'restart_node' })).toBe('Restart');
    expect(draftActionLabel({ action: 'add_waits_on' })).toBe('Apply');
  });

  test('the heading names the project or node, never an id', () => {
    const change = (c: unknown) => c as AutonomyProposal['change'];
    expect(draftHeading(change({ action: 'create_tree', tree }), names, titles)).toBe(
      'New work in Shop',
    );
    expect(
      draftHeading(
        change({
          action: 'create_tree',
          tree: { ...tree, project: undefined, new_project: 'Blog' },
        }),
        names,
        titles,
      ),
    ).toBe('New work in Blog');
    expect(draftHeading(change({ action: 'start_node', node: 'N1' }), names, titles)).toBe(
      'Start Changelog',
    );
    expect(draftHeading(change({ action: 'restart_node', node: 'N9' }), names, titles)).toBe(
      'Restart a node',
    );
    expect(draftHeading(change({ action: 'create_project', name: 'Docs' }), names, titles)).toBe(
      'New project Docs',
    );
  });

  test('parts carry their repo and what they wait on, by title', () => {
    expect(draftParts(tree)).toEqual([
      { title: 'api: add salePrice', goal: 'a', repo: 'api', waitsOn: [] },
      { title: 'web: show salePrice', goal: 'b', waitsOn: ['api: add salePrice'] },
    ]);
  });

  test('every autonomy level has a label and a sentence', () => {
    for (const level of Object.values(DIRECTOR_AUTONOMY)) {
      expect(level.label).toMatch(/^[A-Z]/);
      expect(level.hint).toMatch(/\.$/);
    }
  });
});
