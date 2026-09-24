/**
 * The left rail (cockpit design §9.2): every stream, nested, each with the
 * dot that says who must act. Clicking a stream opens its page (T161,
 * §9.3); "All streams" goes back to the whole inbox.
 * T162: a filter box (`/` focuses it) narrows the tree to matching titles,
 * keeping each match's ancestors so the nesting still reads.
 */

import { useEffect, useRef, useState } from 'react';
import type { CockpitStreamRow } from '../lib/feed-types';
import { isShortcut, useShell } from '../lib/shell';
import {
  DOT_LABEL,
  type StreamTreeNode,
  buildStreamTree,
  filterStreamRows,
  streamDot,
} from '../lib/streams';

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
        title={`${node.row.title} — ${DOT_LABEL[dot]}`}
        onClick={() => select(node.row.id)}
      >
        <span className="cr-dot" data-dot={dot} aria-label={DOT_LABEL[dot]} />
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

export function StreamTree({ rows }: { rows: readonly CockpitStreamRow[] }): JSX.Element {
  const { selected, select, railOpen, toggleRail } = useShell();
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
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
