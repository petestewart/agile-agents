/**
 * `buildBrief` — the text a freshly attached session is prompted with
 * (design/cockpit-design.md §4.1 step 2: "assembles the brief:
 * `briefs/worker.md`, the stream goal and its ancestors' goals, the last N
 * thread entries, repo docs from `<repo>/.agile-docs/*.md`, and accepted
 * rules in scope").
 *
 * T130 builds the minimal body: the role file, the goal, the ancestors'
 * goals root→leaf, and the tail of the thread. `docs` and `rules` are
 * accepted and rendered as plain sections, and callers pass `[]` for now —
 * T133 finishes this (the ceiling test, the snapshot tests, folding the
 * useful parts of the old role briefs in) and T134's `DocsService` supplies
 * the docs.
 *
 * Pure apart from reading the role file off disk: everything else is
 * handed in, so a brief is a function of the stream, not of the daemon's
 * state at the moment it ran.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionRole, Stream, ThreadEntry } from '@agile-agents/shared';

/** `packages/daemon/briefs/` — one Markdown file per role. */
export const BRIEFS_DIR = join(import.meta.dir, '..', '..', 'briefs');

/** How many thread entries the brief carries by default. */
export const BRIEF_THREAD_ENTRIES = 20;

export interface BriefDoc {
  name: string;
  body: string;
}

export interface BriefRule {
  text: string;
  scope?: string;
}

export interface BuildBriefInput {
  role: SessionRole;
  stream: Stream;
  /** The stream's ancestors, root→leaf, excluding the stream itself. */
  ancestors: Stream[];
  /** The stream's thread, oldest first; only the tail is rendered. */
  thread: ThreadEntry[];
  docs: BriefDoc[];
  rules: BriefRule[];
  /** Overrides `BRIEF_THREAD_ENTRIES`. */
  threadEntries?: number;
  /** Test seam: where the role files live. */
  briefsDir?: string;
}

/** The role's Markdown file, or an empty string when there is none on disk. */
export function readRoleBrief(role: SessionRole, briefsDir = BRIEFS_DIR): string {
  const path = join(briefsDir, `${role}.md`);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8').trimEnd();
}

function section(heading: string, body: string): string {
  return `## ${heading}\n\n${body}`;
}

export function buildBrief(input: BuildBriefInput): string {
  const { role, stream, ancestors, thread, docs, rules } = input;
  const parts: string[] = [];

  const roleBrief = readRoleBrief(role, input.briefsDir);
  if (roleBrief.length > 0) parts.push(roleBrief);

  parts.push(section('Stream', `**${stream.title}**\n\n${stream.goal}`));

  if (ancestors.length > 0) {
    parts.push(
      section(
        'Where this sits',
        ancestors
          .map((ancestor, depth) => `${'  '.repeat(depth)}- ${ancestor.title}: ${ancestor.goal}`)
          .join('\n'),
      ),
    );
  }

  if (rules.length > 0) {
    parts.push(
      section(
        'Rules in scope',
        rules
          .map((rule) =>
            rule.scope === undefined ? `- ${rule.text}` : `- (${rule.scope}) ${rule.text}`,
          )
          .join('\n'),
      ),
    );
  }

  if (docs.length > 0) {
    parts.push(
      section('Docs', docs.map((doc) => `### ${doc.name}\n\n${doc.body.trimEnd()}`).join('\n\n')),
    );
  }

  const tail = thread.slice(-(input.threadEntries ?? BRIEF_THREAD_ENTRIES));
  if (tail.length > 0) {
    parts.push(
      section(
        'Thread so far',
        tail.map((entry) => `- **${entry.by}** (${entry.kind}): ${entry.body}`).join('\n'),
      ),
    );
  }

  return `${parts.join('\n\n')}\n`;
}
