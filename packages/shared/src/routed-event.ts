/**
 * Routed events (T240, projects-design §14.9, §15, P9). These are the
 * events the daemon routes to nodes' sessions (`events/log.jsonl` plus one
 * delivery queue per recipient, `events/queue/<node>.jsonl`). They are not
 * the audit log (`log/events.jsonl`, `Event` in ./event), hence the name.
 *
 * Signal over volume: every string in a payload is at most
 * `ROUTED_EVENT_STRING_MAX` chars and the whole payload at most
 * `ROUTED_EVENT_PAYLOAD_MAX` bytes of JSON; detail goes behind `ref`.
 */

import { z } from 'zod';
import { DIRECTOR_NODE } from './director';
import { ULID_PATTERN, UlidSchema } from './ids';
import { EscalationTriggerSchema } from './model-escalation';
import { AutonomyProposalIdSchema, CoordinatorActionSchema } from './plan';
import { AutonomySchema, ProjectIdSchema } from './project';
import { QuestionIdSchema } from './question';
import { ChatThreadIdSchema } from './stream';

export const ROUTED_EVENT_STRING_MAX = 800;
export const ROUTED_EVENT_PAYLOAD_MAX = 4096;
/** Lists in a payload (files, comments) are short; the rest sits behind `ref`. */
const LIST_MAX = 20;

const ulidBody = ULID_PATTERN.source.slice(1, -1);
export const ROUTED_EVENT_ID_PATTERN = new RegExp(`^E-${ulidBody}$`);
export const RoutedEventIdSchema = z
  .string()
  .regex(ROUTED_EVENT_ID_PATTERN, 'must look like E-<ulid>');
export type RoutedEventId = z.infer<typeof RoutedEventIdSchema>;

export const RoutedEventBySchema = z.union([
  z.enum(['human', 'daemon', 'director']),
  z.string().regex(new RegExp(`^agent:${ulidBody}$`), 'must be agent:<ulid>'),
]);

export const ROUTING_REASONS = [
  'self',
  'ancestor',
  'waits_on',
  'same_repo',
  'party',
  'sibling',
] as const;
/** A recipient: a node's ULID, or the Director (T300, P16), which is not a node. */
export const RecipientSchema = z.union([UlidSchema, z.literal(DIRECTOR_NODE)]);
export const RoutingEntrySchema = z
  .object({ node: RecipientSchema, because: z.enum(ROUTING_REASONS) })
  .strict();
export type RoutingEntry = z.infer<typeof RoutingEntrySchema>;

const Str = z.string().max(ROUTED_EVENT_STRING_MAX);
const NonEmpty = Str.min(1);
const Files = z.array(Str).max(LIST_MAX);
const PrNumber = z.number().int().positive();

/** One strict payload schema per event type (§15 catalog). */
export const ROUTED_EVENT_PAYLOADS = {
  /**
   * T502 (D62): `question` when the line is your reply in a question's
   * thread (typed in its card): its id and text, so the agent is told what
   * the reply is about and what it may settle.
   */
  human_line: z.object({
    body: NonEmpty,
    question: z.object({ id: QuestionIdSchema, text: NonEmpty }).strict().optional(),
    /**
     * T503 (D60, design/chat-threads.md §3a, §4): your reply in a chat
     * thread: its id, the turn it is on (`on`, its `ts`, and who wrote it:
     * `agent` for the agent's own) and the passage it quotes, so the agent
     * is told what the reply is about, and a turn it wakes posts there.
     */
    thread: z
      .object({
        id: ChatThreadIdSchema,
        on: NonEmpty,
        of: z.enum(['agent', 'human', 'other']),
        quote: Str.optional(),
      })
      .strict()
      .optional(),
  }),
  answer: z.object({ question: NonEmpty, prompt: Str.optional(), answer: NonEmpty }),
  child_status: z.object({
    child: UlidSchema,
    title: Str,
    status: z.enum(['done', 'blocked', 'question']),
    progress: Str.optional(),
    /** T497: on `question`, the child's open question (capped) and who it asks. */
    question: Str.optional(),
    asks: z.enum(['you', 'operator']).optional(),
  }),
  child_delivered: z.object({ child: UlidSchema, title: Str, repo: NonEmpty, sha: NonEmpty }),
  pr_review: z.object({
    pr: PrNumber,
    login: Str,
    state: NonEmpty,
    comments: z.array(Str).max(5),
    more_comments: z.number().int().nonnegative().optional(),
  }),
  ci_failed: z.object({ pr: PrNumber, check: NonEmpty, sha: Str.optional() }),
  pr_behind: z.object({
    pr: PrNumber,
    state: z.enum(['behind', 'conflicting']),
    files: Files,
  }),
  pr_merged: z.object({ pr: PrNumber.optional(), repo: NonEmpty, sha: NonEmpty }),
  pr_closed: z.object({ pr: PrNumber, login: Str.optional() }),
  main_changed: z.object({
    repo: NonEmpty,
    sha: NonEmpty,
    /** The subject's title, absent for a merge from outside the app. */
    subject_title: Str.optional(),
    outcome: z.enum(['synced', 'conflict', 'not_synced']),
    files: Files.optional(),
  }),
  sync_conflict: z.object({ repo: NonEmpty, files: Files }),
  overlap: z.object({
    other: UlidSchema,
    other_project: ProjectIdSchema.optional(),
    files: Files,
  }),
  symbol_changed: z.object({ sibling: UlidSchema, symbol: NonEmpty, file: NonEmpty }),
  contract_changed: z.object({
    contract: NonEmpty,
    title: Str,
    version: z.number().int().positive(),
    diff: Str,
  }),
  contract_proposal: z.object({
    contract: NonEmpty,
    /** T446: the proposal to decide (`decide_contract`); absent in events written before it. */
    proposal: NonEmpty.optional(),
    children: z.array(UlidSchema).min(1).max(LIST_MAX),
    body: NonEmpty,
    reason: Str,
  }),
  knowledge_accepted: z.object({
    item: NonEmpty,
    kind: NonEmpty,
    text: NonEmpty,
    enforcement: NonEmpty,
    /** T453 (Q25): the node the item came from; the only conversation its accept wakes. */
    source: UlidSchema.optional(),
  }),
  dependency_satisfied: z.object({
    node: UlidSchema,
    title: Str.optional(),
    project: ProjectIdSchema.optional(),
    outcome: z.enum(['merged', 'closed']),
  }),
  sibling_ask: z.object({ sibling: UlidSchema, question: NonEmpty }),
  sibling_reply: z.object({
    sibling: UlidSchema,
    body: NonEmpty,
    /** T286: explicit agreement to a joint proposal: the contract and a sha256 of the exact body. */
    agree: z
      .object({ contract: NonEmpty, body_sha256: z.string().regex(/^[0-9a-f]{64}$/) })
      .optional(),
  }),
  coordinator_note: z.object({ body: NonEmpty }),
  /** T338: a part's question about a shared thing, to its coordinator first. */
  child_question: z.object({
    child: UlidSchema,
    title: Str,
    question: NonEmpty,
    text: NonEmpty,
  }),
  plan_changed: z.object({ summary: NonEmpty, paths: Files }),
  external_changed: z.object({ key: NonEmpty, summary: NonEmpty }),
  director_request: z.object({ body: NonEmpty }),
  /**
   * T332 (D33): a finished tangent's summary to its parent conversation.
   * `summary` is the tangent agent's own words, capped: data, not instructions.
   */
  tangent_summary: z.object({ child: UlidSchema, title: Str, summary: NonEmpty }),
  /**
   * T446 (audit r7 #7): a structural change a coordinator or the Director
   * applied on its own at its autonomy level, or a human applied from a
   * held proposal. `summary` is what changed, in words, without who did it
   * ("Add an RSS field for scheduled posts (web)"); `nodes` are the nodes it
   * created, for links and Undo. A record, not news: see `RECORD_ONLY_EVENT_TYPES`.
   */
  autonomy_applied: z.object({
    principal: z.enum(['coordinator', 'director', 'human']),
    level: AutonomySchema,
    action: CoordinatorActionSchema,
    summary: NonEmpty,
    nodes: z.array(UlidSchema).max(LIST_MAX),
    proposal: AutonomyProposalIdSchema.optional(),
  }),
  /**
   * T456 (D43 follow-up): a node's agent crashed and the daemon started
   * another on the same node: the same vendor again (`retry`) or the next
   * on the fallback list (`switch`). `from`/`to` are vendor ids, `model` the
   * new session's; `reason` is the failure in the vendor's words. A record,
   * not news: see `RECORD_ONLY_EVENT_TYPES`.
   */
  agent_restarted: z.object({
    action: z.enum(['retry', 'switch']),
    from: NonEmpty,
    to: NonEmpty,
    model: Str.optional(),
    reason: Str,
  }),
  /**
   * T481 (D50): a vendor's CLI was updated (Auto in the background, or an
   * Update you pressed). `harness` is the CLI's id (`HARNESS_IDS`), `label`
   * its name; `summary` says it in words ("Updated Claude Code to 2.3.1").
   * It belongs to no node, so nobody is routed it. A record, not news: see
   * `RECORD_ONLY_EVENT_TYPES`.
   */
  harness_updated: z.object({
    harness: NonEmpty,
    label: NonEmpty,
    from: Str.optional(),
    to: Str.optional(),
    summary: NonEmpty,
  }),
  /**
   * T484 (design/model-routing.md §6): a node's model stepped up the ladder
   * at its agent's start (`up`), or a trigger found it at the top of the
   * ladder (or under Strongest first) and it went to Needs me (`stuck`).
   * `from`/`to` are models in words ("Claude Sonnet 5.5 · high"); `reason` is
   * the trigger's, in words. A record, not news: see `RECORD_ONLY_EVENT_TYPES`.
   */
  model_escalated: z.object({
    step: z.enum(['up', 'stuck']),
    trigger: EscalationTriggerSchema,
    from: NonEmpty,
    to: Str.optional(),
    reason: NonEmpty,
  }),
  /**
   * T504 (D65, design/chat-threads.md §6a): the operator archived a chat
   * thread on the node (or restored one: `restored`). `on`/`of`/`quote` say
   * what it is on, as `human_line`'s `thread` does; `withdrawn` are the
   * questions asked in it that it closed. Told once, and quiet: see
   * `QUIET_EVENT_TYPES`.
   */
  thread_archived: z.object({
    thread: ChatThreadIdSchema,
    on: NonEmpty,
    of: z.enum(['agent', 'human', 'other']),
    quote: Str.optional(),
    restored: z.literal(true).optional(),
    withdrawn: z.array(QuestionIdSchema).max(LIST_MAX).optional(),
  }),
  /** T262: the ship check held delivery; the findings go back to the worker. */
  ship_findings: z.object({
    source: z.enum(['classifier', 'reviewer']),
    findings: z.array(NonEmpty).min(1).max(LIST_MAX),
    more_findings: z.number().int().nonnegative().optional(),
  }),
} as const;

export type RoutedEventType = keyof typeof ROUTED_EVENT_PAYLOADS;
export const ROUTED_EVENT_TYPES = Object.keys(ROUTED_EVENT_PAYLOADS) as RoutedEventType[];
export const RoutedEventTypeSchema = z.enum(
  ROUTED_EVENT_TYPES as [RoutedEventType, ...RoutedEventType[]],
);
export type RoutedEventPayload<T extends RoutedEventType> = z.infer<
  (typeof ROUTED_EVENT_PAYLOADS)[T]
>;

/**
 * T446: types that are recorded, never delivered: their deliveries are
 * written `recorded` rather than `pending`, so no digest carries them and no
 * wake starts for them; they show in Events and each recipient's Activity.
 */
export const RECORD_ONLY_EVENT_TYPES: ReadonlySet<RoutedEventType> = new Set<RoutedEventType>([
  'autonomy_applied',
  'agent_restarted',
  'harness_updated',
  'model_escalated',
]);

/**
 * T504 (D65): types delivered only beside something else: they ride the
 * next digest (or the brief of the next start), but never start a turn of
 * their own or wake an agent. An archive notice is not worth a turn.
 */
export const QUIET_EVENT_TYPES: ReadonlySet<RoutedEventType> = new Set<RoutedEventType>([
  'thread_archived',
]);

const RoutedEventBaseSchema = z
  .object({
    id: RoutedEventIdSchema,
    type: RoutedEventTypeSchema,
    /** The node it is about; absent for a repo event with no in-app cause. */
    subject: UlidSchema.optional(),
    repo: z.string().min(1).optional(),
    project: ProjectIdSchema.optional(),
    payload: z.record(z.string(), z.unknown()),
    ref: Str.optional(),
    by: RoutedEventBySchema,
    at: z.string().datetime(),
    routing: z.array(RoutingEntrySchema),
    coalesce_key: Str.optional(),
  })
  .strict();

/** The whole event, with `payload` checked against its type's schema and the size cap. */
export const RoutedEventSchema = RoutedEventBaseSchema.superRefine((event, ctx) => {
  const size = Buffer.byteLength(JSON.stringify(event.payload), 'utf8');
  if (size > ROUTED_EVENT_PAYLOAD_MAX) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payload'],
      message: `payload is ${size} bytes, over the ${ROUTED_EVENT_PAYLOAD_MAX}-byte cap; put detail behind ref`,
    });
    return;
  }
  const parsed = ROUTED_EVENT_PAYLOADS[event.type].strict().safeParse(event.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ ...issue, path: ['payload', ...issue.path] } as z.IssueData);
    }
  }
  const nodes = new Set<string>();
  for (const entry of event.routing) {
    if (nodes.has(entry.node)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routing'],
        message: `node ${entry.node} is routed twice`,
      });
    }
    nodes.add(entry.node);
  }
});
export type RoutedEvent = z.infer<typeof RoutedEventBaseSchema>;

export function validateRoutedEvent(raw: unknown): RoutedEvent {
  return RoutedEventSchema.parse(raw);
}

/** T446: `recorded` is a record-only event's (`RECORD_ONLY_EVENT_TYPES`): never pending, never sent. */
export const EVENT_DELIVERY_STATUSES = [
  'pending',
  'delivered',
  'superseded',
  'expired',
  'recorded',
] as const;
export const EventDeliveryStatusSchema = z.enum(EVENT_DELIVERY_STATUSES);
export type EventDeliveryStatus = z.infer<typeof EventDeliveryStatusSchema>;

/** One line per state change in `events/queue/<node>.jsonl`; the last line per event wins. */
export const DeliverySchema = z
  .object({
    event: RoutedEventIdSchema,
    node: RecipientSchema,
    status: EventDeliveryStatusSchema,
    delivered_at: z.string().datetime().optional(),
    session: z.string().min(1).optional(),
    digest: z.string().min(1).optional(),
  })
  .strict();
export type Delivery = z.infer<typeof DeliverySchema>;

export function validateDelivery(raw: unknown): Delivery {
  return DeliverySchema.parse(raw);
}
