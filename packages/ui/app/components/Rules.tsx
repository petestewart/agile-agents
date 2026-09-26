/**
 * The Knowledge screen (T163, T266; T366 redesign; cockpit design §5, §9).
 *
 * Knowledge is what agents know and must follow: **rules** (items a hook
 * or the ship check enforces), **standards**, **architecture** notes and
 * **decisions** (items agents are told). Agents propose; the human accepts.
 * The screen says so under its title and separates the content:
 *
 *  - Tabs: All · To review · Rules · Standards · Architecture · Decisions.
 *    "To review" (the proposals) comes first, with Accept / Retire per row
 *    and on a selection; retired items fold at the bottom of a list.
 *  - Search, scope and enforcement narrow any tab. The inbox's batch card
 *    opens the screen on a source, a node's "blocked by rule" line on one
 *    item; both show as a chip with Clear.
 *  - Rows, not cards: what it says, where it applies, how it is enforced,
 *    and a rule's counters (§5.7's pruning flag as a quiet warning).
 *  - A click opens the side panel (`KnowledgeDetail`): the full text, the
 *    check, examples and "Test examples", the source, the stats, Accept /
 *    Retire / Edit. Edit and "Add knowledge" use the same form there
 *    (`KnowledgeEditor`).
 *
 * Every write reaches the same `KnowledgeService` the CLI's `agile rules` does.
 */

import {
  KNOWLEDGE_ENFORCEMENTS,
  type KnowledgeEnforcement,
  type KnowledgeItem,
  parseKnowledgeScope,
} from '@agile-agents/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRule, decideRule, getRules, updateRule } from '../lib/api';
import { useFeed } from '../lib/feed-context';
import type { RuleReportRow, RulesPayload } from '../lib/feed-types';
import {
  ENFORCEMENT_INFO,
  KNOWLEDGE_TABS,
  type KnowledgeSectionId,
  type KnowledgeTab,
  type RuleDraft,
  type RulesSort,
  SECTION_INFO,
  TAB_LABEL,
  acceptBlocker,
  createOf,
  draftOf,
  emptyDraft,
  filterRules,
  isNarrowed,
  patchOf,
  plainError,
  ruleScopes,
  scopeWords,
  sectionsFor,
  sortRules,
  sourceFilterWords,
  tabCounts,
  tabOf,
  titleOf,
} from '../lib/rules';
import { useShell } from '../lib/shell';
import { Icon } from './Icon';
import { KnowledgeDetail } from './KnowledgeDetail';
import { KnowledgeEditor } from './KnowledgeEditor';
import { KnowledgeSectionView, KnowledgeSkeleton, SECTION_ICON } from './KnowledgeList';
import { Button, EmptyState, IconButton, Menu, PageHeader, Tabs, useToast } from './ui';

type Panel =
  | { mode: 'view'; id: string }
  | { mode: 'edit'; id: string }
  | { mode: 'create'; draft: RuleDraft };

function message(err: unknown): string {
  return plainError(err instanceof Error ? err.message : String(err));
}

/** "Add knowledge" starts from what the tab is about. */
function draftForTab(tab: KnowledgeTab): RuleDraft {
  const draft = emptyDraft();
  if (tab === 'rules') return { ...draft, enforcement: 'action' };
  if (tab === 'standard' || tab === 'architecture' || tab === 'decision') {
    return { ...draft, kind: tab };
  }
  return draft;
}

const EMPTY_TEXT: Record<KnowledgeSectionId, { title: string; body: string }> = {
  review: {
    title: 'Nothing to review',
    body: 'Agents propose knowledge as they work, and the lessons pass proposes more after a merge. Proposals wait here for you.',
  },
  rules: {
    title: 'No rules yet',
    body: 'A rule is checked automatically: a hook checks each action, or the classifier reads the diff before a merge. For example: "never git reset --hard".',
  },
  standard: {
    title: 'No standards yet',
    body: 'A standard is how you work, told to every agent in scope. For example: "use the repo\'s own scripts for lint and tests".',
  },
  architecture: {
    title: 'No architecture notes yet',
    body: 'Architecture notes say what exists and where, so agents do not rediscover it. For example: "the daemon is the only writer of the home".',
  },
  decision: {
    title: 'No decisions yet',
    body: 'A decision records a choice and its reason. For example: "money is stored as integer cents".',
  },
  retired: { title: 'Nothing retired', body: '' },
};

const ADD_LABEL: Record<KnowledgeSectionId, string> = {
  review: 'Add knowledge',
  rules: 'Add a rule',
  standard: 'Add a standard',
  architecture: 'Add an architecture note',
  decision: 'Add a decision',
  retired: 'Add knowledge',
};

export function Rules(): JSX.Element {
  const { rulesFilter: filter, setRulesFilter: setFilter } = useShell();
  const { onEvent, cockpit } = useFeed();
  const toast = useToast();
  const [data, setData] = useState<RulesPayload | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [sort, setSort] = useState<RulesSort>('report');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const [panel, setPanel] = useState<Panel | undefined>(
    filter.rule !== undefined ? { mode: 'view', id: filter.rule } : undefined,
  );
  const [retiredOpen, setRetiredOpen] = useState(filter.status === 'retired');
  const panelRef = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  const load = useCallback(() => {
    getRules()
      .then((payload) => {
        setData(payload);
        setError(undefined);
      })
      .catch((err: unknown) => setError(message(err)));
  }, []);

  useEffect(load, []);
  // Any knowledge write — here, in the inbox, from the CLI or an agent's
  // `propose_knowledge` — re-reads the list (one read per batch of events).
  useEffect(
    () =>
      onEvent((event) => {
        // T167: a key saved or removed in Settings changes "Test examples".
        if (
          event.kind.startsWith('rule') ||
          event.kind.startsWith('knowledge') ||
          event.kind === 'home_config_put'
        ) {
          load();
        }
      }),
    [onEvent, load],
  );

  // A "blocked by rule" link opens the screen on that item, panel open.
  useEffect(() => {
    if (filter.rule !== undefined) {
      setPanel({ mode: 'view', id: filter.rule });
      setRetiredOpen(true);
    }
  }, [filter.rule]);

  const all = data?.rules ?? [];
  const rows = useMemo(
    () => new Map<string, RuleReportRow>((data?.report.rows ?? []).map((row) => [row.id, row])),
    [data],
  );
  const tab = filter.rule !== undefined ? 'all' : tabOf(filter);
  const narrowed = useMemo(
    () => sortRules(filterRules(all, filter), data?.report.rows ?? [], sort),
    [all, filter, data, sort],
  );
  const counts = useMemo(() => tabCounts(narrowed), [narrowed]);
  const sections = useMemo(() => sectionsFor(narrowed, tab), [narrowed, tab]);
  const scopes = useMemo(() => ruleScopes(all), [all]);
  const proposals = sections.find((s) => s.id === 'review')?.items ?? [];
  const picked = proposals.filter((item) => selected.has(item.id));
  const shownCount = sections.reduce(
    (n, s) =>
      n + (s.id === 'retired' && !retiredOpen && filter.rule === undefined ? 0 : s.items.length),
    0,
  );

  const openItem =
    panel && panel.mode !== 'create' ? all.find((i) => i.id === panel.id) : undefined;
  // The panel's item went away (another writer): close it.
  useEffect(() => {
    if (data && panel && panel.mode !== 'create' && openItem === undefined) setPanel(undefined);
  }, [data, panel, openItem]);

  const closePanel = useCallback(() => {
    setPanel(undefined);
    const back = opener.current;
    if (back && document.contains(back)) back.focus();
  }, []);

  // Esc closes the panel (the editor handles its own Esc first).
  useEffect(() => {
    if (panel === undefined || panel.mode !== 'view') return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('.cr-modal')) return;
      closePanel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [panel, closePanel]);

  const panelKey = panel === undefined ? '' : panel.mode === 'create' ? 'create' : panel.id;
  useEffect(() => {
    if (panelKey !== '') panelRef.current?.focus({ preventScroll: true });
  }, [panelKey]);

  const open = (id: string): void => {
    opener.current = document.activeElement as HTMLElement | null;
    setPanel((current) =>
      current?.mode === 'view' && current.id === id ? undefined : { mode: 'view', id },
    );
  };

  const setTab = (next: KnowledgeTab): void => {
    const { rule: _rule, ...rest } = filter;
    setFilter({ ...rest, status: 'all', tab: next });
    setSelected(new Set());
  };

  const clear = (key: 'source' | 'rule'): void => {
    const next = { ...filter };
    delete next[key];
    setFilter(next);
  };

  /** Shows a write at once; the re-read that follows confirms it. */
  const upsert = (item: KnowledgeItem): void =>
    setData((current) =>
      current === undefined
        ? current
        : {
            ...current,
            rules: current.rules.some((r) => r.id === item.id)
              ? current.rules.map((r) => (r.id === item.id ? item : r))
              : [...current.rules, item],
          },
    );

  async function decide(item: KnowledgeItem, decision: 'accept' | 'retire'): Promise<void> {
    try {
      await decideRule(item.id, decision);
      toast({
        tone: 'success',
        title: decision === 'accept' ? 'Accepted' : 'Retired',
        body: titleOf(item),
        duration: 3000,
      });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      load();
    } catch (err) {
      toast({
        tone: 'error',
        title: `Could not ${decision} “${titleOf(item)}”`,
        body: message(err),
      });
    }
  }

  async function bulk(decision: 'accept' | 'retire'): Promise<void> {
    setBusy(true);
    const failed: string[] = [];
    let done = 0;
    for (const item of picked) {
      const blocker = decision === 'accept' ? acceptBlocker(item) : undefined;
      if (blocker !== undefined) {
        failed.push(`${titleOf(item)}: ${blocker}`);
        continue;
      }
      try {
        await decideRule(item.id, decision);
        done += 1;
      } catch (err) {
        failed.push(`${titleOf(item)}: ${message(err)}`);
      }
    }
    setBulkErrors(failed);
    setSelected(new Set());
    setBusy(false);
    if (done > 0) {
      toast({
        tone: 'success',
        title: `${decision === 'accept' ? 'Accepted' : 'Retired'} ${done} item${done === 1 ? '' : 's'}`,
        duration: 3000,
      });
    }
    load();
  }

  const selection = {
    selected,
    busy,
    bulk: (decision: 'accept' | 'retire') => void bulk(decision),
    toggle: (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    setAll: (on: boolean) => setSelected(on ? new Set(proposals.map((i) => i.id)) : new Set()),
  };

  const days = data?.report.days ?? 14;
  const creating = panel?.mode === 'create';
  const oneItem = filter.rule !== undefined ? all.find((i) => i.id === filter.rule) : undefined;
  const narrowedByControls =
    (filter.query ?? '').trim() !== '' ||
    filter.scope !== 'all' ||
    (filter.enforcement !== undefined && filter.enforcement !== 'all');

  const visible = sections.filter((section) => {
    if (section.items.length > 0) return true;
    // A single category keeps its own (empty) section, to explain itself.
    return tab !== 'all' && tab !== 'review' && section.id === tab && !isNarrowed(filter);
  });

  return (
    <section className="cr-kn" data-testid="rules-screen" data-panel={panel ? 'open' : undefined}>
      <div className="cr-kn-main">
        <div className="cr-kn-col">
          <PageHeader
            title="Knowledge"
            icon="book-open"
            actions={
              <Button
                icon="plus"
                data-testid="rules-new"
                aria-expanded={creating}
                onClick={() => {
                  opener.current = document.activeElement as HTMLElement | null;
                  setPanel(creating ? undefined : { mode: 'create', draft: draftForTab(tab) });
                }}
              >
                Add knowledge
              </Button>
            }
          >
            <p className="cr-kn-lede">
              What your agents know and must follow. Agents propose; you accept.
            </p>
          </PageHeader>

          <div className="cr-kn-tabs" data-review={counts.review > 0 ? 'true' : undefined}>
            <Tabs
              label="Knowledge"
              value={tab}
              onChange={setTab}
              items={KNOWLEDGE_TABS.map((id) => ({
                id,
                label: TAB_LABEL[id],
                count: id === 'all' ? undefined : counts[id],
                testid: `rules-tab-${id}`,
                ...(id === 'all' ? {} : { icon: SECTION_ICON[id] }),
              }))}
            />
          </div>
          {tab !== 'all' && tab !== 'review' && (
            <p className="cr-kn-tab-hint">{SECTION_INFO[tab].hint}</p>
          )}

          <div className="cr-kn-toolbar">
            <label className="cr-kn-search">
              <Icon name="search" size={14} />
              <input
                type="search"
                data-testid="rules-search"
                aria-label="Search knowledge"
                placeholder="Search"
                value={filter.query ?? ''}
                onChange={(e) => setFilter({ ...filter, query: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && (filter.query ?? '') !== '') {
                    e.stopPropagation();
                    setFilter({ ...filter, query: '' });
                  }
                }}
              />
            </label>
            <select
              className="cr-kn-select"
              data-testid="rules-filter-scope"
              aria-label="Scope"
              data-active={filter.scope !== 'all' ? 'true' : undefined}
              value={filter.scope}
              onChange={(e) => setFilter({ ...filter, scope: e.target.value })}
            >
              <option value="all">Any scope</option>
              {scopes.map((scope) => (
                <option key={scope} value={scope}>
                  {scopeLabel(scope, cockpit)}
                </option>
              ))}
            </select>
            <select
              className="cr-kn-select"
              data-testid="rules-filter-enforcement"
              aria-label="Enforcement"
              data-active={
                filter.enforcement !== undefined && filter.enforcement !== 'all'
                  ? 'true'
                  : undefined
              }
              value={filter.enforcement ?? 'all'}
              onChange={(e) =>
                setFilter({
                  ...filter,
                  enforcement: e.target.value as KnowledgeEnforcement | 'all',
                })
              }
            >
              <option value="all">Any enforcement</option>
              {KNOWLEDGE_ENFORCEMENTS.map((value) => (
                <option key={value} value={value}>
                  {ENFORCEMENT_INFO[value].label}
                </option>
              ))}
            </select>
            {narrowedByControls && (
              <Button
                size="sm"
                variant="ghost"
                data-testid="rules-clear-filters"
                onClick={() => {
                  const { query: _q, enforcement: _e, ...rest } = filter;
                  setFilter({ ...rest, scope: 'all' });
                }}
              >
                Clear
              </Button>
            )}
            <span className="cr-kn-toolbar-end">
              <span className="cr-kn-count" data-testid="rules-count">
                {shownCount} {shownCount === 1 ? 'item' : 'items'}
              </span>
              <Menu
                label="Sort"
                testid="rules-sort"
                trigger={(props) => <IconButton icon="sliders" label="Sort" size="sm" {...props} />}
                items={[
                  {
                    label: 'Needs attention first',
                    hint: sort === 'report' ? <Icon name="check" size={14} /> : undefined,
                    title: 'Flagged rules first, then the most fired',
                    onSelect: () => setSort('report'),
                  },
                  {
                    label: 'Asks you most',
                    hint: sort === 'routed' ? <Icon name="check" size={14} /> : undefined,
                    title: 'The rules the classifier is least sure about first',
                    onSelect: () => setSort('routed'),
                  },
                ]}
              />
            </span>
          </div>

          {(filter.source !== undefined || filter.rule !== undefined) && (
            <div className="cr-kn-chips">
              {filter.source !== undefined && (
                <span className="cr-chip" data-testid="rules-filter-source">
                  {sourceFilterWords(filter.source)}
                  <button
                    type="button"
                    className="cr-link"
                    aria-label="Clear: show every source"
                    title="Clear"
                    onClick={() => clear('source')}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </span>
              )}
              {filter.rule !== undefined && (
                <span className="cr-chip" data-testid="rules-filter-rule">
                  Showing one item{oneItem ? `: ${titleOf(oneItem)}` : ''}
                  <button
                    type="button"
                    className="cr-link"
                    aria-label="Clear: show everything"
                    title="Clear"
                    onClick={() => clear('rule')}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </span>
              )}
            </div>
          )}

          {bulkErrors.length > 0 && (
            <div className="cr-kn-banner" role="alert" data-testid="rules-bulk-errors">
              <Icon name="alert-circle" size={15} />
              <div>
                <div className="cr-kn-banner-title">
                  {bulkErrors.length === 1
                    ? 'One item was not changed'
                    : `${bulkErrors.length} items were not changed`}
                </div>
                <ul>
                  {bulkErrors.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              <IconButton icon="x" label="Dismiss" size="sm" onClick={() => setBulkErrors([])} />
            </div>
          )}

          {error && data && (
            <div className="cr-kn-banner" role="alert">
              <Icon name="alert-circle" size={15} />
              <div>
                <div className="cr-kn-banner-title">Could not refresh the list</div>
                <div>{error}</div>
              </div>
              <Button size="sm" onClick={load}>
                Retry
              </Button>
            </div>
          )}

          {!data && !error && <KnowledgeSkeleton />}
          {!data && error && (
            <EmptyState
              icon="alert-circle"
              title="Could not load knowledge"
              testid="rules-load-error"
              actions={<Button onClick={load}>Try again</Button>}
            >
              {error}
            </EmptyState>
          )}

          {data && all.length === 0 && (
            <EmptyState
              icon="book-open"
              title="No knowledge yet"
              testid="rules-empty"
              actions={
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() => setPanel({ mode: 'create', draft: draftForTab(tab) })}
                >
                  Add knowledge
                </Button>
              }
            >
              Rules your agents are checked against, standards, architecture notes and decisions.
              Agents propose items as they work; you accept them. You can add one too.
            </EmptyState>
          )}

          {data && all.length > 0 && visible.length === 0 && (
            <EmptyState
              icon={tab === 'review' ? 'check-circle' : 'search'}
              title={
                isNarrowed(filter)
                  ? 'Nothing matches'
                  : tab === 'review'
                    ? 'Nothing to review'
                    : 'Nothing here'
              }
              testid="rules-empty"
              actions={
                isNarrowed(filter) ? (
                  <Button
                    onClick={() =>
                      setFilter({ status: 'all', scope: 'all', ...(tab === 'all' ? {} : { tab }) })
                    }
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            >
              {isNarrowed(filter)
                ? 'No item in this list matches the filters.'
                : tab === 'review'
                  ? EMPTY_TEXT.review.body
                  : undefined}
            </EmptyState>
          )}

          {data &&
            visible.map((section) => (
              <KnowledgeSectionView
                key={section.id}
                id={section.id}
                items={section.items}
                rows={rows}
                days={days}
                names={cockpit}
                open={openItem?.id}
                onOpen={open}
                onDecide={decide}
                showHint={tab === 'all' || tab === 'review' || section.id !== tab}
                {...(section.id === 'review' ? { selection } : {})}
                {...(section.id === 'retired' && filter.rule === undefined
                  ? {
                      collapsible: {
                        expanded: retiredOpen,
                        toggle: () => setRetiredOpen((v) => !v),
                      },
                    }
                  : {})}
              >
                {section.items.length === 0 && section.id !== 'retired' && (
                  <EmptyState
                    icon={SECTION_ICON[section.id]}
                    title={EMPTY_TEXT[section.id].title}
                    testid="rules-empty"
                    actions={
                      <Button
                        icon="plus"
                        onClick={() => setPanel({ mode: 'create', draft: draftForTab(tab) })}
                      >
                        {ADD_LABEL[section.id]}
                      </Button>
                    }
                  >
                    {EMPTY_TEXT[section.id].body}
                  </EmptyState>
                )}
              </KnowledgeSectionView>
            ))}
        </div>
      </div>

      {panel && (
        <aside
          className="cr-kn-panel"
          id="rules-detail"
          ref={panelRef}
          tabIndex={-1}
          aria-label={panel.mode === 'create' ? 'Add knowledge' : 'Knowledge item'}
        >
          {panel.mode === 'create' ? (
            <KnowledgeEditor
              key="create"
              mode="create"
              initial={panel.draft}
              submit={async (draft) => {
                const built = createOf(draft);
                if ('error' in built) throw new Error(built.error);
                const created = await createRule(built.input);
                // Show it where it now lives: To review.
                upsert(created);
                setPanel({ mode: 'view', id: created.id });
                toast({
                  tone: 'success',
                  title: 'Proposed',
                  body: titleOf(created),
                  duration: 3000,
                });
              }}
              onDone={load}
              onCancel={closePanel}
            />
          ) : openItem === undefined ? null : panel.mode === 'edit' ? (
            <KnowledgeEditor
              key={`edit-${openItem.id}`}
              mode="edit"
              title={titleOf(openItem)}
              initial={draftOf(openItem)}
              submit={async (draft) => {
                const built = patchOf(draft, openItem);
                if ('error' in built) throw new Error(built.error);
                upsert(await updateRule(openItem.id, built.patch));
              }}
              onDone={() => {
                setPanel({ mode: 'view', id: openItem.id });
                load();
              }}
              onCancel={() => setPanel({ mode: 'view', id: openItem.id })}
            />
          ) : (
            <KnowledgeDetail
              key={openItem.id}
              item={openItem}
              row={rows.get(openItem.id)}
              days={days}
              evals={data?.evals ?? { available: false }}
              names={cockpit}
              onEdit={() => setPanel({ mode: 'edit', id: openItem.id })}
              onClose={closePanel}
              onChanged={load}
            />
          )}
        </aside>
      )}
    </section>
  );
}

/** A scope filter option in words ("Repo ledger-lite"); the raw spelling if it will not parse. */
function scopeLabel(scope: string, cockpit: Parameters<typeof scopeWords>[1]): string {
  try {
    return scopeWords(parseKnowledgeScope(scope), cockpit);
  } catch {
    return scope;
  }
}
