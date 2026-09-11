/**
 * `ToolRunner` implementations (T011 — design/agile-agents-design.md §7
 * "Tool framework": "runner.tier tools run as short-lived cheap ACP
 * sessions"; §8 "Adapter contract (ACP)": "cheap runner sessions are
 * ordinary ACP sessions with a fixed prompt").
 *
 * `FakeRunner` backs every unit test (deterministic, no vendor login).
 * `LiveRunner` spawns a real `claude` ACP session via `spawnSession` +
 * `ACP_PROVIDERS.claude` — exercised only under `AGILE_LIVE=1` (this
 * package's tests never construct one outside that guard; see
 * `README`/ticket Validation Steps).
 */

import { ACP_PROVIDERS, type SpawnedSession, spawnSession } from '@agile-agents/acp-client';
import type { ToolRunInput, ToolRunResult, ToolRunner } from './types';

/**
 * QA round 1 (T011): the daemon-side runner call must never outlive a
 * reasonable ceiling on its own — a caller giving up (the MCP bridge's own
 * RPC deadline) does not, by itself, stop the daemon from still waiting on
 * (and the vendor subprocess from still running) a call nobody is listening
 * for any more. Matches the bridge's own default (`cli/commands/mcp.ts`,
 * `DEFAULT_MCP_TOOL_TIMEOUT_MS`) so the runner's own deadline fires at
 * roughly the same time the bridge gives up, not meaningfully later.
 */
export const DEFAULT_RUNNER_TIMEOUT_MS = 60_000;

export class ToolRunnerTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`tool runner timed out after ${timeoutMs}ms`);
    this.name = 'ToolRunnerTimeoutError';
  }
}

/**
 * Races `run()` against `timeoutMs`, rejecting with `ToolRunnerTimeoutError`
 * if it fires first. Does not itself know how to cancel `run()`'s work —
 * callers still need their own `finally` to release whatever `run()` was
 * holding (a child process, a session) regardless of which side of the race
 * won. Shared by every `ToolRunner` implementation so "timed out" always
 * means the same thing (same error class, same message) no matter which
 * runner is in play.
 */
export async function withRunnerTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolRunnerTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Deterministic in-process runner for tests: returns a caller-supplied
 * canned reply per call (by default, echoing the input back as JSON so a
 * test can assert on what it was asked), and counts invocations so a test
 * can assert a cache hit never re-invoked it. Honors `input.timeoutMs` the
 * same way `LiveRunner` does (via `withRunnerTimeout`) and calls the
 * injectable `onCleanup` exactly once per call, win or lose — a stand-in for
 * `LiveRunner`'s `session.close()`, so a test can assert "a timed-out call
 * still cleans up" without spawning a real ACP session.
 */
export class FakeRunner implements ToolRunner {
  calls: ToolRunInput[] = [];
  cleanupCalls = 0;

  constructor(
    private readonly reply: (input: ToolRunInput) => ToolRunResult | Promise<ToolRunResult> = (
      input,
    ) => ({
      text: JSON.stringify({ summary: `stub summary for ${input.tool.name}`, refs: [] }),
      model: 'fake',
      inTokens: 0,
      outTokens: 0,
    }),
    private readonly onCleanup: () => void = () => {},
  ) {}

  get callCount(): number {
    return this.calls.length;
  }

  async run(input: ToolRunInput): Promise<ToolRunResult> {
    this.calls.push(input);
    const timeoutMs = input.timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;
    try {
      return await withRunnerTimeout(async () => this.reply(input), timeoutMs);
    } finally {
      this.cleanupCalls++;
      this.onCleanup();
    }
  }
}

/** ~4 chars/token, same convention as §7's `max_output_tokens: 400` cap and the ticket's "under 500 tokens" acceptance check. */
export function charsPerToken(): number {
  return 4;
}

export function truncateToTokens(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  const maxChars = maxTokens * charsPerToken();
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/**
 * Live runner: one short-lived ACP session per call. `AGILE_LIVE=1` gated by
 * the caller (this class itself has no built-in guard — it's a thin, honest
 * wrapper over `spawnSession`, same as every other ACP-client consumer in
 * this repo).
 *
 * QA round 1 fix: the session is now closed in a `finally` around the whole
 * timed call, not just the happy path — a slow/unresponsive vendor session
 * used to be abandoned (still running as an orphaned `npx
 * @agentclientprotocol/claude-agent-acp` subprocess) the moment a *caller*
 * gave up (e.g. the MCP bridge's own RPC deadline), since nothing here ever
 * told the child to stop. `withRunnerTimeout` enforces this runner's own
 * deadline independently of any caller's, and `session.close()` — reached on
 * success, on a thrown error, and on this runner's own timeout alike — SIGTERMs
 * (escalating to SIGKILL) the child every time.
 */
export class LiveRunner implements ToolRunner {
  async run(input: ToolRunInput): Promise<ToolRunResult> {
    const provider = ACP_PROVIDERS.claude;
    const timeoutMs = input.timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;
    const session: SpawnedSession = spawnSession({
      cmd: provider.command,
      args: [...provider.args],
      cwd: input.cwd,
      envOverrides: { ...provider.envOverrides },
      clientCapabilities: provider.clientCapabilities,
    });
    try {
      return await withRunnerTimeout(async () => {
        const prompt = buildRunnerPrompt(input);
        const reply = await session.prompt(prompt);
        const { text, truncated } = truncateToTokens(reply.text, input.maxOutputTokens);
        return {
          text: truncated ? `${text}\n[truncated at ${input.maxOutputTokens} tokens]` : text,
          model: provider.id,
          inTokens: Math.ceil(prompt.length / charsPerToken()),
          outTokens: Math.ceil(text.length / charsPerToken()),
        };
      }, timeoutMs);
    } finally {
      session.close();
    }
  }
}

/** The tool's `prompt.md`, followed by its validated input as JSON — "the tool's prompt" (§7), fixed per tool, plus this call's arguments. */
function buildRunnerPrompt(input: ToolRunInput): string {
  return `${input.prompt.trim()}\n\nInput:\n${JSON.stringify(input.input)}`;
}
