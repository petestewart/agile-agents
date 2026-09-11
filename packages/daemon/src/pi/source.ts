/**
 * Reads `agile-extension.ts`'s own source text off disk, for
 * `installPiExtension` to copy verbatim into `~/.pi/agent/extensions/
 * agile.ts` (T022 — see `agile-extension.ts`'s file header on why the
 * installed copy has to be this file's *literal* bytes, not a
 * re-serialization of it).
 *
 * Resolved relative to this module's own file (`import.meta.url`), not the
 * process cwd — `packages/daemon`'s `package.json` points `main` at
 * `./src/index.ts` (Bun runs the package straight from TypeScript source,
 * no compiled `dist/` in the loop for the actual daemon process), so
 * `agile-extension.ts` is always a sibling of this file wherever the
 * package itself is loaded from.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readAgileExtensionSource(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(dir, 'agile-extension.ts'), 'utf8');
}
