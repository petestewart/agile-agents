# Retro — {{sprint.id}}

Computed from the ledger, not agent-written — you are reading numbers, not
producing them.

- Mispointed (spent > 3x estimate): {{#each sprint.retro.mispointed}}`{{this}}` {{/each}}
- Global halts this sprint: {{sprint.retro.global_halts}}
- Escalations this sprint: {{sprint.retro.escalations}}

## Protocol
- Every mispointed ticket gets its rubric answers re-scored against what
  actually happened. A recurring pattern ("touching the webhook router is
  always hard-tier") becomes a knowledge-store fact, not a one-off note.
- More than one or two global halts this sprint means the oracle is
  under-specified — say so, don't just log the count.
- A bad tier/model cell may mean the rubric under-tiered the work, not that
  the model is weak; separate the two before touching the routing table.
- Prune expired or contradicted knowledge-store facts while you're here.
