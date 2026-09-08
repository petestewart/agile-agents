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

export const StanzaDiscoverySchema = z.object({
  tier: DiscoveryTierSchema,
  affects: z.array(OracleIdSchema).default([]),
  proposed: z.string().min(1),
});
export type StanzaDiscovery = z.infer<typeof StanzaDiscoverySchema>;

/**
 * "Graceful handoff: ... write a handoff stanza (done / next / gotchas /
 * uncommitted state) and commit WIP" (§10). Field names are prose in the
 * design, not a yaml block — modeled directly from that list.
 * DESIGN-GAP: field naming (`uncommitted_state`) chosen to match the prose.
 */
export const StanzaHandoffSchema = z.object({
  done: z.string().min(1),
  next: z.string().min(1),
  gotchas: z.string().min(1).optional(),
  uncommitted_state: z.string().min(1).optional(),
});
export type StanzaHandoff = z.infer<typeof StanzaHandoffSchema>;

export const StanzaSchema = z.object({
  ts: z.string().min(1),
  ticket: TicketIdSchema,
  agent: z.string().min(1),
  kind: StanzaKindSchema,
  summary: z.string().min(1),
  discovery: StanzaDiscoverySchema.optional(),
  handoff: StanzaHandoffSchema.optional(),
});

export type Stanza = z.infer<typeof StanzaSchema>;

export function validateStanza(input: unknown): Stanza {
  const result = StanzaSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Stanza', result.error));
  }
  const stanza = result.data;
  if (stanza.kind === 'discovery' && !stanza.discovery) {
    throw new Error('invalid Stanza: kind "discovery" requires a discovery block');
  }
  if (stanza.kind === 'handoff' && !stanza.handoff) {
    throw new Error('invalid Stanza: kind "handoff" requires a handoff block');
  }
  return stanza;
}
