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
import { AgentIdSchema, ULID_PATTERN, UlidSchema, formatZodError } from './ids';
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

/**
 * T039 (§17 "Control room v2"): every Needs-you card takes a typed answer as
 * well as its buttons. The free text a human wrote with (or instead of) a
 * button press — body-capped exactly like a bus message body, since that is
 * what it becomes when `gates/service.ts` delivers it to the asking agent
 * (`hil_response`) and to the EM. Non-empty: an empty note is the same as no
 * note and is rejected at the boundary rather than persisted as `""`.
 */
export const HilNoteSchema = MessageBodySchema.min(1, 'note must not be empty');

/**
 * T138 (design/cockpit-design.md §8.1 route band): the tool call a
 * `classifier_review` gate was raised on. `fingerprint` is what makes the
 * gate answerable at all — an approval is not "this session may edit
 * manifests from now on", it is "this one call may go through once" — so it
 * is stored on the record and matched again when the session retries.
 * `tool` plus `path`/`command` are the human-readable half: the inbox card
 * shows the call ("edit package.json", "bash: git push …") so the operator
 * can decide without leaving the list (§3.2).
 */
export const GateCallSchema = z
  .object({
    /** Vendor tool name as the hook saw it (`Edit`, `Write`, `Bash`, …). */
    tool: z.string().min(1),
    /** Normalised absolute path, for an edit-kind call. */
    path: z.string().min(1).optional(),
    /** The exact command, for an execute-kind call — body-capped like every other persisted payload. */
    command: MessageBodySchema.min(1).optional(),
    /** Stable digest of `tool` + path/command — see `packages/daemon/src/hook/fingerprint.ts`. */
    fingerprint: z.string().regex(/^[0-9a-f]{16}$/, 'must be a 16-char hex digest'),
  })
  .strict();
export type GateCall = z.infer<typeof GateCallSchema>;

/** The call as one line for an inbox card or a thread entry ("edit package.json", "bash: git push origin main"). */
export function describeGateCall(call: GateCall): string {
  if (call.command !== undefined) return `bash: ${call.command}`;
  if (call.path !== undefined) return `${call.tool.toLowerCase()} ${call.path}`;
  return call.tool;
}

export const HilRequestSchema = z
  .object({
    id: HilIdSchema,
    /** T121: the gate name is one of the three surviving kinds, exactly like `hil_kind` — `GatesBlockSchema` is keyed by the same closed set, so a policy row and a request can never drift apart. */
    gate: HilKindSchema,
    /** One of the three surviving gate kinds (`message.ts`'s `HIL_KINDS`, cockpit design §3.1). */
    hil_kind: HilKindSchema,
    /** T121: a gate is raised **on a stream** — the reshape's unit of work. `ticket`/`sprint` are gone with the ticket model. */
    stream: UlidSchema,
    /** Owner this request actually resolved to (post-breaker-override). */
    owner: GateOwnerSchema,
    status: HilRequestStatusSchema,
    requested_at: z.string().datetime(),
    /** Only set for a `human_timeout:<d>` owner (§16). */
    deadline: z.string().datetime().optional(),
    /** Names the tripped breaker signal(s), or "no delegate configured" (§16 fail-closed rule). */
    reason: z.string().min(1).optional(),
    /** What was actually asked (the command a hook refused, the permission a session requested, ...) — the part a human or delegate needs to decide on. Absent for a gate that carries its own context. */
    summary: z.string().min(1).optional(),
    /**
     * T048: the agent whose blocked call raised this gate — the hook caller
     * (`hook/service.ts`) or the ACP session (`permissions/responder.ts`).
     * It is NOT the ticket's assignee: a QA or reviewer hook raises gates on
     * a ticket assigned to the engineer, and the first live run of the
     * control room delivered qa-2003's approved `unblock` into eng-2003's
     * inbox, where the engineer refused a command outside its worktree.
     * `gates/service.ts`'s `waitingAgent` is now exactly this field: the
     * ticket-assignee fallback went with the ticket model (T121), so a gate
     * the daemon raises on nobody's behalf simply has nobody waiting.
     */
    requested_by: AgentIdSchema.optional(),
    /**
     * T138: the tool call this gate blocks, and the session that made it.
     * `session` is the fingerprint's other half — an approval unlocks the
     * same call *from the session that asked*, never every session on the
     * stream — and is kept as its own field rather than read off
     * `requested_by` so a gate raised on someone's behalf by the daemon can
     * never be mistaken for one the session itself is waiting on.
     */
    call: GateCallSchema.optional(),
    session: AgentIdSchema.optional(),
    /** T138: set when an approved gate's one allowed retry has been spent — the allowance is once, not standing. */
    consumed_at: z.string().datetime().optional(),
    decision: HilDecisionSchema.optional(),
    /** Free text a human typed with the decision, or on its own (T039). A note on its own resolves nothing — the EM delegate reads it and decides. */
    note: HilNoteSchema.optional(),
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
