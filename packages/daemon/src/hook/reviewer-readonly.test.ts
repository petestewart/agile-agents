/**
 * T131 acceptance criterion, proven at the enforcement tier rather than in
 * the brief: **a reviewer cannot write in the worktree**
 * (design/cockpit-design.md §4.2 — "a read-only permission policy: every
 * write tool is denied at the hook, and a test proves the denial rather
 * than trusting the brief").
 *
 * Everything here goes through `HookService.preToolUse` with a real
 * registry entry whose `role` is `reviewer` — the same path a live
 * reviewer session's tool call takes (§8.1 step 1: the call's `cwd` is
 * resolved to a session through the registry, and that session's role is
 * what the policy table is applied under). No brief, no prompt, no vendor.
 *
 * The contrast case matters as much as the denials: the same call from a
 * `worker` entry in the same worktree is allowed, so these tests fail if
 * the gate ever stops being role-dependent.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentId, AgentRecord, SessionRole } from '@agile-agents/shared';
import { Bus } from '../bus';
import { runInit } from '../init';
import { StateStore } from '../store';
import { HookService } from './service';

let repo: string;
let store: StateStore;
let bus: Bus;
let worktree: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-reviewer-readonly-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  const init = runInit(repo);
  store = StateStore.open(init.stateRoot);
  bus = new Bus(store, init.stateRoot);
  worktree = join(repo, '.worktrees', 'stream-1');
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, 'a.ts'), 'export const a = 1;\n');
});

async function register(agent: string, role: SessionRole): Promise<void> {
  const record: AgentRecord = {
    vendor: 'claude',
    model: 'claude-sonnet-4-5',
    stream: '01J9BBBBBBBBBBBBBBBBBBBBBB',
    last_seen: new Date().toISOString(),
    role,
    worktree,
  };
  await store.putAgent(agent as AgentId, record);
}

function service(): HookService {
  return new HookService(store, bus, { repoRoot: repo });
}

/** Every write tool Claude exposes — the whole set, not a sample. */
const WRITE_TOOLS: { tool: string; input: Record<string, unknown> }[] = [
  { tool: 'Write', input: { file_path: join('WORKTREE', 'a.ts'), content: 'x' } },
  { tool: 'Edit', input: { file_path: join('WORKTREE', 'a.ts') } },
  { tool: 'MultiEdit', input: { file_path: join('WORKTREE', 'a.ts') } },
  { tool: 'NotebookEdit', input: { notebook_path: join('WORKTREE', 'nb.ipynb') } },
];

describe('a reviewer cannot write in the worktree (§4.2)', () => {
  test('every edit tool is denied for a session registered as reviewer', async () => {
    await register('01ARZ3NDEKTSV4RRFFQ69GR001', 'reviewer');
    const svc = service();

    for (const { tool, input } of WRITE_TOOLS) {
      const result = await svc.preToolUse({
        cwd: worktree,
        tool_name: tool,
        tool_input: Object.fromEntries(
          Object.entries(input).map(([k, v]) => [
            k,
            typeof v === 'string' ? v.replace('WORKTREE', worktree) : v,
          ]),
        ),
        agile_agent: '01ARZ3NDEKTSV4RRFFQ69GR001',
      });
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toMatch(
        /reviewer role denies all writes/,
      );
    }
  });

  test('write-shaped Bash is denied, read-only Bash is allowed', async () => {
    await register('01ARZ3NDEKTSV4RRFFQ69GR001', 'reviewer');
    const svc = service();

    const denied = [
      'rm -rf src',
      `echo hacked > ${join(worktree, 'a.ts')}`,
      'git commit -am wip',
      'git push origin HEAD',
      `sed -i s/a/b/ ${join(worktree, 'a.ts')}`,
      'npm install left-pad',
    ];
    for (const command of denied) {
      const result = await svc.preToolUse({
        cwd: worktree,
        tool_name: 'Bash',
        tool_input: { command },
        agile_agent: '01ARZ3NDEKTSV4RRFFQ69GR001',
      });
      expect({ command, decision: result.hookSpecificOutput.permissionDecision }).toEqual({
        command,
        decision: 'deny',
      });
    }

    // `git push` is denied one tier earlier (never-without-human), so only
    // the plain write-shaped commands carry the role's own reason.
    const roleDenied = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf src' },
      agile_agent: '01ARZ3NDEKTSV4RRFFQ69GR001',
    });
    expect(roleDenied.hookSpecificOutput.permissionDecisionReason).toMatch(/reviewer role denies/);

    // Reading the diff is the reviewer's entire job — it must still work.
    for (const command of ['git diff HEAD~1', 'git log --oneline -20', 'grep -rn TODO src']) {
      const result = await svc.preToolUse({
        cwd: worktree,
        tool_name: 'Bash',
        tool_input: { command },
        agile_agent: '01ARZ3NDEKTSV4RRFFQ69GR001',
      });
      expect({ command, decision: result.hookSpecificOutput.permissionDecision }).toEqual({
        command,
        decision: 'allow',
      });
    }
  });

  test('the same worktree, the same tool, a worker entry: allowed — the gate is the role', async () => {
    await register('worker-1', 'worker');
    const svc = service();
    const result = await svc.preToolUse({
      cwd: worktree,
      tool_name: 'Edit',
      tool_input: { file_path: join(worktree, 'a.ts') },
      agile_agent: 'worker-1',
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});
