#!/usr/bin/env bun
/**
 * `fake-agent.ts` — a tiny ACP agent for T012's own tests. Speaks the same
 * newline-delimited JSON-RPC `@agile-agents/acp-client` drives a real
 * vendor over (`initialize` -> `session/new` -> `session/set_mode` ->
 * `session/prompt`), and can be scripted to emit `usage_update`/`tool_call`
 * notifications, raise a `session/request_permission` request mid-turn, end
 * the turn normally, or hang forever (for the `kill -9` crash test — this
 * process is what gets killed).
 *
 * Never imported — always spawned as a subprocess (`bun
 * packages/daemon/src/runner/fake-agent.ts`), the same way a real vendor CLI
 * is spawned by `@agile-agents/acp-client`'s `spawnSession`.
 *
 * Configuration is entirely via env vars (no CLI args — `spawnSession`'s
 * `args` are the vendor's own, so this can't assume it owns argv):
 *
 * - `AGILE_FAKE_AGENT_SCRIPT` — path to a JSON `FakeAgentScript` (see
 *   below). Defaults to one `usage_update` + `end_turn`.
 * - `AGILE_FAKE_AGENT_PIDFILE` — if set, this process's own pid is written
 *   there (as a bare decimal string, no newline needed but one is added)
 *   *before* anything else runs, so a test can `kill -9` the right pid even
 *   if the handshake never completes.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export type FakeAgentStep =
  | { type: 'usage_update'; used: number; size?: number }
  | { type: 'tool_call'; toolCallId: string; kind?: string; title?: string; status?: string }
  | { type: 'tool_call_update'; toolCallId: string; status: string }
  | {
      type: 'request_permission';
      toolCall: { toolCallId: string; kind?: string; title?: string; rawInput?: unknown };
      options: Array<{ optionId: string; kind: string; name?: string }>;
      /** If set, the client's answer (`{outcome}`) is written here as JSON — a test's way to observe what the daemon decided. */
      resultFile?: string;
    }
  | { type: 'end_turn'; stopReason?: string }
  | { type: 'hang' };

export interface FakeAgentScript {
  steps: FakeAgentStep[];
}

const DEFAULT_SCRIPT: FakeAgentScript = {
  steps: [{ type: 'usage_update', used: 10, size: 1000 }, { type: 'end_turn' }],
};

function loadScript(): FakeAgentScript {
  const path = process.env.AGILE_FAKE_AGENT_SCRIPT;
  if (!path || !existsSync(path)) return DEFAULT_SCRIPT;
  return JSON.parse(readFileSync(path, 'utf8')) as FakeAgentScript;
}

interface JsonRpcLine {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function write(line: JsonRpcLine): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...line })}\n`);
}

let nextOutgoingId = 1;
const pendingClientRequests = new Map<number, (result: unknown) => void>();

function requestClient(method: string, params: unknown): Promise<unknown> {
  const id = nextOutgoingId++;
  return new Promise((resolve) => {
    pendingClientRequests.set(id, resolve);
    write({ id, method, params });
  });
}

function notify(method: string, params: unknown): void {
  write({ method, params });
}

let sessionId = 'fake-session-1';

async function runScript(promptRequestId: number | string): Promise<void> {
  const script = loadScript();
  for (const step of script.steps) {
    switch (step.type) {
      case 'usage_update':
        notify('session/update', {
          sessionId,
          update: { sessionUpdate: 'usage_update', used: step.used, size: step.size ?? 200_000 },
        });
        break;
      case 'tool_call':
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: step.toolCallId,
            kind: step.kind ?? 'other',
            title: step.title ?? step.toolCallId,
            status: step.status ?? 'pending',
          },
        });
        break;
      case 'tool_call_update':
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: step.toolCallId,
            status: step.status,
          },
        });
        break;
      case 'request_permission': {
        const result = await requestClient('session/request_permission', {
          sessionId,
          toolCall: step.toolCall,
          options: step.options,
        });
        if (step.resultFile) writeFileSync(step.resultFile, JSON.stringify(result));
        break;
      }
      case 'end_turn':
        write({ id: promptRequestId, result: { stopReason: step.stopReason ?? 'end_turn' } });
        return;
      case 'hang':
        // Never respond — the process just sits here until killed. Matches
        // the crash test's premise: an in-flight turn with no closing
        // update, same as a real vendor's `session/cancel` leaves a
        // `pending` tool_call (design/spike-findings.md).
        return;
      default:
        break;
    }
  }
  // Script exhausted with no explicit `end_turn`/`hang` — end the turn so a
  // caller's `prompt()` doesn't hang on a script bug.
  write({ id: promptRequestId, result: { stopReason: 'end_turn' } });
}

function handleLine(line: string): void {
  if (!line.trim()) return;
  let message: JsonRpcLine;
  try {
    message = JSON.parse(line) as JsonRpcLine;
  } catch {
    return;
  }

  // A response to one of *our* outgoing requests (session/request_permission).
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pendingClientRequests.get(message.id as number);
    if (resolve) {
      pendingClientRequests.delete(message.id as number);
      resolve(message.result);
    }
    return;
  }

  switch (message.method) {
    case 'initialize':
      write({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      return;
    case 'session/new':
      write({ id: message.id, result: { sessionId, modes: null, configOptions: null } });
      return;
    case 'session/load':
      sessionId = (message.params as { sessionId?: string } | undefined)?.sessionId ?? sessionId;
      write({ id: message.id, result: { sessionId, modes: null, configOptions: null } });
      return;
    case 'session/set_mode':
      write({ id: message.id, result: {} });
      return;
    case 'session/prompt':
      if (message.id !== undefined) void runScript(message.id);
      return;
    case 'session/cancel':
      // Fire-and-forget notification, per ACP — nothing to answer.
      return;
    case 'authenticate':
      write({ id: message.id, result: {} });
      return;
    default:
      if (message.id !== undefined) write({ id: message.id, result: {} });
      return;
  }
}

/**
 * Everything below runs only when this file is executed directly (`bun
 * packages/daemon/src/runner/fake-agent.ts`) — never when a test imports its
 * types (`FakeAgentScript`/`FakeAgentStep`), which must stay side-effect-free.
 */
if (import.meta.main) {
  // Written first, synchronously, before any async work — a test that spawns
  // this process and immediately wants its pid (to `kill -9` it) must never
  // race the handshake.
  const pidFile = process.env.AGILE_FAKE_AGENT_PIDFILE;
  if (pidFile) {
    writeFileSync(pidFile, `${process.pid}\n`);
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
      handleLine(line);
    }
  });
}
