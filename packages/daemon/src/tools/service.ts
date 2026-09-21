/**
 * `ToolService` — the one daemon-side object the `tool.*` RPC methods and
 * the in-process `createToolMcpServer` factory both call into (T011). Owns
 * the loaded registry and the runner.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { cacheEntryPath, cacheKey, readCacheEntry, sha256Hex, writeCacheEntry } from './cache';
import { runReadSummary } from './read-summary';
import { type ToolInputSpec, inputSpecFromToolIo } from './schema';
import { runTestRun } from './test-run';
import type { LoadedTool, ToolCallContext, ToolRunner } from './types';

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`unknown tool: ${name}`);
    this.name = 'UnknownToolError';
  }
}

export interface ToolListEntry {
  name: string;
  description: string;
  /** `registry` (loaded from `.agile/tools/<name>/tool.yaml`) or `provider` (plugged in by the daemon). */
  source: 'registry' | 'provider';
  /** Real per-field shape (review fix, T011) — see `schema.ts`'s header. RPC-safe: plain strings/booleans, no zod instances, so `tool.list` can ship it verbatim to a remote MCP bridge. */
  inputSpec: ToolInputSpec;
}

/**
 * Result of a path-based guard check. `pathGuard` is a plain function,
 * wired by whoever constructs `ToolService`.
 */
export type ToolPathGuardResult = { allow: true } | { allow: false; reason: string };
export type ToolPathGuard = (ctx: ToolCallContext, absolutePath: string) => ToolPathGuardResult;

/** Thrown when `pathGuard` denies a reader tool's path (today: `read_summary`) — QA round fix: `read_summary` reads the file itself and returns a summary of it, so it would otherwise bypass the raw-`Read` contract-input/output deny list (§13) by another door. */
export class ToolPathDeniedError extends Error {}

/**
 * Thrown when a registry tool needs a repo to run in and the service has
 * none (T125). The daemon no longer infers a repo from its own cwd, so a
 * `ToolService` built without an explicit root refuses the repo-dependent
 * verbs with a reason instead of running them somewhere arbitrary. T132
 * resolves the worktree per call from the calling agent's stream.
 */
export class ToolRepoUnavailableError extends Error {
  constructor(toolName: string) {
    super(
      `${toolName}: no repo is attached to this daemon — tools that read or run inside a repo need one (register it with \`agile repo add\` and call from a stream attached to it)`,
    );
    this.name = 'ToolRepoUnavailableError';
  }
}

export interface ToolServiceOptions {
  registry: LoadedTool[];
  runner: ToolRunner;
  /**
   * Repo root — the cache/raw-output host-local root (`cache.ts`), and the
   * fallback worktree when a ticket has none on record yet. T125: optional,
   * because the daemon no longer derives one from its own cwd. Without it
   * every registry tool refuses with `ToolRepoUnavailableError`; providers
   * (which bring their own context) are unaffected.
   */
  repoRoot?: string;
  /** Optional path-based guard consulted before a reader tool exposes file content (today: only `read_summary`'s `path`). This module stays caller-agnostic; whoever constructs the service wires the closure. */
  pathGuard?: ToolPathGuard;
}

/**
 * A tool provider plugged into the service by the daemon at startup.
 * `agents` restricts who sees and may call the provider's tools, by agent id;
 * an empty list means every caller.
 */
export interface ToolProvider {
  agents: readonly string[];
  listTools(): Array<{ name: string; description: string; inputSpec: ToolInputSpec }>;
  callTool(ctx: ToolCallContext, name: string, input: unknown): Promise<unknown>;
}

export class ToolService {
  private readonly providers: ToolProvider[] = [];
  private readonly registry: LoadedTool[];
  private readonly runner: ToolRunner;
  private readonly repoRoot: string | undefined;
  private readonly pathGuard?: ToolPathGuard;

  constructor(opts: ToolServiceOptions) {
    this.registry = opts.registry;
    this.runner = opts.runner;
    this.repoRoot = opts.repoRoot;
    this.pathGuard = opts.pathGuard;
  }

  /** Plug a provider in (idempotent by identity). */
  registerProvider(provider: ToolProvider): void {
    if (!this.providers.includes(provider)) this.providers.push(provider);
  }

  private providersFor(agent: string | undefined): ToolProvider[] {
    if (agent === undefined) return this.providers;
    return this.providers.filter((p) => p.agents.length === 0 || p.agents.includes(agent));
  }

  listTools(agent?: string): ToolListEntry[] {
    const provided: ToolListEntry[] = this.providersFor(agent).flatMap((p) =>
      p.listTools().map((t) => ({
        name: t.name,
        description: t.description,
        source: 'provider' as const,
        inputSpec: t.inputSpec,
      })),
    );
    const registered: ToolListEntry[] = this.registry.map((t) => ({
      name: t.definition.name,
      description: `${t.definition.kind} tool (${t.definition.action})`,
      source: 'registry',
      inputSpec: inputSpecFromToolIo(t.definition.input),
    }));
    return [...registered, ...provided];
  }

  /** Tools run at the repo root until a caller supplies a worktree of its own (T132 rewires this to the stream's worktree). */
  private resolveWorktree(_ctx: ToolCallContext, toolName: string): string {
    return this.requireRepoRoot(toolName);
  }

  /** The repo root, or a refusal naming the tool (T125). */
  private requireRepoRoot(toolName: string): string {
    if (this.repoRoot === undefined) throw new ToolRepoUnavailableError(toolName);
    return this.repoRoot;
  }

  async callTool(ctx: ToolCallContext, name: string, input: unknown): Promise<unknown> {
    for (const provider of this.providersFor(ctx.agent)) {
      if (provider.listTools().some((t) => t.name === name)) {
        return provider.callTool(ctx, name, input);
      }
    }
    const loaded = this.registry.find((t) => t.definition.name === name);
    if (!loaded) throw new UnknownToolError(name);

    if (name === 'test_run') {
      return this.callTestRun(loaded, ctx, input);
    }
    return this.callReaderTool(loaded, ctx, input);
  }

  private async callTestRun(
    loaded: LoadedTool,
    ctx: ToolCallContext,
    input: unknown,
  ): Promise<unknown> {
    const toolName = loaded.definition.name;
    const worktree = this.resolveWorktree(ctx, toolName);
    const output = await runTestRun({
      input: input as { command: string; cwd?: string },
      worktree,
      repoRoot: this.requireRepoRoot(toolName),
    });
    return output;
  }

  /**
   * Generic cache+runner path for any `runner.tier` reader tool whose
   * `cache.key` fields this module knows how to compute — today just
   * `read_summary`'s `[file_hash, question]` (`file_hash` is computed from
   * `input.path`'s content; every other named key field is read verbatim off
   * the validated input, stringified if not already a string).
   */
  private async callReaderTool(
    loaded: LoadedTool,
    ctx: ToolCallContext,
    input: unknown,
  ): Promise<unknown> {
    if (loaded.definition.name === 'read_summary') {
      const worktree = this.resolveWorktree(ctx, loaded.definition.name);
      const typedInput = input as { path: string; question?: string };
      if (this.pathGuard) {
        const absPath = isAbsolute(typedInput.path)
          ? typedInput.path
          : join(worktree, typedInput.path);
        const guard = this.pathGuard(ctx, absPath);
        if (!guard.allow) {
          throw new ToolPathDeniedError(`read_summary: ${guard.reason}`);
        }
      }
      const result = await runReadSummary({
        tool: loaded,
        ctx,
        input: typedInput,
        worktree,
        repoRoot: this.requireRepoRoot(loaded.definition.name),
        runner: this.runner,
      });
      return result.output;
    }

    // Any other registered reader tool: cache by its declared key fields
    // (verbatim string/JSON of the matching input field — `file_hash` isn't
    // meaningful without a `read_summary`-shaped `path` input, so a tool
    // naming it without one is a registry authoring error, not silently
    // ignored).
    const def = loaded.definition;
    const rawInput = (input ?? {}) as Record<string, unknown>;
    const keyFields = def.cache?.key ?? [];
    const keyParts = keyFields.map((field) => {
      if (field === 'file_hash') {
        const pathValue = rawInput.path;
        if (typeof pathValue !== 'string') {
          throw new Error(`${def.name}: cache key "file_hash" requires a string "path" input`);
        }
        return sha256Hex(
          readFileSync(
            isAbsolute(pathValue)
              ? pathValue
              : join(this.resolveWorktree(ctx, def.name), pathValue),
            'utf8',
          ),
        );
      }
      const value = rawInput[field];
      return typeof value === 'string' ? value : JSON.stringify(value ?? null);
    });

    const cachePath =
      keyFields.length > 0
        ? cacheEntryPath(this.requireRepoRoot(def.name), def.name, cacheKey(keyParts))
        : undefined;
    const cached = cachePath ? readCacheEntry<unknown>(cachePath) : undefined;
    if (cached !== undefined) return cached;

    const result = await this.runner.run({
      tool: def,
      prompt: loaded.prompt,
      input: rawInput,
      cwd: this.resolveWorktree(ctx, def.name),
      maxOutputTokens: def.runner.max_output_tokens,
    });
    let output: unknown;
    try {
      output = JSON.parse(result.text);
    } catch {
      output = { text: result.text };
    }
    if (cachePath) writeCacheEntry(cachePath, output);
    return output;
  }
}
