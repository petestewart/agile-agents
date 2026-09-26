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
import { type DeliveryOverride, ProjectIdSchema } from './project';

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
    /**
     * T131 (cockpit design §4.2, "Optional per repo: auto-review when
     * `agent.status` becomes `done`"): when true, a worker session that
     * exits cleanly on a stream in this repo is followed by a reviewer
     * session on the same worktree. Absent means off.
     */
    auto_review: z.boolean().optional(),
    /**
     * T150 (§6.4): the per-repo default for the classifier tier. A stream's
     * own `classifier: 'off'` still wins; absent means "fall through to
     * `config.yaml`". Spelled `on`/`off` rather than a boolean so the repo
     * entry reads the same way the stream field and the CLI flag do.
     */
    classifier: z.enum(['on', 'off']).optional(),
    /*
     * projects-design §14.8 (T202). Optional in the schema: the home
     * migration (§17.1 step 3) and `addRepo` write them; absent reads as
     * `direct` / public.
     */
    delivery: z.enum(['direct', 'pr']).optional(),
    /** T222 (§14.8): pr mode only; absent is off. */
    auto_merge: z.boolean().optional(),
    /** T222: the git remote pr mode pushes to; absent is `origin`. */
    remote: z.string().min(1).optional(),
    /** T222: inferred from the remote URL when pr mode is set, stored once confirmed. */
    github: z
      .object({ owner: z.string().min(1), repo: z.string().min(1) })
      .strict()
      .optional(),
    /**
     * T339: the repo's own check commands, handed to agents in the brief.
     * Absent means the worktree's `package.json` scripts (test, typecheck, lint, build).
     */
    checks: z.array(z.string().min(1)).optional(),
    /** The branch this repo's work delivers to; the migration carries `target_branch` over. */
    main_branch: z.string().min(1).optional(),
    visibility: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('public') }).strict(),
        z.object({ mode: z.literal('private'), projects: z.array(ProjectIdSchema) }).strict(),
      ])
      .optional(),
  })
  .strict();

export type RepoEntry = z.infer<typeof RepoEntrySchema>;

export type DeliveryMode = 'direct' | 'pr';
export interface ResolvedDelivery {
  mode: DeliveryMode;
  /** Always false in direct mode (§14.8: auto-merge is pr only). */
  auto_merge: boolean;
}

/**
 * T222 (§14.8, §14.2): the one place delivery is resolved. Each field is
 * taken from the node's override, else the project's, else the repo entry,
 * else `direct` / off.
 */
export function resolveDelivery(
  repo: Pick<RepoEntry, 'delivery' | 'auto_merge'> | undefined,
  project?: { delivery?: DeliveryOverride } | undefined,
  node?: { delivery?: DeliveryOverride } | undefined,
): ResolvedDelivery {
  const mode = node?.delivery?.mode ?? project?.delivery?.mode ?? repo?.delivery ?? 'direct';
  const autoMerge =
    node?.delivery?.auto_merge ?? project?.delivery?.auto_merge ?? repo?.auto_merge ?? false;
  return { mode, auto_merge: mode === 'pr' && autoMerge };
}

/**
 * T222: `agile repo set` / Settings → Repos. Absent = unchanged, `null` =
 * removed. `github` is not settable: the daemon infers it from the remote.
 */
export const RepoSettingsPatchSchema = z
  .object({
    delivery: z.enum(['direct', 'pr']).optional(),
    auto_merge: z.boolean().nullable().optional(),
    remote: z.string().min(1).nullable().optional(),
    main_branch: z.string().min(1).nullable().optional(),
    visibility: RepoEntrySchema.shape.visibility.unwrap().optional(),
  })
  .strict();
export type RepoSettingsPatch = z.infer<typeof RepoSettingsPatchSchema>;

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
