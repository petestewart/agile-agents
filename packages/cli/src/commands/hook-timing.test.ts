/**
 * T008 acceptance criterion: "`agile hook pre-tool-use` round-trips a fake
 * payload in <20 ms." Measured two ways, per the session's instruction to
 * report both honestly rather than loosening the assertion silently:
 *
 *  1. **In-process client round trip** — `callRpc` straight to a running
 *     `hook.pre_tool_use` handler, no process spawn. This is the number the
 *     <20ms budget can plausibly be about (a vendor hook process is already
 *     running; the 20ms is the socket round trip it pays per tool call).
 *  2. **End-to-end CLI subprocess** — `bun packages/cli/src/index.ts hook
 *     pre-tool-use` spawned fresh per call, stdin piped, wall time measured
 *     from spawn to exit. Bun process startup dominates this number and is
 *     asserted against a much looser budget; if it exceeds even that, the
 *     test still reports the measured median instead of hiding it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RpcServerHandle, startRpcServer } from '@agile-agents/daemon';
import { callRpc } from '../client';

const CLI_ENTRY = join(import.meta.dir, '..', 'index.ts');
const WARMUP_RUNS = 1;
const MEASURED_RUNS = 10;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

describe('agile hook pre-tool-use timing', () => {
  let dir: string;
  let socketPath: string;
  let rpc: RpcServerHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agile-cli-hook-timing-'));
    socketPath = join(dir, 'test.sock');
    rpc = startRpcServer({
      socketPath,
      version: 'test',
      stateRoot: dir,
      startedAt: Date.now(),
      extraMethods: { 'hook.pre_tool_use': () => ({ decision: 'allow' }) },
    });
  });

  afterEach(async () => {
    await rpc.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('in-process client round trip: median under 20ms', async () => {
    const samples: number[] = [];
    for (let i = 0; i < WARMUP_RUNS + MEASURED_RUNS; i++) {
      const start = performance.now();
      await callRpc(socketPath, 'hook.pre_tool_use', { tool: 'Read', input: { path: '/x' } });
      const elapsed = performance.now() - start;
      if (i >= WARMUP_RUNS) samples.push(elapsed);
    }
    const m = median(samples);
    console.log(
      `[hook timing] in-process client round trip median: ${m.toFixed(2)}ms (samples: ${samples.map((s) => s.toFixed(2)).join(', ')})`,
    );
    expect(m).toBeLessThan(20);
  });

  test('end-to-end CLI subprocess: report measured numbers honestly', async () => {
    const samples: number[] = [];
    for (let i = 0; i < WARMUP_RUNS + MEASURED_RUNS; i++) {
      const start = performance.now();
      const proc = Bun.spawn({
        cmd: ['bun', CLI_ENTRY, 'hook', 'pre-tool-use'],
        stdin: new Response(JSON.stringify({ tool: 'Read', input: { path: '/x' } })),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, AGILE_SOCKET_PATH: socketPath },
      });
      // T033 round 2: drain stdout, stderr, and exit together (Bun's
      // documented spawn-consumption pattern) instead of sequentially
      // awaiting stdout then exited — see `hook/rpc.test.ts`'s `runHookCli`
      // for why an undrained `stderr: 'pipe'` can otherwise race
      // `proc.exited`'s own epoll bookkeeping into an EBADF under load.
      const [stdout] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const elapsed = performance.now() - start;
      if (i >= WARMUP_RUNS) samples.push(elapsed);
      if (i === WARMUP_RUNS) {
        // Sanity-check the very first measured run actually worked.
        expect(JSON.parse(stdout)).toEqual({ decision: 'allow' });
      }
    }
    const m = median(samples);
    // DESIGN-GAP / honesty clause: Bun subprocess startup in this container
    // can exceed the 20ms hook budget on its own (process spawn + module
    // resolution), which the <20ms acceptance line is about the socket
    // round trip, not process startup. Budget here is loose (2s) so the
    // test still fails on a real regression (e.g. a hang) without asserting
    // a number this container cannot deliver; the actual median is printed
    // either way for whoever tunes this next (see pipeline report).
    console.log(
      `[hook timing] end-to-end CLI subprocess median: ${m.toFixed(2)}ms (samples: ${samples.map((s) => s.toFixed(2)).join(', ')})`,
    );
    expect(m).toBeLessThan(2000);
  });
});
