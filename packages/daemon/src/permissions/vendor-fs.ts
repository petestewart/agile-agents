/**
 * Grok's client-fs permission gate (T027 — design/agile-agents-design.md §6
 * tier "1b · client fs", §14 "Permissions per role"; design/
 * spike-findings.md §C2/§C3: Grok "routes all file I/O through client
 * `fs/*`" and raises **zero** ACP permission requests and has no hook layer
 * ("none known") — so client fs is Grok's *only* gateable surface, not a
 * backstop next to tier 1/2 the way it is for Claude. The spike confirmed a
 * refusal's message text reaches the model verbatim: "refusing
 * `fs/read_text_file` with an error message works — the model reported
 * `REFUSED "…IO Error: AGILE-GATE: this file is too large for a raw read.
 * …"`. Reasoned read/write denial on Grok is real." So a thrown `Error`
 * with an `AGILE-GATE:`-prefixed message (the convention `hook/service.ts`
 * and `spike/permission-matrix.ts` already use) is the whole gate — no
 * separate reason channel to wire, unlike ACP `reject_once` (which
 * `types.ts`'s file header notes carries no reason field on the wire at
 * all).
 *
 * Wiring point: `runner/session.ts` passes this as `SpawnSessionOptions.
 * fsImpl` — `@agile-agents/acp-client`'s injection seam for the `fs/*`
 * handlers `session.ts` runs when the agent calls them (documented there as
 * a *test* seam; reused here as the production gate point because nothing
 * in this package's ownership can observe a Grok client-fs call before it
 * already succeeded against the real filesystem otherwise). Wired only for
 * `provider.id === 'grok'` — no other registered provider is measured
 * routing real file I/O through client fs (Claude/Cursor/Codex/Gemini's own
 * tools do their own I/O; each advertises `fs: {readTextFile: true,
 * writeTextFile: true}` in `providers.ts` anyway, which is harmless exactly
 * because it goes unused).
 */

import { readFile, realpath, writeFile } from 'node:fs/promises';
import type { PermissionRole } from './types';

/** Matches `@agile-agents/acp-client`'s `SpawnSessionOptions['fsImpl']` shape without importing it (this package doesn't otherwise depend on acp-client's internal fs typing, and the shape is small enough to restate). */
export interface VendorFsImpl {
  readFile: (path: string, encoding: 'utf8') => Promise<string>;
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>;
  realpath: (path: string) => Promise<string>;
}

/**
 * §14 "Permissions per role", Write column: Reviewer = "nothing". This is
 * this ticket's acceptance criterion ("a reviewer on Grok cannot write")
 * and the only row this module enforces categorically — Engineer Write
 * ("own worktree only") and QA Write ("own test files in the env") both
 * stay unscoped here (their finer-grained containment is out of this
 * ticket's scope; nothing about Grok changes what an engineer or QA may
 * write, only what a *reviewer* may).
 */
export function canWriteViaClientFs(role: PermissionRole): boolean {
  return role !== 'reviewer';
}

/**
 * Builds the `fsImpl` a Grok session of the given role should run under.
 * Reads and `realpath` are never gated here — §14's Reviewer Read is
 * "worktree via tools" (allowed), and read-gating Grok's client fs isn't
 * this ticket's acceptance criterion — only `writeFile` refuses, and only
 * for a reviewer.
 */
export function buildGrokFsPolicy(role: PermissionRole): VendorFsImpl {
  return {
    readFile: (path, encoding) => readFile(path, encoding),
    async writeFile(path, data, encoding) {
      if (!canWriteViaClientFs(role)) {
        throw new Error(
          `AGILE-GATE: ${role} may not write files (client-fs policy — vendor=grok, design §14 "Permissions per role": Reviewer Write = nothing). This ticket is read-only for you; findings go in the review report.`,
        );
      }
      return writeFile(path, data, encoding);
    },
    realpath: (path) => realpath(path),
  };
}
