/**
 * The left rail (cockpit design §9.2): every stream, nested, each with the
 * dot that says who must act. Clicking a stream opens its page (T161,
 * §9.3); "All streams" goes back to the whole inbox.
 * T162: a filter box (`/` focuses it) narrows the tree to matching titles,
 * keeping each match's ancestors so the nesting still reads.
 * T208: a project switcher ("All" and each project) narrows the tree to one
 * project; each row carries its derived role's icon; "New project".
 */

import { useEffect, useRef, useState } from 'react';
import type { CockpitProjectRow, CockpitStreamRow } from '../lib/feed-types';
import { isShortcut, useShell } from '../lib/shell';
import {
  DOT_LABEL,
  ROLE_ICON,
  type StreamTreeNode,
  buildStreamTree,
  filterStreamRows,
  rowsInProject,
  streamDot,
} from '../lib/streams';
import { NewProject } from './NewProject';

function Node({ node }: { node: StreamTreeNode }): JSX.Element {
  const { selected, select } = useShell();
  const dot = streamDot(node.row);
  return (
    <li>
      <button
        type="button"
        className="cr-tree-row"
        data-stream={node.row.id}
        aria-current={selected === node.row.id ? 'true' : undefined}
        data-role={node.row.role}
        title={`${node.row.title} — ${node.row.role} — ${DOT_LABEL[dot]}`}
        onClick={() => select(node.row.id)}
      >
        <span className="cr-dot" data-dot={dot} aria-label={DOT_LABEL[dot]} />
        <span className="cr-role" data-testid="role-icon" aria-label={node.row.role}>
          {ROLE_ICON[node.row.role]}
        </span>
        <span className="title">{node.row.title}</span>
      </button>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <Node key={child.row.id} node={child} />
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
  const rows = rowsInProject(allRows, project);
  const tree = buildStreamTree(filterStreamRows(rows, filter));

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
            <Node key={node.row.id} node={node} />
          ))}
        </ul>
      )}
    </aside>
  );
}
