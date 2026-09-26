/**
 * Project — a record plus a root node (projects-design §14.1, P2, T200).
 *
 * `~/.agile/projects/<id>.yaml` holds the project's settings; its thread
 * and tree hang off `root`, an ordinary stream with no parent. Names are
 * unique case-insensitively; the store enforces that under its mutex.
 */

import { z } from 'zod';
import { EffortSchema } from './effort';
import { ULID_PATTERN, UlidSchema, formatZodError } from './ids';

export const PROJECT_ID_PATTERN = new RegExp(`^P-${ULID_PATTERN.source.slice(1, -1)}$`);
export const ProjectIdSchema = z.string().regex(PROJECT_ID_PATTERN, 'must look like P-<ulid>');
export type ProjectId = z.infer<typeof ProjectIdSchema>;

/** How far a coordinator or the Director may act on its own (§14.1). */
export const AUTONOMY_LEVELS = ['advise', 'organise', 'run'] as const;
export const AutonomySchema = z.enum(AUTONOMY_LEVELS);
export type Autonomy = z.infer<typeof AutonomySchema>;

/** Overrides repo delivery (§14.2); shared with the node fields T201 adds. */
export const DeliveryOverrideSchema = z
  .object({
    mode: z.enum(['direct', 'pr']).optional(),
    auto_merge: z.boolean().optional(),
  })
  .strict();
export type DeliveryOverride = z.infer<typeof DeliveryOverrideSchema>;

/** §14.10. Absent on a project means no Jira/Linear. */
export const TrackerSettingsSchema = z
  .object({
    system: z.enum(['jira', 'linear']),
    base_url: z.string().min(1).optional(),
    push_status: z.boolean().default(false),
    status_map: z
      .object({
        in_progress: z.string().min(1).optional(),
        in_review: z.string().min(1).optional(),
        done: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TrackerSettings = z.infer<typeof TrackerSettingsSchema>;

/** The project step of the session default order (P5). */
export const ProjectSessionDefaultsSchema = z
  .object({
    vendor: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: EffortSchema.optional(),
  })
  .strict();
export type ProjectSessionDefaults = z.infer<typeof ProjectSessionDefaultsSchema>;

export const PROJECT_NAME_MAX_CHARS = 80;
export const ProjectNameSchema = z.string().trim().min(1).max(PROJECT_NAME_MAX_CHARS);

/** `~/.agile/projects/<id>.yaml`. */
export const ProjectSchema = z
  .object({
    id: ProjectIdSchema,
    name: ProjectNameSchema,
    /** The root node: a stream with no parent that carries the project's thread. */
    root: UlidSchema,
    /** Names from `repos.yaml` this project uses. */
    repos: z.array(z.string().min(1)).default([]),
    session: ProjectSessionDefaultsSchema.optional(),
    delivery: DeliveryOverrideSchema.optional(),
    autonomy: z
      .object({
        coordinator: AutonomySchema.default('advise'),
        director: AutonomySchema.default('advise'),
      })
      .strict()
      .default({ coordinator: 'advise', director: 'advise' }),
    tracker: TrackerSettingsSchema.optional(),
    /** Like a stream's: hidden from `list` by default, nothing moves on disk. */
    archived: z.literal(true).optional(),
    created_at: z.string().min(1),
  })
  .strict();
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectInput = z.input<typeof ProjectSchema>;

/** What a caller supplies to create a project; the daemon mints the rest. */
export const ProjectCreateInputSchema = z
  .object({
    name: ProjectNameSchema,
    repos: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ProjectCreateInput = z.infer<typeof ProjectCreateInputSchema>;

/**
 * The settings a caller may change. `null` clears an optional block.
 * `id`, `root`, `created_at` and `archived` are not settable here.
 */
export const ProjectUpdateInputSchema = z
  .object({
    name: ProjectNameSchema.optional(),
    repos: z.array(z.string().min(1)).optional(),
    session: ProjectSessionDefaultsSchema.nullable().optional(),
    delivery: DeliveryOverrideSchema.nullable().optional(),
    autonomy: z
      .object({
        coordinator: AutonomySchema.optional(),
        director: AutonomySchema.optional(),
      })
      .strict()
      .optional(),
    tracker: TrackerSettingsSchema.nullable().optional(),
  })
  .strict();
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateInputSchema>;

export function validateProject(input: unknown): Project {
  const result = ProjectSchema.safeParse(input);
  if (!result.success) throw new Error(formatZodError('Project', result.error));
  return result.data;
}

export function validateProjectCreateInput(input: unknown): ProjectCreateInput {
  const result = ProjectCreateInputSchema.safeParse(input);
  if (!result.success) throw new Error(formatZodError('ProjectCreateInput', result.error));
  return result.data;
}

export function validateProjectUpdateInput(input: unknown): ProjectUpdateInput {
  const result = ProjectUpdateInputSchema.safeParse(input);
  if (!result.success) throw new Error(formatZodError('ProjectUpdateInput', result.error));
  return result.data;
}

/** The case-insensitive key names are unique on. */
export function projectNameKey(name: string): string {
  return name.trim().toLowerCase();
}
