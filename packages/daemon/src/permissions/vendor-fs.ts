/**
 * Grok's client-fs gate (spike-findings.md §C2/§C3). Grok routes all file
 * I/O through client `fs/*`, raises no ACP permission requests and has no
 * hooks, so client fs is its only gateable surface. A thrown `Error` with
 * an `AGILE-GATE:` message reaches the model verbatim, so that is the
 * whole gate. `runner/session.ts` passes this as `fsImpl` for Grok only.
 */

import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isPathInside } from './command';
import type { PermissionRole } from './types';

/** acp-client's `SpawnSessionOptions['fsImpl']` shape, restated. */
export interface VendorFsImpl {
  readFile: (path: string, encoding: 'utf8') => Promise<string>;
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>;
  realpath: (path: string) => Promise<string>;
}

/** §14 Write column: a reviewer writes nothing; a coordinator only inside its session dir (P20). */
export function canWriteViaClientFs(role: PermissionRole, path?: string, cwd?: string): boolean {
  if (role === 'coordinator') {
    return path !== undefined && cwd !== undefined && isPathInside(path, cwd);
  }
  return role !== 'reviewer';
}

/** The `fsImpl` for a Grok session: only a reviewer's `writeFile` is refused; reads are never gated. */
export function buildGrokFsPolicy(role: PermissionRole, cwd?: string): VendorFsImpl {
  return {
    readFile: (path, encoding) => readFile(path, encoding),
    async writeFile(path, data, encoding) {
      if (!canWriteViaClientFs(role, path, cwd)) {
        throw new Error(
          `AGILE-GATE: ${role} may not write files (client-fs policy — vendor=grok, design §14 "Permissions per role": Reviewer Write = nothing). This ticket is read-only for you; findings go in the review report.`,
        );
      }
      return writeFile(path, data, encoding);
    },
    realpath: (path) => realpath(path),
  };
}
