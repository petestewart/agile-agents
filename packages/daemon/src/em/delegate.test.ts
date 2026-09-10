import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, type AcpProviderConfig } from '@agile-agents/acp-client';
import { runInit } from '../init';
import type { FakeAgentScript } from '../runner/fake-agent';
import { StateStore } from '../store';
import { createEmSessionDelegate, parseEmDecision, renderEmDecisionPrompt } from './delegate';

const FAKE_AGENT_PATH = join(import.meta.dir, '..', 'runner', 'fake-agent.ts');

let repo: string;
let stateRoot: string;

/** A provider that runs the fake ACP agent with `script` — the same shape `runner/session.test.ts`'s `fakeProvider` uses. */
function fakeProvider(script: FakeAgentScript): AcpProviderConfig {
  const scriptPath = join(repo, `${Bun.hash(JSON.stringify(script)).toString(36)}.json`);
  writeFileSync(scriptPath, JSON.stringify(script));
  return {
    ...ACP_PROVIDERS.claude,
    command: 'bun',
    args: [FAKE_AGENT_PATH],
    envOverrides: { AGILE_FAKE_AGENT_SCRIPT: scriptPath },
  };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-em-delegate-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  stateRoot = runInit(repo).stateRoot;
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('parseEmDecision', () => {
  test('takes the last DECISION line and the text before it as rationale', () => {
    expect(
      parseEmDecision('Pushing to the ticket branch is scoped work.\n\nDECISION: approve\n'),
    ).toEqual({ decision: 'approve', rationale: 'Pushing to the ticket branch is scoped work.' });
    expect(
      parseEmDecision('first thoughts\nDECISION: approve\nreconsidered\nDECISION: DENY'),
    ).toEqual({
      decision: 'deny',
      rationale: 'first thoughts DECISION: approve reconsidered',
    });
  });

  test('no decision line -> undefined (the delegate then fails closed)', () => {
    expect(parseEmDecision('I think this is fine.')).toBeUndefined();
    expect(parseEmDecision('')).toBeUndefined();
  });
});

describe('renderEmDecisionPrompt', () => {
  test('is the real EM brief plus the request, and asks for the DECISION line', () => {
    const store = StateStore.open(stateRoot);
    const prompt = renderEmDecisionPrompt(store, {
      gate: 'unblock',
      owner: 'em',
      ticket: 'TKT-0001' as never,
      hilKind: 'unblock',
      summary: 'eng-0001 asked to run `git push origin main` — push to main is never automatic',
    });
    expect(prompt).toContain('# EM brief — em');
    expect(prompt).toContain('## Gate decision requested');
    expect(prompt).toContain('`unblock` gate');
    expect(prompt).toContain('git push origin main');
    expect(prompt).toContain('DECISION: approve');
  });
});

describe('createEmSessionDelegate (fake ACP agent)', () => {
  test('a reply ending in DECISION: approve resolves approve with the rationale, by em', async () => {
    const delegate = createEmSessionDelegate({
      stateRoot,
      cwd: repo,
      provider: fakeProvider({
        steps: [
          { type: 'agent_text', text: 'Scoped to the ticket branch, safe.\nDECISION: approve' },
          { type: 'end_turn' },
        ],
      }),
      timeoutMs: 20_000,
    });
    const decision = await delegate({ gate: 'unblock', owner: 'em', hilKind: 'unblock' });
    expect(decision).toEqual({
      decision: 'approve',
      by: 'em',
      rationale: 'Scoped to the ticket branch, safe.',
    });
  });

  test('DECISION: deny resolves deny', async () => {
    const delegate = createEmSessionDelegate({
      stateRoot,
      cwd: repo,
      provider: fakeProvider({
        steps: [
          { type: 'agent_text', text: 'Touches main.\nDECISION: deny' },
          { type: 'end_turn' },
        ],
      }),
      timeoutMs: 20_000,
    });
    const decision = await delegate({ gate: 'unblock', owner: 'em' });
    expect(decision.decision).toBe('deny');
    expect(decision.rationale).toBe('Touches main.');
  });

  test('an answer with no DECISION line fails closed (deny) and says why', async () => {
    const delegate = createEmSessionDelegate({
      stateRoot,
      cwd: repo,
      provider: fakeProvider({
        steps: [{ type: 'agent_text', text: 'Hmm, it depends.' }, { type: 'end_turn' }],
      }),
      timeoutMs: 20_000,
    });
    const decision = await delegate({ gate: 'unblock', owner: 'em' });
    expect(decision.decision).toBe('deny');
    expect(decision.rationale).toContain('without a DECISION line');
  });

  test('a session that never answers fails closed at the timeout', async () => {
    const notices: string[] = [];
    const delegate = createEmSessionDelegate({
      stateRoot,
      cwd: repo,
      provider: fakeProvider({ steps: [{ type: 'hang' }] }),
      timeoutMs: 1_500,
      onNotice: (line) => notices.push(line),
    });
    const decision = await delegate({ gate: 'unblock', owner: 'em' });
    expect(decision.decision).toBe('deny');
    expect(decision.rationale).toContain('timed out');
    expect(notices.some((n) => n.includes('denying (fail closed)'))).toBe(true);
  }, 15_000);
});
