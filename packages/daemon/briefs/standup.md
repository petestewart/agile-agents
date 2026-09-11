# Standup — {{sprint.id}}

Async by default: agents already wrote board stanzas at their checkpoints.
This is you (EM) reading the board and posting a `decision`, not a meeting.

## Open halts
{{#each halts}}- `{{id}}` scope `{{scope}}` — {{reason}} (raised by {{raised_by}}, quorum: {{quorum}})
{{/each}}

## Discovery stanzas since last standup
{{#each discoveries}}- `{{ticket}}` ({{agent}}): {{summary}}
{{/each}}

## Protocol
1. Any `scoped`/`global` discovery above goes to the architect to confirm or
   change tier, not decided here.
2. For each open halt, check `quorum`: `reached` means every affected agent
   has reported in or timed out — deliberate with the architect now.
   `pending` means keep waiting; don't force it.
3. Product-level calls become a `hil_request`, not a unilateral decision.
4. Post one `decision` (or route onward) per open item — a standup that
   reads the board and posts nothing is a missed one.
