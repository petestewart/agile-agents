/**
 * Registered repos (PLAN.md §5 "State home" → `repos.yaml`; D8 protected
 * branches, D9 one daemon for many repos).
 *
 * `~/.agile/repos.yaml` is a mapping of repo name -> entry. The daemon is
 * not a per-repo process: a repo is *registered* with the home, and every
 * stream that has a repo names one of these entries.
 */

import { z } from 'zod';
import { EffortSchema } from './effort';
import { formatZodError } from './ids';

/** D8: pushing to (or merging into) these is prohibited by default. */
export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master'] as const;

export const RepoEntrySchema = z
  .object({
    /** Absolute path to the repo's toplevel. */
    path: z.string().min(1),
    /** D8. Defaults to `[main, master]`. */
    protected_branches: z.array(z.string().min(1)).default([...DEFAULT_PROTECTED_BRANCHES]),
    /** Where streams in this repo land by default (an integration branch, if the repo has one). */
    target_branch: z.string().min(1).optional(),
    /**
     * T132, §8.2: raise a `land` gate before merging a stream in this repo.
     * Off by default on purpose — "the button IS the decision", and a gate
     * on top of a button is a confirmation dialog.
     */
    land_gate: z.boolean().optional(),
    /** Default vendor for sessions attached to streams in this repo. */
    vendor: z.string().min(1).optional(),
    /** Default model for those sessions (T130, D12) — second in the resolution order, after the `--model` flag. */
    model: z.string().min(1).optional(),
    /** Default effort for those sessions (T130, D12). */
    effort: EffortSchema.optional(),
  })
  .strict();

export type RepoEntry = z.infer<typeof RepoEntrySchema>;

/** `~/.agile/repos.yaml` — one entry per registered repo, keyed by short name. */
export const ReposConfigSchema = z.record(z.string().min(1), RepoEntrySchema);
export type ReposConfig = z.infer<typeof ReposConfigSchema>;

export function validateRepoEntry(input: unknown): RepoEntry {
  const result = RepoEntrySchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('repo entry', result.error));
  }
  return result.data;
}

export function validateReposConfig(input: unknown): ReposConfig {
  const result = ReposConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('repos.yaml', result.error));
  }
  return result.data;
}
