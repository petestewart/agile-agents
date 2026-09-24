/**
 * Stream, Thread entry and SessionRef — the reshape's unit of work
 * (PLAN.md §5 "Target architecture", ticket T110).
 *
 * A stream is a goal with a thread, optional repo/worktree, attached agent
 * sessions, and a parent (streams nest, D1). Its record is split in two by
 * writer (D11, "agent-owned vs human-owned ledger fields"): everything an
 * agent may write lives under `agent`, everything the human may write lives
 * under `human`. `assertStreamWrite` is the pure check the store applies to
 * every proposed write; `assertNoStreamCycle` is the pure check applied to
 * every proposed `parent`.
 */

import { z } from 'zod';
import { EffortSchema } from './effort';
import { UlidSchema, formatZodError } from './ids';

/**
 * Thread-entry body cap. Mirrors the 800-char message body cap
 * (CLAUDE.md tunable, "message body cap 800 chars"), kept separate from
 * `agent-message.ts`'s `MESSAGE_BODY_MAX_CHARS` so the thread owns its own cap.
 */
export const THREAD_BODY_MAX_CHARS = 800;

/**
 * Who may write a stream record. `daemon` may write both halves.
 *
 * A thread entry names its writer precisely (`agent:<session id>`), but a
 * *write* only ever needs the writer's kind: the two-writer split is about
 * which half of the record may change, not which session changed it. Every
 * agent session therefore reduces to the bare `'agent'` principal here, on
 * purpose — the session id belongs in the thread, not in the check.
 */
export const STREAM_PRINCIPALS = ['agent', 'human', 'daemon'] as const;
export const StreamPrincipalSchema = z.enum(STREAM_PRINCIPALS);
export type StreamPrincipal = z.infer<typeof StreamPrincipalSchema>;

/** Agent-owned status: what the attached worker/reviewer is doing. */
export const STREAM_AGENT_STATUSES = ['idle', 'working', 'blocked', 'question', 'done'] as const;
export const StreamAgentStatusSchema = z.enum(STREAM_AGENT_STATUSES);
export type StreamAgentStatus = z.infer<typeof StreamAgentStatusSchema>;

/** Human-owned status: where the human has put this stream. */
export const STREAM_HUMAN_STATUSES = ['open', 'waiting_on_you', 'landed', 'closed'] as const;
export const StreamHumanStatusSchema = z.enum(STREAM_HUMAN_STATUSES);
export type StreamHumanStatus = z.infer<typeof StreamHumanStatusSchema>;

/**
 * Roles collapse to worker and reviewer (D3). `lessons` is the third and
 * last: the per-stream retro of §5.5, a one-shot read-only session the
 * daemon starts itself on land or close. It is not a role a human attaches
 * — `agile attach` and `stream.attach` accept `worker` and `reviewer` only.
 */
export const SESSION_ROLES = ['worker', 'reviewer', 'lessons'] as const;
export const SessionRoleSchema = z.enum(SESSION_ROLES);
export type SessionRole = z.infer<typeof SessionRoleSchema>;

export const SESSION_STATUSES = ['starting', 'running', 'idle', 'stopped', 'error'] as const;
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** An agent session attached to a stream (`~/.agile/sessions/<id>/`). */
export const SessionRefSchema = z
  .object({
    id: UlidSchema,
    vendor: z.string().min(1),
    model: z.string().min(1),
    role: SessionRoleSchema,
    status: SessionStatusSchema,
    /**
     * T130 (**D12**): the effort level this session was attached with, when
     * the operator (or a default) named one. Optional because a vendor with
     * no effort mapping in the provider registry still starts — the daemon
     * writes an "effort <level> ignored by <vendor>" thread line instead of
     * recording a level the session is not actually running at.
     */
    effort: EffortSchema.optional(),
    worktree: z.string().min(1).optional(),
    /**
     * T171: why a session that died on a vendor failure ended — the exit
     * reason plus the vendor's last stderr line — so the sessions strip can
     * say it without the thread. Absent on a clean end.
     */
    ended_reason: z.string().min(1).max(300).optional(),
    /**
     * T174: thread `ts` of human lines sent while a turn was running, not
     * yet delivered to this session. Cleared on delivery and on session end.
     */
    queued: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict();
export type SessionRef = z.infer<typeof SessionRefSchema>;

/** `human` | `daemon` | `agent:<session ulid>` — the writer of a thread entry. */
export const ThreadAuthorSchema = z
  .string()
  .refine(
    (value) =>
      value === 'human' ||
      value === 'daemon' ||
      (value.startsWith('agent:') && UlidSchema.safeParse(value.slice('agent:'.length)).success),
    'must be "human", "daemon" or "agent:<ulid>"',
  );
export type ThreadAuthor = z.infer<typeof ThreadAuthorSchema>;

export const THREAD_ENTRY_KINDS = [
  'line',
  'question',
  'answer',
  'event',
  'finding',
  'proposal',
] as const;
export const ThreadEntryKindSchema = z.enum(THREAD_ENTRY_KINDS);
export type ThreadEntryKind = z.infer<typeof ThreadEntryKindSchema>;

/** One append-only line of `~/.agile/threads/<stream id>.jsonl`. */
export const ThreadEntrySchema = z
  .object({
    ts: z.string().min(1),
    by: ThreadAuthorSchema,
    kind: ThreadEntryKindSchema,
    body: z
      .string()
      .min(1)
      .max(
        THREAD_BODY_MAX_CHARS,
        `body must be at most ${THREAD_BODY_MAX_CHARS} characters; write the detail to a file and reference it`,
      ),
    /** Pointer to the detail: a file path, url, session id, rule id. */
    ref: z.string().min(1).optional(),
  })
  .strict();
export type ThreadEntry = z.infer<typeof ThreadEntrySchema>;

/**
 * Finding severities. Deliberately the same four words (and the same
 * spelling, `blocker` not `blocking`) as the repo's existing
 * `FINDING_SEVERITIES`, so a severity means one thing everywhere.
 */
export const STREAM_FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export const StreamFindingSeveritySchema = z.enum(STREAM_FINDING_SEVERITIES);
export type StreamFindingSeverity = z.infer<typeof StreamFindingSeveritySchema>;

/**
 * `Finding = { severity, file, line?, text }` (cockpit design §2.1) — one
 * structured item under `agent.findings`, so the cockpit can group and link
 * them instead of re-parsing a paragraph (T131).
 *
 * Exported as `StreamFinding`, not `Finding`: the plain name is still taken
 * by the deprecated review-protocol finding in `review.ts`, which the daemon
 * imports today. Rename to `Finding` when T122/T125 deletes that one.
 */
export const StreamFindingSchema = z
  .object({
    severity: StreamFindingSeveritySchema,
    /** Repo-relative path the finding is about. */
    file: z.string().min(1),
    line: z.number().int().positive().optional(),
    text: z.string().min(1).max(THREAD_BODY_MAX_CHARS),
  })
  .strict();
export type StreamFinding = z.infer<typeof StreamFindingSchema>;

/** Agent-owned half of the stream record. Only `agent`/`daemon` may write it. */
export const StreamAgentStateSchema = z
  .object({
    status: StreamAgentStatusSchema,
    progress: z.string().max(THREAD_BODY_MAX_CHARS).optional(),
    findings: z.array(StreamFindingSchema).optional(),
    /** Each next step is one line; the detail belongs in the thread. */
    proposed_next: z.array(z.string().min(1).max(THREAD_BODY_MAX_CHARS)).optional(),
    updated_at: z.string().min(1),
  })
  .strict();
export type StreamAgentState = z.infer<typeof StreamAgentStateSchema>;

/** Human-owned half of the stream record. Only `human`/`daemon` may write it. */
export const StreamHumanStateSchema = z
  .object({
    status: StreamHumanStatusSchema,
    decision: z.string().max(THREAD_BODY_MAX_CHARS).optional(),
    answered_at: z.string().min(1).optional(),
    note: z.string().max(THREAD_BODY_MAX_CHARS).optional(),
  })
  .strict();
export type StreamHumanState = z.infer<typeof StreamHumanStateSchema>;

/** T176: the last land's conflict, written by the daemon; cleared when a worker attaches or a land succeeds. */
export const LandConflictSchema = z
  .object({
    target: z.string().min(1),
    files: z.array(z.string().min(1).max(1_000)).max(200),
    at: z.string().min(1),
  })
  .strict();
export type LandConflict = z.infer<typeof LandConflictSchema>;

/** `~/.agile/streams/<id>.yaml`. */
export const StreamSchema = z
  .object({
    id: UlidSchema,
    title: z.string().min(1),
    goal: z.string().min(1),
    /** Parent stream — streams nest to any depth (D1), but never in a cycle. */
    parent: UlidSchema.optional(),
    repo: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    worktree: z.string().min(1).optional(),
    target_branch: z.string().min(1).optional(),
    created_at: z.string().min(1),
    /**
     * T120: archived streams stay on disk (archiving moves nothing —
     * cockpit design §7.2's home layout has one file per stream and no
     * archive directory); they are simply hidden from `stream.list` unless
     * `include_archived` is set. A boolean rather than a fifth
     * `human.status`, because archiving is orthogonal to where the human
     * put the stream: a `landed` stream and a `closed` one are both
     * archivable and both keep their status when they are.
     */
    archived: z.literal(true).optional(),
    /**
     * T150 (§6.4): the per-stream opt-out from the classifier tier — "a
     * stream working on something the operator does not want leaving the
     * machine turns the tier off; pattern rules and guidance still apply."
     *
     * Human-owned, but deliberately top-level rather than under `human`,
     * exactly like `archived`: both halves of the record are *state the
     * stream is in*, and this is a setting on the stream. Only `'off'` is
     * representable — "on" is the absence of the opt-out, so there is no
     * way to write a stream-level override that re-enables a tier the repo
     * or the home turned off.
     */
    classifier: z.literal('off').optional(),
    land_conflict: LandConflictSchema.optional(),
    agent: StreamAgentStateSchema,
    human: StreamHumanStateSchema,
    sessions: z.array(SessionRefSchema).default([]),
  })
  .strict();
export type Stream = z.infer<typeof StreamSchema>;
/** Pre-validation shape: `sessions` is optional on input (defaults to `[]`). */
export type StreamInput = z.input<typeof StreamSchema>;

/**
 * What a caller may supply when *creating* a stream (T120). Everything the
 * daemon owns — `id`, `created_at`, both status halves, `sessions`,
 * `branch`/`worktree` (created on first attach, not on create) — is absent
 * on purpose: the store mints them, so an RPC client cannot forge them.
 */
export const StreamCreateInputSchema = z
  .object({
    title: z.string().min(1),
    goal: z.string().min(1),
    parent: UlidSchema.optional(),
    repo: z.string().min(1).optional(),
    target_branch: z.string().min(1).optional(),
  })
  .strict();
export type StreamCreateInput = z.infer<typeof StreamCreateInputSchema>;

export function validateStreamCreateInput(input: unknown): StreamCreateInput {
  const result = StreamCreateInputSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('StreamCreateInput', result.error));
  }
  return result.data;
}

export function validateStream(input: unknown): Stream {
  const result = StreamSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Stream', result.error));
  }
  return result.data;
}

export function validateThreadEntry(input: unknown): ThreadEntry {
  const result = ThreadEntrySchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('ThreadEntry', result.error));
  }
  return result.data;
}

export function validateStreamFinding(input: unknown): StreamFinding {
  const result = StreamFindingSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('StreamFinding', result.error));
  }
  return result.data;
}

export function validateSessionRef(input: unknown): SessionRef {
  const result = SessionRefSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('SessionRef', result.error));
  }
  return result.data;
}

function changed(before: unknown, after: unknown): boolean {
  return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
}

/**
 * The two-writer split (D11), enforced for every stream write.
 *
 * - an `agent` principal may not change `human.*`
 * - a `human` principal may not change `agent.*`
 * - the `daemon` principal may write both
 *
 * Throws on violation; returns the `after` record when the write is allowed.
 * A no-op write of the other half (identical value) is allowed — the store
 * writes whole records, so an unchanged half is not an attempted write.
 */
export function assertStreamWrite(
  principal: StreamPrincipal,
  before: Stream,
  after: Stream,
): Stream {
  if (principal === 'agent' && changed(before.human, after.human)) {
    throw new Error('invalid Stream write: an agent principal may not change human.* fields');
  }
  if (principal === 'human' && changed(before.agent, after.agent)) {
    throw new Error('invalid Stream write: a human principal may not change agent.* fields');
  }
  return after;
}

/**
 * Thrown when a proposed `parent` would make a stream its own ancestor.
 * A distinct class so the RPC edge can map it to `invalid params`
 * (-32602): a cycle is bad caller input, not a daemon-internal fault.
 */
export class StreamCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamCycleError';
  }
}

/**
 * Rejects a parent cycle. Nesting depth is unlimited (D1); a stream that is
 * its own ancestor is not. `lookupParent` returns the stored parent of a
 * stream id, or `undefined` for a root (or unknown) stream.
 *
 * The message names the whole ancestor chain it walked, so a caller can see
 * *where* the cycle closes; every segment is a known stream id, so nothing
 * interpolates as `undefined`.
 */
export function assertNoStreamCycle(
  id: string,
  parent: string | undefined,
  lookupParent: (streamId: string) => string | undefined,
): void {
  if (parent === undefined) return;
  if (parent === id) {
    throw new StreamCycleError(`invalid Stream parent: ${id} cannot be its own parent`);
  }
  const chain: string[] = [id, parent];
  const seen = new Set<string>([id, parent]);
  let current: string | undefined = lookupParent(parent);
  while (current !== undefined) {
    chain.push(current);
    if (seen.has(current)) {
      throw new StreamCycleError(
        `invalid Stream parent: ${parent} would create a parent cycle: ${chain.join(' -> ')}`,
      );
    }
    seen.add(current);
    current = lookupParent(current);
  }
}

/**
 * T161: the cockpit composer's write (`POST /api/streams/:id/say`) — one
 * human line on the thread, which also prompts the attached worker if
 * there is one (cockpit design §9.3). The principal is stamped by the
 * daemon; the body carries text only.
 */
export const StreamSayInputSchema = z
  .object({
    body: z.string().trim().min(1).max(THREAD_BODY_MAX_CHARS),
  })
  .strict();
export type StreamSayInput = z.infer<typeof StreamSayInputSchema>;

/**
 * T161: the stream page's sessions strip (`POST /api/streams/:id/attach`).
 * Only the two attachable roles (the `lessons` session is the daemon's).
 */
export const StreamAttachRequestSchema = z
  .object({
    role: z.enum(['worker', 'reviewer']).optional(),
    vendor: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    /** T176: attach a worker to a stream with open children anyway. */
    force: z.boolean().optional(),
  })
  .strict();
export type StreamAttachRequest = z.infer<typeof StreamAttachRequestSchema>;
