/**
 * Fixture render-context data for brief/ceremony template tests (T013).
 *
 * Modeled directly on `packages/shared/src/__fixtures__/*` (the design doc's
 * own example blocks, validated in T002's `fixtures.test.ts`) rather than
 * loaded from those YAML files — `packages/daemon` has no YAML-parsing
 * dependency and adding one is out of this ticket's scope. Each literal
 * below is typed against the real `@agile-agents/shared` types, so a field
 * this module forgets is a compile error, not a silent gap.
 */

import type {
  Halt,
  KbFact,
  OracleEntry,
  Policy,
  Sprint,
  Stanza,
  Ticket,
} from '@agile-agents/shared';

/** design/agile-agents-design.md §4 "Ticket" (verbatim, per shared's ticket.yaml fixture). */
export const FIXTURE_TICKET: Ticket = {
  id: 'TKT-0231',
  title: 'Issue JWT on login',
  status: 'in_progress',
  sprint: 'S-07',
  parent: 'EPIC-0009',
  depends: ['TKT-0230'],
  oracle_refs: ['DEC-0042', 'SPEC-auth-003'],
  kb_refs: ['KB-0117'],
  contract: {
    inputs: ['packages/api/auth/**'],
    outputs: ['packages/api/auth/jwt.ts', 'tests/auth/jwt.test.ts'],
    acceptance: [
      'POST /login with valid creds returns 200 and a JWT whose exp is +24h',
      'npm test -w packages/api passes',
    ],
    done: ['tests_pass', 'review_approved', 'qa_accepted', 'oracle_consistent'],
    env: 'clone',
  },
  estimate: {
    points: 3,
    tier: 'standard',
    reasoning: 'high',
    pointed_by: 'architect',
    pointed_at: '2026-09-05',
  },
  routing: {
    attempts: 1,
    max_attempts: 2,
    escalation: ['standard', 'hard'],
  },
  budget: {
    ceiling_tokens: 400_000,
    spent_tokens: 0,
  },
  assignee: 'eng-3',
  worktree: '.worktrees/TKT-0231',
  history: ['2026-09-05 created by architect', '2026-09-07 assigned to eng-3 (claude/sonnet)'],
  security: false,
};

/** design/agile-agents-design.md §4 "Oracle" (verbatim). */
export const FIXTURE_ORACLE_ENTRY: OracleEntry = {
  id: 'DEC-0042',
  title: 'Sessions are JWT, not server-side',
  status: 'active',
  supersedes: ['DEC-0019'],
  depends: ['SPEC-auth-003'],
  affects: ['SPEC-api-001'],
  decided: '2026-09-07',
  by: 'architect',
  rationale: 'Server-side sessions do not survive the multi-region rollout without sticky LBs.',
};

export const FIXTURE_ORACLE_ENTRY_2: OracleEntry = {
  id: 'SPEC-auth-003',
  title: 'Auth service API surface',
  status: 'active',
  supersedes: [],
  depends: [],
  affects: [],
  decided: '2026-08-20',
  by: 'architect',
  rationale: 'Baseline spec for login/refresh/logout endpoints.',
};

/** design/agile-agents-design.md §4 "Knowledge store" (verbatim). */
export const FIXTURE_KB_FACT: KbFact = {
  id: 'KB-0117',
  kind: 'env',
  scope: ['packages/api'],
  confidence: 'observed',
  source: 'TKT-0198',
  expires: null,
};

/** design/agile-agents-design.md §4 "Halts" (constructed from prose, per shared's halt.yaml fixture). */
export const FIXTURE_HALT: Halt = {
  id: 'H-12',
  scope: ['TKT-0231'],
  reason: 'Auth session model is ambiguous — JWT vs server-side',
  raised_by: 'architect',
  resolves_when: 'DEC-0042',
  quorum: 'pending',
};

/** design/agile-agents-design.md §4 "Board" (per shared's stanza.json fixture). */
export const FIXTURE_DISCOVERY_STANZA: Stanza = {
  ts: '2026-09-07T18:00:00Z',
  ticket: 'TKT-0231',
  agent: 'eng-3',
  kind: 'discovery',
  summary: 'Login flow assumes server-side sessions; the oracle says JWT — needs a ruling.',
  discovery: {
    tier: 'scoped',
    affects: ['SPEC-auth-003'],
    proposed: 'Confirm JWT per DEC-0042 and update the login handler accordingly.',
  },
};

/** design/agile-agents-design.md §4 "Sprint", with the §15/§16 team + gates override applied. */
export const FIXTURE_SPRINT: Sprint = {
  id: 'S-07',
  goal: 'Auth works end to end',
  tickets: ['TKT-0230', 'TKT-0231'],
  budget_tokens: 5_000_000,
  started: '2026-09-05T09:00:00Z',
  review_at: '2026-09-10T17:00:00Z',
  carried_over: [],
  retro: {
    mispointed: ['TKT-0229'],
    global_halts: 1,
    escalations: 2,
  },
  team: 'auth-team',
  gates: {
    sprint_review: 'human',
  },
};

/** design/agile-agents-design.md §16 "HIL gates policy" (verbatim). */
export const FIXTURE_POLICY: Policy = {
  gates: {
    approve_plan: 'human',
    approve_decision: 'human',
    sprint_review: 'human',
    unblock: 'em',
    demo: 'human',
  },
  breaker_signals: [],
};
