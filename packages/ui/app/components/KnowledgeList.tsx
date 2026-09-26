/**
 * T366: the Knowledge screen's list — one section per kind of item (To
 * review, Rules, Standards, Architecture, Decisions, Retired), each a stack
 * of compact rows. A row reads: what the item says, where it applies, how
 * it is enforced, and (for a rule) how often it fired. A click opens the
 * detail panel (`KnowledgeDetail`); a proposal can be accepted or retired
 * from its row.
 */

import type { KnowledgeEnforcement, KnowledgeItem } from '@agile-agents/shared';
import { type KeyboardEvent, type MouseEvent, type ReactNode, useState } from 'react';
import type { RuleReportRow } from '../lib/feed-types';
import {
  ENFORCEMENT_INFO,
  KIND_LABEL,
  type KnowledgeNames,
  type KnowledgeSectionId,
  SECTION_INFO,
  acceptBlocker,
  flagWords,
  formatFiredAt,
  isEnforced,
  scopeHint,
  scopeWords,
  sourceWords,
  statsWords,
  summaryOf,
  titleOf,
} from '../lib/rules';
import { ago } from '../lib/status';
import { Icon, type IconName } from './Icon';
import { Badge, type BadgeTone, Button } from './ui';

export const SECTION_ICON: Record<KnowledgeSectionId, IconName> = {
  review: 'circle-dashed',
  rules: 'shield-check',
  standard: 'ruler',
  architecture: 'layers',
  decision: 'signpost',
  retired: 'archive',
};

export const ENFORCEMENT_ICON: Record<KnowledgeEnforcement, IconName> = {
  tell: 'message-square',
  review: 'eye',
  action: 'shield-check',
  ship: 'git-merge',
};

export const ENFORCEMENT_TONE: Record<KnowledgeEnforcement, BadgeTone> = {
  tell: 'neutral',
  review: 'neutral',
  action: 'blue',
  ship: 'purple',
};

/** The icon for one item: its category, or dashed for a proposal. */
export function itemIcon(item: KnowledgeItem): IconName {
  if (isEnforced(item)) return 'shield-check';
  return SECTION_ICON[item.kind];
}

export function EnforcementBadge({
  item,
  testid,
}: {
  item: Pick<KnowledgeItem, 'enforcement'>;
  testid?: string;
}): JSX.Element {
  const info = ENFORCEMENT_INFO[item.enforcement];
  return (
    <Badge
      tone={ENFORCEMENT_TONE[item.enforcement]}
      icon={ENFORCEMENT_ICON[item.enforcement]}
      title={info.hint}
      testid={testid}
    >
      {info.label}
    </Badge>
  );
}

export function CriticalMark({ withLabel = false }: { withLabel?: boolean }): JSX.Element {
  const hint = "Critical: blocks even when the checker can't be reached.";
  return withLabel ? (
    <Badge tone="red" icon="lock" title={hint} testid="rules-critical">
      Critical
    </Badge>
  ) : (
    <span className="cr-kn-critical" title={hint} data-testid="rules-critical">
      <Icon name="lock" size={13} label="Critical" />
    </span>
  );
}

export interface SectionProps {
  id: KnowledgeSectionId;
  items: KnowledgeItem[];
  rows: ReadonlyMap<string, RuleReportRow>;
  days: number;
  names: KnowledgeNames;
  open: string | undefined;
  onOpen: (id: string) => void;
  /** Accept/Retire from a proposal's row. */
  onDecide: (item: KnowledgeItem, decision: 'accept' | 'retire') => Promise<void>;
  /** To review only: the bulk selection. */
  selection?: {
    selected: ReadonlySet<string>;
    toggle: (id: string) => void;
    setAll: (on: boolean) => void;
    busy: boolean;
    bulk: (decision: 'accept' | 'retire') => void;
  };
  /** Retired only: folded until asked for. */
  collapsible?: { expanded: boolean; toggle: () => void };
  /** Hide the one-line hint (a single-category tab shows it once, above). */
  showHint?: boolean;
  children?: ReactNode;
}

export function KnowledgeSectionView({
  id,
  items,
  rows,
  days,
  names,
  open,
  onOpen,
  onDecide,
  selection,
  collapsible,
  showHint = true,
  children,
}: SectionProps): JSX.Element {
  const info = SECTION_INFO[id];
  const picked = selection ? items.filter((item) => selection.selected.has(item.id)) : [];
  const expanded = collapsible === undefined || collapsible.expanded;
  const heading = (
    <>
      <Icon name={SECTION_ICON[id]} size={15} className="cr-kn-sec-icon" />
      <h2>{info.label}</h2>
      <span className="cr-kn-sec-count" data-testid={`rules-section-count-${id}`}>
        {items.length}
      </span>
      {showHint && <span className="cr-kn-sec-hint">{info.hint}</span>}
    </>
  );
  return (
    <section className="cr-kn-sec" data-section={id} data-testid={`rules-section-${id}`}>
      <div className="cr-kn-sec-hd">
        {selection && items.length > 0 && (
          <input
            type="checkbox"
            className="cr-kn-sec-check"
            data-testid="rules-select-all"
            aria-label="Select every proposal"
            checked={picked.length > 0 && picked.length === items.length}
            ref={(el) => {
              if (el) el.indeterminate = picked.length > 0 && picked.length < items.length;
            }}
            onChange={(e) => selection.setAll(e.target.checked)}
          />
        )}
        {collapsible ? (
          <button
            type="button"
            className="cr-kn-sec-toggle"
            data-testid="rules-show-retired"
            aria-expanded={collapsible.expanded}
            onClick={collapsible.toggle}
          >
            <Icon name={collapsible.expanded ? 'chevron-down' : 'chevron-right'} size={14} />
            {heading}
          </button>
        ) : (
          heading
        )}
        {selection && picked.length > 0 && (
          <div className="cr-kn-bulk" data-testid="rules-bulk">
            <span className="cr-kn-bulk-count">{picked.length} selected</span>
            <Button
              size="sm"
              icon="check"
              data-testid="rules-bulk-accept"
              busy={selection.busy}
              onClick={() => selection.bulk('accept')}
            >
              Accept
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="archive"
              data-testid="rules-bulk-retire"
              disabled={selection.busy}
              onClick={() => selection.bulk('retire')}
            >
              Retire
            </Button>
          </div>
        )}
      </div>
      {children}
      {expanded && items.length > 0 && (
        <div className="cr-kn-rows" onKeyDown={moveFocus}>
          {items.map((item) => (
            <KnowledgeRow
              key={item.id}
              item={item}
              section={id}
              row={rows.get(item.id)}
              days={days}
              names={names}
              open={open === item.id}
              onOpen={() => onOpen(item.id)}
              onDecide={(decision) => onDecide(item, decision)}
              checked={selection?.selected.has(item.id)}
              onToggle={selection ? () => selection.toggle(item.id) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Up/Down move between rows (their title buttons); Enter opens one. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const target = event.target as HTMLElement;
  if (!target.classList.contains('cr-kn-row-main')) return;
  const all = [
    ...(event.currentTarget
      .closest('.cr-kn')
      ?.querySelectorAll<HTMLButtonElement>('.cr-kn-row-main') ?? []),
  ];
  const at = all.indexOf(target as HTMLButtonElement);
  const next = all[event.key === 'ArrowDown' ? at + 1 : at - 1];
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

function KnowledgeRow({
  item,
  section,
  row,
  days,
  names,
  open,
  onOpen,
  onDecide,
  checked,
  onToggle,
}: {
  item: KnowledgeItem;
  section: KnowledgeSectionId;
  row: RuleReportRow | undefined;
  days: number;
  names: KnowledgeNames;
  open: boolean;
  onOpen: () => void;
  onDecide: (decision: 'accept' | 'retire') => Promise<void>;
  checked: boolean | undefined;
  onToggle: (() => void) | undefined;
}): JSX.Element {
  const [busy, setBusy] = useState<'accept' | 'retire' | undefined>(undefined);
  const title = titleOf(item);
  const summary = summaryOf(item);
  const proposed = item.status === 'proposed';
  const enforced = isEnforced(item);
  // A kind section names its kind, and a rule is a rule whatever its kind:
  // say the kind where kinds mix and it matters.
  const showKind = section === 'review' || section === 'retired';
  const flag =
    enforced && item.status === 'accepted' && row ? flagWords(row.flag, days) : undefined;
  const blocker = proposed ? acceptBlocker(item) : undefined;

  async function decide(decision: 'accept' | 'retire'): Promise<void> {
    setBusy(decision);
    try {
      await onDecide(decision);
    } finally {
      setBusy(undefined);
    }
  }

  // The whole row opens the panel; its own controls keep their clicks.
  const onRowClick = (e: MouseEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement;
    // The title is a button with its own click; controls keep theirs.
    if (target.closest('button, input, a, label')) return;
    if (window.getSelection()?.toString()) return;
    onOpen();
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row's title is a button (keyboard); the row click is a larger mouse target for it.
    <div
      className="cr-kn-row"
      data-testid="rules-row"
      data-rule={item.id}
      data-status={item.status}
      data-open={open ? 'true' : undefined}
      data-checked={checked ? 'true' : undefined}
      onClick={onRowClick}
    >
      <span className="cr-kn-row-lead">
        {onToggle && (
          <input
            type="checkbox"
            className="cr-kn-row-check"
            data-testid="rules-select"
            aria-label={`Select ${title}`}
            checked={checked ?? false}
            onChange={onToggle}
          />
        )}
        <span className="cr-kn-row-icon" data-enforced={enforced ? 'true' : undefined}>
          <Icon name={itemIcon(item)} size={15} />
        </span>
      </span>
      <div className="cr-kn-row-body">
        <button
          type="button"
          className="cr-kn-row-main"
          aria-expanded={open}
          aria-controls="rules-detail"
          title={item.name ? undefined : plainTitle(item.text)}
          onClick={onOpen}
        >
          <span className="cr-kn-row-title" data-testid="rules-title">
            {title}
          </span>
          {summary && <span className="cr-kn-row-summary">{summary}</span>}
        </button>
        <div className="cr-kn-row-meta">
          {showKind && (
            <span className="cr-kn-row-kind" data-testid="rules-kind">
              {KIND_LABEL[item.kind]}
            </span>
          )}
          <span className="cr-kn-row-scope" data-testid="rules-scope" title={scopeHint(item.scope)}>
            {scopeWords(item.scope, names)}
          </span>
          {item.paths !== undefined && item.paths.length > 0 && (
            <span className="cr-kn-row-paths" data-testid="rules-paths" title="Only these paths">
              {item.paths.join(', ')}
            </span>
          )}
          {proposed && (
            <span className="cr-kn-row-source">
              {sourceWords(item.source, names)} · {ago(item.created_at)}
            </span>
          )}
          {blocker !== undefined && (
            <span className="cr-kn-row-warn" title={blocker}>
              Needs examples
            </span>
          )}
        </div>
      </div>
      <div className="cr-kn-row-side">
        {enforced && item.status === 'accepted' && (
          <span
            className="cr-kn-row-stats"
            data-testid="rules-stats"
            title={`Checked ${item.stats.fired} times; ${item.stats.violated} violations; asked you ${item.stats.routed} times`}
          >
            {statsWords(item.stats)}
            {item.stats.last_fired_at !== undefined && (
              <span
                className="cr-kn-row-last"
                data-testid="rules-last-fired"
                title={`Last fired ${formatFiredAt(item.stats.last_fired_at)} UTC`}
              >
                {' · '}
                {ago(item.stats.last_fired_at)}
              </span>
            )}
          </span>
        )}
        {flag && row && (
          <span className="cr-kn-flag" data-testid="rules-flag" data-flag={row.flag} title={flag}>
            <Icon name="alert-triangle" size={14} label={flag} />
          </span>
        )}
        {item.critical && enforced && <CriticalMark />}
        {/* In a kind section "Guidance" is the section's own promise; say only the exceptions. */}
        {(item.enforcement !== 'tell' || section === 'review' || section === 'retired') && (
          <EnforcementBadge item={item} testid="rules-tier" />
        )}
        {proposed && (
          <div className="cr-kn-row-actions">
            <Button
              size="sm"
              icon="check"
              data-testid="rules-accept"
              busy={busy === 'accept'}
              disabled={busy !== undefined || blocker !== undefined}
              title={blocker ?? 'Accept: agents in scope follow it from now on'}
              onClick={() => decide('accept')}
            >
              Accept
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="rules-retire"
              busy={busy === 'retire'}
              disabled={busy !== undefined}
              title="Retire: never applied, kept for the record"
              onClick={() => decide('retire')}
            >
              Retire
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function plainTitle(text: string): string {
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
}

/** Placeholder rows while the first read is in flight. */
export function KnowledgeSkeleton(): JSX.Element {
  return (
    <div
      className="cr-kn-skeleton"
      data-testid="rules-loading"
      aria-busy="true"
      aria-label="Loading"
    >
      {[72, 54, 64, 48, 58].map((w) => (
        <div key={w} className="cr-kn-skel-row">
          <span className="cr-kn-skel-dot" />
          <span className="cr-kn-skel-bar" style={{ width: `${w}%` }} />
          <span className="cr-kn-skel-pill" />
        </div>
      ))}
    </div>
  );
}
