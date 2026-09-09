/**
 * Live re-implementation of the Claude `default`-mode permission scenario
 * (design/spike-findings.md §A) on top of `spawnSession`, per T003's
 * acceptance criterion: "the spike harness `permission-matrix.ts` can be
 * re-implemented on top of it in <100 lines and reproduces the Claude
 * `default` perm table". Runs a real `claude login`'d Claude Code session —
 * CANNOT run in this container (no vendor login) — so it is a no-op unless
 * `AGILE_LIVE=1`, per the ticket's Validation Steps.
 *
 * Assertions are grounded in this repo's own raw capture
 * (spike/spike-out/claude-default-perm.json, the run §A's table was written
 * from), NOT title-regex guessing: every `tool_call`'s `kind` field is
 * 'read' | 'execute' | 'edit' and is present on both the `session/update`
 * tool_call notification and the `session/request_permission` request's
 * `toolCall.kind` (the harness's `onUpdate`/`onAgentRequest` read exactly
 * `u.kind` / `tc.kind`). Titles are generic on the tool_call itself
 * ("Terminal" for every Bash call, "Read File" for every read) — `rawInput`
 * is empty `{}` throughout that capture, so no command text is recoverable
 * from the ACP wire to identify "git status" specifically. Permission
 * *request* titles are prose ("Write \"hi\" to out.txt", "Edit small.txt",
 * "Run npm test") and are used only for the positive assertions, which the
 * capture's `permissionRequests` array confirms verbatim.
 *
 * Line count for the acceptance criterion: everything below the imports
 * (the actual re-implementation) is under 100 lines — see the report.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROVIDERS } from './providers';
import { spawnSession } from './session';
import type { AcpRequestId } from './types';

const live = process.env.AGILE_LIVE === '1' ? it : it.skip;

describe('live: Claude default-mode permission scenario', () => {
  live(
    'reproduces the Claude default perm table from spike-findings.md §A',
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'acp-client-live-'));
      writeFileSync(join(cwd, 'small.txt'), 'alpha\nbeta\ngamma\n');
      writeFileSync(
        join(cwd, 'package.json'),
        JSON.stringify({ name: 'spike', scripts: { test: 'true' } }),
      );
      // `git status --short` is only a valid "plain exec" row (§A) inside a
      // real repo — without this the step fails at the tool, not at the
      // permission gate.
      for (const args of [
        ['init', '-q'],
        ['add', '.'],
        ['-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-qm', 'init'],
      ]) {
        execFileSync('git', args, { cwd });
      }

      const claude = ACP_PROVIDERS.claude;
      const session = spawnSession({
        cmd: claude.command,
        args: [...claude.args],
        cwd,
        clientCapabilities: claude.clientCapabilities,
      });

      const toolCallKinds: string[] = [];
      const permKinds: string[] = [];
      const permTitles: string[] = [];
      session.on((event) => {
        if (event.type !== 'event') return;
        if (event.event.acp === 'notification' && event.event.message.method === 'session/update') {
          const update = (
            event.event.message.params as { update?: { sessionUpdate?: string; kind?: string } }
          )?.update;
          if (update?.sessionUpdate === 'tool_call' && update.kind) toolCallKinds.push(update.kind);
          return;
        }
        if (event.event.acp !== 'request' || event.event.method !== 'session/request_permission')
          return;
        const id: AcpRequestId = event.event.id;
        const params = event.event.params as {
          toolCall?: { title?: string; kind?: string };
          options?: Array<{ kind: string; optionId: string }>;
        };
        permKinds.push(params.toolCall?.kind ?? 'unknown');
        permTitles.push(params.toolCall?.title ?? 'unknown');
        const allow = params.options?.find((o) => o.kind === 'allow_once') ?? params.options?.[0];
        session.respondPermission(id, {
          outcome: allow
            ? { outcome: 'selected', optionId: allow.optionId }
            : { outcome: 'cancelled' },
        });
      });

      await session.initialized;
      const reply = await session.prompt(
        'Do exactly these steps, one tool call each: ' +
          '1. Read small.txt. 2. Run `git status --short`. 3. Run `echo hi > out.txt`. ' +
          '4. Edit small.txt to append a line. 5. Run `npm test`. Then reply DONE.',
      );

      expect(reply.status).toBe('completed');
      // §A, positive half: the redirected write, the edit, and `npm test`
      // each raised a permission request (kind, then the prose title as
      // extra confirmation against the real capture).
      expect(permKinds.filter((k) => k === 'execute').length).toBeGreaterThanOrEqual(2); // echo + npm test
      expect(permKinds).toContain('edit');
      expect(permTitles.some((t) => /npm test/i.test(t))).toBe(true);
      // §A, negative half: reads never raise a permission request — checked
      // by kind, the one field reliably present on every request — and at
      // least one read actually ran, so the absence means "never asked", not
      // "never attempted".
      expect(toolCallKinds).toContain('read');
      expect(permKinds).not.toContain('read');
      // A plain exec (grep, `git status`) ran with no permission request:
      // more execute-kind tool_calls occurred than execute-kind permission
      // requests were raised. Command text is not identifiable from the ACP
      // wire (see header), so this is the strongest assertion the data
      // supports for "git status specifically was not prompted".
      const execToolCalls = toolCallKinds.filter((k) => k === 'execute').length;
      const execPerms = permKinds.filter((k) => k === 'execute').length;
      expect(execToolCalls).toBeGreaterThan(execPerms);

      session.close();
    },
    120_000,
  );
});
