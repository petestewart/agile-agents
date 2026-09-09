/**
 * `ToolService` — the one daemon-side object the `tool.*` RPC methods and
 * the in-process `createToolMcpServer` factory both call into (T011). Owns
 * the loaded registry, the runner, and wiring to `StateStore`/`Bus` for the
 * built-in verbs and the ledger.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { LedgerKind, TicketId } from '@agile-agents/shared';
import type { Bus } from '../bus/bus';
import type { StateStore } from '../store/store';
import { BUILTIN_TOOLS, type BuiltinToolDeps } from './builtins';
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
  /** `builtin` (board_post/bus_send/ticket_get/oracle_get/kb_search) or `registry` (loaded from `.agile/tools/<name>/tool.yaml`). */
  source: 'builtin' | 'registry';
  /** Real per-field shape (review fix, T011) — see `schema.ts`'s header. RPC-safe: plain strings/booleans, no zod instances, so `tool.list` can ship it verbatim to a remote MCP bridge. */
  inputSpec: ToolInputSpec;
}

export interface ToolServiceOptions {
  store: StateStore;
  bus: Bus;
  registry: LoadedTool[];
  runner: ToolRunner;
  /** Repo root — the cache/raw-output host-local root (`cache.ts`), and the fallback worktree when a ticket has none on record yet. */
  repoRoot: string;
  /** Resolves the current sprint id for cache TTL scoping (§7: "ttl: sprint"); `undefined` when no sprint is active. */
  currentSprintId?: () => string | undefined;
}

export class ToolService {
  private readonly store: StateStore;
  private readonly bus: Bus;
  private readonly registry: LoadedTool[];
  private readonly runner: ToolRunner;
  private readonly repoRoot: string;
  private readonly currentSprintId: () => string | undefined;

  constructor(opts: ToolServiceOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.registry = opts.registry;
    this.runner = opts.runner;
    this.repoRoot = opts.repoRoot;
    this.currentSprintId = opts.currentSprintId ?? (() => undefined);
  }

  listTools(): ToolListEntry[] {
    const builtins: ToolListEntry[] = BUILTIN_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      source: 'builtin',
      inputSpec: t.inputSpec,
    }));
    const registered: ToolListEntry[] = this.registry.map((t) => ({
      name: t.definition.name,
      description: `${t.definition.kind} tool (${t.definition.action}); ledger_kind=${t.definition.ledger_kind}`,
      source: 'registry',
      inputSpec: inputSpecFromToolIo(t.definition.input),
    }));
    return [...builtins, ...registered];
  }

  /** The ticket's worktree if one is on record, else the repo root — see `ReadSummaryOptions`/`RunTestRunOptions`'s worktree contract. */
  private resolveWorktree(ctx: ToolCallContext): string {
    if (ctx.ticket) {
      try {
        const ticket = this.store.getTicket(ctx.ticket as TicketId);
        if (ticket.worktree) {
          return isAbsolute(ticket.worktree)
            ? ticket.worktree
            : join(this.repoRoot, ticket.worktree);
        }
      } catch {
        // No such ticket (yet), or no worktree recorded — fall back below.
      }
    }
    return this.repoRoot;
  }

  async callTool(ctx: ToolCallContext, name: string, input: unknown): Promise<unknown> {
    const builtin = BUILTIN_TOOLS.find((t) => t.name === name);
    if (builtin) {
      const deps: BuiltinToolDeps = { store: this.store, bus: this.bus };
      return builtin.handler(deps, ctx, input);
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
    const worktree = this.resolveWorktree(ctx);
    const output = await runTestRun({
      input: input as { command: string; cwd?: string },
      worktree,
      repoRoot: this.repoRoot,
    });
    await this.writeLedgerLine(ctx, loaded.definition.ledger_kind, {
      model: '',
      inTokens: 0,
      outTokens: 0,
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
      const worktree = this.resolveWorktree(ctx);
      const result = await runReadSummary({
        tool: loaded,
        ctx,
        input: input as { path: string; question?: string },
        worktree,
        repoRoot: this.repoRoot,
        sprintId: this.currentSprintId(),
        runner: this.runner,
      });
      await this.writeLedgerLine(ctx, loaded.definition.ledger_kind, {
        model: result.model,
        inTokens: result.inTokens,
        outTokens: result.outTokens,
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
            isAbsolute(pathValue) ? pathValue : join(this.resolveWorktree(ctx), pathValue),
            'utf8',
          ),
        );
      }
      const value = rawInput[field];
      return typeof value === 'string' ? value : JSON.stringify(value ?? null);
    });

    const cachePath =
      keyFields.length > 0
        ? cacheEntryPath(this.repoRoot, def.name, this.currentSprintId(), cacheKey(keyParts))
        : undefined;
    const cached = cachePath ? readCacheEntry<unknown>(cachePath) : undefined;
    if (cached !== undefined) {
      await this.writeLedgerLine(ctx, def.ledger_kind, { model: '', inTokens: 0, outTokens: 0 });
      return cached;
    }

    const result = await this.runner.run({
      tool: def,
      prompt: loaded.prompt,
      input: rawInput,
      cwd: this.resolveWorktree(ctx),
      maxOutputTokens: def.runner.max_output_tokens,
    });
    let output: unknown;
    try {
      output = JSON.parse(result.text);
    } catch {
      output = { text: result.text };
    }
    if (cachePath) writeCacheEntry(cachePath, output);
    await this.writeLedgerLine(ctx, def.ledger_kind, {
      model: result.model,
      inTokens: result.inTokens,
      outTokens: result.outTokens,
    });
    return output;
  }

  /**
   * DESIGN-GAP: §7's ledger example ("appendLedgerLine(sprint, {...,
   * ledger_kind: tool.ledger_kind, tokens, cache})") names a `cache` field
   * the shared `LedgerLineSchema` (T005, not owned by this ticket) doesn't
   * have — only `in_tokens`/`out_tokens`/`cost_usd`. Rather than extend a
   * file outside this ticket's granted ownership, "zero runner cost" is
   * represented the way the existing schema already can: a cache hit writes
   * `in_tokens: 0, out_tokens: 0, model: ''`, which is externally
   * distinguishable from a real (however cheap) runner call without a new
   * field. A literal `cache: hit/miss` marker is left for whoever next edits
   * `ledger.ts`.
   */
  private async writeLedgerLine(
    ctx: ToolCallContext,
    kind: LedgerKind,
    usage: { model: string; inTokens: number; outTokens: number },
  ): Promise<void> {
    const sprint = this.currentSprintId() ?? 'nosprint';
    await this.store.appendLedgerLine(
      sprint,
      {
        ts: new Date().toISOString(),
        sprint,
        ticket: ctx.ticket ?? '',
        agent: ctx.agent,
        model: usage.model,
        in_tokens: usage.inTokens,
        out_tokens: usage.outTokens,
        cost_usd: 0,
        kind,
      },
      { commit: 'deferred' },
    );
  }
}
