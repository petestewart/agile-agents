/**
 * Tool definition (design/agile-agents-design.md §7 "Tool framework").
 *
 * A tool is a folder (`.agile/tools/<name>/tool.yaml` + prompt + optional
 * script); this schema covers `tool.yaml`.
 */

import { z } from 'zod';
import { formatZodError } from './ids';
import { LedgerKindSchema } from './ledger';
import { TicketTierSchema } from './ticket';

/**
 * DESIGN-GAP: only `hook: pre-tool-use` is shown in the §7 example; §5/§6
 * mention turn-end/stop delivery and pre-commit as other hook points, so the
 * value is kept as a free-form string rather than a closed enum.
 */
export const ToolTriggerSchema = z.object({
  hook: z.string().min(1),
  // A small boolean DSL over tool/file predicates, e.g.
  // "tool in [Read, cat] and (file.size > 30KB or files > 5)" — kept as a raw
  // string; there is no parser for it in this ticket's scope.
  match: z.string().min(1),
});
export type ToolTrigger = z.infer<typeof ToolTriggerSchema>;

export const TOOL_ACTIONS = ['redirect', 'deny', 'augment', 'require'] as const;
export const ToolActionSchema = z.enum(TOOL_ACTIONS);
export type ToolAction = z.infer<typeof ToolActionSchema>;

export const ToolRunnerSchema = z.object({
  tier: TicketTierSchema,
  max_output_tokens: z.number().int().min(1),
});
export type ToolRunner = z.infer<typeof ToolRunnerSchema>;

export const ToolCacheSchema = z.object({
  key: z.array(z.string().min(1)).default([]),
  ttl: z.string().min(1),
});
export type ToolCache = z.infer<typeof ToolCacheSchema>;

/**
 * `promote_to_kb: optional` is the only value shown; DESIGN-GAP: the closed
 * set below adds `required`/`never` as the natural complements ("summaries
 * can be proposed as KB facts" implies it is not always on).
 */
export const PromoteToKbSchema = z.enum(['optional', 'required', 'never']).default('never');

/**
 * `input`/`output` are ad hoc type sketches (`{ path: string, question?:
 * string }`, `{ summary: string, refs: [{path, lines}] }`), not data — kept
 * as permissive records rather than encoding a mini type-grammar.
 */
export const ToolIoSchema = z.record(z.string().min(1), z.unknown());

export const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  // DESIGN-GAP: only `kind: reader` is shown; other starter tools
  // (find_in_repo, kb_lookup, test_run, log_tail, diff_summary, doc_lookup)
  // are named but never given a `kind` value, so this stays a free string.
  kind: z.string().min(1),
  trigger: ToolTriggerSchema,
  action: ToolActionSchema,
  runner: ToolRunnerSchema,
  input: ToolIoSchema.default({}),
  output: ToolIoSchema.default({}),
  cache: ToolCacheSchema.optional(),
  ledger_kind: LedgerKindSchema,
  promote_to_kb: PromoteToKbSchema.optional(),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export function validateToolDefinition(input: unknown): ToolDefinition {
  const result = ToolDefinitionSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('ToolDefinition', result.error));
  }
  return result.data;
}
