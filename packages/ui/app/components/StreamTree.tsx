/**
 * The left rail (cockpit design §9.2): every stream, nested, each with the
 * dot that says who must act. Clicking a stream narrows the inbox to it
 * and its descendants; "All streams" clears that.
 */

import type { CockpitStreamRow } from '../lib/feed-types';
import { useShell } from '../lib/shell';
import { DOT_LABEL, type StreamTreeNode, buildStreamTree, streamDot } from '../lib/streams';

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
        onClick={() => select(selected === node.row.id ? undefined : node.row.id)}
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
  const { selected, select } = useShell();
  const tree = buildStreamTree(rows);
  return (
    <aside className="cr-rail" id="cr-rail" data-testid="stream-tree">
      <h2>Streams</h2>
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
