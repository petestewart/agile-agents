/**
 * Shared types for the review module (T016). `ReviewRecord` is the shape
 * persisted at `board/reviews/<TKT>-r<n>.yaml` (protocol.ts's Design note:
 * "pick the path, document" — flat directory, one file per (ticket, round,
 * pass), named after the ticket and round the same way `.agile/tickets/`
 * and `.agile/board/status/` name files after their ticket).
 */

import {
  FindingSchema,
  ReviewPassSchema,
  ReviewVerdictKindSchema,
  TicketIdSchema,
  formatZodError,
} from '@agile-agents/shared';
import type { Finding, ReviewPass, ReviewVerdictKind, TicketId } from '@agile-agents/shared';
import { z } from 'zod';
import type { DiffHunk } from './diff-summary';

export interface ReviewRecord {
  ticket: TicketId;
  round: number;
  pass: ReviewPass;
  agent: string;
  ts: string;
  findings: Finding[];
  verdict: ReviewVerdictKind;
  /** This round's `diff_summary` hunks — the material `rereview.ts` checks a later round's new findings against. */
  hunks: DiffHunk[];
}

const DiffHunkSchema = z
  .object({
    path: z.string().min(1),
    newStart: z.number().int().positive(),
    newEnd: z.number().int().positive(),
    hash: z.string().min(1),
  })
  .strict();

/** Zod counterpart of `ReviewRecord`, for `StateStore`'s generic entity trio (`putEntity`/`getEntity`/`listEntities` all require a validator). */
export const ReviewRecordSchema = z
  .object({
    ticket: TicketIdSchema,
    round: z.number().int().positive(),
    pass: ReviewPassSchema,
    agent: z.string().min(1),
    ts: z.string().min(1),
    findings: z.array(FindingSchema),
    verdict: ReviewVerdictKindSchema,
    hunks: z.array(DiffHunkSchema),
  })
  .strict();

export function validateReviewRecord(input: unknown): ReviewRecord {
  const result = ReviewRecordSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('ReviewRecord', result.error));
  }
  return result.data;
}

/** `board/reviews/<TKT>-r<n>[-security].yaml` (protocol.ts's Design note: "pick the path, document"). */
export function reviewRecordRelPath(ticket: TicketId, round: number, pass: ReviewPass): string {
  const suffix = pass === 'security' ? '-security' : '';
  return `board/reviews/${ticket}-r${round}${suffix}.yaml`;
}

/**
 * Per-ticket dispute counts, keyed by `findingKey()` (§12 "Convergence":
 * "Engineer and reviewer disagree twice on one finding → daemon routes it
 * to the architect as a `question`"). Sibling file to the review records,
 * same `board/reviews/` directory — a ticket-scoped index rather than one
 * file per dispute, since a dispute has no identity of its own beyond
 * "this finding, disputed N times".
 */
export interface DisputeRecord {
  ticket: TicketId;
  disputes: Record<string, number>;
}

export const DisputeRecordSchema = z
  .object({
    ticket: TicketIdSchema,
    disputes: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

export function validateDisputeRecord(input: unknown): DisputeRecord {
  const result = DisputeRecordSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('DisputeRecord', result.error));
  }
  return result.data;
}

export function disputeRecordRelPath(ticket: TicketId): string {
  return `board/reviews/${ticket}-disputes.yaml`;
}
