/**
 * The Knowledge screen's pure half (cockpit design §5, §9; T163, T366):
 * the filter, the sections it is split into, every enforcement / scope /
 * source / pattern in words, and turning the edit form into a patch.
 * Plain `bun test`, no DOM.
 *
 * T366: knowledge is more than rules. An item has a kind (standard,
 * architecture, decision), a status (proposed → accepted, or retired) and
 * an enforcement (guidance, reviewer checklist, checked on every action,
 * checked before merge). A "rule" is an *enforced* item (action or ship),
 * whatever its kind; the rest is what agents are told, by kind.
 */

import {
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  type KnowledgeCheck,
  type KnowledgeKind,
  type KnowledgeSource,
  RULE_EXAMPLES_MAX,
  type KnowledgeItem as Rule,
  type KnowledgeCreateInput as RuleCreateInput,
  type RuleCriteria,
  type KnowledgeEnforcement as RuleEnforcement,
  type RuleExample,
  type KnowledgePatch as RulePatch,
  type RulePattern,
  type RulePatternKind,
  type KnowledgeScope as RuleScope,
  type KnowledgeStatus as RuleStatus,
  classifierCheckOf,
  examplesOf,
  formatKnowledgeScope as formatRuleScope,
  patternOf as itemPattern,
  parseKnowledgeScope as parseRuleScope,
  rulePatternArgs,
  rulePatternFromArgs,
} from '@agile-agents/shared';
import type { CockpitFrame, RuleEvalReport, RuleReportRow } from './feed-types';

// ---------------------------------------------------------------- sections

/** T366: what an accepted item is, for the screen: an enforced rule, or guidance of one kind. */
export type KnowledgeCategory = 'rules' | KnowledgeKind;

/** The screen's sections, in the order they are shown. */
export type KnowledgeSectionId = 'review' | KnowledgeCategory | 'retired';

/** The screen's tabs: everything, the proposals, or one category. */
export type KnowledgeTab = 'all' | 'review' | KnowledgeCategory;

export const KNOWLEDGE_CATEGORIES: readonly KnowledgeCategory[] = [
  'rules',
  'standard',
  'architecture',
  'decision',
];

export const KNOWLEDGE_TABS: readonly KnowledgeTab[] = ['all', 'review', ...KNOWLEDGE_CATEGORIES];

export const SECTION_ORDER: readonly KnowledgeSectionId[] = [
  'review',
  ...KNOWLEDGE_CATEGORIES,
  'retired',
];

export const SECTION_INFO: Record<KnowledgeSectionId, { label: string; hint: string }> = {
  review: {
    label: 'To review',
    hint: 'Proposed by an agent or by you. Nothing applies until you accept it.',
  },
  rules: {
    label: 'Rules',
    hint: 'Checked automatically: before each action, or on the diff before a merge.',
  },
  standard: { label: 'Standards', hint: 'How we work. Agents are told these in their brief.' },
  architecture: {
    label: 'Architecture',
    hint: 'What exists and where. Agents are told these in their brief.',
  },
  decision: {
    label: 'Decisions',
    hint: 'Choices made, and why. Agents are told these in their brief.',
  },
  retired: {
    label: 'Retired',
    hint: 'No longer applied; kept for the record. Accept one to bring it back.',
  },
};

export const TAB_LABEL: Record<KnowledgeTab, string> = {
  all: 'All',
  review: 'To review',
  rules: 'Rules',
  standard: 'Standards',
  architecture: 'Architecture',
  decision: 'Decisions',
};

export const KIND_LABEL: Record<KnowledgeKind, string> = {
  standard: 'Standard',
  architecture: 'Architecture',
  decision: 'Decision',
};

export const KIND_HINT: Record<KnowledgeKind, string> = {
  standard: 'How we work',
  architecture: 'What exists and where',
  decision: 'A choice made, and why',
};

export const STATUS_LABEL: Record<RuleStatus, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  retired: 'Retired',
};

/** An item a hook or the ship check enforces: what the user calls a "rule". */
export function isEnforced(item: Pick<Rule, 'enforcement'>): boolean {
  return item.enforcement === 'action' || item.enforcement === 'ship';
}

/** Rules (enforced, whatever the kind), else the item's kind. */
export function categoryOf(item: Pick<Rule, 'enforcement' | 'kind'>): KnowledgeCategory {
  return isEnforced(item) ? 'rules' : item.kind;
}

/** Proposed items are to review, retired ones retired; accepted ones by category. */
export function sectionOf(item: Pick<Rule, 'status' | 'enforcement' | 'kind'>): KnowledgeSectionId {
  if (item.status === 'proposed') return 'review';
  if (item.status === 'retired') return 'retired';
  return categoryOf(item);
}

export interface KnowledgeSection {
  id: KnowledgeSectionId;
  items: Rule[];
}

/**
 * The sections a tab shows, in order, each with its items (kept in the
 * order given). `all`: every section. `review`: the proposals alone. A
 * category: its proposals, its accepted items, and its retired ones.
 * Empty sections are kept; the screen decides what an empty one shows.
 */
export function sectionsFor(items: readonly Rule[], tab: KnowledgeTab): KnowledgeSection[] {
  const inTab = (item: Rule): boolean =>
    tab === 'all' || (tab === 'review' ? item.status === 'proposed' : categoryOf(item) === tab);
  const ids: readonly KnowledgeSectionId[] =
    tab === 'all' ? SECTION_ORDER : tab === 'review' ? ['review'] : ['review', tab, 'retired'];
  return ids.map((id) => ({
    id,
    items: items.filter((item) => inTab(item) && sectionOf(item) === id),
  }));
}

/** Each tab's count: proposals for To review; accepted items for All and a category. */
export function tabCounts(items: readonly Rule[]): Record<KnowledgeTab, number> {
  const counts: Record<KnowledgeTab, number> = {
    all: 0,
    review: 0,
    rules: 0,
    standard: 0,
    architecture: 0,
    decision: 0,
  };
  for (const item of items) {
    if (item.status === 'proposed') counts.review += 1;
    if (item.status !== 'accepted') continue;
    counts.all += 1;
    counts[categoryOf(item)] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------- the filter

/**
 * What the Knowledge screen shows. Kept in the shell so the inbox's batch
 * card (`source`, with `status: 'proposed'`) and a "blocked by rule" line
 * on a node (`rule`) can open the screen narrowed.
 */
export interface RulesFilter {
  /** `proposed` opens To review; `retired` opens with the retired items shown. */
  status: RuleStatus | 'all';
  /** T366: the tab; absent, it follows `status`. */
  tab?: KnowledgeTab;
  /** T266: tell · review · action · ship, or `all`. */
  enforcement?: RuleEnforcement | 'all';
  /** A `formatRuleScope` value, or `all`. */
  scope: string;
  /** A `source.by`: the inbox's batch card sets it. */
  source?: string;
  /** T169: one item by id — a "blocked by rule" card on a node opens the screen on it. */
  rule?: string;
  /** T366: words to find in the name or text. */
  query?: string;
}

export const DEFAULT_RULES_FILTER: RulesFilter = { status: 'all', scope: 'all' };

/** The tab a filter opens on. */
export function tabOf(filter: RulesFilter): KnowledgeTab {
  if (filter.tab !== undefined) return filter.tab;
  return filter.status === 'proposed' ? 'review' : 'all';
}

/** Lower-case words of the query, every one of which must appear in the name or text. */
function matchesQuery(item: Rule, query: string | undefined): boolean {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${item.name ?? ''} ${item.text}`.toLowerCase();
  return words.every((word) => hay.includes(word));
}

/**
 * Everything but the tab: one item (`rule`, which overrides the rest), or
 * source, scope, enforcement and the text query. The tab and status split
 * what is left into sections (`sectionsFor`).
 */
export function filterRules(rules: readonly Rule[], filter: RulesFilter): Rule[] {
  if (filter.rule !== undefined) return rules.filter((rule) => rule.id === filter.rule);
  return rules.filter(
    (rule) =>
      (filter.enforcement === undefined ||
        filter.enforcement === 'all' ||
        rule.enforcement === filter.enforcement) &&
      (filter.scope === 'all' || formatRuleScope(rule.scope) === filter.scope) &&
      (filter.source === undefined || rule.source.by === filter.source) &&
      matchesQuery(rule, filter.query),
  );
}

/** True when anything narrows the list beyond the tab. */
export function isNarrowed(filter: RulesFilter): boolean {
  return (
    filter.rule !== undefined ||
    filter.source !== undefined ||
    (filter.scope !== 'all' && filter.scope !== '') ||
    (filter.enforcement !== undefined && filter.enforcement !== 'all') ||
    (filter.query ?? '').trim() !== ''
  );
}

/** Every scope the items name, for the scope filter. */
export function ruleScopes(rules: readonly Rule[]): string[] {
  return [...new Set(rules.map((rule) => formatRuleScope(rule.scope)))].sort();
}

/** §5.7's two pruning orders beside the report's own (flagged first, then most fired). */
export type RulesSort = 'report' | 'routed';

/**
 * The report's order (flagged first, then fired), or "most routed" — the
 * rules the human keeps being asked about, which are the ones whose wording
 * most needs work (D14). Rules the report does not know sort last.
 */
export function sortRules(
  rules: readonly Rule[],
  rows: readonly RuleReportRow[],
  sort: RulesSort,
): Rule[] {
  const rank = new Map(rows.map((row, index) => [row.id, index]));
  const byReport = (a: Rule, b: Rule): number =>
    (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER);
  return [...rules].sort((a, b) =>
    sort === 'routed' ? b.stats.routed - a.stats.routed || byReport(a, b) : byReport(a, b),
  );
}

// ---------------------------------------------------------------- words

export interface EnforcementInfo {
  /** The badge: "Checked on every action". */
  label: string;
  /** One sentence on what happens. */
  hint: string;
}

export const ENFORCEMENT_INFO: Record<RuleEnforcement, EnforcementInfo> = {
  tell: { label: 'Guidance', hint: 'Agents are told this in their brief. Nothing checks it.' },
  review: {
    label: 'Reviewer checklist',
    hint: "On the reviewer agent's checklist before the work ships.",
  },
  action: {
    label: 'Checked on every action',
    hint: 'A hook checks each command and edit before it runs. A violation is blocked.',
  },
  ship: {
    label: 'Checked before merge',
    hint: 'The classifier reads the diff before a merge or pull request. A violation holds it.',
  },
};

/** The order the editor offers them in: weakest to strongest. */
export const ENFORCEMENT_ORDER: readonly RuleEnforcement[] = ['tell', 'review', 'action', 'ship'];

/** "Checked on every action", and how: "with a pattern" / "by the classifier". */
export function checkWords(item: Pick<Rule, 'check'>): string | undefined {
  if (item.check === undefined) return undefined;
  return item.check.by === 'pattern' ? 'with a fixed pattern' : 'by the classifier';
}

/** Names the screen shows instead of ids. */
export type KnowledgeNames = Pick<CockpitFrame, 'projects' | 'streams'> | undefined;

function projectName(names: KnowledgeNames, id: string): string | undefined {
  return names?.projects.find((p) => p.id === id)?.name;
}

function nodeTitle(names: KnowledgeNames, id: string): string | undefined {
  return names?.streams.find((s) => s.id === id)?.title;
}

/** "Everywhere" · "Repo ledger-lite" · "Project Shop" · "“Checkout” and below". */
export function scopeWords(scope: RuleScope, names: KnowledgeNames): string {
  switch (scope.kind) {
    case 'global':
      return 'Everywhere';
    case 'repo':
      return `Repo ${scope.repo}`;
    case 'project': {
      const name = projectName(names, scope.project);
      return name === undefined ? 'A project' : `Project ${name}`;
    }
    case 'subtree': {
      const title = nodeTitle(names, scope.node);
      return title === undefined ? 'A node and below' : `“${title}” and below`;
    }
  }
}

/** One sentence on where an item applies, for the detail panel. */
export function scopeHint(scope: RuleScope): string {
  switch (scope.kind) {
    case 'global':
      return 'Every node in every project.';
    case 'repo':
      return 'Every node that works in this repo.';
    case 'project':
      return 'Every node in this project.';
    case 'subtree':
      return 'This node and every node under it.';
  }
}

/** Who proposed it, in words. */
export function sourceWords(source: KnowledgeSource, names: KnowledgeNames): string {
  const node = source.node === undefined ? undefined : nodeTitle(names, source.node);
  switch (source.by) {
    case 'human':
      return 'Added by you';
    case 'agent':
      return node === undefined ? 'Proposed by an agent' : `Proposed by the agent on “${node}”`;
    case 'lessons':
      return node === undefined
        ? 'Proposed by the lessons pass after a merge'
        : `Proposed by the lessons pass after “${node}” merged`;
    case 'director':
      return 'Proposed by the Director';
    case 'migration':
      return 'Imported from the old rules';
    case 'builtin':
      return 'Built in';
  }
}

/** The chip a source filter shows: "Showing items agents proposed". */
export function sourceFilterWords(by: string): string {
  switch (by) {
    case 'human':
      return 'Showing items you added';
    case 'agent':
      return 'Showing items agents proposed';
    case 'lessons':
      return 'Showing items from the lessons pass';
    case 'director':
      return 'Showing items the Director proposed';
    case 'migration':
      return 'Showing items imported from the old rules';
    case 'builtin':
      return 'Showing built-in items';
    default:
      return `Showing items from ${by}`;
  }
}

/**
 * A finding without design-doc references: "cockpit design §5.4, D8: the
 * one action…" reads "the one action…" (design/cockpit-ui.md §1.2).
 */
export function plainFinding(text: string): string {
  const cleaned = text
    .replace(/\b(cockpit|projects)[- ]design\s*§[\d.]+,?\s*/gi, '')
    .replace(/§[\d.]+,?\s*/g, '')
    .replace(/\bD\d+(,\s*D\d+)*:\s*/g, '')
    .trim();
  return cleaned.length > 0 ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : cleaned;
}

/** A pattern check in words: a lead-in and the values it matches (shown as code). */
export function patternWords(pattern: RulePattern): { lead: string; args: string[] } {
  switch (pattern.kind) {
    case 'no_push':
      return { lead: 'Blocks every git push.', args: [] };
    case 'no_push_protected':
      return {
        lead: 'Blocks pushing to, or merging into, a protected branch (main and master unless the repo says otherwise).',
        args: [],
      };
    case 'path_deny':
      return pattern.args.globs.length === 0
        ? { lead: "Blocks writes outside the node's own worktree.", args: [] }
        : {
            lead: "Blocks writes outside the node's own worktree, and to paths matching",
            args: [...pattern.args.globs],
          };
    case 'command_deny':
      return { lead: 'Blocks commands matching', args: [...pattern.args.patterns] };
  }
}

/** `patternWords` as one line: `Blocks commands matching "rm -rf", "git reset --hard"`. */
export function patternSentence(pattern: RulePattern): string {
  const { lead, args } = patternWords(pattern);
  return args.length === 0 ? lead : `${lead} ${args.map((a) => JSON.stringify(a)).join(', ')}`;
}

/** The pattern kinds, as the editor offers them. */
export const PATTERN_KIND_LABEL: Record<RulePatternKind, string> = {
  command_deny: 'Block commands',
  path_deny: 'Block writes to paths',
  no_push_protected: 'Block pushes to protected branches',
  no_push: 'Block every git push',
};

/** A classifier band in words: what the check did with the example. */
export function bandWords(band: 'allow' | 'route' | 'deny' | undefined): string {
  if (band === 'deny') return 'Block';
  if (band === 'route') return 'Ask you';
  if (band === 'allow') return 'Allow';
  return 'No answer';
}

/** "2 of 3 examples agree", plus errors. */
export function evalSummary(report: Pick<RuleEvalReport, 'agreed' | 'total' | 'errors'>): string {
  const base = `${report.agreed} of ${report.total} example${report.total === 1 ? '' : 's'} agree`;
  return report.errors > 0
    ? `${base} · ${report.errors} error${report.errors === 1 ? '' : 's'}`
    : base;
}

/** §5.7's pruning flag as advice. */
export function flagWords(flag: RuleReportRow['flag'], days: number): string | undefined {
  switch (flag) {
    case 'never fired':
      return `Never fired in ${days} days: it may no longer be needed.`;
    case 'never violated':
      return 'Fires often but has never caught anything: it may be dead weight.';
    case 'routes often':
      return 'Often unsure and asks you: its wording may need work.';
    default:
      return undefined;
  }
}

/** "412 checks · 3 violations", or "Not fired yet" — the quiet counters on a row. */
export function statsWords(stats: Rule['stats']): string {
  const plural = (n: number, one: string, many: string): string =>
    `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  if (stats.fired === 0) return 'Not fired yet';
  return `${plural(stats.fired, 'check', 'checks')} · ${plural(stats.violated, 'violation', 'violations')}`;
}

/** Markdown to one plain line: code ticks, emphasis, headings and links dropped. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A row's title: the item's name, else its text's first sentence. */
export function titleOf(item: Pick<Rule, 'name' | 'text'>): string {
  if (item.name !== undefined && item.name.trim() !== '') return item.name;
  const text = plainText(item.text);
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
  return sentence.length > 120 ? `${sentence.slice(0, 117).trimEnd()}…` : sentence;
}

/** The row's second half: the text when the title is a name, else what follows the first sentence. */
export function summaryOf(item: Pick<Rule, 'name' | 'text'>): string {
  const text = plainText(item.text);
  if (item.name !== undefined && item.name.trim() !== '') return text;
  const title = titleOf(item);
  return title.endsWith('…') ? '' : text.slice(title.length).trim();
}

/**
 * Why an item cannot be accepted yet, in words, or `undefined`. The store
 * refuses a classifier check with fewer than two examples (§5.6); saying so
 * before the click beats a refusal after it.
 */
export function acceptBlocker(item: Pick<Rule, 'check' | 'status'>): string | undefined {
  if (item.status === 'accepted') return undefined;
  const classifier = classifierCheckOf(item);
  if (classifier === undefined) return undefined;
  const missing = 2 - classifier.examples.length;
  if (missing <= 0) return undefined;
  return `Add ${missing === 2 ? 'two examples' : 'one more example'} before accepting: one that breaks the rule and one that doesn't.`;
}

/**
 * A daemon refusal without its record prefix and design references:
 * "invalid KnowledgeItem K-…: a classifier check needs … (§5.6); it has 1"
 * reads "A classifier check needs …; it has 1".
 */
export function plainError(message: string): string {
  const cleaned = message
    .replace(/^invalid Knowledge\w*( K-[0-9A-Za-z]+)?( write)?:\s*/, '')
    .replace(/\s*\((§[\d.]+|D\d+|human-only, D\d+)\)/g, '')
    .trim();
  return cleaned.length > 0 ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : message;
}

// ---------------------------------------------------------------- the editor

/** The edit form's fields, as typed. */
export interface RuleDraft {
  /** T338: the item's short name (≤ 64); empty leaves it unnamed (or unchanged on an edit). */
  name: string;
  text: string;
  /** T260: standard · architecture · decision. */
  kind: KnowledgeKind;
  enforcement: RuleEnforcement;
  /** T366: how an `action` item is checked; a `ship` item is always the classifier. */
  checkBy: 'pattern' | 'classifier';
  /** T167: the pattern's kind (read only when `checkBy` is `pattern`). */
  patternKind: RulePatternKind;
  /** T167: its arguments, one per line (globs for `path_deny`, tokens for `command_deny`). */
  patternArgs: string;
  question: string;
  criteriaTrue: string;
  criteriaFalse: string;
  examples: RuleExample[];
  /** T266: the item's path globs, one per line; empty means all paths. */
  paths: string;
  /** `global` · `repo:<name>` · `project:<id>` · `subtree:<id>`. */
  scope: string;
  critical: boolean;
}

export function draftOf(rule: Rule): RuleDraft {
  const classifier = classifierCheckOf(rule);
  const pattern = itemPattern(rule);
  return {
    name: rule.name ?? '',
    text: rule.text,
    kind: rule.kind,
    enforcement: rule.enforcement,
    checkBy: pattern !== undefined ? 'pattern' : 'classifier',
    patternKind: pattern?.kind ?? 'command_deny',
    patternArgs: pattern ? rulePatternArgs(pattern).join('\n') : '',
    question: classifier?.question ?? '',
    criteriaTrue: classifier?.criteria?.true ?? '',
    criteriaFalse: classifier?.criteria?.false ?? '',
    examples: examplesOf(rule).map((example) => ({ ...example })),
    paths: (rule.paths ?? []).join('\n'),
    scope: formatRuleScope(rule.scope),
    critical: rule.critical,
  };
}

/** T167: the "Add knowledge" form's starting point. */
export function emptyDraft(): RuleDraft {
  return {
    name: '',
    text: '',
    kind: 'standard',
    enforcement: 'tell',
    checkBy: 'classifier',
    patternKind: 'command_deny',
    patternArgs: '',
    question: '',
    criteriaTrue: '',
    criteriaFalse: '',
    examples: [],
    paths: '',
    scope: 'global',
    critical: false,
  };
}

/** Which of the editor's check fields apply to a draft. */
export function draftCheck(draft: Pick<RuleDraft, 'enforcement' | 'checkBy'>): {
  checked: boolean;
  pattern: boolean;
  classifier: boolean;
} {
  const checked = draft.enforcement === 'action' || draft.enforcement === 'ship';
  const pattern = draft.enforcement === 'action' && draft.checkBy === 'pattern';
  return { checked, pattern, classifier: checked && !pattern };
}

/** How many more examples a classifier draft needs before it can be accepted (0 when enough). */
export function examplesShort(draft: RuleDraft): number {
  if (!draftCheck(draft).classifier) return 0;
  const filled = draft.examples.filter((e) => e.action.trim().length > 0).length;
  return Math.max(0, 2 - filled);
}

/**
 * The patch `rule.update` gets, or the reason there is none. An empty
 * question or pair of criteria is left out (the patch cannot clear a field),
 * and criteria are both-or-neither, as the schema requires. `before` is
 * the item being edited: scope and criticality are sent only when changed
 * (a scope whose node has gone would otherwise refuse an unrelated edit).
 */
export function patchOf(draft: RuleDraft, before?: Rule): { patch: RulePatch } | { error: string } {
  const text = draft.text.trim();
  if (text.length === 0) return { error: 'Write what agents should know: the text is empty.' };
  const question = draft.question.trim();
  const whenTrue = draft.criteriaTrue.trim();
  const whenFalse = draft.criteriaFalse.trim();
  const how = draftCheck(draft);
  if (how.classifier && (whenTrue.length === 0) !== (whenFalse.length === 0)) {
    return { error: 'Criteria need both halves: what yes means and what no means.' };
  }
  const examples = draft.examples
    .map((example) => ({ action: example.action.trim(), violates: example.violates }))
    .filter((example) => example.action.length > 0);
  if (examples.length > RULE_EXAMPLES_MAX) {
    return { error: `An item carries at most ${RULE_EXAMPLES_MAX} examples.` };
  }
  let pattern: RulePattern | undefined;
  if (how.pattern) {
    try {
      pattern = rulePatternFromArgs(draft.patternKind, draft.patternArgs.split('\n'));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    // A command check with nothing to match checks nothing.
    if (pattern.kind === 'command_deny' && pattern.args.patterns.length === 0) {
      return { error: 'List at least one command to block, one per line.' };
    }
  }
  const criteria: RuleCriteria | undefined =
    whenTrue.length > 0 ? { true: whenTrue, false: whenFalse } : undefined;
  // §14.3: `action`/`ship` carry a check (the pattern, else a classifier
  // question with its examples); `tell`/`review` carry none.
  const check: KnowledgeCheck | undefined = !how.checked
    ? undefined
    : pattern
      ? { by: 'pattern', pattern }
      : {
          by: 'classifier',
          ...(question.length > 0 ? { question } : {}),
          ...(criteria ? { criteria } : {}),
          examples,
        };
  const paths = draft.paths
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const name = draft.name.trim();
  let scope: RuleScope | undefined;
  if (before === undefined || formatRuleScope(before.scope) !== draft.scope) {
    try {
      scope = parseRuleScope(draft.scope);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  // Critical is the fail policy of a check (§6.4); it is only offered, and
  // only sent, for an enforced item.
  const critical = how.checked ? draft.critical : undefined;
  const criticalChanged =
    critical !== undefined && (before === undefined ? critical : critical !== before.critical);
  return {
    patch: {
      ...(name.length > 0 ? { name } : {}),
      text,
      kind: draft.kind,
      paths,
      enforcement: draft.enforcement,
      ...(check ? { check } : {}),
      ...(scope ? { scope } : {}),
      ...(criticalChanged ? { critical } : {}),
    },
  };
}

/** T167: the "Add knowledge" form's `POST /api/rules` body — the patch with its scope. */
export function createOf(draft: RuleDraft): { input: RuleCreateInput } | { error: string } {
  const built = patchOf(draft);
  if ('error' in built) return built;
  const { text, scope, ...rest } = built.patch;
  return {
    input: {
      ...rest,
      text: text ?? draft.text.trim(),
      scope: scope ?? { kind: 'global' },
    },
  };
}

/** T338: one choice of the scope picker: the wire spelling and what it reads as. */
export interface ScopeChoice {
  value: string;
  label: string;
}

/** T338: every scope an item can take, named: everywhere, each repo, each project, each node. */
export function scopeChoices(
  cockpit: Pick<CockpitFrame, 'streams' | 'projects' | 'repos'> | undefined,
): ScopeChoice[] {
  return [
    { value: 'global', label: 'Everywhere' },
    ...(cockpit?.repos ?? []).map((r) => ({ value: `repo:${r.name}`, label: `Repo: ${r.name}` })),
    ...(cockpit?.projects ?? []).map((p) => ({
      value: `project:${p.id}`,
      label: `Project: ${p.name}`,
    })),
    ...(cockpit?.streams ?? []).map((s) => ({
      value: `subtree:${s.id}`,
      label: `Node and below: ${s.title}`,
    })),
  ];
}

/**
 * How long "Test examples" waits: one classifier call per example (T155),
 * each up to the classifier's timeout, plus slack for the round trip.
 */
export function evalDeadlineMs(examples: number, timeoutMs?: number): number {
  return Math.max(1, examples) * (timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS) + 10_000;
}

/** T169: "2026-09-23 14:02" (UTC) — the date alone hid whether a rule fired a minute or a day ago. */
export function formatFiredAt(iso: string): string {
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso;
}
