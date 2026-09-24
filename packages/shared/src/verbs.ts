/**
 * The eight MCP verbs an attached agent session gets, as zod schemas
 * (design/cockpit-design.md §4.1: "The MCP verb surface an agent gets
 * shrinks to eight: `ask` · `progress` · `finding` · `propose_knowledge` ·
 * `propose_next` · `read_stream` · `search_docs` · `test_run`. Everything
 * else in the old `tools/builtins.ts` is deleted").
 *
 * They live here, in `packages/shared`, for the same reason every other
 * schema does: the daemon validates a call against them at the RPC edge and
 * the MCP bridge publishes the same shapes to the model, so the contract is
 * written once. Rationale for the shrink (§4.1): "each verb is a schema the
 * model can get wrong, and the live runs showed models burning turns
 * retrying rejected schemas".
 *
 * Every verb takes `session` — a session's own ULID, which is what stamps
 * the `agent` principal at the edge (the verb family is the only one that
 * takes a session; `stream.*` stamps `human`). The id is never read from a
 * body field the model could choose: `agile mcp --session <id>` fixes it
 * for the life of the bridge process.
 */

import { z } from 'zod';
import { UlidSchema, formatZodError } from './ids';
import {
  KnowledgeEnforcementSchema,
  KnowledgeKindSchema,
  KnowledgePathsSchema,
  RuleExampleSchema,
} from './knowledge';
import { ContractWriteFieldsSchema, PlanWriteFieldsSchema } from './plan';
import { RoutedEventIdSchema } from './routed-event';
import { StreamFindingSeveritySchema, THREAD_BODY_MAX_CHARS } from './stream';

/** Free text an agent writes into the thread — capped like every thread body. */
const Body = z.string().min(1).max(THREAD_BODY_MAX_CHARS);

/** Every verb names the session it is called from. */
const Session = UlidSchema;

export const AskInputSchema = z.object({ session: Session, text: Body }).strict();
export type AskInput = z.infer<typeof AskInputSchema>;

export const ProgressInputSchema = z.object({ session: Session, text: Body }).strict();
export type ProgressInput = z.infer<typeof ProgressInputSchema>;

export const FindingInputSchema = z
  .object({
    session: Session,
    severity: StreamFindingSeveritySchema,
    file: z.string().min(1),
    line: z.number().int().positive().optional(),
    text: Body,
  })
  .strict();
export type FindingInput = z.infer<typeof FindingInputSchema>;

/**
 * T264 (projects-design §14.3): an agent proposes a knowledge item. The
 * agent picks the `kind` (default `standard`) and may guess the tier
 * (`tell` · `action` · `ship` · `review`), `paths`, and two `examples`.
 * The scope defaults to the caller's subtree. Everything the daemon owns —
 * `status`, `source`, `stats` — is absent, so no call arrives accepted.
 */
export const ProposeKnowledgeInputSchema = z
  .object({
    session: Session,
    text: Body,
    kind: KnowledgeKindSchema.optional(),
    scope: z.string().min(1).optional(),
    paths: KnowledgePathsSchema.optional(),
    examples: z.array(RuleExampleSchema).max(8).optional(),
    enforcement: KnowledgeEnforcementSchema.optional(),
    critical: z.boolean().optional(),
  })
  .strict();
export type ProposeKnowledgeInput = z.infer<typeof ProposeKnowledgeInputSchema>;

export const ProposeNextInputSchema = z
  .object({ session: Session, title: z.string().min(1), goal: Body })
  .strict();
export type ProposeNextInput = z.infer<typeof ProposeNextInputSchema>;

export const ReadStreamInputSchema = z
  .object({ session: Session, limit: z.number().int().positive().max(500).optional() })
  .strict();
export type ReadStreamInput = z.infer<typeof ReadStreamInputSchema>;

export const SearchDocsInputSchema = z.object({ session: Session, query: Body }).strict();
export type SearchDocsInput = z.infer<typeof SearchDocsInputSchema>;

export const TestRunInputSchema = z.object({ session: Session, command: Body }).strict();
export type TestRunVerbInput = z.infer<typeof TestRunInputSchema>;

/** T244 (projects-design §15): one routed event's full payload, by id. */
export const ReadEventInputSchema = z
  .object({ session: Session, id: RoutedEventIdSchema })
  .strict();
export type ReadEventInput = z.infer<typeof ReadEventInputSchema>;

/**
 * T246 (projects-design §4.1): push the caller's branch and update its open
 * PR. Only an already-open PR: the first delivery (and any direct merge)
 * stays the human's (D8).
 */
/**
 * T263 (projects-design §16): the accepted knowledge items in scope for one
 * repo-relative path, so an agent can check an unfamiliar area before it
 * touches it.
 */
export const LookupKnowledgeInputSchema = z
  .object({ session: Session, path: z.string().min(1).max(1024) })
  .strict();
export type LookupKnowledgeInput = z.infer<typeof LookupKnowledgeInputSchema>;

export const DeliverInputSchema = z.object({ session: Session }).strict();
export type DeliverInput = z.infer<typeof DeliverInputSchema>;

/** T281 (§14.4): a coordinator writes its plan; it lands `draft` until approved. */
export const PlanWriteInputSchema = PlanWriteFieldsSchema.extend({ session: Session }).strict();
export type PlanWriteInput = z.infer<typeof PlanWriteInputSchema>;

/** T281 (§14.4): a coordinator creates a contract (no `id`) or bumps one. */
export const ContractWriteInputSchema = ContractWriteFieldsSchema.extend({
  session: Session,
}).strict();
export type ContractWriteInput = z.infer<typeof ContractWriteInputSchema>;

/**
 * T282 (§9 Autonomy): a coordinator's structural verbs. Each is gated by
 * the node's autonomy level: at Advise it becomes an inbox proposal, at
 * Organise and Run it is applied with a thread line.
 */
export const AddChildInputSchema = z
  .object({
    session: Session,
    title: z.string().trim().min(1).max(200),
    goal: Body,
    repo: z.string().min(1).optional(),
  })
  .strict();
export const AddWaitsOnInputSchema = z
  .object({ session: Session, child: UlidSchema, on: UlidSchema })
  .strict();
export const SetOwnerInputSchema = z
  .object({
    session: Session,
    child: UlidSchema,
    owns: z.array(z.string().trim().min(1).max(512)).max(50),
  })
  .strict();

/** The verb table, in the order §4.1 lists it. */
export const AGENT_VERBS = [
  'ask',
  'progress',
  'finding',
  'propose_knowledge',
  'propose_next',
  'read_stream',
  'search_docs',
  'test_run',
  'read_event',
  'deliver',
  'lookup_knowledge',
  'plan_write',
  'contract_write',
  'add_child',
  'add_waits_on',
  'set_owner',
] as const;
export type AgentVerb = (typeof AGENT_VERBS)[number];

export const AGENT_VERB_SCHEMAS = {
  ask: AskInputSchema,
  progress: ProgressInputSchema,
  finding: FindingInputSchema,
  propose_knowledge: ProposeKnowledgeInputSchema,
  propose_next: ProposeNextInputSchema,
  read_stream: ReadStreamInputSchema,
  search_docs: SearchDocsInputSchema,
  test_run: TestRunInputSchema,
  read_event: ReadEventInputSchema,
  deliver: DeliverInputSchema,
  lookup_knowledge: LookupKnowledgeInputSchema,
  plan_write: PlanWriteInputSchema,
  contract_write: ContractWriteInputSchema,
  add_child: AddChildInputSchema,
  add_waits_on: AddWaitsOnInputSchema,
  set_owner: SetOwnerInputSchema,
} as const satisfies Record<AgentVerb, z.ZodType>;

/** One line of help per verb, published to the model by the MCP bridge. */
export const AGENT_VERB_DESCRIPTIONS: Record<AgentVerb, string> = {
  ask: 'Ask the operator a question and block until it is answered.',
  progress: 'Report one line of progress onto the stream thread.',
  finding: 'Record a finding ({severity, file, line?, text}) on the stream.',
  propose_knowledge:
    'Propose a knowledge item for the operator to accept or reject ({text, kind?: standard|architecture|decision, scope?, paths?, examples?: [{action, violates}], enforcement?: tell|action|ship|review, critical?}). Scope defaults to this node’s subtree.',
  propose_next: 'Propose a follow-up stream ({title, goal}); a human creates it.',
  read_stream: 'Read the most recent entries of this session’s stream thread.',
  search_docs: 'Search the repo and stream docs visible to this stream.',
  test_run: 'Run a test command in this session’s worktree; failures only, never a green log.',
  read_event: 'Read the full payload of a routed event ({id}) that was delivered to this stream.',
  deliver:
    'Push your committed fix and update your open PR (babysitting). Only once a PR is open; commit first.',
  lookup_knowledge:
    'List the accepted standards, architecture and decisions that apply to a repo-relative path ({path}). Use it before touching an unfamiliar area.',
  plan_write:
    'Coordinator only: write the plan ({owners: [{child, owns: [path globs]}], contracts?: [C-ids]}). It stays draft until the operator approves it.',
  contract_write:
    'Coordinator only: create a contract ({title, body ≤800, parties: [child ids]}) or bump one ({id, …, reason, routine?}); a bump of an agreed contract is gated by your autonomy level (routine = additive only).',
  add_child:
    'Coordinator only: add a child node ({title, goal, repo?}). At Advise it is proposed to the operator; at Organise/Run it is created.',
  add_waits_on:
    'Coordinator only: make one child wait on another node ({child, on}). Gated by your autonomy level.',
  set_owner:
    'Coordinator only: give a child ownership of paths ({child, owns: [globs]}). Gated by your autonomy level.',
};

export function isAgentVerb(name: string): name is AgentVerb {
  return (AGENT_VERBS as readonly string[]).includes(name);
}

/** Validates a verb's input, naming the verb in the error the model sees. */
export function validateVerbInput<V extends AgentVerb>(
  verb: V,
  input: unknown,
): z.infer<(typeof AGENT_VERB_SCHEMAS)[V]> {
  const result = AGENT_VERB_SCHEMAS[verb].safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError(verb, result.error));
  }
  return result.data as z.infer<(typeof AGENT_VERB_SCHEMAS)[V]>;
}
