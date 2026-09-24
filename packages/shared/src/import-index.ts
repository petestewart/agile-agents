/**
 * ImportIndex — `~/.agile/index/<repo>.json` (projects-design §14.6, P14, T284).
 *
 * A derived cache, rebuilt whenever the repo's main moves: each TS/JS file's
 * exported names and what it imports from which repo file. Deleting it is
 * safe. `names` is `*` for a namespace, side-effect or `export *` import.
 */

import { z } from 'zod';
import { formatZodError } from './ids';

const Name = z.string().min(1).max(200);
const File = z.string().min(1).max(1024);

export const ImportIndexEntrySchema = z
  .object({
    exports: z.array(Name),
    imports: z.array(z.object({ from: File, names: z.array(Name) }).strict()),
  })
  .strict();
export type ImportIndexEntry = z.infer<typeof ImportIndexEntrySchema>;

export const ImportIndexSchema = z
  .object({
    repo: z.string().min(1),
    /** The main commit the index was built from. */
    sha: z.string().min(1),
    files: z.record(File, ImportIndexEntrySchema),
    built_at: z.string().datetime(),
  })
  .strict();
export type ImportIndex = z.infer<typeof ImportIndexSchema>;

export function validateImportIndex(raw: unknown): ImportIndex {
  const result = ImportIndexSchema.safeParse(raw);
  if (!result.success) throw new Error(formatZodError('ImportIndex', result.error));
  return result.data;
}
