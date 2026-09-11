import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMessage } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { type PermissionResponderSession, buildPermissionResponder } from './responder';
import type { AcpPermissionRequestParams } from './types';

let repo: string;
let stateRoot: string;
let store: StateStore;

function git(args: string[], cwd: string): void {
  Bun.spawnSync(['git', ...args], { cwd });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-permissions-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'initial commit'], repo);
  const init = runInit(repo);
  stateRoot = init.stateRoot;
  store = StateStore.open(stateRoot);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const STANDARD_OPTIONS = [
  { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' as const },
  { optionId: 'allow-with-updates', name: 'Yes, always', kind: 'allow_always' as const },
  { optionId: 'reject', name: 'No', kind: 'reject_once' as const },
];

function request(kind: string, rawInput: Record<string, unknown> = {}): AcpPermissionRequestParams {
  return {
    sessionId: 's1',
    toolCall: { toolCallId: 'tc-1', kind, rawInput },
    options: STANDARD_OPTIONS,
  };
}

function fakeSession(): PermissionResponderSession & {
  calls: Array<{ id: unknown; result: unknown }>;
} {
  const calls: Array<{ id: unknown; result: unknown }> = [];
  return {
    calls,
    respondPermission(id, result) {
      calls.push({ id, result });
      return true;
    },
  };
}

describe('buildPermissionResponder', () => {
  test('allow: answers the ACP request with allow_once and logs a hook_decision event', async () => {
    const session = fakeSession();
    const responder = buildPermissionResponder(store, {
      role: 'engineer',
      ticket: 'TKT-0001',
      agent: 'eng-1',
      worktreePath: '/work/.worktrees/TKT-0001-x',
      session,
    });

    const decision = await responder.handleRequest(
      7,
      request('edit', { file_path: '/work/.worktrees/TKT-0001-x/src/a.ts' }),
    );

    expect(decision.kind).toBe('allow');
    expect(session.calls).toHaveLength(1);
    expect(session.calls[0]?.id).toBe(7);
    expect(session.calls[0]?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    const events = store.listEvents().filter((e) => e.kind === 'hook_decision');
    expect(events).toHaveLength(1);
    expect(events[0]?.data.decision).toBe('allow');
    expect(events[0]?.data.role).toBe('engineer');
  });

  test('deny: answers with reject_once and logs the reason', async () => {
    const session = fakeSession();
    const responder = buildPermissionResponder(store, {
      role: 'reviewer',
      ticket: 'TKT-0001',
      agent: 'reviewer-1',
      worktreePath: '/qa/env',
      session,
    });

    await responder.handleRequest(1, request('edit', { file_path: '/qa/env/src/a.ts' }));

    expect(session.calls[0]?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
    const events = store.listEvents().filter((e) => e.kind === 'hook_decision');
    expect(events[0]?.data.decision).toBe('deny');
    expect(typeof events[0]?.data.reason).toBe('string');
  });

  test('hil: writes a hil_request message with a deadline instead of answering, then resolveHil answers it', async () => {
    const session = fakeSession();
    const responder = buildPermissionResponder(store, {
      role: 'engineer',
      ticket: 'TKT-0001',
      agent: 'eng-1',
      worktreePath: '/work/.worktrees/TKT-0001-x',
      session,
    });

    const decision = await responder.handleRequest(
      42,
      request('execute', { command: 'git push origin main' }),
    );
    expect(decision.kind).toBe('hil');
    expect(session.calls).toHaveLength(0); // still pending
    expect(responder.pendingHilCount()).toBe(1);

    const events = store.listEvents().filter((e) => e.kind === 'hook_decision');
    expect(events[0]?.data.decision).toBe('hil');

    // The message is discoverable through the generic entity trio at the
    // documented path (bus/inbox/human/<id>.yaml).
    if (decision.kind !== 'hil') throw new Error('unreachable');
    // We don't get the message id back from handleRequest directly, so
    // recover it the same way a real consumer would: list the human inbox
    // directory the responder wrote into.
    const files = readdirSync(join(stateRoot, 'bus', 'inbox', 'human'));
    expect(files).toHaveLength(1);
    const id = files[0]?.replace(/\.yaml$/, '') ?? '';
    expect(id).not.toBe('');

    const message = store.getEntity(join('bus', 'inbox', 'human', `${id}.yaml`), validateMessage);
    expect(message.kind).toBe('hil_request');
    expect(message.hil_kind).toBe('unblock');
    expect(message.to).toEqual(['human']);
    expect(message.deadline).toBeDefined();
    expect(message.ticket).toBe('TKT-0001');

    const resolved = await responder.resolveHil(id, { optionId: 'allow-once' });
    expect(resolved).toBe(true);
    expect(session.calls).toHaveLength(1);
    expect(session.calls[0]?.id).toBe(42);
    expect(session.calls[0]?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(responder.pendingHilCount()).toBe(0);

    // Review-round fix: resolveHil must not ack/delete the message itself —
    // that lifecycle belongs to T018's GateService (or T006's bus ack), not
    // this module.
    expect(store.getEntity(join('bus', 'inbox', 'human', `${id}.yaml`), validateMessage).id).toBe(
      id,
    );
  });

  test('resolveHil returns false for an unknown/already-resolved id', async () => {
    const session = fakeSession();
    const responder = buildPermissionResponder(store, {
      role: 'engineer',
      ticket: 'TKT-0001',
      agent: 'eng-1',
      worktreePath: '/work/.worktrees/TKT-0001-x',
      session,
    });
    expect(await responder.resolveHil('nonexistent', { optionId: 'allow-once' })).toBe(false);
  });

  test('requestHil is injectable, so T018 can own persistence instead of the default store writer', async () => {
    const session = fakeSession();
    const calls: Array<{
      ticket: string;
      agent: string;
      hilKind: string;
      summary: string;
      deadline: string;
    }> = [];
    const responder = buildPermissionResponder(store, {
      role: 'engineer',
      ticket: 'TKT-0001',
      agent: 'eng-1',
      worktreePath: '/work/.worktrees/TKT-0001-x',
      session,
      requestHil: async (input) => {
        calls.push(input);
        return { id: 'custom-id-1' };
      },
    });

    const decision = await responder.handleRequest(
      99,
      request('execute', { command: 'git push origin main' }),
    );
    expect(decision.kind).toBe('hil');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ticket).toBe('TKT-0001');
    expect(calls[0]?.agent).toBe('eng-1');
    expect(calls[0]?.hilKind).toBe('unblock');

    // No message was written to the default bus path — the injected
    // callback owns persistence entirely.
    expect(() => readdirSync(join(stateRoot, 'bus', 'inbox', 'human'))).toThrow();

    const resolved = await responder.resolveHil('custom-id-1', { optionId: 'allow-once' });
    expect(resolved).toBe(true);
    expect(session.calls[0]?.id).toBe(99);
  });
});
