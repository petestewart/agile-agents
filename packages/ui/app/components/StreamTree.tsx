/**
 * The left rail (cockpit design §9.2): every node, nested under its
 * project, each with the dot that says who must act. Clicking a node opens
 * its page (T161, §9.3).
 * T162: a filter box (`/` focuses it) narrows the tree to matching titles,
 * keeping each match's ancestors so the nesting still reads.
 * T208: each row carries its derived role's icon; "New project".
 * T331: a caret folds a node's subtree without opening it (double-click or
 * Left/Right on the row too). The folded set is a per-viewer convenience in
 * localStorage; a folded row whose subtree waits on you shows that dot.
 * T333 (D34): drag a row onto another row in its project to move it there
 * (onto the project row: to the top level). The daemon refuses what D34
 * refuses; the rail shows why.
 *
 * T365 (design/cockpit-ui.md): the rail shows every project by default and
 * never switches on its own. A project's ⋯ has "Show only this project",
 * which a chip at the top undoes. Each row has, on hover or focus, a `+`
 * (a node under it) and a ⋯ menu (Open, New child node, Rename, Move to,
 * Copy node id, Delete); right-click opens the same menu. Delete asks, then
 * offers Undo; Deleted (in the sidebar, below) restores. A drop the rail
 * refuses says why. The arrow keys walk the rows (one tab stop), Enter
 * opens, F2 renames. The ? next to Projects explains the dots.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { archiveStream, moveStream, unarchiveStream, updateStream } from '../lib/api';
import { useOptionalFeed } from '../lib/feed-context';
import type { CockpitProjectRow, CockpitStreamRow } from '../lib/feed-types';
import { isShortcut, useShell } from '../lib/shell';
import { type NodeStatusKey, ROLE_LABEL, nodeStatus, statusOf } from '../lib/status';
import {
  type StreamTreeNode,
  buildStreamTree,
  filterStreamRows,
  parseCollapsed,
  rowsInProject,
  subtreeNeedsYou,
} from '../lib/streams';
import {
  LEGEND_NOTE,
  LEGEND_ORDER,
  ROLE_NOTE,
  checkMove,
  deleteQuestion,
  legendRow,
  moveTargets,
  subtreeIds,
} from '../lib/tree';
import { Icon, type IconName } from './Icon';
import { PickList, type PickOption } from './Pickers';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  IconButton,
  Menu,
  type MenuItem,
  Popover,
  StatusDot,
  useCopy,
  useToast,
} from './ui';

/** Project-row statuses that are not worth a dot: the layers icon says enough. */
const QUIET_PROJECT: ReadonlySet<NodeStatusKey> = new Set([
  'idle',
  'not_started',
  'stopped',
  'done',
]);

/** T360: the role glyphs (design/cockpit-ui.md §2); `data-role` names the role for tests. */
export const ROLE_GLYPH: Record<CockpitStreamRow['role'], IconName> = {
  project: 'layers',
  coordinating: 'network',
  work: 'git-branch',
  conversation: 'message-square',
};

const COLLAPSED_KEY = 'agile.rail.collapsed';
const DELETED_OPEN_KEY = 'agile.rail.deleted';

function loadCollapsed(): Set<string> {
  try {
    return parseCollapsed(window.localStorage.getItem(COLLAPSED_KEY));
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage blocked or full: the fold just won't survive a reload.
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface Fold {
  /** While the filter is on, every match shows, folded or not, and the carets rest. */
  locked: boolean;
  isOpen(id: string): boolean;
  setOpen(id: string, open: boolean): void;
}

/** T333/T365: the rail's drag; `check` is the rail's view, the daemon decides. */
interface Drag {
  dragging: string | undefined;
  /** The row under the pointer, and why it refuses the drop (if it does). */
  over: { id: string; reason?: string } | undefined;
  start(id: string): void;
  enter(target: string): boolean;
  leave(target: string): void;
  drop(target: string): void;
  end(): void;
}

/** What a row's `+` and ⋯ do. */
interface RowActions {
  open(row: CockpitStreamRow): void;
  add(row: CockpitStreamRow): void;
  rename(row: CockpitStreamRow): void;
  move(row: CockpitStreamRow): void;
  copyId(row: CockpitStreamRow): void;
  remove(row: CockpitStreamRow): void;
  only(project: string): void;
  showAll(): void;
}

interface TreeContext {
  fold: Fold;
  drag: Drag;
  actions: RowActions;
  /** The one row that is a tab stop (roving tabindex). */
  tabStop: string | undefined;
  setFocused(id: string): void;
  onRowKey(event: ReactKeyboardEvent<HTMLButtonElement>, node: StreamTreeNode, open: boolean): void;
  filterProject: string | undefined;
  projectName(id: string | undefined): string | undefined;
}

/** Where a row's menu opens: above it when there is no room below in the sidebar. */
function menuPlacement(el: Element): 'top' | 'bottom' {
  const box = el.getBoundingClientRect();
  const scroller = el.closest('.cr-sb-scroll') ?? document.documentElement;
  const view = scroller.getBoundingClientRect();
  const bottom = Math.min(view.bottom, window.innerHeight);
  return box.bottom + 250 > bottom && box.top - 250 > view.top ? 'top' : 'bottom';
}

function Node({ node, ctx }: { node: StreamTreeNode; ctx: TreeContext }): JSX.Element {
  const { selected } = useShell();
  const { fold, drag, actions } = ctx;
  const row = node.row;
  const status = nodeStatus(row);
  const id = row.id;
  const isProject = row.role === 'project';
  const hasChildren = node.children.length > 0;
  const open = !hasChildren || fold.isOpen(id);
  const hiddenNeedsYou = !open && subtreeNeedsYou(node);
  const tabbable = ctx.tabStop === id;
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom');
  const refusal = drag.over?.id === id ? drag.over.reason : undefined;
  const itemRef = useRef<HTMLDivElement>(null);
  // The open node stays in sight: a node just made, restored or opened from Needs me.
  useEffect(() => {
    if (selected === id) itemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected, id]);

  const items: MenuItem[] = isProject
    ? [
        {
          label: 'New node in this project',
          icon: 'plus',
          testid: 'tree-menu-new-child',
          onSelect: () => actions.add(row),
        },
        ctx.filterProject !== undefined && ctx.filterProject === row.project
          ? {
              label: 'Show all projects',
              icon: 'layers',
              testid: 'tree-menu-all',
              onSelect: actions.showAll,
            }
          : {
              label: 'Show only this project',
              icon: 'filter',
              testid: 'tree-menu-only',
              hidden: row.project === undefined,
              onSelect: () => row.project !== undefined && actions.only(row.project),
            },
        {
          label: 'Project settings',
          icon: 'settings',
          testid: 'tree-menu-settings',
          onSelect: () => actions.open(row),
        },
        'separator',
        {
          label: 'Copy node id',
          icon: 'copy',
          testid: 'tree-menu-copy-id',
          onSelect: () => actions.copyId(row),
        },
      ]
    : [
        {
          label: 'Open',
          icon: 'arrow-right',
          testid: 'tree-menu-open',
          onSelect: () => actions.open(row),
        },
        {
          label: 'New child node…',
          icon: 'plus',
          testid: 'tree-menu-new-child',
          onSelect: () => actions.add(row),
        },
        'separator',
        {
          label: 'Rename…',
          icon: 'pencil',
          hint: 'F2',
          testid: 'tree-menu-rename',
          onSelect: () => actions.rename(row),
        },
        {
          label: 'Move to…',
          icon: 'corner-down-right',
          testid: 'tree-menu-move',
          onSelect: () => actions.move(row),
        },
        {
          label: 'Copy node id',
          icon: 'copy',
          testid: 'tree-menu-copy-id',
          onSelect: () => actions.copyId(row),
        },
        'separator',
        {
          label: 'Delete…',
          icon: 'trash',
          danger: true,
          testid: 'tree-menu-delete',
          onSelect: () => actions.remove(row),
        },
      ];

  const openMenu = (item: Element): void => {
    setPlacement(menuPlacement(item));
    const trigger = item.querySelector<HTMLButtonElement>('[data-testid="tree-menu-trigger"]');
    if (trigger?.getAttribute('aria-expanded') !== 'true') trigger?.click();
  };

  const project = isProject ? (ctx.projectName(row.project) ?? row.title) : undefined;
  return (
    <li data-tree-node={id}>
      <div
        ref={itemRef}
        className="cr-tree-item"
        data-drop-refused={refusal !== undefined ? 'true' : undefined}
        onPointerEnter={(e) => setPlacement(menuPlacement(e.currentTarget))}
        onContextMenu={(e: ReactMouseEvent<HTMLDivElement>) => {
          e.preventDefault();
          openMenu(e.currentTarget);
        }}
      >
        {hasChildren && (
          <button
            type="button"
            className="cr-tree-caret"
            data-testid="tree-caret"
            tabIndex={-1}
            aria-expanded={open}
            aria-controls={`cr-tree-kids-${id}`}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${row.title}`}
            disabled={fold.locked}
            onClick={() => fold.setOpen(id, !open)}
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} strokeWidth={2.25} />
          </button>
        )}
        <button
          type="button"
          className="cr-tree-row"
          data-stream={id}
          tabIndex={tabbable ? 0 : -1}
          draggable={!isProject}
          data-drop-target={drag.over?.id === id && refusal === undefined ? 'true' : undefined}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', id);
            drag.start(id);
          }}
          onDragEnd={() => drag.end()}
          onDragOver={(e) => {
            if (!drag.enter(id)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDragLeave={() => drag.leave(id)}
          onDrop={(e) => {
            e.preventDefault();
            drag.drop(id);
          }}
          aria-current={selected === id ? 'true' : undefined}
          aria-expanded={hasChildren ? open : undefined}
          data-role={row.role}
          data-status={status.key}
          title={`${row.title}\n${ROLE_LABEL[row.role]} · ${status.label} — ${status.hint}`}
          onFocus={() => ctx.setFocused(id)}
          onClick={() => actions.open(row)}
          onDoubleClick={() => {
            if (hasChildren) fold.setOpen(id, !open);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
              e.preventDefault();
              const item = e.currentTarget.closest('.cr-tree-item');
              if (item) openMenu(item);
              return;
            }
            ctx.onRowKey(e, node, open);
          }}
        >
          {/* A project row shows a dot only when its status is news (a coordinator's question, work, a merge). */}
          {!isProject || !QUIET_PROJECT.has(status.key) ? (
            <StatusDot row={row} status={status} />
          ) : null}
          <span
            className="cr-role"
            data-testid="role-icon"
            data-role={row.role}
            role="img"
            aria-label={ROLE_LABEL[row.role]}
          >
            <Icon name={ROLE_GLYPH[row.role]} size={14} />
          </span>
          {/* T347 (D36 D11): the plan badge sits on its own line, so the title keeps the width. */}
          <span className="cr-tree-label">
            <span className="title">{row.title}</span>
            {row.waiting_for_plan && (
              <span className="cr-waiting" data-testid="waiting-for-plan">
                waiting for the plan
              </span>
            )}
          </span>
          {row.overlap && (
            <span
              className="cr-overlap"
              data-testid="overlap-mark"
              title="Overlapping changes with another live node"
            >
              <Icon name="alert-triangle" size={13} label="overlapping changes" />
            </span>
          )}
          {row.visibility_advisory && (
            <span className="cr-visibility" data-testid="visibility-advisory">
              visibility advisory
            </span>
          )}
          {hiddenNeedsYou && (
            <span
              className="cr-dot cr-tree-hidden-dot"
              data-dot="amber"
              data-testid="collapsed-needs-you"
              aria-label="something inside is waiting on you"
            />
          )}
        </button>
        <span className="cr-tree-actions">
          <IconButton
            icon="plus"
            size="sm"
            tabIndex={tabbable ? 0 : -1}
            label={isProject ? `New node in ${project}` : `New node under ${row.title}`}
            data-testid="tree-add"
            onClick={() => actions.add(row)}
          />
          <Menu
            label={isProject ? `${project} actions` : `${row.title} actions`}
            testid="tree-menu"
            align="end"
            placement={placement}
            items={items}
            trigger={(props) => (
              <IconButton
                {...props}
                icon="more"
                size="sm"
                tabIndex={tabbable ? 0 : -1}
                label={isProject ? `${project} actions` : `${row.title} actions`}
                data-testid="tree-menu-trigger"
              />
            )}
          />
        </span>
        {refusal !== undefined && (
          <output className="cr-drop-hint" data-testid="move-refused">
            {refusal}
          </output>
        )}
      </div>
      {hasChildren && open && (
        <ul id={`cr-tree-kids-${id}`}>
          {node.children.map((child) => (
            <Node key={child.row.id} node={child} ctx={ctx} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The rows a keyboard walk visits, in order (folded subtrees skipped). */
function visibleIds(nodes: readonly StreamTreeNode[], fold: Fold, out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.row.id);
    if (node.children.length > 0 && fold.isOpen(node.row.id)) visibleIds(node.children, fold, out);
  }
  return out;
}

/** T365: what the rail's dots, icons and marks mean. */
function Legend(): JSX.Element {
  const [at, setAt] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const anchor = useRef<HTMLElement | null>(null);
  const roles: CockpitStreamRow['role'][] = ['project', 'coordinating', 'work', 'conversation'];
  // The sidebar clips what overflows it, so the legend floats beside it,
  // level with the tree it explains (over the drawer on a phone).
  const place = useCallback((el: HTMLElement): void => {
    const box = el.getBoundingClientRect();
    const side = el.closest('.cr-sidebar')?.getBoundingClientRect();
    const beside = side !== undefined && side.right + 8 + 340 <= window.innerWidth;
    setAt({
      top: Math.round(Math.max(8, Math.min(box.top - 8, window.innerHeight - 560))),
      left: Math.round(beside && side ? side.right + 8 : 8),
    });
  }, []);
  // T384: it follows a window resize while open.
  useEffect(() => {
    const onResize = (): void => {
      if (anchor.current?.getAttribute('aria-expanded') === 'true') place(anchor.current);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [place]);
  return (
    <Popover
      align="end"
      className="cr-legend"
      label="What the rail shows"
      testid="tree-legend"
      trigger={(props) => (
        <IconButton
          {...props}
          icon="help-circle"
          size="sm"
          label="What the dots mean"
          data-testid="tree-legend-open"
          onClick={(e) => {
            anchor.current = e.currentTarget;
            place(e.currentTarget);
            props.onClick();
          }}
        />
      )}
    >
      {() => (
        <div
          className="cr-legend-body"
          style={{ top: at.top, left: at.left, maxHeight: `calc(100vh - ${at.top + 12}px)` }}
        >
          <div className="cr-legend-hd">Status</div>
          <ul className="cr-legend-list">
            {LEGEND_ORDER.map((key) => {
              const s = statusOf(key);
              return (
                <li key={key} data-status={key}>
                  <span className="cr-legend-mark">
                    <StatusDot row={legendRow(key)} status={s} />
                  </span>
                  <span className="cr-legend-label">{s.label}</span>
                  <span className="cr-legend-hint">{LEGEND_NOTE[key]}</span>
                </li>
              );
            })}
          </ul>
          <div className="cr-legend-hd">Kinds of node</div>
          <ul className="cr-legend-list">
            {roles.map((role) => (
              <li key={role}>
                <span className="cr-legend-mark cr-role">
                  <Icon name={ROLE_GLYPH[role]} size={14} />
                </span>
                <span className="cr-legend-label">{ROLE_LABEL[role]}</span>
                <span className="cr-legend-hint">{ROLE_NOTE[role]}</span>
              </li>
            ))}
          </ul>
          <div className="cr-legend-hd">Marks</div>
          <ul className="cr-legend-list">
            <li>
              <span className="cr-legend-mark cr-overlap">
                <Icon name="alert-triangle" size={13} />
              </span>
              <span className="cr-legend-hint">Overlaps another live node’s changes</span>
            </li>
            <li>
              <span className="cr-legend-mark">
                <span className="cr-dot cr-tree-hidden-dot" data-dot="amber" />
              </span>
              <span className="cr-legend-hint">On a folded row: something inside needs you</span>
            </li>
          </ul>
        </div>
      )}
    </Popover>
  );
}

type TreeDialog =
  | { kind: 'rename'; row: CockpitStreamRow }
  | { kind: 'move'; row: CockpitStreamRow }
  | { kind: 'delete'; row: CockpitStreamRow };

export function StreamTree({
  rows: allRows,
  projects,
}: {
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
}): JSX.Element {
  const {
    railOpen,
    toggleRail,
    project,
    setProject,
    setNewProjectOpen,
    select,
    selected,
    openNewStream,
  } = useShell();
  const toast = useToast();
  const copy = useCopy();
  const sectionRef = useRef<HTMLElement>(null);
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const setOpen = useCallback((id: string, open: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(id);
      else next.add(id);
      saveCollapsed(next);
      return next;
    });
  }, []);
  const filtering = filter.trim() !== '';
  const fold: Fold = {
    locked: filtering,
    isOpen: (id) => filtering || !collapsed.has(id),
    setOpen: filtering ? () => {} : setOpen,
  };
  const rows = rowsInProject(allRows, project);
  const tree = buildStreamTree(filterStreamRows(rows, filter));
  const [dialog, setDialog] = useState<TreeDialog | undefined>(undefined);
  const [focused, setFocused] = useState<string | undefined>(undefined);
  // The open node is never hidden in a folded subtree: opening it (or its
  // first frame) unfolds its ancestors. Folding one afterwards is left alone.
  const rowsNow = useRef(allRows);
  rowsNow.current = allRows;
  const collapsedNow = useRef(collapsed);
  collapsedNow.current = collapsed;
  const selectedShown = selected !== undefined && allRows.some((r) => r.id === selected);
  useEffect(() => {
    if (!selectedShown || selected === undefined) return;
    const byId = new Map(rowsNow.current.map((r) => [r.id, r]));
    const seen = new Set<string>();
    for (let at = byId.get(selected)?.parent; at !== undefined && !seen.has(at); ) {
      seen.add(at);
      if (collapsedNow.current.has(at)) setOpen(at, true);
      at = byId.get(at)?.parent;
    }
  }, [selected, selectedShown, setOpen]);
  const projectName = useCallback(
    (id: string | undefined) => projects.find((p) => p.id === id)?.name,
    [projects],
  );
  const filterName = project !== undefined ? (projectName(project) ?? 'this project') : undefined;

  // ---- drag (T333, T365)
  const [dragging, setDragging] = useState<string | undefined>(undefined);
  const [over, setOver] = useState<{ id: string; reason?: string } | undefined>(undefined);
  const [moveError, setMoveError] = useState<string | undefined>(undefined);
  // Read at dragend: why the row under the pointer refused, and whether a drop happened.
  const refused = useRef<string | undefined>(undefined);
  const dropped = useRef(false);
  useEffect(() => {
    if (dragging === undefined) return;
    // Anywhere but a row: the last refusal no longer applies.
    const onOver = (e: DragEvent): void => {
      const target = e.target as Element | null;
      if (!target?.closest?.('.cr-tree-row')) refused.current = undefined;
    };
    window.addEventListener('dragover', onOver);
    return () => window.removeEventListener('dragover', onOver);
  }, [dragging]);
  const drag: Drag = {
    dragging,
    over,
    start: (id) => {
      dropped.current = false;
      refused.current = undefined;
      setMoveError(undefined);
      setDragging(id);
    },
    enter: (target) => {
      if (dragging === undefined) return false;
      const check = checkMove(allRows, dragging, target);
      if (check.ok) {
        refused.current = undefined;
        if (over?.id !== target || over.reason !== undefined) setOver({ id: target });
        return true;
      }
      refused.current = check.quiet ? undefined : check.reason;
      const next = check.quiet ? undefined : { id: target, reason: check.reason };
      if (over?.id !== next?.id || over?.reason !== next?.reason) setOver(next);
      return false;
    },
    leave: (target) => {
      if (over?.id === target) setOver(undefined);
    },
    drop: (target) => {
      const moving = dragging;
      dropped.current = true;
      setDragging(undefined);
      setOver(undefined);
      if (moving === undefined || !checkMove(allRows, moving, target).ok) return;
      moveStream(moving, target).catch((err: unknown) => setMoveError(errorText(err)));
    },
    end: () => {
      const reason = refused.current;
      if (!dropped.current && reason !== undefined) {
        toast({ title: 'Can’t move it there', body: reason, tone: 'error' });
      }
      refused.current = undefined;
      setDragging(undefined);
      setOver(undefined);
    },
  };

  // ---- row actions
  const actions: RowActions = {
    open: (row) => select(row.id),
    add: (row) =>
      row.role === 'project' && row.project !== undefined
        ? openNewStream({ project: row.project })
        : openNewStream({ parent: row.id }),
    rename: (row) => setDialog({ kind: 'rename', row }),
    move: (row) => setDialog({ kind: 'move', row }),
    copyId: (row) => copy(row.id, 'Node id copied'),
    remove: (row) => {
      if (row.role !== 'project') setDialog({ kind: 'delete', row });
    },
    only: (id) => setProject(id),
    showAll: () => setProject(undefined),
  };

  // ---- keyboard: one tab stop, the arrows walk the rows
  const order = visibleIds(tree, fold);
  const shown = new Set(order);
  const tabStop = [focused, selected].find((id) => id !== undefined && shown.has(id)) ?? order[0];
  const focusRow = (id: string | undefined): void => {
    if (id === undefined) return;
    sectionRef.current
      ?.querySelector<HTMLButtonElement>(`.cr-tree-row[data-stream="${CSS.escape(id)}"]`)
      ?.focus();
  };
  const onRowKey: TreeContext['onRowKey'] = (e, node, open) => {
    const id = node.row.id;
    const at = order.indexOf(id);
    const hasChildren = node.children.length > 0;
    switch (e.key) {
      case 'ArrowDown':
        focusRow(order[at + 1]);
        break;
      case 'ArrowUp':
        focusRow(order[at - 1]);
        break;
      case 'Home':
        focusRow(order[0]);
        break;
      case 'End':
        focusRow(order[order.length - 1]);
        break;
      case 'ArrowLeft':
        if (hasChildren && open && !fold.locked) fold.setOpen(id, false);
        else if (node.row.parent !== undefined && shown.has(node.row.parent))
          focusRow(node.row.parent);
        else return;
        break;
      case 'ArrowRight':
        if (hasChildren && !open) fold.setOpen(id, true);
        else if (hasChildren) focusRow(node.children[0]?.row.id);
        else return;
        break;
      case 'F2':
        if (node.row.role === 'project') return;
        actions.rename(node.row);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isShortcut(event, '/')) return;
      event.preventDefault();
      if (!railOpen) toggleRail();
      filterRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [railOpen, toggleRail]);

  const ctx: TreeContext = {
    fold,
    drag,
    actions,
    tabStop,
    setFocused,
    onRowKey,
    filterProject: project,
    projectName,
  };
  const empty = allRows.length === 0 && projects.length === 0;

  return (
    <section ref={sectionRef} className="cr-rail" data-testid="stream-tree" aria-label="Projects">
      <div className="cr-sb-section cr-rail-hd">
        <span>Projects</span>
        <Legend />
        <IconButton
          icon="plus"
          size="sm"
          label="New project"
          data-testid="new-project-open"
          onClick={() => setNewProjectOpen(true)}
        />
      </div>
      {filterName !== undefined && (
        <div className="cr-rail-only" data-testid="project-filter">
          <Menu
            label="Switch project"
            align="start"
            items={[
              {
                label: 'All projects',
                icon: 'layers',
                testid: 'project-filter-option',
                onSelect: () => setProject(undefined),
              },
              'separator',
              ...projects.map(
                (p): MenuItem => ({
                  label: p.name,
                  icon: p.id === project ? 'check' : undefined,
                  testid: 'project-filter-option',
                  onSelect: () => setProject(p.id),
                }),
              ),
            ]}
            trigger={(props) => (
              <button
                {...props}
                type="button"
                className="cr-rail-only-name"
                data-testid="project-filter-switch"
                title="Showing one project. Switch project"
              >
                <Icon name="filter" size={12} />
                <span>
                  Only <b>{filterName}</b>
                </span>
                <Icon name="chevron-down" size={12} />
              </button>
            )}
          />
          <IconButton
            icon="x"
            size="sm"
            label="Show all projects"
            data-testid="project-filter-clear"
            onClick={() => setProject(undefined)}
          />
        </div>
      )}
      {!empty && (
        <input
          ref={filterRef}
          type="search"
          className="cr-tree-filter"
          data-testid="stream-filter"
          placeholder="Filter nodes…"
          title="Filter nodes (/)"
          aria-label="Filter nodes"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setFilter('');
              e.currentTarget.blur();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              focusRow(order[0]);
            }
          }}
        />
      )}
      {empty ? (
        <div className="cr-rail-empty" data-testid="tree-empty">
          <div className="cr-rail-empty-title">No projects yet</div>
          <p>A project holds the nodes for one product, and the repositories they work in.</p>
          <Button
            size="sm"
            icon="plus"
            data-testid="tree-empty-new-project"
            onClick={() => setNewProjectOpen(true)}
          >
            New project
          </Button>
        </div>
      ) : tree.length === 0 ? (
        <p className="cr-tree-empty">
          {filtering ? `No nodes match “${filter.trim()}”.` : 'Nothing here yet.'}
        </p>
      ) : (
        <ul className="cr-tree" aria-label="Nodes">
          {tree.map((node) => (
            <Node key={node.row.id} node={node} ctx={ctx} />
          ))}
        </ul>
      )}
      {moveError && (
        <p className="cr-error cr-tree-move-error" role="alert" data-testid="move-error">
          <span>{moveError}</span>
          <IconButton icon="x" size="sm" label="Dismiss" onClick={() => setMoveError(undefined)} />
        </p>
      )}
      {dialog !== undefined &&
        createPortal(
          dialog.kind === 'rename' ? (
            <RenameDialog row={dialog.row} onClose={() => setDialog(undefined)} />
          ) : dialog.kind === 'move' ? (
            <MoveDialog
              row={dialog.row}
              rows={allRows}
              projectName={projectName(dialog.row.project)}
              onClose={() => setDialog(undefined)}
            />
          ) : (
            <DeleteDialog
              row={dialog.row}
              rows={allRows}
              onClose={() => setDialog(undefined)}
              onDeleted={(ids) => {
                if (selected !== undefined && ids.includes(selected)) select(undefined);
              }}
            />
          ),
          document.body,
        )}
    </section>
  );
}

// ---------------------------------------------------------------- dialogs

function RenameDialog({
  row,
  onClose,
}: { row: CockpitStreamRow; onClose: () => void }): JSX.Element {
  const toast = useToast();
  const [title, setTitle] = useState(row.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const next = title.trim();
  const save = async (): Promise<void> => {
    if (busy || next === '' || next === row.title) {
      if (next === row.title) onClose();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await updateStream(row.id, { title: next });
      toast({ title: `Renamed to “${next}”`, tone: 'success', duration: 3000 });
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename node"
      size="sm"
      testid="rename-dialog"
      onSubmit={() => void save()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={next === ''}
            data-testid="rename-save"
          >
            Rename
          </Button>
        </>
      }
    >
      <Field label="Title" error={error} htmlFor="cr-rename-input">
        <input
          id="cr-rename-input"
          data-testid="rename-input"
          data-autofocus
          value={title}
          maxLength={200}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
    </Dialog>
  );
}

function MoveDialog({
  row,
  rows,
  projectName,
  onClose,
}: {
  row: CockpitStreamRow;
  rows: readonly CockpitStreamRow[];
  projectName: string | undefined;
  onClose: () => void;
}): JSX.Element {
  const toast = useToast();
  const targets = useMemo(() => moveTargets(rows, row.id), [rows, row.id]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const options: PickOption[] = targets.map(({ row: r, depth }) => ({
    value: r.id,
    text: r.role === 'project' ? `Top level of ${projectName ?? r.title}` : r.title,
    icon: <Icon name={ROLE_GLYPH[r.role]} size={14} />,
    depth,
    tag: r.id === row.parent ? 'current' : undefined,
    disabled: r.id === row.parent,
    attrs: { 'data-node': r.id },
  }));
  const chosen = targets.find((o) => o.row.id === target)?.row;
  const save = async (): Promise<void> => {
    if (!chosen || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await moveStream(row.id, chosen.id);
      toast({
        title: `Moved “${row.title}”`,
        body: chosen.role === 'project' ? 'To the top level.' : `Under ${chosen.title}.`,
        tone: 'success',
        duration: 3000,
      });
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Move “${row.title}”`}
      description={`Pick its new parent${projectName ? ` in ${projectName}` : ''}. Everything under it moves too.`}
      testid="move-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!chosen}
            data-testid="move-save"
            onClick={() => void save()}
          >
            Move here
          </Button>
        </>
      }
    >
      {options.every((o) => o.disabled) ? (
        <p className="cr-dialog-text" data-testid="move-nowhere">
          There is nowhere else in its project to move it: it already sits at the top level, and
          every other node is inside it.
        </p>
      ) : (
        <div className="cr-move-list">
          <PickList
            options={options}
            value={target}
            onPick={setTarget}
            label="New parent"
            testid="move-target"
            placeholder="Search nodes…"
            autoFocus
          />
        </div>
      )}
      {error && (
        <p className="cr-error" role="alert" data-testid="move-dialog-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}

function DeleteDialog({
  row,
  rows,
  onClose,
  onDeleted,
}: {
  row: CockpitStreamRow;
  rows: readonly CockpitStreamRow[];
  onClose: () => void;
  onDeleted: (ids: string[]) => void;
}): JSX.Element {
  const toast = useToast();
  const ids = useMemo(() => subtreeIds(rows, row.id), [rows, row.id]);
  const below = ids.length - 1;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const confirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await archiveStream(row.id);
      onDeleted(result.archived.length > 0 ? result.archived : ids);
      onClose();
      toast({
        title: `Deleted “${row.title}”`,
        body:
          below > 0 ? `And the ${below === 1 ? 'node' : `${below} nodes`} under it.` : undefined,
        tone: 'success',
        duration: 8000,
        action: {
          label: 'Undo',
          onClick: () => {
            unarchiveStream(row.id)
              .then(() =>
                toast({ title: `Restored “${row.title}”`, tone: 'success', duration: 3000 }),
              )
              .catch((err: unknown) =>
                toast({ title: 'Could not restore it', body: errorText(err), tone: 'error' }),
              );
          },
        },
      });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open
      title={deleteQuestion(row.title, below)}
      confirmLabel="Delete"
      danger
      busy={busy}
      testid="delete-dialog"
      onCancel={onClose}
      onConfirm={() => void confirm()}
    >
      <p className="cr-dialog-text">
        {below > 0 ? 'Their agents stop.' : 'Its agent stops.'}{' '}
        {below > 0 ? 'Branches and worktrees are kept' : 'Its branch and worktree are kept'}; you
        can restore {below > 0 ? 'them' : 'it'} from <b>Deleted</b> at the bottom of the sidebar.
      </p>
      {error && (
        <p className="cr-error" role="alert" data-testid="delete-error">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------- Deleted

function loadDeletedOpen(): boolean {
  try {
    return window.localStorage.getItem(DELETED_OPEN_KEY) === 'open';
  } catch {
    return false;
  }
}

/**
 * T365: the nodes Delete archived (T361's `archived` in the cockpit frame),
 * folded under "Deleted (n)" at the foot of the sidebar, each with Restore.
 * The rail's project filter applies here too.
 */
export function DeletedNodes({
  projects,
}: {
  projects: readonly CockpitProjectRow[];
}): JSX.Element | null {
  const { project, select } = useShell();
  const toast = useToast();
  const archived = useOptionalFeed()?.cockpit?.archived ?? [];
  const [open, setOpenState] = useState(loadDeletedOpen);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const shown = project === undefined ? archived : archived.filter((a) => a.project === project);
  if (shown.length === 0) return null;
  const toggle = (): void => {
    setOpenState((was) => {
      try {
        window.localStorage.setItem(DELETED_OPEN_KEY, was ? 'closed' : 'open');
      } catch {
        // Storage blocked: the fold just won't survive a reload.
      }
      return !was;
    });
  };
  const restore = (id: string, title: string): void => {
    setBusy(id);
    unarchiveStream(id)
      .then(() =>
        toast({
          title: `Restored “${title}”`,
          tone: 'success',
          action: { label: 'Open', onClick: () => select(id) },
        }),
      )
      .catch((err: unknown) =>
        toast({ title: 'Could not restore it', body: errorText(err), tone: 'error' }),
      )
      .finally(() => setBusy(undefined));
  };
  return (
    <section className="cr-rail-deleted" data-testid="deleted-nodes" aria-label="Deleted nodes">
      <div className="cr-sb-section">
        <button
          type="button"
          className="cr-sb-section-toggle"
          aria-expanded={open}
          data-testid="deleted-toggle"
          onClick={toggle}
        >
          Deleted
          <span className="cr-rail-deleted-count">{shown.length}</span>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        </button>
      </div>
      {open && (
        <ul className="cr-rail-deleted-list">
          {shown.map((a) => {
            const where = projects.find((p) => p.id === a.project)?.name;
            return (
              <li
                key={a.id}
                className="cr-rail-deleted-row"
                data-testid="archived-row"
                data-stream={a.id}
              >
                <Icon name="trash" size={13} className="cr-rail-deleted-icon" />
                <span
                  className="cr-rail-deleted-title"
                  title={where ? `${a.title} (in ${where})` : a.title}
                >
                  {a.title}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  busy={busy === a.id}
                  data-testid="archived-restore"
                  title={`Restore “${a.title}” and what was deleted with it`}
                  onClick={() => restore(a.id, a.title)}
                >
                  Restore
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
