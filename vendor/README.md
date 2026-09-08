# vendor/

Read-only reference snapshots. Nothing here is built, tested, or imported at runtime.

## terma/ (snapshot 2026-09-08, from petestewart/terma)

Terma's ACP layer and the adjacent pieces the design doc says to lift (design §8 "Prior art: Terma", spike-findings §E). Input to **T003 — Extract ACP client from Terma**: copy into `packages/acp-client`, strip Electron/Drizzle/Terma-specific bits, keep the tests that still apply.

| file | what |
|---|---|
| `src/main/terminal-host/acp-session.ts` | AcpSession: spawn, JSON-RPC framing, fs methods, request forwarding, turn markers, kill escalation (Node-only) |
| `src/main/terminal-host/acp-event-log.ts` | event log for a session |
| `src/shared/acp-types.ts`, `acp-providers.ts` | wire types; per-vendor launch config |
| `src/shared/agent-session-contract.ts` | vendor-neutral `MessageableSession` seam |
| `src/main/lib/terminal-host/acp-events.ts`, `acp-session-contract.ts` | event parsing / contract |
| `src/main/lib/control/messageable-acp-session.ts` | MessageableSession over AcpSession |
| `src/main/lib/control/mailbox.ts`, `wait-graph.ts` | mailbox + wait graph (Drizzle store — swap for files) |
| `src/main/lib/hooks/pi-integration.ts` | installs a self-guarding Pi extension into `~/.pi/agent/extensions/` — the install mechanism for the `agile` Pi extension (T022) |
| `src/main/lib/orchestration2/triage.ts` | pure safe-command classifier |
| `src/__tests__/unit/acp-*.test.ts`, `messageable-acp-session.test.ts` | tests to carry over where they still apply |

Do **not** lift orchestration2's model (DB-as-oracle, two roles, review gate default off).
