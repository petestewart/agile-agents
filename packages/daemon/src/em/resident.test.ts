/**
 * T041 — the resident EM session. Driven against the real `fake-agent.ts`
 * ACP subprocess (the same `fakeProvider` shape `em/delegate.test.ts` and
 * `runner/session.test.ts` use), so the streaming, the queueing and the
 * respawn are exercised over real ACP framing, with no vendor login.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, type AcpProviderConfig } from '@agile-agents/acp-client';
import { runInit } from '../init';
import type { FakeAgentScript } from '../runner/fake-agent';
import { StateStore } from '../store';
import { ResidentEm } from './resident';

const FAKE_AGENT_PATH = join(import.meta.dir, '..', 'runner', 'fake-agent.ts');

let repo: string;
let store: StateStore;
let scriptSeq = 0;

function fakeProvider(script: FakeAgentScript): AcpProviderConfig {
  const scriptPath = join(repo, `script-${scriptSeq++}.json`);
  writeFileSync(scriptPath, JSON.stringify(script));
  return {
    ...ACP_PROVIDERS.claude,
    command: 'bun',
    args: [FAKE_AGENT_PATH],
    envOverrides: { AGILE_FAKE_AGENT_SCRIPT: scriptPath },
  };
}

async function collect(turn: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of turn) out.push(chunk);
  return out;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-em-resident-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  // The resident session's permission responder writes its `hook_decision`
  // events through the store, so every test needs a real one.
  store = StateStore.open(runInit(repo).stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('ResidentEm', () => {
  test('streams a turn as deltas and resolves done with the full reply', async () => {
    const em = new ResidentEm({
      cwd: repo,
      store,
      provider: fakeProvider({
        steps: [
          { type: 'agent_text', text: 'TKT-1001 is in review, ' },
          { type: 'agent_text', text: 'TKT-1002 is unassigned.' },
          { type: 'end_turn' },
        ],
      }),
    });
    try {
      const turn = em.prompt('what is left on all tickets');
      expect(await collect(turn)).toEqual(['TKT-1001 is in review, ', 'TKT-1002 is unassigned.']);
      expect(await turn.done).toBe('TKT-1001 is in review, TKT-1002 is unassigned.');
      expect(em.alive).toBe(true);
    } finally {
      em.stop();
    }
  }, 20000);

  test('keeps ONE session across turns and sends the brief only on the first', async () => {
    const logFile = join(repo, 'prompts.jsonl');
    const em = new ResidentEm({
      cwd: repo,
      store,
      brief: () => '# EM brief — em',
      provider: fakeProvider({
        logFile,
        steps: [{ type: 'agent_text', text: 'ack' }, { type: 'end_turn' }],
      }),
    });
    try {
      await em.prompt('first').done;
      await em.prompt('second').done;
      const prompts = readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { method: string; params: unknown })
        .filter((l) => l.method === 'session/prompt')
        .map((l) => JSON.stringify(l.params));
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain('EM brief');
      expect(prompts[0]).toContain('first');
      expect(prompts[1]).not.toContain('EM brief');
      expect(prompts[1]).toContain('second');
    } finally {
      em.stop();
    }
  }, 20000);

  test('serialises concurrent prompts — one turn at a time, in order', async () => {
    const em = new ResidentEm({
      cwd: repo,
      store,
      provider: fakeProvider({
        steps: [{ type: 'agent_text', text: 'done' }, { type: 'end_turn' }],
      }),
    });
    try {
      const settled: string[] = [];
      const a = em.prompt('a').done.then(() => settled.push('a'));
      const b = em.prompt('b').done.then(() => settled.push('b'));
      await Promise.all([a, b]);
      expect(settled).toEqual(['a', 'b']);
    } finally {
      em.stop();
    }
  }, 20000);

  test('a killed session is respawned by the next prompt', async () => {
    const pidFile = join(repo, 'agent.pid');
    const provider = fakeProvider({
      steps: [{ type: 'agent_text', text: 'still here' }, { type: 'end_turn' }],
    });
    const em = new ResidentEm({
      cwd: repo,
      store,
      provider: {
        ...provider,
        envOverrides: { ...provider.envOverrides, AGILE_FAKE_AGENT_PIDFILE: pidFile },
      },
    });
    try {
      await em.prompt('first').done;
      expect(existsSync(pidFile)).toBe(true);
      const firstPid = Number(readFileSync(pidFile, 'utf8').trim());

      em.kill();
      expect(em.alive).toBe(false);

      expect(await em.prompt('after the kill').done).toBe('still here');
      expect(em.alive).toBe(true);
      const secondPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(secondPid).not.toBe(firstPid);
    } finally {
      em.stop();
    }
  }, 20000);

  test('a hung turn times out, ends the delta stream with the error, and the next turn recovers', async () => {
    const hung = new ResidentEm({
      cwd: repo,
      store,
      timeoutMs: 400,
      provider: fakeProvider({
        steps: [{ type: 'agent_text', text: 'thinking' }, { type: 'hang' }],
      }),
    });
    try {
      const turn = hung.prompt('hello?');
      await expect(collect(turn)).rejects.toThrow(/timed out/);
      await expect(turn.done).rejects.toThrow(/timed out/);
      expect(hung.alive).toBe(false);
    } finally {
      hung.stop();
    }
  }, 20000);

  /**
   * T041 review round 1 (blocker): the resident session attaches listeners,
   * which disables `acp-client`'s "no listener -> auto-refuse" fallback — so
   * it must answer `session/request_permission` itself, per the §14 EM row.
   */
  test('answers an edit and an exec permission request with the em policy, and the turn still completes', async () => {
    const editResult = join(repo, 'edit-answer.json');
    const execResult = join(repo, 'exec-answer.json');
    const options = [
      { optionId: 'allow', kind: 'allow_once' },
      { optionId: 'reject', kind: 'reject_once' },
    ];
    const em = new ResidentEm({
      cwd: repo,
      store,
      provider: fakeProvider({
        steps: [
          {
            type: 'request_permission',
            toolCall: { toolCallId: 't1', kind: 'edit', title: 'Edit src/index.ts' },
            options,
            resultFile: editResult,
          },
          {
            type: 'request_permission',
            toolCall: { toolCallId: 't2', kind: 'execute', title: 'Run npm test' },
            options,
            resultFile: execResult,
          },
          { type: 'agent_text', text: 'both refused, here is what I know instead' },
          { type: 'end_turn' },
        ],
      }),
    });
    try {
      expect(await em.prompt('what is left on all tickets').done).toBe(
        'both refused, here is what I know instead',
      );
      expect(JSON.parse(readFileSync(editResult, 'utf8'))).toEqual({
        outcome: { outcome: 'selected', optionId: 'reject' },
      });
      expect(JSON.parse(readFileSync(execResult, 'utf8'))).toEqual({
        outcome: { outcome: 'selected', optionId: 'reject' },
      });
      // Every verdict is on the audit trail, same as a ticket session's.
      const decisions = store.listEvents().filter((e) => e.kind === 'hook_decision');
      expect(decisions).toHaveLength(2);
      expect(decisions.every((e) => e.data.role === 'em' && e.data.decision === 'deny')).toBe(true);
    } finally {
      em.stop();
    }
  }, 20000);

  test('a never-without-human request is refused rather than parked — it can never hang the turn', async () => {
    const pushResult = join(repo, 'push-answer.json');
    const em = new ResidentEm({
      cwd: repo,
      store,
      // Well under the fake agent's own pace: if the request were parked
      // (the pre-fix behaviour), the turn would time out instead of
      // completing, and `done` would reject.
      timeoutMs: 8000,
      provider: fakeProvider({
        steps: [
          {
            type: 'request_permission',
            toolCall: { toolCallId: 't1', kind: 'execute', title: 'Run git push origin main' },
            options: [
              { optionId: 'allow', kind: 'allow_once' },
              { optionId: 'reject', kind: 'reject_once' },
            ],
            resultFile: pushResult,
          },
          { type: 'agent_text', text: 'refused' },
          { type: 'end_turn' },
        ],
      }),
    });
    try {
      expect(await em.prompt('push my branch for me').done).toBe('refused');
      // `hil` has nowhere to park for an EM session (no ticket, no waiting
      // engineer), so it is answered `cancelled` — refused, fail closed.
      // `git push origin main` is a `hil` verdict from the universal
      // never-without-human list (verified: `decidePermission` returns
      // kind 'hil' for this request under role `em`).
      expect(JSON.parse(readFileSync(pushResult, 'utf8'))).toEqual({
        outcome: { outcome: 'cancelled' },
      });
      const refusal = store
        .listEvents()
        .find((e) => e.kind === 'hook_decision' && e.data.decision === 'hil');
      expect(refusal).toBeDefined();
    } finally {
      em.stop();
    }
  }, 20000);

  test('stop() refuses further turns', async () => {
    const em = new ResidentEm({
      cwd: repo,
      store,
      provider: fakeProvider({ steps: [{ type: 'end_turn' }] }),
    });
    em.stop();
    await expect(em.prompt('anything').done).rejects.toThrow(/stopped/);
  });
});
