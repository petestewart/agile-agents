/**
 * Shared types for the tool framework (T011 — design/agile-agents-design.md
 * §7 "Tool framework").
 */

import type { ToolDefinition } from '@agile-agents/shared';

/** One tool loaded from `.agile/tools/<name>/tool.yaml` + its `prompt.md`. */
export interface LoadedTool {
  definition: ToolDefinition;
  /** Contents of `prompt.md` next to `tool.yaml`, or `''` if absent. */
  prompt: string;
  /** Absolute path to the tool's directory. */
  dir: string;
}

/** Who is calling a tool, and on what ticket — the daemon-side identity a hook/CLI bridge already knows from `agile mcp --agent <id> --ticket <id>`. */
export interface ToolCallContext {
  agent: string;
  ticket?: string;
}

/** What a `ToolRunner` needs to run one `runner.tier` invocation. */
export interface ToolRunInput {
  tool: ToolDefinition;
  /** The tool's `prompt.md` contents. */
  prompt: string;
  /** The tool's validated input, plus whatever extra context the caller assembled (e.g. file contents for `read_summary`). */
  input: Record<string, unknown>;
  /** Working directory for the short-lived session (the ticket worktree). */
  cwd: string;
  maxOutputTokens: number;
  /**
   * QA round 1 (T011): every `ToolRunner` must enforce a deadline and own
   * its own cleanup (kill the child/session) when it fires — a caller's own
   * timeout (e.g. the MCP bridge's RPC deadline) only stops *that caller*
   * from waiting, it does nothing to the still-running daemon-side call.
   * Defaults to `DEFAULT_RUNNER_TIMEOUT_MS` (`runner.ts`) when omitted.
   */
  timeoutMs?: number;
}

export interface ToolRunResult {
  /** The session's final reply text, verbatim — callers parse/truncate it themselves. */
  text: string;
  model: string;
  inTokens: number;
  outTokens: number;
}

/**
 * Abstraction over "run this `runner.tier` tool as a short-lived ACP
 * session" (§7, §8 "cheap runner sessions are ordinary ACP sessions with a
 * fixed prompt") — a `FakeRunner` backs every unit test; the live path
 * (`LiveRunner`, `spawnSession` + `ACP_PROVIDERS.claude`) is exercised only
 * under `AGILE_LIVE=1`.
 */
export interface ToolRunner {
  run(input: ToolRunInput): Promise<ToolRunResult>;
}
