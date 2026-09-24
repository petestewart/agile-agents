/**
 * T200 acceptance, end to end: `agile project new|list|show|set` against a
 * real in-process daemon on a temp `AGILE_HOME`. No vendor, no network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
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

    const shown = JSON.parse((await cli(['project', 'show', project.id, '--json'])).out);
    expect(shown).toEqual(updated);
    const listed = JSON.parse((await cli(['project', 'list', '--json'])).out) as Project[];
    expect(listed.map((p) => p.id)).toEqual([project.id]);
    const table = await cli(['project', 'list']);
    expect(table.out).toContain('Shop');
  });
});
