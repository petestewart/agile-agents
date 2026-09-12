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
import type { FakeAgentScript } from '../runner/fake-agent';
import { ResidentEm } from './resident';

const FAKE_AGENT_PATH = join(import.meta.dir, '..', 'runner', 'fake-agent.ts');

let repo: string;
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
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('ResidentEm', () => {
  test('streams a turn as deltas and resolves done with the full reply', async () => {
    const em = new ResidentEm({
      cwd: repo,
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

  test('stop() refuses further turns', async () => {
    const em = new ResidentEm({
      cwd: repo,
      provider: fakeProvider({ steps: [{ type: 'end_turn' }] }),
    });
    em.stop();
    await expect(em.prompt('anything').done).rejects.toThrow(/stopped/);
  });
});
