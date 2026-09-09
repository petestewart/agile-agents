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
 * Deterministic in-process runner for tests: returns a caller-supplied
 * canned reply per call (by default, echoing the input back as JSON so a
 * test can assert on what it was asked), and counts invocations so a test
 * can assert a cache hit never re-invoked it.
 */
export class FakeRunner implements ToolRunner {
  calls: ToolRunInput[] = [];

  constructor(
    private readonly reply: (input: ToolRunInput) => ToolRunResult | Promise<ToolRunResult> = (
      input,
    ) => ({
      text: JSON.stringify({ summary: `stub summary for ${input.tool.name}`, refs: [] }),
      model: 'fake',
      inTokens: 0,
      outTokens: 0,
    }),
  ) {}

  get callCount(): number {
    return this.calls.length;
  }

  async run(input: ToolRunInput): Promise<ToolRunResult> {
    this.calls.push(input);
    return this.reply(input);
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
 * Live runner: one short-lived ACP session per call, closed after the first
 * reply. `AGILE_LIVE=1` gated by the caller (this class itself has no
 * built-in guard — it's a thin, honest wrapper over `spawnSession`, same as
 * every other ACP-client consumer in this repo).
 */
export class LiveRunner implements ToolRunner {
  async run(input: ToolRunInput): Promise<ToolRunResult> {
    const provider = ACP_PROVIDERS.claude;
    let session: SpawnedSession | undefined;
    try {
      session = spawnSession({
        cmd: provider.command,
        args: [...provider.args],
        cwd: input.cwd,
        envOverrides: { ...provider.envOverrides },
        clientCapabilities: provider.clientCapabilities,
      });
      const prompt = buildRunnerPrompt(input);
      const reply = await session.prompt(prompt);
      const { text, truncated } = truncateToTokens(reply.text, input.maxOutputTokens);
      return {
        text: truncated ? `${text}\n[truncated at ${input.maxOutputTokens} tokens]` : text,
        model: provider.id,
        inTokens: Math.ceil(prompt.length / charsPerToken()),
        outTokens: Math.ceil(text.length / charsPerToken()),
      };
    } finally {
      session?.close();
    }
  }
}

/** The tool's `prompt.md`, followed by its validated input as JSON — "the tool's prompt" (§7), fixed per tool, plus this call's arguments. */
function buildRunnerPrompt(input: ToolRunInput): string {
  return `${input.prompt.trim()}\n\nInput:\n${JSON.stringify(input.input)}`;
}
