/**
 * Role brief assembly (T012) — renders the T013 template for the role being
 * spawned, from the ticket YAML plus KB refs and `.agile/rules/*.md`
 * (design/agile-agents-design.md §8 "Adapter contract": "(ticket,
 * oracle_refs, kb_refs, worktree) -> ..."). The result becomes the session's
 * first `prompt()` call.
 *
 * Oracle refs (DESIGN-GAP): none of the three original T013 contexts this
 * module renders (`EngineerBriefContext`, `ReviewerBriefContext`,
 * `QaBriefContext`) carry a resolved `oracleEntries` field — their templates
 * print `ticket.oracle_refs` as bare IDs (`{{#each ticket.oracle_refs}}...
 * {{/each}}`), never a resolved body — so `getOracleEntry` is not called
 * here for these three roles; the ticket's `oracle_refs` array is all the
 * brief shows, matching T013's own contract. `ArchitectBriefContext` is the
 * one context that DOES carry a resolved `oracleEntries` field (T031 wires
 * it via `oracleEntriesFor` below, resolving the spawn ticket's
 * `oracle_refs` the same stale-tolerant way `kbFactsFor` already does for
 * the reviewer's `kb_refs`).
 *
 * Rules (DESIGN-GAP): `.agile/rules/*.md` (§12 "Rules live in
 * `.agile/rules/RULE-012.md`, one per file") has no field in any T013
 * context either — the templates were never given a `{{#each rules}}` slot.
 * Rather than editing T013's templates/types (outside this ticket's file
 * ownership), whatever rule files exist are appended as a plain Markdown
 * appendix after the rendered template.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentId, KbFact, OracleEntry, Ticket } from '@agile-agents/shared';
import {
  renderArchitectBrief,
  renderEngineerBrief,
  renderQaBrief,
  renderReviewerBrief,
} from '../briefs';
import type { PermissionRole } from '../permissions';
import type { StateStore } from '../store';

/** Every `.agile/rules/*.md` file's raw content, sorted by filename for determinism. */
function loadRules(stateRoot: string): string[] {
  const dir = join(stateRoot, 'rules');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf8').trim())
    .filter((text) => text.length > 0);
}

function rulesAppendix(rules: string[]): string {
  if (rules.length === 0) return '';
  return `\n\n## Rules\n\n${rules.join('\n\n---\n\n')}\n`;
}

/** Resolves `ticket.kb_refs` to `KbFact`s, skipping any ref that no longer resolves (a pointer, not a hard dependency at render time). */
function kbFactsFor(store: StateStore, ticket: Ticket): KbFact[] {
  const facts: KbFact[] = [];
  for (const id of ticket.kb_refs) {
    try {
      facts.push(store.getKbFact(id).fact);
    } catch {
      // Stale/removed kb_ref — brief renders without it rather than failing outright.
    }
  }
  return facts;
}

/**
 * Resolves `ticket.oracle_refs` to `OracleEntry`s for `ArchitectBriefContext`
 * (T031 — this ticket's own file header DESIGN-GAP note: "only
 * `ArchitectBriefContext` [carries] a resolved `oracleEntries` field").
 * Same stale-ref tolerance as `kbFactsFor` above.
 */
function oracleEntriesFor(store: StateStore, ticket: Ticket): OracleEntry[] {
  const entries: OracleEntry[] = [];
  for (const id of ticket.oracle_refs) {
    try {
      entries.push(store.getOracleEntry(id).entry);
    } catch {
      // Stale/removed oracle_ref — brief renders without it rather than failing outright.
    }
  }
  return entries;
}

export interface AssembleBriefOptions {
  store: StateStore;
  /** `.agile/` root — where `rules/*.md` lives. */
  stateRoot: string;
  role: PermissionRole;
  agent: AgentId;
  ticket: Ticket;
  /** The ticket's reviewer agent id, named in the engineer brief as the `review_request` recipient. */
  reviewer?: AgentId;
}

/** Renders the T013 role brief for `role` plus the `.agile/rules/*.md` appendix — this is the session's first prompt. */
export function assembleBrief(opts: AssembleBriefOptions): string {
  const { store, stateRoot, role, agent, ticket, reviewer } = opts;
  const appendix = rulesAppendix(loadRules(stateRoot));

  switch (role) {
    case 'engineer':
      return (
        renderEngineerBrief({
          agent,
          ticket,
          policy: store.getPolicy(),
          ...(reviewer !== undefined ? { reviewer } : {}),
        }) + appendix
      );
    case 'reviewer':
      return renderReviewerBrief({ agent, ticket, kbFacts: kbFactsFor(store, ticket) }) + appendix;
    case 'qa':
      return renderQaBrief({ agent, ticket }) + appendix;
    case 'architect':
      return (
        renderArchitectBrief({ agent, ticket, oracleEntries: oracleEntriesFor(store, ticket) }) +
        appendix
      );
    default: {
      const exhaustive: never = role;
      throw new Error(`assembleBrief: unknown role ${String(exhaustive)}`);
    }
  }
}
