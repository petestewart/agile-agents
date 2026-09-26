/**
 * The left rail (cockpit design §9.2): every stream, nested, each with the
 * dot that says who must act. Clicking a stream opens its page (T161,
 * §9.3); "All streams" goes back to the whole inbox.
 * T162: a filter box (`/` focuses it) narrows the tree to matching titles,
 * keeping each match's ancestors so the nesting still reads.
 * T208: a project switcher ("All" and each project) narrows the tree to one
 * project; each row carries its derived role's icon; "New project".
 * T331: a caret folds a node's subtree without opening it (double-click or
 * Left/Right on the row too). The folded set is a per-viewer convenience in
 * localStorage; a folded row whose subtree waits on you shows that dot.
 * T333 (D34): drag a row onto another row in its project to move it there
 * (onto the project row: to the top level). The daemon refuses what D34
 * refuses; the rail shows why.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { moveStream } from '../lib/api';
import type { CockpitProjectRow, CockpitStreamRow } from '../lib/feed-types';
import { isShortcut, useShell } from '../lib/shell';
import {
  DOT_LABEL,
  ROLE_ICON,
  type StreamTreeNode,
  buildStreamTree,
  filterStreamRows,
  parseCollapsed,
  rowsInProject,
  streamDot,
  subtreeNeedsYou,
} from '../lib/streams';
import { NewProject } from './NewProject';

/** T333: the rail's drag state; `canDrop` is a hint, the daemon decides. */
interface DragProps {
  dragging: string | undefined;
  over: string | undefined;
  setDragging: (id: string | undefined) => void;
  setOver: (id: string | undefined) => void;
  canDrop: (target: string) => boolean;
  drop: (target: string) => void;
}

const COLLAPSED_KEY = 'agile.rail.collapsed';

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

interface Fold {
  /** While the filter is on, every match shows, folded or not, and the carets rest. */
  locked: boolean;
  isOpen(id: string): boolean;
  setOpen(id: string, open: boolean): void;
}

function Node({
  node,
  fold,
  drag,
}: {
  node: StreamTreeNode;
  fold: Fold;
  drag: DragProps;
}): JSX.Element {
  const { selected, select } = useShell();
  const dot = streamDot(node.row);
  const id = node.row.id;
  const hasChildren = node.children.length > 0;
  const open = !hasChildren || fold.isOpen(id);
  const hiddenNeedsYou = !open && subtreeNeedsYou(node);
  return (
    <li>
      {hasChildren && (
        <button
          type="button"
          className="cr-tree-caret"
          data-testid="tree-caret"
          aria-expanded={open}
          aria-controls={`cr-tree-kids-${id}`}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${node.row.title}`}
          disabled={fold.locked}
          onClick={() => fold.setOpen(id, !open)}
        >
          {open ? '\u25BE' : '\u25B8'}
        </button>
      )}
      <button
        type="button"
        className="cr-tree-row"
        data-stream={id}
        draggable={node.row.role !== 'project'}
        data-drop-target={drag.over === id ? 'true' : undefined}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', id);
          drag.setDragging(id);
        }}
        onDragEnd={() => {
          drag.setDragging(undefined);
          drag.setOver(undefined);
        }}
        onDragOver={(e) => {
          if (!drag.canDrop(id)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (drag.over !== id) drag.setOver(id);
        }}
        onDragLeave={() => {
          if (drag.over === id) drag.setOver(undefined);
        }}
        onDrop={(e) => {
          e.preventDefault();
          drag.drop(id);
        }}
        aria-current={selected === id ? 'true' : undefined}
        aria-expanded={hasChildren ? open : undefined}
        data-role={node.row.role}
        title={`${node.row.title} — ${node.row.role} — ${DOT_LABEL[dot]}`}
        onClick={() => select(id)}
        onDoubleClick={() => {
          if (hasChildren) fold.setOpen(id, !open);
        }}
        onKeyDown={(e) => {
          if (!hasChildren) return;
          if (e.key === 'ArrowLeft' && open) fold.setOpen(id, false);
          else if (e.key === 'ArrowRight' && !open) fold.setOpen(id, true);
          else return;
          e.preventDefault();
        }}
      >
        <span className="cr-dot" data-dot={dot} aria-label={DOT_LABEL[dot]} />
        <span className="cr-role" data-testid="role-icon" aria-label={node.row.role}>
          {ROLE_ICON[node.row.role]}
        </span>
        {/* T347 (D36 D11): the plan badge sits on its own line, so the title keeps the width. */}
        <span className="cr-tree-label">
          <span className="title">{node.row.title}</span>
          {node.row.waiting_for_plan && (
            <span className="cr-waiting" data-testid="waiting-for-plan">
              waiting for the plan
            </span>
          )}
        </span>
        {node.row.overlap && (
          <span className="cr-overlap" data-testid="overlap-mark" title="overlapping changes">
            ⚠
          </span>
        )}
        {node.row.visibility_advisory && (
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
      {hasChildren && open && (
        <ul id={`cr-tree-kids-${id}`}>
          {node.children.map((child) => (
            <Node key={child.row.id} node={child} fold={fold} drag={drag} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function StreamTree({
  rows: allRows,
  projects,
}: {
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
}): JSX.Element {
  const { selected, select, railOpen, toggleRail, project, setProject } = useShell();
  const [filter, setFilter] = useState('');
  const [newProjectOpen, setNewProjectOpen] = useState(false);
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
  const [dragging, setDragging] = useState<string | undefined>(undefined);
  const [over, setOver] = useState<string | undefined>(undefined);
  const [moveError, setMoveError] = useState<string | undefined>(undefined);
  const byId = new Map(allRows.map((r) => [r.id, r]));
  const drag: DragProps = {
    dragging,
    over,
    setDragging,
    setOver,
    canDrop: (target) => {
      const moving = dragging !== undefined ? byId.get(dragging) : undefined;
      const to = byId.get(target);
      if (!moving || !to || moving.parent === target || moving.project !== to.project) {
        return false;
      }
      for (let cur: string | undefined = target; cur; cur = byId.get(cur)?.parent) {
        if (cur === moving.id) return false;
      }
      return true;
    },
    drop: (target) => {
      const moving = dragging;
      setDragging(undefined);
      setOver(undefined);
      if (moving === undefined || moving === target) return;
      setMoveError(undefined);
      moveStream(moving, target).catch((err: unknown) =>
        setMoveError(err instanceof Error ? err.message : String(err)),
      );
    },
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

  return (
    <aside className="cr-rail" id="cr-rail" data-testid="stream-tree">
      <h2>Streams</h2>
      <div className="cr-project-bar">
        <select
          data-testid="project-switcher"
          aria-label="Project"
          value={project ?? ''}
          onChange={(e) => setProject(e.target.value || undefined)}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="cr-btn"
          data-testid="new-project-open"
          onClick={() => setNewProjectOpen(true)}
        >
          New project
        </button>
      </div>
      {newProjectOpen && <NewProject onClose={() => setNewProjectOpen(false)} />}
      <input
        ref={filterRef}
        type="search"
        className="cr-tree-filter"
        data-testid="stream-filter"
        placeholder="Filter streams (/)"
        aria-label="Filter streams"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setFilter('');
            e.currentTarget.blur();
          }
        }}
      />
      {rows.length === 0 ? (
        <p className="cr-tree-empty">No streams yet.</p>
      ) : (
        <ul className="cr-tree">
          <li>
            <button
              type="button"
              className="cr-tree-row"
              aria-current={selected === undefined ? 'true' : undefined}
              onClick={() => select(undefined)}
            >
              <span className="title">All streams</span>
            </button>
          </li>
          {tree.map((node) => (
            <Node key={node.row.id} node={node} fold={fold} drag={drag} />
          ))}
        </ul>
      )}
      {moveError && (
        <p className="cr-error" role="alert" data-testid="move-error">
          {moveError}
        </p>
      )}
    </aside>
  );
}
