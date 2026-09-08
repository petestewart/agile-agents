# Sprint review — {{sprint.id}}

Goal: {{sprint.goal}}

## Tickets landed this layer
{{#each doneTickets}}- `{{id}}` {{title}}
{{/each}}

## Gate
`sprint_review` owner for this sprint: {{#if sprint.gates.sprint_review}}{{sprint.gates.sprint_review}}{{/if}}{{#if policy.gates.sprint_review}}(repo default: {{policy.gates.sprint_review}}){{/if}}

## Protocol
- Owner `human`: in-flight work finishes, engineers idle, and you (EM)
  pre-plan the next layer so one approval unblocks both — send a
  `hil_request` (`kind: demo`) with a deadline.
- Owner delegated (`em`/`architect`): merge `integration → main` now and
  plan the next layer immediately; the human gets a low-priority `fyi`
  instead of a request, so the log reads the same either way.
- A circuit-breaker signal in force (global halt, budget over threshold,
  integration red, escalation ladder exhausted, reviewer/engineer deadlock)
  overrides delegation — this review waits for `human` regardless of the
  configured owner.
