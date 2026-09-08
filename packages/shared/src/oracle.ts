/**
 * OracleEntry — decision/spec header (design/agile-agents-design.md §4 "Oracle").
 *
 * Decisions and specs share this header. Body is prose and out of scope for
 * the schema (the yaml block is the frontmatter of a markdown file).
 */

import { z } from 'zod';
import { OracleIdSchema, formatZodError } from './ids';

export const OracleStatusSchema = z.enum(['active', 'superseded', 'retired']);
export type OracleStatus = z.infer<typeof OracleStatusSchema>;

export const OracleEntrySchema = z
  .object({
    id: OracleIdSchema,
    title: z.string().min(1),
    status: OracleStatusSchema,
    supersedes: z.array(OracleIdSchema).default([]),
    // DESIGN-GAP: `depends` is shown as a single-item array (`[SPEC-auth-003]`)
    // with no cardinality rule given; modeled as any-length array like the
    // other graph-edge fields (`affects`, `supersedes`).
    depends: z.array(OracleIdSchema).default([]),
    // "affects makes ripple analysis a graph walk" — forward edges, architect-maintained.
    affects: z.array(OracleIdSchema).default([]),
    decided: z.string().min(1),
    // "by: architect  # or human"
    by: z.enum(['architect', 'human']),
    rationale: z.string().min(1),
  })
  .strict();

export type OracleEntry = z.infer<typeof OracleEntrySchema>;

export function validateOracleEntry(input: unknown): OracleEntry {
  const result = OracleEntrySchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('OracleEntry', result.error));
  }
  return result.data;
}
