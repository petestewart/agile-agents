#!/usr/bin/env bun
/**
 * A tiny scriptable ACP agent for tests, always spawned as a subprocess
 * like a real vendor CLI. Speaks the newline-delimited JSON-RPC
 * `@agile-agents/acp-client` drives (`initialize` → `session/new` →
 * `session/set_mode` → `session/prompt`; T465: or `session/load` in place of
 * `session/new`, which it advertises), and can emit updates, request
 * permission mid-turn, end the turn, or hang until killed.
 *
 * Configured by env vars only (argv belongs to the vendor):
 * - `AGILE_FAKE_AGENT_SCRIPT`: a JSON `FakeAgentScript`; default one
 *   `usage_update` + `end_turn`.
 * - `AGILE_FAKE_AGENT_PIDFILE`: this pid is written there before anything
 *   else, so a test can `kill -9` it even if the handshake never completes.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export type FakeAgentStep =
  /** T489: `extra` fields ride the update as sent (a `cost`, a rate-limit field). */
  | { type: 'usage_update'; used: number; size?: number; extra?: Record<string, unknown> }
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
  | {
      type: 'end_turn';
      stopReason?: string;
      usage?: Record<string, unknown>;
      /** T489: the prompt reply's `_meta` (a vendor's rate-limit or plan fields). */
      _meta?: Record<string, unknown>;
    }
  | { type: 'hang' }
  /** Blocks until `path` exists: end a turn after something outside happened, without a racy sleep. */
  | { type: 'wait_for_file'; path: string; timeoutMs?: number }
  /** Pauses `ms` before the next step: a long turn with events spaced out in real time. */
  | { type: 'delay'; ms: number }
  /**
   * T341: blocks until `path` exists, then says its contents as one
   * `agent_message_chunk` (nothing when empty or timed out): a test plays
   * the agent turn by turn, deciding each reply while the turn is open.
   * The file is read as soon as it exists, so the writer must create it
   * whole (write aside, then rename): a plain write can be read empty.
   */
  | { type: 'text_from_file'; path: string; timeoutMs?: number }
  /** Dies mid-turn with `code` (default 1), the prompt unanswered: an agent that crashed. */
  | { type: 'exit'; code?: number }
  /**
   * T460: answers `session/prompt` with a JSON-RPC error, the process
   * alive: a refused turn (Claude Code's expired login says so as
   * `agent_text`, then fails the prompt).
   */
  | { type: 'reject_prompt'; message?: string };

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
  /** One JSON line per `session/set_mode`, `authenticate`, `session/load` and `session/prompt` received is appended here. */
  logFile?: string;
  /** T465: `session/load` fails with this message (a vendor that lost the session). */
  loadFails?: string;
  /** T465: said as one `agent_message_chunk` while `session/load` replays the old conversation. */
  loadReplay?: string;
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
  /**
   * T461: slash commands advertised in an `available_commands_update` right
   * after `session/new`, in ACP's shape (`{name, description, input?: {hint}}`).
   */
  commands?: Array<{ name: string; description: string; input?: { hint: string } }>;
  /** T467b: `session/new` replies with its session id alone (no modes, config options or models). */
  bareSessionNew?: boolean;
  /**
   * T467 (D46): the model option `session/new`/`session/load` report, in
   * the shape the measured vendors send (LIVE-CHECKLIST §12): a
   * `configOptions` entry `{id: "model", category: "model", type: "select",
   * currentValue, options}`. Replaces the bare `model` entry.
   */
  modelOption?: { current: string; options: Array<{ value: string; name: string }> };
  /**
   * T488: an effort option, as Codex reports it (LIVE-CHECKLIST §12): a
   * `configOptions` entry `{id, category: "thought_level", type: "select",
   * currentValue, options}`, sent after the model entry. `session/set_config_option`
   * answers it like the model's (`setConfigOption`).
   */
  effortOption?: { id: string; current: string; values: string[] };
  /** T467: ACP's `models` field (`{currentModelId, availableModels}`), sent beside `configOptions`. */
  models?: {
    currentModelId: string;
    availableModels: Array<{ modelId: string; name: string; description?: string }>;
  };
  /**
   * T467: how `session/set_config_option` for the model is answered.
   * `honour` (default): the value becomes `currentValue`; `ignore`: the
   * reply keeps the old value (a vendor that won't switch); `error`: a
   * JSON-RPC error. Each call is logged (`logFile`).
   */
  setConfigOption?: 'honour' | 'ignore' | 'error';
  /** T489: how the effort option's `session/set_config_option` is answered; default `setConfigOption`'s. */
  setEffortOption?: 'honour' | 'ignore' | 'error';
  /** T486: log whether the classifier key reached the agent (`{method: "spawn-secrets", classifier_key}`), never its value. */
  logSecretEnv?: boolean;
  /** T467: log `ANTHROPIC_MODEL` as the agent saw it at spawn (`{method: "spawn", ANTHROPIC_MODEL}`); T480: and the bridge overrides, when set. */
  logModelEnv?: boolean;
}

function appendLog(script: FakeAgentScript, line: Record<string, unknown>): void {
  if (!script.logFile) return;
  // T492: one append, never a read-and-rewrite: a test reading the log while
  // the agent wrote it saw the file truncated, or a line cut in half.
  appendFileSync(script.logFile, `${JSON.stringify(line)}\n`);
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
if (script.logSecretEnv && import.meta.main) {
  appendLog(script, {
    method: 'spawn-secrets',
    classifier_key: process.env.TYPESAFE_API_KEY !== undefined,
  });
}
if (script.logModelEnv && import.meta.main) {
  appendLog(script, {
    method: 'spawn',
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? null,
    // T480: the bridge overrides, only when the daemon set them.
    ...(process.env.CLAUDE_CODE_EXECUTABLE !== undefined
      ? { CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE }
      : {}),
    ...(process.env.CODEX_PATH !== undefined ? { CODEX_PATH: process.env.CODEX_PATH } : {}),
  });
}
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

/** T467: the model the session runs now (`modelOption`'s, until a `session/set_config_option` takes). */
let currentModel = script.modelOption?.current ?? script.model ?? DEFAULT_FAKE_MODEL;

/** T488: the effort level the session runs now (`effortOption`'s, until a `session/set_config_option` takes). */
let currentEffort = script.effortOption?.current;

/** The `configOptions` of a `session/new`/`session/load` result. */
function sessionConfigOptions(): Array<Record<string, unknown>> {
  const effort =
    script.effortOption !== undefined
      ? [
          {
            id: script.effortOption.id,
            name: 'Reasoning effort',
            category: 'thought_level',
            type: 'select',
            currentValue: currentEffort,
            options: script.effortOption.values.map((value) => ({ value, name: value })),
          },
        ]
      : [];
  if (script.modelOption !== undefined) {
    return [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: currentModel,
        options: script.modelOption.options,
      },
      ...effort,
    ];
  }
  return [{ id: 'model', name: 'Model', currentValue: currentModel }, ...effort];
}

/** A `session/new`/`session/load` result. */
function sessionResult(): Record<string, unknown> {
  return {
    sessionId,
    modes: null,
    configOptions: sessionConfigOptions(),
    ...(script.models !== undefined ? { models: script.models } : {}),
  };
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
          update: {
            sessionUpdate: 'usage_update',
            used: step.used,
            size: step.size ?? 200_000,
            ...(step.extra ?? {}),
          },
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
        write({
          id: promptRequestId,
          // T485a: a vendor may report the turn's token usage on the reply.
          result: {
            stopReason: step.stopReason ?? 'end_turn',
            ...(step.usage !== undefined ? { usage: step.usage } : {}),
            ...(step._meta !== undefined ? { _meta: step._meta } : {}),
          },
        });
        return;
      case 'reject_prompt':
        write({
          id: promptRequestId,
          error: { code: -32603, message: step.message ?? 'Internal error' },
        });
        return;
      case 'hang':
        // Never respond: an in-flight turn with no closing update, until killed.
        return;
      case 'exit':
        process.exit(step.code ?? 1);
        break;
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
      case 'text_from_file': {
        const deadline = Date.now() + (step.timeoutMs ?? 20_000);
        while (!existsSync(step.path) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const text = existsSync(step.path) ? readFileSync(step.path, 'utf8') : '';
        if (text.trim() !== '') {
          notify('session/update', {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
          });
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
      write({
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      });
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
        result: script.bareSessionNew ? { sessionId } : sessionResult(),
      });
      if (script.commands !== undefined) {
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: script.commands,
          },
        });
      }
      return;
    case 'session/load':
      appendLog(script, { method: 'session/load', params: message.params });
      if (script.loadFails !== undefined) {
        write({ id: message.id, error: { code: -32603, message: script.loadFails } });
        return;
      }
      sessionId = (message.params as { sessionId?: string } | undefined)?.sessionId ?? sessionId;
      // The replay comes before the reply, as a vendor re-sends its conversation.
      if (script.loadReplay !== undefined) {
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: script.loadReplay },
          },
        });
      }
      write({ id: message.id, result: sessionResult() });
      return;
    case 'session/set_config_option': {
      appendLog(script, { method: 'session/set_config_option', params: message.params });
      const params = message.params as { configId?: string; value?: string } | undefined;
      const isEffort =
        script.effortOption !== undefined && params?.configId === script.effortOption.id;
      const answer = (isEffort ? script.setEffortOption : undefined) ?? script.setConfigOption;
      if (answer === 'error') {
        write({
          id: message.id,
          error: { code: -32602, message: `cannot set ${params?.configId ?? 'option'}` },
        });
        return;
      }
      if (answer !== 'ignore' && params?.configId === 'model' && typeof params.value === 'string') {
        currentModel = params.value;
      }
      if (
        answer !== 'ignore' &&
        script.effortOption !== undefined &&
        params?.configId === script.effortOption.id &&
        typeof params.value === 'string'
      ) {
        currentEffort = params.value;
      }
      write({ id: message.id, result: { configOptions: sessionConfigOptions() } });
      return;
    }
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
