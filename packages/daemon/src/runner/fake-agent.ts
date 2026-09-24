#!/usr/bin/env bun
/**
 * A tiny scriptable ACP agent for tests, always spawned as a subprocess
 * like a real vendor CLI. Speaks the newline-delimited JSON-RPC
 * `@agile-agents/acp-client` drives (`initialize` → `session/new` →
 * `session/set_mode` → `session/prompt`), and can emit updates, request
 * permission mid-turn, end the turn, or hang until killed.
 *
 * Configured by env vars only (argv belongs to the vendor):
 * - `AGILE_FAKE_AGENT_SCRIPT`: a JSON `FakeAgentScript`; default one
 *   `usage_update` + `end_turn`.
 * - `AGILE_FAKE_AGENT_PIDFILE`: this pid is written there before anything
 *   else, so a test can `kill -9` it even if the handshake never completes.
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
      /** The client's answer (`{outcome}`) is written here as JSON. */
      resultFile?: string;
    }
  /** One `agent_message_chunk`: what `session.prompt()` returns as `reply.text`. */
  | { type: 'agent_text'; text: string }
  | { type: 'end_turn'; stopReason?: string }
  | { type: 'hang' }
  /** Blocks until `path` exists: end a turn after something outside happened, without a racy sleep. */
  | { type: 'wait_for_file'; path: string; timeoutMs?: number }
  /** Pauses `ms` before the next step: a long turn with events spaced out in real time. */
  | { type: 'delay'; ms: number };

export interface FakeAgentScript {
  steps: FakeAgentStep[];
  /** One step list per prompt turn (turn n runs `turns[n-1]`); past the end, `steps`. */
  turns?: FakeAgentStep[][];
  /**
   * `session/new` fails with the code acp-client maps to
   * `AuthRequiredError` until `authenticate` sends this method id
   * (Cursor/Grok, spike-findings.md §C2/§D).
   */
  requireAuthMethod?: string;
  /** One JSON line per `session/set_mode`, `authenticate` and `session/prompt` received is appended here. */
  logFile?: string;
  /**
   * Mode ids this vendor supports (a real vendor's advertised set); any
   * other `session/set_mode` is rejected with `Unknown mode: <id>`, which
   * catches a Claude-only mode id sent to another vendor.
   */
  validModes?: string[];
  /** The model reported in `session/new`/`session/load`'s `configOptions` (as the Claude bridge does). Default `DEFAULT_FAKE_MODEL`. */
  model?: string;
  /** Written to stderr once at startup, for testing the per-session stderr log. */
  stderrBanner?: string;
}

function appendLog(script: FakeAgentScript, line: Record<string, unknown>): void {
  if (!script.logFile) return;
  const prior = existsSync(script.logFile) ? readFileSync(script.logFile, 'utf8') : '';
  writeFileSync(script.logFile, `${prior}${JSON.stringify(line)}\n`);
}

const DEFAULT_SCRIPT: FakeAgentScript = {
  steps: [{ type: 'usage_update', used: 10, size: 1000 }, { type: 'end_turn' }],
};

function loadScript(): FakeAgentScript {
  const path = process.env.AGILE_FAKE_AGENT_SCRIPT;
  if (!path || !existsSync(path)) return DEFAULT_SCRIPT;
  return JSON.parse(readFileSync(path, 'utf8')) as FakeAgentScript;
}

/** Loaded once; `handleLine` needs it too. */
const script = loadScript();
if (script.stderrBanner !== undefined) process.stderr.write(`${script.stderrBanner}\n`);
/** `authenticate` method ids seen, for `requireAuthMethod`. */
const authenticatedMethods = new Set<string>();

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

/** The model id reported when a script names none. */
export const DEFAULT_FAKE_MODEL = 'fake/model-1';

/** The `configOptions` of a `session/new`/`session/load` result. */
function sessionConfigOptions(): Array<{ id: string; name: string; currentValue: string }> {
  return [{ id: 'model', name: 'Model', currentValue: script.model ?? DEFAULT_FAKE_MODEL }];
}

/** Prompt turns seen so far — indexes `FakeAgentScript.turns`. */
let turnIndex = 0;

async function runScript(promptRequestId: number | string): Promise<void> {
  const steps = script.turns?.[turnIndex] ?? script.steps;
  turnIndex += 1;
  for (const step of steps) {
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
      case 'agent_text':
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: step.text },
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
        // Never respond: an in-flight turn with no closing update, until killed.
        return;
      case 'delay':
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        break;
      case 'wait_for_file': {
        const deadline = Date.now() + (step.timeoutMs ?? 20_000);
        while (!existsSync(step.path) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        break;
      }
      default:
        break;
    }
  }
  // Script exhausted with no `end_turn`/`hang`: end the turn anyway.
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

  // A response to one of our outgoing requests.
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
      // `requireAuthMethod`: fail until `authenticate` has run.
      if (script.requireAuthMethod && !authenticatedMethods.has(script.requireAuthMethod)) {
        write({
          id: message.id,
          error: { code: -32000, message: 'authentication required' },
        });
        return;
      }
      write({
        id: message.id,
        result: { sessionId, modes: null, configOptions: sessionConfigOptions() },
      });
      return;
    case 'session/load':
      sessionId = (message.params as { sessionId?: string } | undefined)?.sessionId ?? sessionId;
      write({
        id: message.id,
        result: { sessionId, modes: null, configOptions: sessionConfigOptions() },
      });
      return;
    case 'session/set_mode': {
      appendLog(script, { method: 'session/set_mode', params: message.params });
      const modeId = (message.params as { modeId?: string } | undefined)?.modeId;
      if (script.validModes && (modeId === undefined || !script.validModes.includes(modeId))) {
        write({ id: message.id, error: { code: -32602, message: `Unknown mode: ${modeId}` } });
        return;
      }
      write({ id: message.id, result: {} });
      return;
    }
    case 'session/prompt':
      // Logged so a test can assert what a session was prompted with.
      appendLog(script, { method: 'session/prompt', params: message.params });
      if (message.id !== undefined) void runScript(message.id);
      return;
    case 'session/cancel':
      // A notification: nothing to answer.
      return;
    case 'authenticate': {
      const methodId = (message.params as { methodId?: string } | undefined)?.methodId;
      if (methodId) authenticatedMethods.add(methodId);
      appendLog(script, { method: 'authenticate', params: message.params });
      write({ id: message.id, result: {} });
      return;
    }
    default:
      if (message.id !== undefined) write({ id: message.id, result: {} });
      return;
  }
}

// Only when executed directly; importing the types must stay side-effect-free.
if (import.meta.main) {
  // The pid first, synchronously, so a test never races the handshake.
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
