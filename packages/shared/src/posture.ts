/**
 * T457 (D45 follow-up): the permission posture. Vendors keep their normal
 * permission mode; the daemon decides every read outside a node's own
 * worktree:
 *
 *  - `trusted` (like Claude's bypass or Codex's yolo): any path on disk,
 *    without asking, except the agile home, private repos of other projects
 *    and the named credential locations;
 *  - `ask` (the default): the registered repos it can see, and the
 *    project's "Always" read roots; a read anywhere else is a Needs me card
 *    (Allow once, Always for this project, Deny).
 *
 * Writes stay in the node's own worktree under both. Its own module because
 * the home config and the project record both carry it (as `effort.ts`).
 */

import { z } from 'zod';
import { formatZodError } from './ids';

export const PERMISSION_POSTURES = ['trusted', 'ask'] as const;
export const PermissionPostureSchema = z.enum(PERMISSION_POSTURES);
export type PermissionPosture = z.infer<typeof PermissionPostureSchema>;

/** Neither the home nor the project names one. */
export const DEFAULT_PERMISSION_POSTURE: PermissionPosture = 'ask';

export const READ_ROOT_MAX_CHARS = 1024;
/** Enough for a project's hand-picked extra dirs; more is a sign it should be Trusted. */
export const READ_ROOTS_MAX = 50;

/**
 * An "Always for this project" read root: an absolute, normalised directory
 * (no `.`/`..` segment, no trailing or doubled `/`), never `/` itself.
 */
export const ReadRootSchema = z
  .string()
  .max(READ_ROOT_MAX_CHARS)
  .regex(/^(\/[^/\0]+)+$/, 'must be an absolute path (not /), with no trailing or doubled /')
  .refine(
    (path) => path.split('/').every((part) => part !== '.' && part !== '..'),
    'must not contain a . or .. segment',
  );
export const ReadRootsSchema = z.array(ReadRootSchema).max(READ_ROOTS_MAX);

/** `POST /api/settings/permissions`: the home's posture. */
export const PermissionsInputSchema = z.object({ posture: PermissionPostureSchema }).strict();
export type PermissionsInput = z.infer<typeof PermissionsInputSchema>;

export function validatePermissionPosture(input: unknown): PermissionPosture {
  const result = PermissionPostureSchema.safeParse(input);
  if (!result.success) throw new Error(formatZodError('PermissionPosture', result.error));
  return result.data;
}
