/**
 * The eight MCP verbs an attached agent session gets, as zod schemas
 * (design/cockpit-design.md §4.1: "The MCP verb surface an agent gets
 * shrinks to eight: `ask` · `progress` · `finding` · `propose_rule` ·
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
import { RuleExampleSchema } from './knowledge';
import { RoutedEventIdSchema } from './routed-event';
import { LegacyRuleEnforcementSchema } from './rule';
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
 * §5.1's proposal, as an agent may state it. `examples` · `enforcement` ·
 * `critical` are here because T141's lessons session is asked for exactly
 * those: two example actions per rule (the human's documentation and the
 * classifier's evals, §5.6), the tier it guesses, and whether it is
 * critical. Everything the daemon owns — `status`, `provenance`, `stats` —
 * is still absent, so no verb call can propose a rule that arrives
 * accepted.
 */
export const ProposeRuleInputSchema = z
  .object({
    session: Session,
    text: Body,
    scope: z.string().min(1).optional(),
    examples: z.array(RuleExampleSchema).max(8).optional(),
    enforcement: LegacyRuleEnforcementSchema.optional(),
    critical: z.boolean().optional(),
  })
  .strict();
export type ProposeRuleInput = z.infer<typeof ProposeRuleInputSchema>;

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
export const DeliverInputSchema = z.object({ session: Session }).strict();
export type DeliverInput = z.infer<typeof DeliverInputSchema>;

/** The verb table, in the order §4.1 lists it. */
export const AGENT_VERBS = [
  'ask',
  'progress',
  'finding',
  'propose_rule',
  'propose_next',
  'read_stream',
  'search_docs',
  'test_run',
  'read_event',
  'deliver',
] as const;
export type AgentVerb = (typeof AGENT_VERBS)[number];

export const AGENT_VERB_SCHEMAS = {
  ask: AskInputSchema,
  progress: ProgressInputSchema,
  finding: FindingInputSchema,
  propose_rule: ProposeRuleInputSchema,
  propose_next: ProposeNextInputSchema,
  read_stream: ReadStreamInputSchema,
  search_docs: SearchDocsInputSchema,
  test_run: TestRunInputSchema,
  read_event: ReadEventInputSchema,
  deliver: DeliverInputSchema,
} as const satisfies Record<AgentVerb, z.ZodType>;

/** One line of help per verb, published to the model by the MCP bridge. */
export const AGENT_VERB_DESCRIPTIONS: Record<AgentVerb, string> = {
  ask: 'Ask the operator a question and block until it is answered.',
  progress: 'Report one line of progress onto the stream thread.',
  finding: 'Record a finding ({severity, file, line?, text}) on the stream.',
  propose_rule:
    'Propose a rule for the operator to accept or reject ({text, scope?, examples?: [{action, violates}], enforcement?, critical?}).',
  propose_next: 'Propose a follow-up stream ({title, goal}); a human creates it.',
  read_stream: 'Read the most recent entries of this session’s stream thread.',
  search_docs: 'Search the repo and stream docs visible to this stream.',
  test_run: 'Run a test command in this session’s worktree; failures only, never a green log.',
  read_event: 'Read the full payload of a routed event ({id}) that was delivered to this stream.',
  deliver:
    'Push your committed fix and update your open PR (babysitting). Only once a PR is open; commit first.',
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
