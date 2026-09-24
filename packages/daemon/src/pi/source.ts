/**
 * Reads `agile-extension.ts`'s own source text for `installPiExtension` to
 * copy verbatim. Resolved from this module's location (the daemon runs
 * from TypeScript source, so the file is always a sibling), not the cwd.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readAgileExtensionSource(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(dir, 'agile-extension.ts'), 'utf8');
}
