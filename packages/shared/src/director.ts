/**
 * The Director record (T300, projects-design §12, §14.11, P16): a singleton
 * at `<home>/director.yaml`, not a node in any project tree. Its thread is
 * `<home>/threads/director.jsonl` and its routed-event queue is
 * `events/queue/director.jsonl`; `DIRECTOR_NODE` is the id both use.
 */

import { z } from 'zod';
import { formatZodError } from './ids';
import { SessionRefSchema } from './stream';

/** The Director's id wherever a node id would go (thread file, event queue, routing). */
export const DIRECTOR_NODE = 'director';

export const DirectorRecordSchema = z
  .object({
    thread: z.literal(DIRECTOR_NODE),
    /** The Director's current (or last) session. */
    session: SessionRefSchema.optional(),
    created_at: z.string().datetime(),
  })
  .strict();
export type DirectorRecord = z.infer<typeof DirectorRecordSchema>;

export function validateDirectorRecord(input: unknown): DirectorRecord {
  const result = DirectorRecordSchema.safeParse(input);
  if (!result.success) throw new Error(formatZodError('DirectorRecord', result.error));
  return result.data;
}
