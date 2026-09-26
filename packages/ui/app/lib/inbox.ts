/**
 * T364: the pure half of Needs me and its decision cards
 * (design/cockpit-ui.md §7 "Decision cards"). What a card is called, what
 * its text says once the daemon's machine phrasing is taken apart, which
 * choices a question offers, how the list groups (project, then node,
 * oldest first), the kind filter, and the first-run steps. No DOM, so plain
 * `bun test` covers it; `components/Inbox.tsx` only renders.
 */

import { type InboxItem, inboxContext } from '@agile-agents/shared';
import type { CockpitFrame, CockpitProjectRow, CockpitStreamRow } from './feed-types';

// ---------------------------------------------------------------- kinds

/** The icon and title tone a card wears; each is a status token (design/cockpit-ui.md §4). */
export type CardTone = 'amber' | 'blue' | 'green' | 'purple' | 'red' | 'gray' | 'accent';

/** A gate item's context leads with its gate name (`inbox/service.ts`), which is how a `land` gate is told from a `classifier_review` one. */
export function isLandGate(item: Pick<InboxItem, 'kind' | 'context'>): boolean {
  return item.kind === 'gate' && item.context.startsWith('land:');
}

function capitalise(word: string): string {
  return word.length === 0 ? word : `${word[0]?.toUpperCase()}${word.slice(1)}`;
}

/** The card's plain title: what it is, in words (design/cockpit-ui.md §2). */
export function cardTitle(item: InboxItem): string {
  switch (item.kind) {
    case 'question':
      return 'Question';
    case 'gate':
      return isLandGate(item) ? 'Approve this merge?' : 'Allow this action?';
    case 'rule_accept':
      return `${capitalise(item.knowledge_kind ?? 'knowledge')} proposed`;
    case 'rule_batch':
      return 'Knowledge to review';
    case 'plan_approve':
      return 'Plan to approve';
    case 'plan_waiting':
      return 'Waiting for the plan';
    case 'proposal':
      return proposalOf(item).principal === 'director'
        ? 'Director proposal'
        : 'Coordinator proposal';
    case 'done':
      return 'Ready to merge';
    case 'blocked':
      return 'Blocked';
  }
}

export function cardTone(item: InboxItem): CardTone {
  switch (item.kind) {
    case 'question':
      return 'amber';
    case 'gate':
      return isLandGate(item) ? 'green' : 'amber';
    case 'rule_accept':
    case 'rule_batch':
      return 'purple';
    case 'plan_approve':
    case 'proposal':
      return 'accent';
    case 'plan_waiting':
      return 'gray';
    case 'done':
      return 'green';
    case 'blocked':
      return 'red';
  }
}

/** The whole text behind a card: `detail` when the daemon clipped `context`. */
export function fullText(item: Pick<InboxItem, 'context' | 'detail'>): string {
  return item.detail ?? item.context;
}

/**
 * A card's main text, short (one line, ≤200 chars, as the daemon clips) and
 * whole. `long` is set only when the short form lost something, which is
 * when the card offers Show more.
 */
export function fold(text: string): { short: string; long?: string } {
  const short = inboxContext(text);
  return short === text.replace(/\s+/g, ' ').trim() ? { short: text } : { short, long: text };
}

// ---------------------------------------------------------------- question choices

export const CHOICES_MIN = 2;
export const CHOICES_MAX = 6;
/** A parsed choice longer than this is a paragraph, not a button. */
export const CHOICE_MAX_CHARS = 100;

export interface ParsedChoices {
  /** The question without its choices, which the buttons now show. */
  stem: string;
  choices: string[];
}

type LabelKind = 'upper' | 'lower' | 'digit';

function labelOf(label: string): { kind: LabelKind; index: number } | undefined {
  if (/^[A-F]$/.test(label)) return { kind: 'upper', index: label.charCodeAt(0) - 65 };
  if (/^[a-f]$/.test(label)) return { kind: 'lower', index: label.charCodeAt(0) - 97 };
  if (/^[1-6]$/.test(label)) return { kind: 'digit', index: Number(label) - 1 };
  return undefined;
}

/** `A, B, C…` (or `a…`, `1…`) in order from the first, all one kind. */
function isSequence(labels: readonly string[]): boolean {
  const parsed = labels.map(labelOf);
  const kind = parsed[0]?.kind;
  return parsed.every((p, i) => p !== undefined && p.kind === kind && p.index === i);
}

/** Plain text for a button: no emphasis markers or code ticks, one line. */
export function cleanChoice(text: string): string {
  return text
    .replace(/\*\*|__/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drops the joining words and punctuation between inline choices: "floats, or" → "floats". */
function stripJoiners(text: string): string {
  let out = text.trim().replace(/^[-–—:]\s*/, '');
  for (;;) {
    const next = out.replace(/(?:[\s,;]+|\s+(?:or|and)\b)$/i, '').replace(/^(?:or|and)\s+/i, '');
    if (next === out) return out;
    out = next;
  }
}

/** Words that introduce a list to pick from ("Pick one:", "Options:"). */
const PICK_WORDS = /\b(which|pick|choose|prefer|select|options?|choices?|either)\b/i;
/** Words that make a question one with alternatives ("Which…?", "…or…?", "What should…?"). */
const ASK_WORDS = /\b(which|what|prefer|choose|pick|select|options?|choices?|either|or|rather)\b/i;

/**
 * A stem that asks for a pick: it ends in a question, or introduces the
 * list after one. A numbered list is as often steps as choices, so its stem
 * must also ask for alternatives ("Is this plan OK?" over steps is not a pick).
 */
function stemInvites(stem: string, kind: LabelKind | undefined): boolean {
  const asks =
    stem.endsWith('?') || (stem.endsWith(':') && (stem.includes('?') || PICK_WORDS.test(stem)));
  return asks && (kind !== 'digit' || ASK_WORDS.test(stem));
}

/** Masks code spans (same length) so a label inside code — `f(a)` — is never read as a choice. */
function maskCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

function valid(choices: readonly string[]): boolean {
  if (choices.length < CHOICES_MIN || choices.length > CHOICES_MAX) return false;
  const seen = new Set<string>();
  for (const choice of choices) {
    if (choice.length === 0 || choice.length > CHOICE_MAX_CHARS) return false;
    const key = choice.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** `(A) text`, `A) text`, `A. text`, `1. text`, `1) text` on a line of its own. */
const LINE_OPTION = /^ {0,3}(?:\(([A-Fa-f1-6])\)|([A-Fa-f1-6])[.)])\s+(\S.*)$/;

/** A list of choices that ends the text, one per line, after a stem that asks. */
function parseLines(text: string): ParsedChoices | undefined {
  const lines = text.split('\n');
  const found: Array<{ label: string; body: string }> = [];
  let i = lines.length - 1;
  while (i >= 0) {
    const line = lines[i] ?? '';
    if (line.trim() === '' && found.length > 0) {
      i--;
      continue;
    }
    const m = LINE_OPTION.exec(line);
    if (!m) break;
    found.unshift({ label: m[1] ?? m[2] ?? '', body: m[3] ?? '' });
    i--;
  }
  if (found.length === 0) return undefined;
  const stem = lines
    .slice(0, i + 1)
    .join('\n')
    .trim();
  if (!isSequence(found.map((f) => f.label))) return undefined;
  if (stem === '' || !stemInvites(stem, labelOf(found[0]?.label ?? '')?.kind)) return undefined;
  const choices = found.map((f) => cleanChoice(f.body));
  return valid(choices) ? { stem, choices } : undefined;
}

/** Inline labels: `(A) ` (any kind), or a bare `A) ` (letters only). */
const INLINE_STYLES: readonly RegExp[] = [
  /(?<=^|[\s,;:—–-])\(([A-Fa-f1-6])\)(?=\s)/g,
  /(?<=^|[\s,;:—–-])([A-Fa-f])\)(?=\s)/g,
];

/** The last inline choice ends at the question mark, or at a sentence end, or at a line break. */
function cutLast(text: string): { body: string; asked: boolean } {
  const q = text.indexOf('?');
  const nl = text.indexOf('\n');
  const stop = /[.!](?=\s+[A-Z]|\s*$)/.exec(text);
  const cuts = [q, nl, stop ? stop.index : -1].filter((n) => n >= 0);
  if (cuts.length === 0) return { body: text, asked: false };
  const at = Math.min(...cuts);
  return { body: text.slice(0, at), asked: at === q };
}

/** Choices written into one sentence: "…or floats? (A) integer cents (B) floats (C) decimal strings". */
function parseInline(text: string): ParsedChoices | undefined {
  const masked = maskCode(text);
  for (const style of INLINE_STYLES) {
    const marks = [...masked.matchAll(style)].map((m) => ({
      label: m[1] ?? '',
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    }));
    if (marks.length < CHOICES_MIN || !isSequence(marks.map((m) => m.label))) continue;
    const stem = text.slice(0, marks[0]?.start ?? 0).trim();
    const bodies = marks.map((m, i) => text.slice(m.end, marks[i + 1]?.start ?? text.length));
    const last = cutLast(bodies[bodies.length - 1] ?? '');
    bodies[bodies.length - 1] = last.body;
    if (bodies.slice(0, -1).some((b) => b.trim().includes('\n'))) continue;
    const kind = labelOf(marks[0]?.label ?? '')?.kind;
    const asks =
      stemInvites(stem, kind) || (last.asked && (kind !== 'digit' || ASK_WORDS.test(stem)));
    if (stem === '' || !asks) continue;
    const choices = bodies.map((b) => cleanChoice(stripJoiners(b)));
    if (valid(choices)) return { stem, choices };
  }
  return undefined;
}

/**
 * T364: the choices written into an older question's text — a lettered or
 * numbered list ending the question, or `(A) … (B) …` in one sentence —
 * and the question without them. Conservative on purpose: 2–6 short,
 * distinct options, labelled in order from the first, after a stem that
 * asks for a pick; never inside code, never in a text with a code block.
 * Anything less clear is no choices, and the operator types.
 */
export function parseChoices(text: string): ParsedChoices | undefined {
  if (text.includes('```')) return undefined;
  const trimmed = text.replace(/\s+$/, '');
  return parseLines(trimmed) ?? parseInline(trimmed);
}

/** A question card's text and its choices: the agent's `options` (T361), else the ones its text spells out. */
export function questionView(item: InboxItem): { text: string; choices: string[] } {
  const text = fullText(item);
  if (item.kind !== 'question') return { text, choices: [] };
  if (item.options !== undefined && item.options.length > 0) {
    return { text, choices: [...item.options] };
  }
  const parsed = parseChoices(text);
  return parsed ? { text: parsed.stem, choices: parsed.choices } : { text, choices: [] };
}

/** The question's choices (the buttons): `options`, else parsed from its text, else none. */
export function choicesOf(item: InboxItem): string[] {
  return questionView(item).choices;
}

// ---------------------------------------------------------------- the other kinds' text

export interface GateView {
  land: boolean;
  /** The call the classifier was unsure of ("edit src/app.ts", "bash: rm -rf dist"). */
  action?: string;
  /** Why it was routed (the classifier's reason, or the gate's summary). */
  reason: string;
  /** A land gate's branch and target, when its summary names them. */
  branch?: string;
  target?: string;
}

/** Takes a gate's `<gate>: <call> — <why>` apart (`gateText` in `inbox/service.ts`). */
export function gateView(item: InboxItem): GateView {
  const land = isLandGate(item);
  const text = fullText(item);
  const colon = text.indexOf(': ');
  const rest = colon >= 0 && /^[a-z_]+$/.test(text.slice(0, colon)) ? text.slice(colon + 2) : text;
  if (land) {
    const m = /^land (\S+) into (\S+)$/.exec(rest.trim());
    return m ? { land, reason: rest, branch: m[1], target: m[2] } : { land, reason: rest };
  }
  const dash = rest.indexOf(' — ');
  if (dash < 0) return { land, reason: rest };
  return { land, action: rest.slice(0, dash), reason: rest.slice(dash + 3) };
}

export interface KnowledgeView {
  /** The item's short name, when it has one ("money-in-cents"). */
  name?: string;
  /** `global`, `repo:<name>`, `project:<id>` or `subtree:<node>`. */
  scope?: string;
  text: string;
}

/** Takes a proposal's `<name> · <scope>: <text>` apart (`ruleItem` in `inbox/service.ts`). */
export function knowledgeView(item: InboxItem): KnowledgeView {
  const text = fullText(item);
  const m = /^(?:([^\n]+?) · )?(global|(?:repo|project|subtree):[^\s:]+): ([\s\S]+)$/.exec(text);
  if (!m) return { text };
  return {
    ...(m[1] !== undefined ? { name: m[1] } : {}),
    scope: m[2],
    text: m[3] ?? '',
  };
}

/** A node branch without its `stream/<id>-` prefix: `stream/01h…-add-csv-import` → `add-csv-import`. */
export function branchName(branch: string): string {
  return branch.replace(/^stream\/[0-9a-z]{26}-/i, '');
}

/** A knowledge scope in words: "everywhere", "the web-app repo", "Shop", "Checkout and the nodes under it". */
export function scopeWords(
  scope: string | undefined,
  names: {
    node?: (id: string) => string | undefined;
    project?: (id: string) => string | undefined;
  } = {},
): string | undefined {
  if (scope === undefined) return undefined;
  if (scope === 'global') return 'everywhere';
  const [kind, value = ''] = [
    scope.slice(0, scope.indexOf(':')),
    scope.slice(scope.indexOf(':') + 1),
  ];
  if (kind === 'repo') return `the ${value} repo`;
  if (kind === 'project') {
    const name = names.project?.(value);
    return name !== undefined ? `the ${name} project` : 'one project';
  }
  if (kind === 'subtree') {
    const title = names.node?.(value);
    return title !== undefined
      ? `${title} and the nodes under it`
      : 'one node and the nodes under it';
  }
  return undefined;
}

/** A held change's `<principal> proposes: <summary>` (`inbox/service.ts`). */
export function proposalOf(item: Pick<InboxItem, 'context' | 'detail'>): {
  principal?: 'coordinator' | 'director';
  summary: string;
} {
  const text = fullText(item);
  const m = /^(coordinator|director) proposes: ([\s\S]+)$/.exec(text);
  if (!m) return { summary: text };
  return { principal: m[1] as 'coordinator' | 'director', summary: m[2] ?? '' };
}

export interface PlanView {
  /** "Sale prices", when the text names the node. */
  node?: string;
  revised: boolean;
  /** One line per part: "api owns `prices.ts`". */
  owners: string[];
  contracts: string[];
}

/** Takes a plan card's `Approve the plan for <node>: <owner>; <owner>. Contracts: <c> | <c>` apart; `undefined` when it isn't that shape. */
export function planView(item: InboxItem): PlanView | undefined {
  if (item.kind !== 'plan_approve') return undefined;
  const m =
    /^Approve (the plan|the revised plan \(approved v\d+\)) for ([^\n]+?): ([\s\S]*?)(?:\. Contracts: ([\s\S]*))?$/.exec(
      fullText(item),
    );
  if (!m) return undefined;
  const owners = (m[3] ?? '')
    .split('; ')
    .map((o) => o.trim())
    .filter((o) => o !== '' && o !== 'no owners');
  const contracts = (m[4] ?? '')
    .split(' | ')
    .map((c) => c.replace(/\s+/g, ' ').trim())
    .filter((c) => c !== '');
  return { node: m[2], revised: m[1] !== 'the plan', owners, contracts };
}

/** The daemon's stock lines for a stopped agent, in the UI's words (a node, not a stream). */
const STOCK_TEXT: Record<string, string> = {
  'worker finished — merge or close the stream':
    'The agent finished. Look over the changes, then merge — or close the node if you won’t.',
  blocked: 'The agent is stuck and needs a hand. Open the node to see where it stopped.',
};

/** A `done` or `blocked` card's text: the agent's last progress line, or the stock line in words. */
export function statusText(item: InboxItem): string {
  const text = fullText(item);
  return STOCK_TEXT[text] ?? text;
}

// ---------------------------------------------------------------- filter

export type NeedsMeFilter = 'all' | 'questions' | 'decisions' | 'merges';

/** Questions (and a blocked agent) want your words; merges want a Merge; the rest are decisions. */
export function filterOf(item: InboxItem): Exclude<NeedsMeFilter, 'all'> {
  if (item.kind === 'question' || item.kind === 'blocked') return 'questions';
  if (item.kind === 'done' || isLandGate(item)) return 'merges';
  return 'decisions';
}

export function filterCounts(items: readonly InboxItem[]): Record<NeedsMeFilter, number> {
  const counts: Record<NeedsMeFilter, number> = {
    all: items.length,
    questions: 0,
    decisions: 0,
    merges: 0,
  };
  for (const item of items) counts[filterOf(item)]++;
  return counts;
}

export function applyFilter(items: readonly InboxItem[], filter: NeedsMeFilter): InboxItem[] {
  return filter === 'all' ? [...items] : items.filter((item) => filterOf(item) === filter);
}

// ---------------------------------------------------------------- grouping

export interface NeedsMeGroup {
  /** The node's id; `''` for knowledge that belongs to no node. */
  key: string;
  /** The node's path inside its section, root→leaf (the project root is the section heading). */
  path: string[];
  items: InboxItem[];
}

export interface NeedsMeSection {
  /** `project:<id>`, `none` (nodes in no project) or `knowledge` (no node). */
  key: string;
  kind: 'project' | 'none' | 'knowledge';
  project?: string;
  label: string;
  groups: NeedsMeGroup[];
  count: number;
}

function oldest(items: readonly InboxItem[]): string {
  return items.reduce((min, item) => (item.ts < min ? item.ts : min), items[0]?.ts ?? '');
}

/**
 * T364: Needs me grouped by project, then by node — each level, and each
 * node's items, oldest first (§3.3). Knowledge that belongs to no node is
 * its own section; nodes in no project are another.
 */
export function groupNeedsMe(
  items: readonly InboxItem[],
  rows: readonly Pick<CockpitStreamRow, 'id' | 'project'>[],
  projects: readonly Pick<CockpitProjectRow, 'id' | 'name' | 'root'>[],
): NeedsMeSection[] {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const sections = new Map<string, NeedsMeSection & { byNode: Map<string, NeedsMeGroup> }>();

  for (const item of items) {
    const projectId = item.stream !== undefined ? rowById.get(item.stream)?.project : undefined;
    const project = projectId !== undefined ? projectById.get(projectId) : undefined;
    const key =
      item.stream === undefined ? 'knowledge' : project ? `project:${project.id}` : 'none';
    let section = sections.get(key);
    if (!section) {
      section = {
        key,
        kind: item.stream === undefined ? 'knowledge' : project ? 'project' : 'none',
        ...(project ? { project: project.id } : {}),
        label:
          item.stream === undefined ? 'Knowledge' : project ? project.name : 'Not in a project',
        groups: [],
        count: 0,
        byNode: new Map(),
      };
      sections.set(key, section);
    }
    const node = item.stream ?? '';
    let group = section.byNode.get(node);
    if (!group) {
      // Inside a project, the root is the section heading; its nodes read from below it.
      const path =
        project && item.stream !== project.root && item.stream_path.length > 1
          ? item.stream_path.slice(1)
          : item.stream_path;
      group = { key: node, path: path.length > 0 ? path : ['Knowledge'], items: [] };
      section.byNode.set(node, group);
      section.groups.push(group);
    }
    group.items.push(item);
    section.count++;
  }

  const byTs = (a: InboxItem, b: InboxItem) =>
    a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts < b.ts ? -1 : 1;
  return [...sections.values()]
    .map(({ byNode: _, ...section }) => {
      for (const group of section.groups) group.items.sort(byTs);
      section.groups.sort((a, b) => (oldest(a.items) < oldest(b.items) ? -1 : 1));
      return section;
    })
    .sort((a, b) => {
      const ta = oldest(a.groups.flatMap((g) => g.items));
      const tb = oldest(b.groups.flatMap((g) => g.items));
      return ta === tb ? a.key.localeCompare(b.key) : ta < tb ? -1 : 1;
    });
}

// ---------------------------------------------------------------- first run

export type SetupStepId = 'repo' | 'project' | 'node';

export interface SetupStep {
  id: SetupStepId;
  done: boolean;
  count: number;
}

/**
 * T364: the three steps to a working cockpit — a repository, a project, a
 * node — and whether each is done. A project's root is not a node you
 * started, so it doesn't count as one.
 */
export function setupSteps(
  cockpit: Pick<CockpitFrame, 'repos' | 'projects' | 'streams'> | undefined,
): SetupStep[] {
  const repos = cockpit?.repos.length ?? 0;
  const projects = cockpit?.projects.length ?? 0;
  const nodes = (cockpit?.streams ?? []).filter((row) => row.role !== 'project').length;
  return [
    { id: 'repo', done: repos > 0, count: repos },
    { id: 'project', done: projects > 0, count: projects },
    { id: 'node', done: nodes > 0, count: nodes },
  ];
}

/** First run: no repository, or no project, yet (the setup steps show instead of "all caught up"). */
export function isFirstRun(steps: readonly SetupStep[]): boolean {
  return steps.some((step) => (step.id === 'repo' || step.id === 'project') && !step.done);
}
