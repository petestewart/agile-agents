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
import {
  CONTRACT_BODY_MAX_CHARS,
  ContractIdSchema,
  ContractProposalIdSchema,
  ContractWriteFieldsSchema,
  DRAFT_TREE_PARTS_MAX,
  DraftTreePartSchema,
  PLAN_LIST_MAX,
  PlanWriteFieldsSchema,
} from './plan';
import { ProjectIdSchema, ProjectNameSchema } from './project';
import { QuestionChoicesSchema, QuestionIdSchema } from './question';
import { RoutedEventIdSchema } from './routed-event';
import { StreamFindingSeveritySchema, THREAD_BODY_MAX_CHARS } from './stream';

/** Free text an agent writes into the thread — capped like every thread body. */
const Body = z.string().min(1).max(THREAD_BODY_MAX_CHARS);

/** Every verb names the session it is called from. */
const Session = UlidSchema;

/** T361: `options` are choices the operator can click; typing an answer is always allowed. */
export const AskInputSchema = z
  .object({ session: Session, text: Body, options: QuestionChoicesSchema.optional() })
  .strict();
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
    /** T303: what the item came out of (e.g. the finding ids of a norm suggestion); kept on its source. */
    sources: z.array(z.string().min(1).max(200)).max(20).optional(),
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

/** T283 (§14.5): a sibling's, an ancestor's (or, for the Director, any) node's status card. */
export const ReadCardInputSchema = z.object({ session: Session, node: UlidSchema }).strict();
export type ReadCardInput = z.infer<typeof ReadCardInputSchema>;

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
/** T287 (§9.4): a coordinator's targeted note to one of its children. */
export const NoteChildInputSchema = z
  .object({ session: Session, child: UlidSchema, body: Body })
  .strict();

/** T338: the coordinator answers a part's question, or (no `answer`) passes it to the operator. */
export const AnswerChildInputSchema = z
  .object({ session: Session, question: QuestionIdSchema, answer: Body.optional() })
  .strict();

/**
 * T285 (§9.1, §9.5): a child (optionally co-signed by siblings in `with`)
 * proposes a new body for a contract it relies on. It lands on the
 * contract as an open proposal and wakes the coordinator.
 */
export const ProposeContractInputSchema = z
  .object({
    session: Session,
    contract: ContractIdSchema,
    body: z.string().trim().min(1).max(CONTRACT_BODY_MAX_CHARS),
    reason: z.string().max(400),
    routine: z.boolean().optional(),
    with: z.array(UlidSchema).max(10).optional(),
  })
  .strict();
export type ProposeContractInput = z.infer<typeof ProposeContractInputSchema>;

/** T285: the coordinator approves (gated by autonomy) or rejects a proposal. */
export const DecideContractInputSchema = z
  .object({
    session: Session,
    proposal: ContractProposalIdSchema,
    decision: z.enum(['approve', 'reject']),
    reason: z.string().max(400).optional(),
    routine: z.boolean().optional(),
  })
  .strict();
export type DecideContractInput = z.infer<typeof DecideContractInputSchema>;

/**
 * T286 (§9.5): a child asks a sibling (same parent) a question about a
 * detail; the sibling answers with `reply_sibling`. Both threads and the
 * parent see the exchange.
 */
export const AskSiblingInputSchema = z
  .object({ session: Session, node: UlidSchema, question: z.string().trim().min(1).max(800) })
  .strict();
export const ReplySiblingInputSchema = z
  .object({
    session: Session,
    ask: RoutedEventIdSchema,
    body: z.string().trim().min(1).max(800),
    /** Agree to a joint `propose_contract`: the contract and the exact proposed body. */
    agree: z
      .object({
        contract: ContractIdSchema,
        body: z.string().trim().min(1).max(CONTRACT_BODY_MAX_CHARS),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * T301 (§12): the Director's verbs, gated by each project's `director`
 * autonomy level. The MCP bridge publishes a plain object shape, so the
 * cross-field checks (exactly one of project/new_project, parent/project)
 * run on the change itself (`CoordinatorChangeSchema`).
 */
const NodeTitle = z.string().trim().min(1).max(200);
export const DraftTreeInputSchema = z
  .object({
    session: Session,
    project: ProjectIdSchema.optional(),
    new_project: ProjectNameSchema.optional(),
    title: NodeTitle,
    goal: Body,
    repo: z.string().min(1).optional(),
    parts: z.array(DraftTreePartSchema).min(1).max(DRAFT_TREE_PARTS_MAX),
  })
  .strict();
export const CreateProjectInputSchema = z
  .object({
    session: Session,
    name: ProjectNameSchema,
    repos: z.array(z.string().min(1)).max(PLAN_LIST_MAX).optional(),
  })
  .strict();
export const CreateNodeInputSchema = z
  .object({
    session: Session,
    title: NodeTitle,
    goal: Body,
    parent: UlidSchema.optional(),
    project: ProjectIdSchema.optional(),
    repo: z.string().min(1).optional(),
  })
  .strict();
export const StartNodeInputSchema = z.object({ session: Session, node: UlidSchema }).strict();
export const RestartNodeInputSchema = StartNodeInputSchema;

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
  'read_card',
  'plan_write',
  'contract_write',
  'add_child',
  'add_waits_on',
  'set_owner',
  'note_child',
  'answer_child',
  'propose_contract',
  'decide_contract',
  'ask_sibling',
  'reply_sibling',
  'draft_tree',
  'create_project',
  'create_node',
  'start_node',
  'restart_node',
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
  read_card: ReadCardInputSchema,
  plan_write: PlanWriteInputSchema,
  contract_write: ContractWriteInputSchema,
  add_child: AddChildInputSchema,
  add_waits_on: AddWaitsOnInputSchema,
  set_owner: SetOwnerInputSchema,
  note_child: NoteChildInputSchema,
  answer_child: AnswerChildInputSchema,
  propose_contract: ProposeContractInputSchema,
  decide_contract: DecideContractInputSchema,
  ask_sibling: AskSiblingInputSchema,
  reply_sibling: ReplySiblingInputSchema,
  draft_tree: DraftTreeInputSchema,
  create_project: CreateProjectInputSchema,
  create_node: CreateNodeInputSchema,
  start_node: StartNodeInputSchema,
  restart_node: RestartNodeInputSchema,
} as const satisfies Record<AgentVerb, z.ZodType>;

/** One line of help per verb, published to the model by the MCP bridge. */
export const AGENT_VERB_DESCRIPTIONS: Record<AgentVerb, string> = {
  ask: 'Ask the operator a question and block until it is answered ({text, options?: 2–6 short choices, each ≤200 chars}). With `options` the operator can click one; they may still type their own answer.',
  progress: 'Report one line of progress onto the stream thread.',
  finding: 'Record a finding ({severity, file, line?, text}) on the stream.',
  propose_knowledge:
    'Propose a knowledge item for the operator to accept or reject ({text, kind?: standard|architecture|decision, scope?, paths?, examples?: [{action, violates}], enforcement?: tell|action|ship|review, critical?, sources?: [id]}). Scope defaults to this node’s subtree; the Director names it (global, repo:<name>, project:<id>).',
  propose_next: 'Propose a follow-up stream ({title, goal}); a human creates it.',
  read_stream: 'Read the most recent entries of this session’s stream thread.',
  search_docs: 'Search the repo and stream docs visible to this stream.',
  test_run: 'Run a test command in this session’s worktree; failures only, never a green log.',
  read_event: 'Read the full payload of a routed event ({id}) that was delivered to this stream.',
  deliver:
    'Push your committed fix and update your open PR (babysitting). Only once a PR is open; commit first.',
  lookup_knowledge:
    'List the accepted standards, architecture and decisions that apply to a repo-relative path ({path}). Use it before touching an unfamiliar area.',
  read_card:
    'Read the status card ({node}) of a sibling or an ancestor: what it is doing, its state, the files it changed and the contracts it relies on.',
  plan_write:
    'Coordinator only: write the plan ({owners: [{child, owns: [path globs]}], contracts?: [C-ids]}). It stays draft until the operator approves it.',
  contract_write:
    'Coordinator only: create a contract ({title, body ≤800, parties: [child ids]}) or bump one ({id, …, reason, routine?}); a bump of an agreed contract is gated by your autonomy level (routine = additive only).',
  add_child:
    'Coordinator only: add a child node ({title, goal, repo?}). At Advise it is proposed to the operator; at Organise/Run it is created.',
  add_waits_on:
    'Coordinator or Director: make one node wait on another ({child, on}); a coordinator only for its own children. Gated by your autonomy level.',
  set_owner:
    'Coordinator only: give a child ownership of paths ({child, owns: [globs]}). Gated by your autonomy level.',
  note_child:
    'Coordinator only: send one child a targeted note ({child, body}), e.g. after a sibling merged or collided.',
  answer_child:
    'Coordinator only: answer a child’s question that came to you first ({question: Q-id, answer}); leave out `answer` to pass it to the operator.',
  propose_contract:
    'Propose a change to a contract you rely on ({contract, body ≤800, reason, routine?, with?: [sibling ids who agreed]}). Each co-signer in `with` must have answered your latest `ask_sibling` with `agree` naming this contract and this exact body. Your coordinator approves, rejects or asks the operator; you are told which.',
  decide_contract:
    'Coordinator only: decide a child’s contract proposal ({proposal, decision: approve|reject, reason?, routine?}). Approval is gated by your autonomy level (routine = additive only).',
  ask_sibling:
    'Ask a sibling (same parent) a question about a detail ({node, question ≤800}). Both threads show it and your parent gets a copy. Plan, contract or ownership changes go to your parent (`propose_contract`), not here.',
  reply_sibling:
    'Answer a sibling’s `ask_sibling` ({ask: the event id, body ≤800, agree?: {contract, body}}). Pass `agree` only to co-sign their contract proposal with that exact body. Both threads show it and your parent gets a copy.',
  draft_tree:
    'Director only: draft a node and its parts ({project | new_project, title, goal, repo?, parts: [{title, goal, repo?, after?: [part indexes it waits on]}]}). At Advise (and for a new project) it is a draft with a Create button for the operator; at Organise/Run it is created.',
  create_project:
    'Director only: create a project ({name, repos?}). A new project has no level yet, so it is always a draft for the operator.',
  create_node:
    'Director only: create a node ({title, goal, parent | project, repo?}). Gated by the project’s Director level.',
  start_node: 'Director only: start a node’s agent ({node}). Applied at Organise/Run.',
  restart_node:
    'Director only: restart a stuck node’s agent ({node}). Applied at Run only; otherwise a proposal.',
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
