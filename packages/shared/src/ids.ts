/**
 * ID formats for every entity in the state model.
 *
 * Design doc refs: design/agile-agents-design.md §4 "State model" (layout tree
 * + per-entity examples: DEC-0042, KB-0117, TKT-0231, H-12, S-07, RULE-012)
 * and §5 "Comms bus" (message `id` is a ULID).
 */

import { z } from 'zod';

/** Crockford base32, 26 chars — used for message/bus-file ids (design §5). */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const UlidSchema = z
  .string()
  .regex(ULID_PATTERN, 'must be a 26-character Crockford-base32 ULID');
export type Ulid = z.infer<typeof UlidSchema>;

/**
 * DEC-0042 / SPEC-auth-003 — oracle entry ids (§4 "Oracle").
 * DESIGN-GAP: the design only shows a numeric decision id (`DEC-0042`) and a
 * slugged spec id (`SPEC-auth-003`); no format grammar is given, so the slug
 * segment is read permissively as `[a-z0-9-]+` ending in a numeric suffix.
 */
export const DecisionIdSchema = z.string().regex(/^DEC-\d{4,}$/, 'must look like DEC-0042');
export type DecisionId = z.infer<typeof DecisionIdSchema>;

export const SpecIdSchema = z
  .string()
  .regex(/^SPEC-[a-z0-9]+(?:-[a-z0-9]+)*-\d{3,}$/, 'must look like SPEC-auth-003');
export type SpecId = z.infer<typeof SpecIdSchema>;

/** Either half of the oracle (decisions/specs share a header, §4 "Oracle"). */
export const OracleIdSchema = z.union([DecisionIdSchema, SpecIdSchema]);
export type OracleId = z.infer<typeof OracleIdSchema>;

/** KB-0117 — knowledge store fact id (§4 "Knowledge store"). */
export const KbIdSchema = z.string().regex(/^KB-\d{4,}$/, 'must look like KB-0117');
export type KbId = z.infer<typeof KbIdSchema>;

/** TKT-0231 — ticket id (§4 "Ticket"). */
export const TicketIdSchema = z.string().regex(/^TKT-\d{4,}$/, 'must look like TKT-0231');
export type TicketId = z.infer<typeof TicketIdSchema>;

/**
 * EPIC-0009 — parent epic id, referenced by `Ticket.parent` (§4 "Ticket"
 * example: `parent: EPIC-0009`). Not otherwise specified.
 * DESIGN-GAP: treated as a sibling id format to TKT-.
 */
export const EpicIdSchema = z.string().regex(/^EPIC-\d{4,}$/, 'must look like EPIC-0009');
export type EpicId = z.infer<typeof EpicIdSchema>;

/** H-12 — halt id (§4 "Halts": `board/halts/<id>.yaml`). */
export const HaltIdSchema = z.string().regex(/^H-\d+$/, 'must look like H-12');
export type HaltId = z.infer<typeof HaltIdSchema>;

/** S-07 — sprint id (§4 "Sprint"). */
export const SprintIdSchema = z.string().regex(/^S-\d+$/, 'must look like S-07');
export type SprintId = z.infer<typeof SprintIdSchema>;

/** RULE-012 — coding-standard rule id (§4 layout, §12 "Review protocol"). */
export const RuleIdSchema = z.string().regex(/^RULE-\d{3,}$/, 'must look like RULE-012');
export type RuleId = z.infer<typeof RuleIdSchema>;

/**
 * Bus agent identity: `em | architect | eng-N | reviewer-N | qa-N | human | daemon`
 * (§5 "Message" — the `from` field enumeration).
 */
export const AGENT_ID_PATTERN = /^(em|architect|human|daemon|eng-\d+|reviewer-\d+|qa-\d+)$/;
export const AgentIdSchema = z.string().regex(AGENT_ID_PATTERN, 'must be a valid agent id');
export type AgentId = z.infer<typeof AgentIdSchema>;

/** Formats a zod validation failure into a single readable line. */
export function formatZodError(entity: string, error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  return `invalid ${entity}: ${issues}`;
}
