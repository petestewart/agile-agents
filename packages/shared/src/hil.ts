/**
 * HIL requests + circuit breaker (design/agile-agents-design.md §16 "HIL
 * gates policy", §5 "HIL"). `.agile/board/hil/<id>.yaml` per request,
 * `.agile/board/breaker.yaml` for breaker state (a sibling of `board/hil/`,
 * `board/halts/`, `board/status/` — not nested under `board/hil/` so a
 * directory listing of HIL requests never has to special-case it).
 *
 * T018 review fix: these were hand-validated local types in
 * `packages/daemon/src/gates/types.ts`; moved here per CLAUDE.md ("Schemas
 * live in `packages/shared` and nowhere else") so any package (T006's bus,
 * T008's CLI) can validate a HIL request or breaker file without importing
 * daemon internals. `packages/daemon/src/gates/**` is the only writer/reader
 * today, via `StateStore`'s generic `putEntity`/`getEntity`/`listEntities`.
 */

import { z } from 'zod';
import { TicketIdSchema, ULID_PATTERN, formatZodError } from './ids';
import { HilKindSchema, MessageBodySchema } from './message';
import { GateOwnerSchema } from './policy';

/**
 * `HIL-<ulid>` — reuses `ids.ts`'s ULID charset (Crockford base32, 26 chars)
 * rather than a numeric halt-style id (`H-12`): a HIL request is created at
 * high frequency by daemon-internal code, not hand-assigned like a halt, so
 * a ulid (sortable, collision-free without a counter) fits better.
 */
export const HilIdSchema = z
  .string()
  .regex(new RegExp(`^HIL-${ULID_PATTERN.source.slice(1, -1)}$`), 'must look like HIL-<ulid>');
export type HilId = z.infer<typeof HilIdSchema>;

export const HIL_REQUEST_STATUSES = ['pending', 'resolved'] as const;
export const HilRequestStatusSchema = z.enum(HIL_REQUEST_STATUSES);
export type HilRequestStatus = z.infer<typeof HilRequestStatusSchema>;

export const HIL_DECISIONS = ['approve', 'deny'] as const;
export const HilDecisionSchema = z.enum(HIL_DECISIONS);
export type HilDecision = z.infer<typeof HilDecisionSchema>;

/**
 * "send the human a low-priority `fyi`" (§16) — the notice a delegated
 * decision carries. `body` reuses `MessageBodySchema` (the same 800-char cap
 * every bus message body gets) since this is exactly that payload, written
 * as a real `fyi`-kind `Message` by `packages/daemon/src/gates/service.ts`.
 */
export const HilFyiSchema = z
  .object({
    to: z.literal('human'),
    body: MessageBodySchema,
    sent_at: z.string().datetime(),
  })
  .strict();
export type HilFyi = z.infer<typeof HilFyiSchema>;

export const HilRequestSchema = z
  .object({
    id: HilIdSchema,
    gate: z.string().min(1),
    // "`hil_request` has `kind: approve_decision | steer | demo | unblock`" (§5 "HIL").
    hil_kind: HilKindSchema,
    ticket: TicketIdSchema.optional(),
    /** Owner this request actually resolved to (post-breaker-override). */
    owner: GateOwnerSchema,
    status: HilRequestStatusSchema,
    requested_at: z.string().datetime(),
    /** Only set for a `human_timeout:<d>` owner (§16). */
    deadline: z.string().datetime().optional(),
    /** Names the tripped breaker signal(s), or "no delegate configured" (§16 fail-closed rule). */
    reason: z.string().min(1).optional(),
    /** What was actually asked (the command a hook refused, the permission a session requested, ...) — the part a human or delegate needs to decide on. Absent for gates that carry their own context (sprint_review). */
    summary: z.string().min(1).optional(),
    decision: HilDecisionSchema.optional(),
    decided_by: z.string().min(1).optional(),
    resolved_at: z.string().datetime().optional(),
    /** True when an `em`/`architect` owner (policy or single-instance delegate) auto-decided this. */
    delegated: z.boolean().optional(),
    fyi: HilFyiSchema.optional(),
  })
  .strict();
export type HilRequest = z.infer<typeof HilRequestSchema>;

export function validateHilRequest(input: unknown): HilRequest {
  const result = HilRequestSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('HilRequest', result.error));
  }
  return result.data;
}

/**
 * "Circuit breaker: configurable signals (global halt this sprint, budget
 * over X%, integration tests red, escalation ladder exhausted,
 * reviewer/engineer deadlock) force every gate to human until cleared" (§16).
 * DESIGN-GAP: the design names five signals in prose; the T018 ticket text
 * names six ("global halt, budget %, integration red, ladder exhausted,
 * deadlock, N denials"). The sixth (repeated permission denials) has no
 * named signal id in the design, so it is modeled here as `denials`.
 */
export const BREAKER_SIGNALS = [
  'global_halt',
  'budget_pct',
  'integration_red',
  'ladder_exhausted',
  'deadlock',
  'denials',
] as const;
export const BreakerSignalSchema = z.enum(BREAKER_SIGNALS);
export type BreakerSignal = z.infer<typeof BreakerSignalSchema>;

/** `.agile/board/breaker.yaml` — one file, tripped signal -> human-readable detail. */
export const BreakerStateSchema = z
  .object({
    tripped: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict()
  .superRefine((state, ctx) => {
    for (const key of Object.keys(state.tripped)) {
      if (!(BREAKER_SIGNALS as readonly string[]).includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tripped', key],
          message: `unknown breaker signal: ${key}`,
        });
      }
    }
  });
export type BreakerState = z.infer<typeof BreakerStateSchema>;

export function validateBreakerState(input: unknown): BreakerState {
  const result = BreakerStateSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('BreakerState', result.error));
  }
  return result.data;
}
