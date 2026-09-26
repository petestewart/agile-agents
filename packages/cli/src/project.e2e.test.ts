/**
 * T200 acceptance, end to end: `agile project new|list|show|set` against a
 * real in-process daemon on a temp `AGILE_HOME`. No vendor, no network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, Stream } from '@agile-agents/shared';
import { runCli } from './index';
import { type TestDaemon, startTestDaemon } from './test-support';

let daemon: TestDaemon;

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const lines: string[] = [];
  const errs: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (msg: string) => lines.push(String(msg));
  console.error = (msg: string) => errs.push(String(msg));
  try {
    const code = await runCli(argv, daemon.repo);
    return { code, out: lines.join('\n'), err: errs.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

beforeEach(async () => {
  daemon = await startTestDaemon('agile-project-e2e-');
});

afterEach(async () => {
  await daemon.cleanup();
});

describe('agile project against a daemon on a temp AGILE_HOME', () => {
  test('new prints JSON with id and root, and writes the root stream', async () => {
    expect((await cli(['repo', 'add', daemon.repo, '--name', 'shop-web'])).code).toBe(0);
    const made = await cli(['project', 'new', '--name', 'Shop', '--repo', 'shop-web', '--json']);
    expect(made.err).toBe('');
    expect(made.code).toBe(0);
    const project = JSON.parse(made.out) as Project;
    expect(project.id).toMatch(/^P-/);
    expect(project.repos).toEqual(['shop-web']);
    expect(existsSync(join(daemon.home, 'projects', `${project.id}.yaml`))).toBe(true);
    expect(existsSync(join(daemon.home, 'streams', `${project.root}.yaml`))).toBe(true);
    const root = JSON.parse((await cli(['stream', 'show', project.root, '--json'])).out) as {
      stream: Stream;
    } & Stream;
    expect(root.stream?.id ?? root.id).toBe(project.root);

    const dup = await cli(['project', 'new', '--name', 'shop']);
    expect(dup.code).toBe(1);
    expect(dup.err).toMatch(/already exists/);

    const set = await cli([
      'project',
      'set',
      project.id,
      '--vendor',
      'claude',
      '--effort',
      'high',
      '--director',
      'run',
      '--json',
    ]);
    expect(set.code).toBe(0);
    const updated = JSON.parse(set.out) as Project;
    expect(updated.session).toEqual({ vendor: 'claude', effort: 'high' });
    expect(updated.autonomy.director).toBe('run');

    // T282: the flags T289's script uses, and a node override.
    const organise = await cli([
      'project',
      'set',
      project.id,
      '--coordinator-autonomy',
      'organise',
      '--json',
    ]);
    expect(organise.err).toBe('');
    expect((JSON.parse(organise.out) as Project).autonomy).toEqual({
      coordinator: 'organise',
      director: 'run',
    });
    const node = await cli(['node', 'set', project.root, '--autonomy', 'advise', '--json']);
    expect(node.err).toBe('');
    expect((JSON.parse(node.out) as Stream).autonomy).toBe('advise');
    const inherit = await cli(['node', 'set', project.root, '--autonomy', 'inherit', '--json']);
    expect((JSON.parse(inherit.out) as Stream).autonomy).toBeUndefined();
    expect((await cli(['node', 'set', project.root, '--autonomy', 'wild'])).code).toBe(1);

    // Repeated --repo accumulates (with commas too) on new and set.
    // T206: a repo is registered by its toplevel, so the second one is its own repo.
    const ledger = mkdtempSync(join(tmpdir(), 'agile-project-ledger-'));
    Bun.spawnSync(['git', 'init', '-q'], { cwd: ledger });
    expect((await cli(['repo', 'add', ledger, '--name', 'ledger'])).code).toBe(0);
    const two = await cli([
      'project',
      'new',
      '--name',
      'Two',
      '--repo',
      'shop-web',
      '--repo',
      'ledger',
      '--json',
    ]);
    expect(two.err).toBe('');
    const twoP = JSON.parse(two.out) as Project;
    expect(twoP.repos).toEqual(['shop-web', 'ledger']);
    const reset = await cli([
      'project',
      'set',
      twoP.id,
      '--repo',
      'ledger',
      '--repo',
      'shop-web',
      '--json',
    ]);
    expect((JSON.parse(reset.out) as Project).repos).toEqual(['ledger', 'shop-web']);

    const shown = JSON.parse((await cli(['project', 'show', project.id, '--json'])).out);
    expect(shown).toEqual({ ...updated, autonomy: { coordinator: 'organise', director: 'run' } });
    const listed = JSON.parse((await cli(['project', 'list', '--json'])).out) as Project[];
    expect(listed.map((p) => p.id)).toEqual([project.id, twoP.id]);
    const table = await cli(['project', 'list']);
    expect(table.out).toContain('Shop');
  });
});
