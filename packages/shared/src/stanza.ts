/**
 * Stanza — board entry written by engineers at checkpoints
 * (design/agile-agents-design.md §4 "Board", §10 "Quota-driven pause and
 * handoff" for the `handoff` kind/payload).
 */

import { z } from 'zod';
import { OracleIdSchema, TicketIdSchema, formatZodError } from './ids';

export const STANZA_KINDS = [
  'progress',
  'blocked',
  'discovery',
  'review_submitted',
  'handoff',
  'done',
] as const;
export const StanzaKindSchema = z.enum(STANZA_KINDS);
export type StanzaKind = z.infer<typeof StanzaKindSchema>;

export const DISCOVERY_TIERS = ['local', 'scoped', 'global'] as const;
export const DiscoveryTierSchema = z.enum(DISCOVERY_TIERS);
export type DiscoveryTier = z.infer<typeof DiscoveryTierSchema>;

export const StanzaDiscoverySchema = z
  .object({
    tier: DiscoveryTierSchema,
    affects: z.array(OracleIdSchema).default([]),
    proposed: z.string().min(1),
  })
  .strict();
export type StanzaDiscovery = z.infer<typeof StanzaDiscoverySchema>;

/**
 * "Graceful handoff: ... write a handoff stanza (done / next / gotchas /
 * uncommitted state) and commit WIP" (§10). Field names are prose in the
 * design, not a yaml block — modeled directly from that list.
 * DESIGN-GAP: field naming (`uncommitted_state`) chosen to match the prose.
 */
export const StanzaHandoffSchema = z
  .object({
    done: z.string().min(1),
    next: z.string().min(1),
    gotchas: z.string().min(1).optional(),
    uncommitted_state: z.string().min(1).optional(),
  })
  .strict();
export type StanzaHandoff = z.infer<typeof StanzaHandoffSchema>;

// The kind <-> block invariant lives on the schema itself (via
// `.superRefine`), not only in `validateStanza`, so anything that imports
// `StanzaSchema` directly (T005's store, an MCP tool definition) still gets
// the check — a plain `.parse()` used to accept `kind: 'discovery'` with no
// `discovery` block.
export const StanzaSchema = z
  .object({
    ts: z.string().min(1),
    ticket: TicketIdSchema,
    agent: z.string().min(1),
    kind: StanzaKindSchema,
    summary: z.string().min(1),
    discovery: StanzaDiscoverySchema.optional(),
    handoff: StanzaHandoffSchema.optional(),
  })
  .strict()
  .superRefine((stanza, ctx) => {
    if (stanza.kind === 'discovery' && !stanza.discovery) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discovery'],
        message: 'kind "discovery" requires a discovery block',
      });
    }
    if (stanza.kind === 'handoff' && !stanza.handoff) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['handoff'],
        message: 'kind "handoff" requires a handoff block',
      });
    }
  });

export type Stanza = z.infer<typeof StanzaSchema>;

export function validateStanza(input: unknown): Stanza {
  const result = StanzaSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Stanza', result.error));
  }
  return result.data;
}
