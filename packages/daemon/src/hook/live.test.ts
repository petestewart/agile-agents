/**
 * Live test for the Claude hook gate (T009 acceptance criteria): "an
 * engineer session under a global halt is blocked at its next tool call
 * with the halt reason; a big read is denied and the model's output quotes
 * the reason; an `answer` message appears in the model's context on the
 * next tool call." Needs a real `claude login`'d Claude Code session —
 * CANNOT run in this container (no vendor login) — so it is a no-op unless
 * `AGILE_LIVE=1`, per the ticket's Validation Steps.
 *
 * Wiring: a real `agiled` (`startDaemon`) over a freshly-initialised
 * `.agile/` state, a ticket assigned to `eng-1` with `worktree` pointing at
 * the temp Claude cwd, `writeClaudeSettings` rendering `.claude/
 * settings.json` in that cwd with `agileBin` = `bun <cli entry>` and
 * `socketPath` = the daemon's real socket, then `spawnSession` (T003's
 * `@agile-agents/acp-client`) drives Claude exactly like
 * `spike/permission-matrix.ts` does. Assertions read the final assistant
 * text for the injected/denial reasons, same as
 * `spike/spike-out/claude-default-perm-hooks.json`'s own
 * `hookReasonSeenByModel` check.
 */

import { describe, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS, spawnSession } from '@agile-agents/acp-client';
import { ulid, validateTicket } from '@agile-agents/shared';
import { startDaemon } from '../daemon';
import { createHalt, releaseHalt } from '../halts';
import { runInit } from '../init';
import { StateStore } from '../store';
import { writeClaudeSettings } from './settings';

const live = process.env.AGILE_LIVE === '1' ? it : it.skip;
const CLI_ENTRY = join(import.meta.dir, '..', '..', '..', 'cli', 'src', 'index.ts');

/** Spawns a fresh Claude session in `cwd` (per T003, the settings.json/hooks already written there are picked up by the harness), auto-approves every ACP permission request (this ticket's hook, not ACP, is what's under test), and returns the turn's final assistant text. */
async function promptAndCollectText(cwd: string, text: string): Promise<string> {
  const claude = ACP_PROVIDERS.claude;
  const session = spawnSession({
    cmd: claude.command,
    args: [...claude.args],
    cwd,
    clientCapabilities: claude.clientCapabilities,
  });
  session.on((event) => {
    if (event.type !== 'event') return;
    if (event.event.acp !== 'request' || event.event.method !== 'session/request_permission') {
      return;
    }
    const params = event.event.params as {
      options?: Array<{ kind: string; optionId: string }>;
    };
    const allow = params.options?.find((o) => o.kind === 'allow_once') ?? params.options?.[0];
    session.respondPermission(event.event.id, {
      outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' },
    });
  });
  await session.initialized;
  const reply = await session.prompt(text);
  session.close();
  return reply.text;
}

describe('live: Claude hook gate end-to-end', () => {
  live(
    'halt blocks the next tool call with the halt reason; big read points at read_summary; an answer appears',
    async () => {
      const repo = mkdtempSync(join(tmpdir(), 'agile-hook-live-'));
      const cwd = join(repo, '.worktrees', 'TKT-0001');
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, 'small.txt'), 'alpha\nbeta\ngamma\n');
      for (const args of [
        ['init', '-q'],
        ['add', '.'],
        ['-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-qm', 'init'],
      ]) {
        execFileSync('git', args, { cwd: repo });
      }

      const init = runInit(repo);
      const store = StateStore.open(init.stateRoot);
      await store.putTicket(
        validateTicket({
          id: 'TKT-0001',
          title: 'Live hook test',
          status: 'in_progress',
          contract: {},
          history: [],
          assignee: 'eng-1',
          worktree: join('.worktrees', 'TKT-0001'),
        }),
      );

      const daemon = await startDaemon({ cwd: repo });
      writeClaudeSettings(cwd, {
        agileBin: `bun ${CLI_ENTRY}`,
        socketPath: daemon.config.socketPath,
      });

      try {
        // 1. Global halt blocks the next tool call with the halt reason.
        const halt = await createHalt(store, {
          scope: 'global',
          reason: 'AGILE-HALT: standup called, stand down',
          raised_by: 'architect',
        });
        const haltedText = await promptAndCollectText(cwd, 'read small.txt');
        if (!haltedText.includes(halt.reason)) {
          throw new Error(`expected halt reason in model output, got: ${haltedText}`);
        }
        await releaseHalt(store, halt.id);

        // 2. A big read is denied and the model's output quotes read_summary.
        writeFileSync(join(cwd, 'big.txt'), 'x'.repeat(100 * 1024));
        const bigReadText = await promptAndCollectText(cwd, 'read big.txt');
        if (!bigReadText.includes('read_summary')) {
          throw new Error(`expected read_summary reason in model output, got: ${bigReadText}`);
        }

        // 3. An `answer` message appears in the model's context on the next tool call.
        const { Bus } = await import('../bus');
        const bus = new Bus(store, init.stateRoot);
        await bus.send({
          id: ulid(),
          ts: new Date().toISOString(),
          from: 'em',
          to: ['eng-1'],
          kind: 'answer',
          priority: 'normal',
          body: 'AGILE-ANSWER: use the JWT approach',
          promote_to: 'none',
        });
        const answerText = await promptAndCollectText(cwd, 'read small.txt again');
        if (!answerText.includes('AGILE-ANSWER')) {
          throw new Error(`expected the answer message in model context, got: ${answerText}`);
        }
      } finally {
        await daemon.stop();
      }
    },
  );
});
