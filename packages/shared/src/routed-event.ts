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
import { ProjectIdSchema } from './project';

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
  human_line: z.object({ body: NonEmpty }),
  answer: z.object({ question: NonEmpty, prompt: Str.optional(), answer: NonEmpty }),
  child_status: z.object({
    child: UlidSchema,
    title: Str,
    status: z.enum(['done', 'blocked', 'question']),
    progress: Str.optional(),
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
    children: z.array(UlidSchema).min(1).max(LIST_MAX),
    body: NonEmpty,
    reason: Str,
  }),
  knowledge_accepted: z.object({
    item: NonEmpty,
    kind: NonEmpty,
    text: NonEmpty,
    enforcement: NonEmpty,
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

export const EVENT_DELIVERY_STATUSES = ['pending', 'delivered', 'superseded', 'expired'] as const;
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
