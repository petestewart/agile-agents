/**
 * Live re-implementation of the Claude `default`-mode permission scenario
 * (design/spike-findings.md §A) on top of `spawnSession`, per T003's
 * acceptance criterion: "the spike harness `permission-matrix.ts` can be
 * re-implemented on top of it in <100 lines and reproduces the Claude
 * `default` perm table". Runs a real `claude login`'d Claude Code session —
 * CANNOT run in this container (no vendor login) — so it is a no-op unless
 * `AGILE_LIVE=1`, per the ticket's Validation Steps.
 *
 * Line count for the acceptance criterion: everything below the imports
 * (the actual re-implementation) is under 100 lines — see the report.
 */
import { describe, expect, it } from 'bun:test';
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

      const claude = ACP_PROVIDERS.claude;
      const session = spawnSession({
        cmd: claude.command,
        args: [...claude.args],
        cwd,
        clientCapabilities: claude.clientCapabilities,
      });

      const permsRaised: string[] = [];
      session.on((event) => {
        if (event.type !== 'event' || event.event.acp !== 'request') return;
        if (event.event.method !== 'session/request_permission') return;
        const id: AcpRequestId = event.event.id;
        const params = event.event.params as {
          toolCall?: { title?: string; kind?: string };
          options?: Array<{ kind: string; optionId: string }>;
        };
        const label = params.toolCall?.title ?? params.toolCall?.kind ?? 'unknown';
        permsRaised.push(label);
        const allow = params.options?.find((o) => o.kind === 'allow_once') ?? params.options?.[0];
        if (allow)
          session.respondPermission(id, {
            outcome: { outcome: 'selected', optionId: allow.optionId },
          });
        else session.respondPermission(id, { outcome: { outcome: 'cancelled' } });
      });

      await session.initialized;
      const reply = await session.prompt(
        'Do exactly these steps, one tool call each: ' +
          '1. Read small.txt. 2. Run `git status --short`. 3. Run `echo hi > out.txt`. ' +
          '4. Edit small.txt to append a line. 5. Run `npm test`. Then reply DONE.',
      );

      expect(reply.status).toBe('completed');
      // §A: reads and plain exec (`git status`) never raise a permission
      // request in `default` mode; a redirected write, an edit, and `npm
      // test` all do.
      expect(permsRaised.some((label) => /echo|out\.txt/i.test(label))).toBe(true);
      expect(permsRaised.some((label) => /edit|small\.txt/i.test(label))).toBe(true);
      expect(permsRaised.some((label) => /npm test/i.test(label))).toBe(true);

      session.close();
    },
    120_000,
  );
});
