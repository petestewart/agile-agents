/**
 * T363: a node page's header (design/cockpit-ui.md §7 "Page header"): the
 * path (each ancestor opens its page), the title, its status in words, its
 * role, where it works (repo and branch; a click copies the branch), and on
 * the right one primary action chosen by state — Start agent (one click, the
 * defaults; the chevron, Start with…, picks another model), Stop while it works, Merge
 * when there is something to merge — then the details toggle and ⋯.
 *
 * T413: the title keeps one line (it truncates; the whole title is its
 * tooltip), the role reads as muted text at the head of the line under it,
 * the branch by its name (the whole name is its tooltip and what it
 * copies), and on a phone the details toggle and ⋯ sit on the path's line.
 *
 * T423: the chevron is Start with… (the one place to start with another
 * model; the composer's chip picks the next message's). While the daemon is
 * away Start, Stop and Merge are off and say "Reconnecting to the daemon…".
 */

import { type ReactNode, useState } from 'react';
import type { HeaderActions } from '../lib/chat';
import { RECONNECTING } from '../lib/errors';
import type { CockpitStreamRow } from '../lib/feed-types';
import { branchName } from '../lib/inbox';
import { ROLE_HINT, ROLE_LABEL, type StatusInput } from '../lib/status';
import { Icon, type IconName } from './Icon';
import { Button, IconButton, Menu, type MenuItem, StatusPill, useCopy } from './ui';

/** The role glyphs, the same the rail shows. */
const ROLE_ICON: Record<CockpitStreamRow['role'], IconName> = {
  project: 'layers',
  coordinating: 'network',
  work: 'git-branch',
  conversation: 'message-square',
};

export interface Crumb {
  id?: string;
  title: string;
}

export interface NodeHeaderProps {
  title: string;
  crumbs: readonly Crumb[];
  onOpen: (id: string) => void;
  status: StatusInput;
  role: CockpitStreamRow['role'] | undefined;
  /** "Agent finished", "Merged": the agent's half in words. */
  agentText: string;
  repo?: string;
  branch?: string;
  actions: HeaderActions;
  /** "Start agent" or "Restart agent". */
  startLabel: string;
  busy: boolean;
  merging: boolean;
  /** T423: the daemon is away: the write buttons are off, and say so. */
  offline?: boolean;
  onStart: () => void;
  onChooseStart: () => void;
  onStop: () => void;
  onMerge: () => void;
  mergeTitle?: string;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  menu: ReadonlyArray<MenuItem>;
  /** T385: renames the node in place (a click on the title); absent where it can't be. */
  onRename?: (title: string) => Promise<void>;
  /** T435: actions before the agent's (an answered conversation's Send to and Turn into work…). */
  extra?: ReactNode;
  /** Under the title row: the action error, a banner. */
  children?: ReactNode;
}

/** T385: the title, or an input while you rename it (Enter or leaving saves, Esc cancels). */
function Title({
  title,
  onRename,
}: {
  title: string;
  onRename?: (title: string) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const commit = (): void => {
    const next = (draft ?? '').trim();
    setDraft(undefined);
    if (!onRename || next === '' || next === title) return;
    onRename(next).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };
  if (draft !== undefined) {
    return (
      <input
        className="cr-node-title cr-node-title-input"
        data-testid="title-input"
        aria-label="Title"
        value={draft}
        // biome-ignore lint/a11y/noAutofocus: the user just asked to rename it.
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(undefined);
          }
        }}
      />
    );
  }
  return (
    <h1
      className="cr-node-title"
      data-testid="stream-title"
      data-editable={onRename ? 'true' : undefined}
      title={error ?? (onRename ? `${title} — click to rename` : title)}
    >
      {onRename ? (
        <button
          type="button"
          className="cr-node-title-btn"
          onClick={() => {
            setError(undefined);
            setDraft(title);
          }}
        >
          {title}
        </button>
      ) : (
        title
      )}
    </h1>
  );
}

export function NodeHeader(props: NodeHeaderProps): JSX.Element {
  const copy = useCopy();
  const { actions, offline = false } = props;
  const hasActions = actions.agent !== undefined || actions.merge || props.extra !== undefined;
  return (
    <header className="cr-node-hd">
      <div className="cr-node-hd-row" data-actions={hasActions ? 'true' : undefined}>
        <div className="cr-node-hd-main">
          <nav className="cr-crumbs" aria-label="Path" data-testid="stream-path">
            {props.crumbs.map((c, i) => (
              <span key={c.id ?? `${c.title}:${i}`} className="cr-crumb">
                {c.id ? (
                  <button type="button" onClick={() => c.id && props.onOpen(c.id)}>
                    {c.title}
                  </button>
                ) : (
                  <span>{c.title}</span>
                )}
                <Icon name="chevron-right" size={12} className="cr-crumb-sep" />
              </span>
            ))}
          </nav>
          {/* T413: one line whatever the title's length: it truncates, the pill stays beside it. */}
          <div className="cr-node-title-row">
            <Title title={props.title} {...(props.onRename ? { onRename: props.onRename } : {})} />
            <StatusPill row={props.status} testid="node-status" />
          </div>
          <div className="cr-node-meta">
            <span className="cr-node-meta-line">
              {/* T413: the role reads as the rest of this line does (muted, with its glyph), not a button. */}
              {props.role && (
                <>
                  <span
                    className="cr-role-badge cr-meta-item"
                    data-testid="node-role"
                    data-role={props.role}
                    title={ROLE_HINT[props.role]}
                  >
                    <Icon name={ROLE_ICON[props.role]} size={13} />
                    {ROLE_LABEL[props.role]}
                  </span>
                  <span className="cr-meta-sep" aria-hidden="true">
                    ·
                  </span>
                </>
              )}
              <span data-testid="stream-status" className="cr-node-meta-status">
                <span className="cr-meta-item">{props.agentText}</span>
                {props.repo && (
                  <>
                    <span className="cr-meta-sep" aria-hidden="true">
                      ·
                    </span>
                    <span className="cr-meta-item" title="Repository">
                      <Icon name="folder-git" size={13} />
                      {props.repo}
                    </span>
                  </>
                )}
                {props.branch && (
                  <>
                    <span className="cr-meta-sep" aria-hidden="true">
                      ·
                    </span>
                    <button
                      type="button"
                      className="cr-meta-item cr-meta-branch"
                      data-testid="node-branch"
                      data-branch={props.branch}
                      title={`${props.branch} — click to copy`}
                      onClick={() => copy(props.branch ?? '', 'Copied the branch name')}
                    >
                      <Icon name="git-branch" size={13} />
                      <span className="cr-meta-text">{branchName(props.branch)}</span>
                    </button>
                  </>
                )}
              </span>
            </span>
          </div>
        </div>
        {hasActions && (
          <div className="cr-node-actions">
            {props.extra}
            {actions.agent === 'start' && (
              <span
                className="cr-split"
                data-primary={actions.primary === 'agent' ? 'true' : undefined}
              >
                <Button
                  variant={actions.primary === 'agent' ? 'primary' : 'secondary'}
                  icon="play"
                  data-testid="attach"
                  busy={props.busy}
                  disabled={offline}
                  title={offline ? RECONNECTING : 'Start the agent with the default model'}
                  onClick={props.onStart}
                >
                  {props.startLabel}
                </Button>
                <IconButton
                  icon="chevron-down"
                  label={offline ? RECONNECTING : 'Start with…'}
                  variant={actions.primary === 'agent' ? 'primary' : 'secondary'}
                  data-testid="attach-options"
                  disabled={props.busy || offline}
                  onClick={props.onChooseStart}
                />
              </span>
            )}
            {actions.agent === 'stop' && (
              <Button
                icon="square"
                data-testid="stop"
                disabled={props.busy || offline}
                title={
                  offline
                    ? RECONNECTING
                    : "Stop the agent. It won't wake again until you start it or send it a message."
                }
                onClick={props.onStop}
              >
                Stop
              </Button>
            )}
            {actions.merge && (
              <Button
                variant={actions.primary === 'merge' ? 'primary' : 'secondary'}
                icon="git-merge"
                data-testid="stream-land"
                busy={props.merging}
                disabled={offline}
                title={offline ? RECONNECTING : props.mergeTitle}
                onClick={props.onMerge}
              >
                {props.merging ? 'Merging…' : 'Merge'}
              </Button>
            )}
          </div>
        )}
        {/* T413: on a phone these sit on the path's line, not a row of their own. */}
        <div className="cr-node-tools">
          <IconButton
            icon="panel-right"
            label={props.detailsOpen ? 'Hide details' : 'Show details'}
            data-testid="details-toggle"
            aria-pressed={props.detailsOpen}
            className="cr-details-toggle"
            onClick={props.onToggleDetails}
          />
          <Menu items={props.menu} label="More actions" testid="node-menu" />
        </div>
      </div>
      {props.children}
    </header>
  );
}
