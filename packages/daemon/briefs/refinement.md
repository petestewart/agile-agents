# Refinement — {{sprint.id}}

## Tickets to refine or re-refine
{{#each tickets}}- `{{id}}` {{title}} (status: `{{status}}`)
{{/each}}

## Oracle entries in scope
{{#each oracleEntries}}- `{{id}}` {{title}} ({{status}})
{{/each}}

## Pointing rubric (tier = the worst answer)
| Question | trivial/standard | hard | novel |
|---|---|---|---|
| Ambiguity | contract fully specified by oracle refs | requires choices the oracle doesn't make | choices that would themselves be decisions |
| Blast radius | one module | crosses a bounded context | public interface or data model |
| Verifiability | executable acceptance tests | needs judgment | can't be written until done — it's a spike |
| Precedent | pattern to copy (trivial) or similar pattern (standard) | none | none |

`reasoning` (low/medium/high) defaults from tier; override only with a reason.
Points (1/2/3/5/8) measure work, not intelligence; over 8 → split.

## Protocol
For each ticket: write `contract` (inputs/outputs/acceptance/done/env) and
`oracle_refs`, answer the four questions, set `estimate.tier` from the worst
answer, then `reasoning`. A `stale` ticket that is unchanged by the decision
that stale'd it goes back to `ready` as-is; otherwise split it or add a
`refactor` child pointing at the WIP commit.
