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

/**
 * `oracle/index.yaml` (§4 "Oracle": "index.yaml # id → title, status,
 * supersedes, depends (active only)"; init writes `{}`, T004).
 *
 * DESIGN-GAP: no literal yaml block is given for this file, only that one
 * inline comment. Modeled directly from it: a map keyed by id (matching the
 * `{}` empty-object default, not an array) to exactly the four named
 * fields — a projection of `OracleEntrySchema` minus `affects`, `decided`,
 * `by`, `rationale` (ripple/audit detail that belongs to the entry file
 * itself, not the lookup index). "(active only)" is enforced by the writer
 * (T005's store drops an entry from the index when it supersedes/retires,
 * per "Superseded files ... drop out of index.yaml so readers never load
 * dead items by default"), not by this schema — a superseded entry is still
 * a structurally valid `OracleIndexEntry` while the index is being rewritten.
 */
export const OracleIndexEntrySchema = z
  .object({
    title: z.string().min(1),
    status: OracleStatusSchema,
    supersedes: z.array(OracleIdSchema).default([]),
    depends: z.array(OracleIdSchema).default([]),
  })
  .strict();
export type OracleIndexEntry = z.infer<typeof OracleIndexEntrySchema>;

export const OracleIndexSchema = z.record(OracleIdSchema, OracleIndexEntrySchema);
export type OracleIndex = z.infer<typeof OracleIndexSchema>;

export function validateOracleIndex(input: unknown): OracleIndex {
  const result = OracleIndexSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('OracleIndex', result.error));
  }
  return result.data;
}
