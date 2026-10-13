/**
 * The inbox (design/cockpit-design.md §3): one list of everything waiting
 * on the human, across every stream, oldest first.
 *
 * An inbox item is **derived**, never persisted: the daemon builds it from
 * the records that already exist (`questions/Q-*.yaml`, `board/hil/HIL-*.
 * yaml`, and the streams themselves), so a restart re-reads them and does
 * not re-deliver anything (§3.3 "Items are records, not messages").
 */

import { z } from 'zod';
import { HilKindSchema } from './agent-message';
import { HarnessIdSchema } from './harness-updates';
import { UlidSchema, formatZodError } from './ids';
import {
  KnowledgeIdSchema,
  KnowledgeKindSchema,
  KnowledgeScopeSchema,
  RULE_TEXT_MAX_CHARS,
} from './knowledge';
import { CoordinatorActionSchema, PLAN_LIST_MAX } from './plan';
import { ReadRootSchema } from './posture';
import { QUESTION_OPTIONS_MAX, QuestionOptionSchema } from './question';
import { LegacyRuleIdSchema } from './rule';

/**
 * §3.1's kinds. `question` and `gate` are the two that carry a decision;
 * `blocked` and `done` are streams whose agent half has stopped with the
 * human half still open — the "waiting for me" states of §2.2. T140 adds
 * `rule_accept`: a rule with `status: 'proposed'`, which is the one item
 * whose decision is the human's authority itself (§5.1, **D4**). Every
 * other gate kind (`approve_plan`, `sprint_review`, `unblock`,
 * `promote_to_main`, …) is deleted with its policy rows (T121).
 *
 * T163 adds `rule_batch`: every proposal one seed import made (provenance
 * `seed:<source>`), collapsed into one card that opens the rules screen
 * filtered to them. Its `id` is the provenance, `rules` the rule ids.
 * Lessons and agent proposals stay one `rule_accept` item each.
 *
 * T281 adds `plan_approve`: a coordinator's draft plan (projects-design
 * §9.1, §14.4). Its `id` is the coordinating node's id.
 *
 * T481 (D50) adds `harness_update`: a vendor's CLI with a newer version (or,
 * in Auto, an update that failed). It belongs to no node; its `id` is
 * `harness:<id>` and `harness` names the CLI.
 *
 * T484 adds `model_stuck`: a node whose work stalled (or whose merge was
 * refused twice) on the strongest preset model, so there is no rung left to
 * step up to (design/model-routing.md §6). Its `id` is the node's.
 */
export const INBOX_ITEM_KINDS = [
  'question',
  'gate',
  'rule_accept',
  'rule_batch',
  'plan_approve',
  'plan_waiting',
  'proposal',
  'blocked',
  'done',
  'harness_update',
  'model_stuck',
] as const;

/** The kinds that may belong to no stream: a rule decision (§5.1), and T481's CLI update. */
function isStreamlessKind(kind: InboxItemKind): boolean {
  return kind === 'rule_accept' || kind === 'rule_batch' || kind === 'harness_update';
}

/** T481: the CLI a `harness_update` item is about, and whether its update failed. */
export const InboxHarnessSchema = z
  .object({
    id: HarnessIdSchema,
    /** Its name in words ("Claude Code"). */
    label: z.string().min(1).max(80),
    /** An update ran and failed (Auto, or an Update pressed): the item says how to run it by hand. */
    failed: z.literal(true).optional(),
  })
  .strict();
export type InboxHarness = z.infer<typeof InboxHarnessSchema>;
export const InboxItemKindSchema = z.enum(INBOX_ITEM_KINDS);
export type InboxItemKind = z.infer<typeof InboxItemKindSchema>;

/** "one line, never the whole diff, never the whole question" (§3.2). */
export const INBOX_CONTEXT_MAX_CHARS = 200;

/** T161: the ceiling on an item's `detail` (the full text behind a clipped `context`). */
export const INBOX_DETAIL_MAX_CHARS = 4000;

/**
 * T514: the parts below are what `context` runs together for the CLI
 * ("classifier_review: edit x — why", "name · scope: text"), kept apart so
 * the cockpit's cards render from them instead of taking the line apart.
 * `context` stays the readable line.
 */
const InboxPartText = z.string().min(1).max(INBOX_DETAIL_MAX_CHARS);

/** T514: a `gate` item's parts (`HilRequest`). */
export const InboxGateSchema = z
  .object({
    /** `land` (a merge waits for your OK) or `classifier_review` (a routed call). */
    name: HilKindSchema,
    /** The call it holds, as one line ("edit src/app.ts", "bash: rm -rf dist"); a routed call's only. */
    call: InboxPartText.optional(),
    /** Why it waits: the routing rule's text when a rule routed it, else the gate's summary. */
    reason: InboxPartText,
    /** The rule that routed the call; `name` when it has one. A gate raised before T260 names its `R-` rule. */
    rule: z
      .object({
        id: z.union([KnowledgeIdSchema, LegacyRuleIdSchema]),
        name: z.string().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
    /** A ship check's classifier probability that the diff breaks the rule. */
    probability: z.number().finite().optional(),
    /** A land gate's branch and the branch it merges into. */
    branch: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
  })
  .strict();
export type InboxGate = z.infer<typeof InboxGateSchema>;

/** T514: a `rule_accept` item's parts: the proposed knowledge item's name, scope and text. */
export const InboxKnowledgeSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    scope: KnowledgeScopeSchema,
    text: z.string().min(1).max(RULE_TEXT_MAX_CHARS),
  })
  .strict();
export type InboxKnowledge = z.infer<typeof InboxKnowledgeSchema>;

/** T514: a `plan_approve` item's parts: one line per part ("api owns `prices.ts`") and per contract. */
export const InboxPlanSchema = z
  .object({
    /** A revision of an approved plan: each part's line says what changed. */
    revised: z.boolean(),
    owners: z.array(InboxPartText).max(PLAN_LIST_MAX),
    contracts: z.array(InboxPartText).max(PLAN_LIST_MAX),
  })
  .strict();
export type InboxPlan = z.infer<typeof InboxPlanSchema>;

/** T514: a `proposal` item's parts (`AutonomyProposal`): who proposes it, the change in words, and which change. */
export const InboxProposalSchema = z
  .object({
    principal: z.enum(['coordinator', 'director']),
    summary: z.string().min(1).max(800),
    change: CoordinatorActionSchema,
    /** The change makes a new project, so no project's level holds it. */
    new_project: z.literal(true).optional(),
  })
  .strict();
export type InboxProposal = z.infer<typeof InboxProposalSchema>;

/**
 * T361: a question item's choices, as buttons on its card. Bounded like an
 * `ask`'s (at least one here: a question raised over RPC may offer one).
 */
export const InboxItemOptionsSchema = z
  .array(QuestionOptionSchema)
  .min(1)
  .max(QUESTION_OPTIONS_MAX);

export const InboxItemSchema = z
  .object({
    kind: InboxItemKindSchema,
    /** The underlying record's id — `Q-<ulid>`, `HIL-<ulid>`, `R-<ulid>`, or the stream's own id for `blocked`/`done`. */
    id: z.string().min(1),
    /**
     * The stream the item is about. Optional for one kind only: a
     * `rule_accept` item for a rule that belongs to no stream (a global
     * rule proposed by the human or imported by `agile rules seed`) still
     * needs deciding, and the refinement below keeps it required for every
     * other kind.
     */
    stream: UlidSchema.optional(),
    /** Ancestor chain rendered root→leaf, as titles: "ledger-lite / import CSV / parser" (§3.2). */
    stream_path: z.array(z.string().min(1)),
    /** ISO-8601; the list is sorted on this, oldest first (§3.3). */
    ts: z.string().datetime(),
    context: z.string().min(1).max(INBOX_CONTEXT_MAX_CHARS),
    /**
     * T161: the full text `context` was clipped from — the whole question,
     * gate summary or rule — present only when the clip lost something, so
     * a clipped card can expand in place and the stream page can show it
     * whole. Still bounded: an item is a pointer, not the artifact.
     */
    detail: z.string().min(1).max(INBOX_DETAIL_MAX_CHARS).optional(),
    /** Pointer to the full artifact, when there is one (a home-relative path). */
    ref: z.string().min(1).optional(),
    /** T163: a `rule_batch` item's rule ids — present on that kind only. */
    rules: z.array(KnowledgeIdSchema).min(1).optional(),
    /** T266: a `rule_accept` item's knowledge kind, so the card reads "decision proposed". */
    knowledge_kind: KnowledgeKindSchema.optional(),
    /** T361: a `question` item's choices (the question's `options`); typing is always allowed. */
    options: InboxItemOptionsSchema.optional(),
    /** T457: a routed read's gate: the dir "Always for this project" adds (`HilRequest.read_root`). */
    read_root: ReadRootSchema.optional(),
    /** T481: a `harness_update` item's CLI — present on that kind only. */
    harness: InboxHarnessSchema.optional(),
    /** T514: a `gate` item's parts — that kind only. */
    gate: InboxGateSchema.optional(),
    /** T514: a `rule_accept` item's parts — that kind only. */
    knowledge: InboxKnowledgeSchema.optional(),
    /** T514: a `plan_approve` item's parts — that kind only. */
    plan: InboxPlanSchema.optional(),
    /** T514: a `proposal` item's parts — that kind only. */
    proposal: InboxProposalSchema.optional(),
    /**
     * T502 (design/chat-threads.md §5): a choice question you replied to whose
     * agent finished the turn your reply started without settling it or
     * asking again: its vendor (`codex`), for "Codex didn't settle …". A
     * question item only.
     */
    unsettled_by: z.string().min(1).max(80).optional(),
  })
  .strict()
  .refine((item) => isStreamlessKind(item.kind) || item.stream !== undefined, {
    message: 'must name its stream',
    path: ['stream'],
  })
  .refine((item) => isStreamlessKind(item.kind) || item.stream_path.length > 0, {
    message: 'must carry the stream path',
    path: ['stream_path'],
  })
  .refine((item) => item.knowledge_kind === undefined || item.kind === 'rule_accept', {
    message: 'only a rule_accept item carries a knowledge kind',
    path: ['knowledge_kind'],
  })
  .refine((item) => (item.kind === 'rule_batch') === (item.rules !== undefined), {
    message: 'a rule_batch item carries its rule ids, and only it does',
    path: ['rules'],
  })
  .refine((item) => item.options === undefined || item.kind === 'question', {
    message: 'only a question item carries options',
    path: ['options'],
  })
  .refine((item) => item.unsettled_by === undefined || item.kind === 'question', {
    message: 'only a question item is unsettled',
    path: ['unsettled_by'],
  })
  .refine((item) => item.read_root === undefined || item.kind === 'gate', {
    message: 'only a gate item carries a read root',
    path: ['read_root'],
  })
  .refine((item) => (item.kind === 'harness_update') === (item.harness !== undefined), {
    message: 'a harness_update item names its CLI, and only it does',
    path: ['harness'],
  })
  .refine((item) => item.gate === undefined || item.kind === 'gate', {
    message: 'only a gate item carries gate parts',
    path: ['gate'],
  })
  .refine((item) => item.knowledge === undefined || item.kind === 'rule_accept', {
    message: 'only a rule_accept item carries knowledge parts',
    path: ['knowledge'],
  })
  .refine((item) => item.plan === undefined || item.kind === 'plan_approve', {
    message: 'only a plan_approve item carries plan parts',
    path: ['plan'],
  })
  .refine((item) => item.proposal === undefined || item.kind === 'proposal', {
    message: 'only a proposal item carries proposal parts',
    path: ['proposal'],
  });
export type InboxItem = z.infer<typeof InboxItemSchema>;

export function validateInboxItem(input: unknown): InboxItem {
  const result = InboxItemSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('InboxItem', result.error));
  }
  return result.data;
}

/**
 * Trims to one line and to the §3.2 cap — the one place a context string is
 * normalized.
 *
 * T136 (QA rough edge 4): the cut lands on a word boundary. Slicing at the
 * character budget chopped the last word in half ("…the parser diale…"),
 * which reads as corruption rather than as elision. The whole-word prefix
 * is used only when there is one inside the budget; a single word longer
 * than the budget still gets a hard cut, because there is no boundary to
 * find.
 */
export function inboxContext(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= INBOX_CONTEXT_MAX_CHARS) return oneLine;
  const hard = oneLine.slice(0, INBOX_CONTEXT_MAX_CHARS - 1);
  const lastSpace = hard.lastIndexOf(' ');
  const body = (lastSpace > 0 ? hard.slice(0, lastSpace) : hard).trimEnd();
  // T341: a cut inside a code span closes it, or the card shows a stray backtick.
  if ((body.match(/`/g) ?? []).length % 2 === 1) {
    return `${body.slice(0, INBOX_CONTEXT_MAX_CHARS - 2)}\`…`;
  }
  return `${body}…`;
}

/**
 * T161: the full text behind `inboxContext(text)`, or `undefined` when the
 * context already says everything (nothing was clipped). Line breaks are
 * kept — the detail is rendered as Markdown — and the result is bounded by
 * `INBOX_DETAIL_MAX_CHARS`.
 */
export function inboxDetail(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.replace(/\s+/g, ' ').length <= INBOX_CONTEXT_MAX_CHARS) return undefined;
  return trimmed.length <= INBOX_DETAIL_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, INBOX_DETAIL_MAX_CHARS - 1)}…`;
}
