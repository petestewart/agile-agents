/**
 * Brief rendering (PLAN.md T013 "Role briefs and ceremony templates").
 *
 * Loads the Markdown templates under `packages/daemon/briefs/` (resolved at
 * runtime relative to this module — see `BRIEFS_DIR` below, which works both
 * from `src/briefs/` under Bun/ts-node and from `dist/briefs/` after
 * `tsc` build) and renders them against typed context built from
 * `@agile-agents/shared` entities.
 *
 * Prompts are the intent layer, not the enforcement layer (design §6): a
 * brief states a role's contract, its MCP verbs, and what it must never do,
 * but the actual gates are hooks and daemon-side checks elsewhere. Keep new
 * briefs short — the whole point of the token-ceiling tests.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatesBlock } from '@agile-agents/shared';
import { approxTokenCount, render } from './template';
import type {
  ArchitectBriefContext,
  EmBriefContext,
  EngineerBriefContext,
  QaBriefContext,
  ReaderBriefContext,
  RefinementContext,
  RetroContext,
  ReviewerBriefContext,
  SprintReviewContext,
  StandupContext,
} from './types';

export * from './template';
export * from './types';

/**
 * Resolved relative to this module: from `src/briefs/index.ts` that's
 * `packages/daemon/briefs`; from the compiled `dist/briefs/index.js` (same
 * nesting depth, since `tsc`'s `rootDir: src` mirrors `src/briefs` to
 * `dist/briefs`) it resolves to the same directory. Either way the `.md`
 * templates live outside `dist` and are read straight off disk, not bundled.
 */
const BRIEFS_DIR = join(import.meta.dir, '../../briefs');

const templateCache = new Map<string, string>();

function loadTemplate(name: string): string {
  const cached = templateCache.get(name);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(BRIEFS_DIR, `${name}.md`), 'utf8');
  templateCache.set(name, text);
  return text;
}

/** `{a: 'human', b: 'em'}` -> `[{name: 'a', owner: 'human'}, ...]`, for `{{#each}}` over a GatesBlock record. */
function gatesToList(gates: GatesBlock | undefined): Array<{ name: string; owner: string }> {
  if (gates === undefined) return [];
  return Object.entries(gates).map(([name, owner]) => ({ name, owner }));
}

export const ROLE_BRIEF_NAMES = [
  'em',
  'architect',
  'engineer',
  'reviewer',
  'qa',
  'reader',
] as const;
export type RoleBriefName = (typeof ROLE_BRIEF_NAMES)[number];

export const CEREMONY_TEMPLATE_NAMES = ['standup', 'refinement', 'sprint-review', 'retro'] as const;
export type CeremonyTemplateName = (typeof CEREMONY_TEMPLATE_NAMES)[number];

/** Ceiling asserted in tests; role briefs stay short — enforcement is elsewhere (§6). */
export const ROLE_BRIEF_TOKEN_CEILING = 900;
/** Ceiling asserted in tests; ceremony templates render per-item lists so stay tighter. */
export const CEREMONY_TEMPLATE_TOKEN_CEILING = 500;

export function renderEngineerBrief(ctx: EngineerBriefContext): string {
  return render(loadTemplate('engineer'), ctx);
}

export function renderArchitectBrief(ctx: ArchitectBriefContext): string {
  return render(loadTemplate('architect'), ctx);
}

export function renderEmBrief(ctx: EmBriefContext): string {
  return render(loadTemplate('em'), {
    agent: ctx.agent,
    sprint: ctx.sprint,
    policy: { ...ctx.policy, gates: gatesToList(ctx.policy.gates) },
  });
}

export function renderReviewerBrief(ctx: ReviewerBriefContext): string {
  return render(loadTemplate('reviewer'), ctx);
}

export function renderQaBrief(ctx: QaBriefContext): string {
  return render(loadTemplate('qa'), ctx);
}

export function renderReaderBrief(ctx: ReaderBriefContext): string {
  return render(loadTemplate('reader'), ctx);
}

export function renderStandup(ctx: StandupContext): string {
  return render(loadTemplate('standup'), ctx);
}

export function renderRefinement(ctx: RefinementContext): string {
  return render(loadTemplate('refinement'), ctx);
}

export function renderSprintReview(ctx: SprintReviewContext): string {
  // Most-specific-wins resolution (§16): sprint override, then repo default.
  // Resolved here, not in the template, so an unresolvable owner fails the
  // same way any other missing required field does (render() throws).
  const sprintOwner = ctx.sprint.gates?.sprint_review;
  const repoDefault = ctx.policy.gates.sprint_review;
  const gateOwner = sprintOwner ?? repoDefault;
  return render(loadTemplate('sprint-review'), {
    sprint: ctx.sprint,
    policy: ctx.policy,
    doneTickets: ctx.doneTickets,
    gateOwner,
    repoDefault,
    // The override note needs both values; degrade to no note when the repo policy has no default.
    overridden: sprintOwner !== undefined && repoDefault !== undefined,
  });
}

export function renderRetro(ctx: RetroContext): string {
  return render(loadTemplate('retro'), ctx);
}

/** Renders every known brief/ceremony name against fixture-shaped data — used by tests to sweep the whole set. */
export function approxTokenCounts(rendered: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, text] of Object.entries(rendered)) {
    out[name] = approxTokenCount(text);
  }
  return out;
}
