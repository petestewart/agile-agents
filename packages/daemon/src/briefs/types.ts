/**
 * Render-context types for each brief / ceremony template (T013). Fields
 * are drawn from `@agile-agents/shared` entities — the state store's own
 * types — per PLAN.md T013 scope ("Rendered with the entity data from the
 * state store (use the @agile-agents/shared types...)").
 *
 * These are plain data shapes, not zod schemas: the renderer's job is to
 * throw when a *template* reaches into a field this context doesn't carry,
 * not to re-validate entities already validated by the shared package.
 */

import type {
  AgentId,
  Halt,
  KbFact,
  OracleEntry,
  Policy,
  Sprint,
  Stanza,
  Ticket,
} from '@agile-agents/shared';

/** Shared by every role brief: who is being briefed and for which ticket. */
export interface RoleBriefBase {
  agent: AgentId;
  ticket: Ticket;
}

export interface EngineerBriefContext extends RoleBriefBase {
  policy: Policy;
  /** The reviewer agent id for this ticket (`agentIdFor('reviewer', ticket)`), so the engineer never has to guess the `review_request` recipient. Optional for callers that render without a runner. */
  reviewer?: AgentId;
}

export interface ArchitectBriefContext extends RoleBriefBase {
  oracleEntries: OracleEntry[];
}

export interface EmBriefContext {
  agent: AgentId;
  sprint: Sprint;
  policy: Policy;
}

export interface ReviewerBriefContext extends RoleBriefBase {
  kbFacts: KbFact[];
}

export interface QaBriefContext extends RoleBriefBase {}

export interface ReaderBriefContext {
  agent: AgentId;
  path: string;
  question?: string;
}

export interface StandupContext {
  sprint: Sprint;
  halts: Halt[];
  discoveries: Stanza[];
}

export interface RefinementContext {
  sprint: Sprint;
  tickets: Ticket[];
  oracleEntries: OracleEntry[];
}

export interface SprintReviewContext {
  sprint: Sprint;
  policy: Policy;
  doneTickets: Ticket[];
}

export interface RetroContext {
  sprint: Sprint;
}
