/**
 * `agile land <stream>` against a real in-process daemon socket and a real
 * git repo — no fakes (T132). The daemon side is covered by
 * `packages/daemon/src/delivery/service.test.ts`; what this asserts is the
 * CLI contract: the thread line on stdout, `--json`, and the exit codes.
 *
 * It wires its own RPC server rather than `test-support.ts`'s shared one:
 * landing needs a repo registered in `repos.yaml` and a stream with a real
 * branch, which is setup no other command test wants.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeliveryService,
  type RpcServerHandle,
  StateStore,
  StreamService,
  buildDeliveryRpcMethods,
  runInit,
  startRpcServer,
} from '@agile-agents/daemon';
import { parseArgs } from '../args';
import { runLand } from './land';

let home: string;
let repo: string;
let store: StateStore;
let streams: StreamService;
let rpc: RpcServerHandle;
let socketPath: string;

function git(args: string[], cwd = repo): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function capture(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(String(msg));
  try {
    return { code: await run(), out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

/** A stream with a branch that has one commit beyond main. */
async function streamWithWork(name: string, file: string, contents: string): Promise<string> {
  const worktree = join(repo, '.worktrees', name);
  git(['worktree', 'add', '-q', '-b', name, worktree, 'main']);
  writeFileSync(join(worktree, file), contents);
  git(['add', '-A'], worktree);
  git(['commit', '-q', '-m', name], worktree);
  const stream = await streams.create('human', { title: name, goal: 'ship it', repo: 'demo' });
  await streams.update('daemon', stream.id, { branch: name, worktree });
  return stream.id;
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'agile-cli-land-repo-'));
  home = join(repo, 'home');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);

  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  await store.putRepos({ demo: { path: repo, protected_branches: ['main'] } });
  socketPath = join(home, 'agiled.sock');
  rpc = startRpcServer({
    socketPath,
    version: 'test',
    stateRoot: init.stateRoot,
    startedAt: Date.now(),
    extraMethods: buildDeliveryRpcMethods(new DeliveryService({ store, streams })),
  });
  await rpc.listening;
});

afterEach(async () => {
  await rpc.close();
  await store.flush();
  store.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('agile land <stream>', () => {
  test('prints the thread line the daemon wrote and exits 0', async () => {
    const id = await streamWithWork('s-cli', 'feature.txt', 'feature\n');
    const { code, out } = await capture(() => runLand(socketPath, parseArgs([id]), false));
    expect(code).toBe(0);
    expect(out).toContain('landed s-cli into main');
    expect(streams.get(id).human.status).toBe('landed');
    expect(git(['show', 'main:feature.txt'])).toBe('feature');
  });

  test('--json prints the whole outcome', async () => {
    const id = await streamWithWork('s-json', 'a.txt', 'a\n');
    const { out } = await capture(() => runLand(socketPath, parseArgs([id, '--json']), true));
    const parsed = JSON.parse(out) as { status: string; target: string; sha: string };
    expect(parsed.status).toBe('landed');
    expect(parsed.target).toBe('main');
    expect(parsed.sha).toBe(git(['rev-parse', 'refs/heads/main']));
  });

  test('a conflict prints the conflicting files and exits 1', async () => {
    const id = await streamWithWork('s-cli-conflict', 'shared.txt', 'from the stream\n');
    writeFileSync(join(repo, 'shared.txt'), 'from main\n');
    git(['add', 'shared.txt']);
    git(['commit', '-q', '-m', 'main writes shared.txt']);

    const { code, out } = await capture(() => runLand(socketPath, parseArgs([id]), false));
    expect(code).toBe(1);
    expect(out).toContain('conflicted in: shared.txt');
    expect(streams.get(id).agent.status).toBe('blocked');
  });

  test('agile deliver: delivery.deliver sets delivery_state merged (T223)', async () => {
    const id = await streamWithWork('s-deliver', 'd.txt', 'd\n');
    const { code } = await capture(() => runLand(socketPath, parseArgs([id]), false));
    expect(code).toBe(0);
    expect(streams.get(id).delivery_state?.status).toBe('merged');
  });

  test('a refusal surfaces as a CLI error, not a stack trace', async () => {
    const stream = await streams.create('human', { title: 'planning', goal: 'think' });
    expect(runLand(socketPath, parseArgs([stream.id]), false)).rejects.toThrow(
      'planning has no repo — there is nothing to merge',
    );
  });

  test('a missing stream id is a usage error', async () => {
    expect(runLand(socketPath, parseArgs([]), false)).rejects.toThrow(/stream-id/);
  });
});
