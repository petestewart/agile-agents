/**
 * The Director page (T300, projects-design §12, P16): the Director's own
 * thread with a composer, and its activity (the `director_request`s routed
 * to it and what carried them). Re-read on every pushed frame.
 */

import type { AutonomyProposal } from '@agile-agents/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { type DirectorPayload, decideProposal, getDirector, sayToDirector } from '../lib/api';
import { useFeed } from '../lib/feed-context';
import { activityDelivery, eventTime } from '../lib/streams';
import { ThreadBody } from './StreamPage';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** T301: a held Director change. A draft tree renders as the tree it would build. */
function DirectorProposal(props: {
  proposal: AutonomyProposal;
  onDecide: (decision: 'apply' | 'dismiss') => void;
}): JSX.Element {
  const { proposal, onDecide } = props;
  const change = proposal.change;
  const tree = change.action === 'create_tree' ? change.tree : undefined;
  return (
    <li data-testid="director-proposal" data-id={proposal.id} data-action={change.action}>
      {tree ? (
        <ul className="cr-tree" data-testid="director-draft-tree">
          <li>
            <strong>{tree.new_project ?? tree.project}</strong>
            {tree.new_project ? <span className="cr-dim"> (new project)</span> : null}
            <ul>
              <li data-testid="director-draft-node">
                {tree.title}
                <span className="cr-dim"> · {tree.goal}</span>
                <ul>
                  {tree.parts.map((part, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: parts are referenced by index.
                    <li key={i} data-testid="director-draft-part">
                      {part.title}
                      {part.repo ? <span className="cr-dim"> on {part.repo}</span> : null}
                      {(part.after ?? []).length > 0 ? (
                        <span className="cr-dim">
                          {' '}
                          · waits on{' '}
                          {(part.after ?? []).map((a) => tree.parts[a]?.title ?? a).join(', ')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      ) : (
        <p>{proposal.summary}</p>
      )}
      <div className="cr-actions">
        <button
          type="button"
          className="cr-btn signal"
          data-testid="director-create"
          onClick={() => onDecide('apply')}
        >
          {tree || change.action.startsWith('create_') ? 'Create' : 'Apply'}
        </button>
        <button
          type="button"
          className="cr-btn"
          data-testid="director-dismiss"
          onClick={() => onDecide('dismiss')}
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}

export function DirectorPage(): JSX.Element {
  const { cockpit } = useFeed();
  const [page, setPage] = useState<DirectorPayload | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');
  const [seq, setSeq] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `cockpit` (the pushed frame) and `seq` are re-read triggers.
  useEffect(() => {
    let live = true;
    getDirector()
      .then((p) => {
        if (!live) return;
        setPage(p);
        setError(undefined);
      })
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [cockpit, seq]);

  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const line = text.trim();
    if (!line) return;
    try {
      await sayToDirector(line);
      setText('');
      setSeq((n) => n + 1);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const decide = async (id: string, decision: 'apply' | 'dismiss'): Promise<void> => {
    try {
      await decideProposal(id, decision);
      setSeq((n) => n + 1);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const session = page?.record?.session;
  return (
    <section className="cr-stream" data-testid="director-page">
      <header className="cr-stream-hd">
        <h1>Director</h1>
        <p className="cr-dim" data-testid="director-session">
          {session
            ? `${session.vendor}/${session.model} · ${page?.live ? 'live' : session.status}`
            : 'No session yet: a line below starts one.'}
        </p>
      </header>
      {error && <p className="cr-dim">{error}</p>}
      <section className="cr-thread-wrap">
        <ol className="cr-thread" data-testid="director-thread">
          {(page?.thread ?? []).map((entry, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: the thread is append-only, so an index is stable.
              key={i}
              data-testid="thread-entry"
              data-kind={entry.kind}
              data-by={entry.by === 'human' || entry.by === 'daemon' ? entry.by : 'director'}
            >
              <div className="who">
                {entry.by}
                {entry.kind !== 'line' ? ` · ${entry.kind}` : ''}
              </div>
              <ThreadBody body={entry.body} />
            </li>
          ))}
        </ol>
        <form className="cr-composer" onSubmit={send}>
          <textarea
            data-testid="director-composer"
            aria-label="Message the Director"
            rows={2}
            maxLength={800}
            placeholder="Tell the Director…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="submit"
            className="cr-btn"
            data-testid="director-send"
            disabled={!text.trim()}
          >
            Send
          </button>
        </form>
      </section>
      {(page?.proposals ?? []).length > 0 && (
        <>
          <h2>Drafts</h2>
          <ul className="cr-docs" data-testid="director-proposals">
            {(page?.proposals ?? []).map((p) => (
              <DirectorProposal key={p.id} proposal={p} onDecide={(d) => void decide(p.id, d)} />
            ))}
          </ul>
        </>
      )}
      <h2>Activity</h2>
      {(page?.activity ?? []).length === 0 ? (
        <p className="cr-dim" data-testid="director-activity-empty">
          Nothing routed to the Director yet.
        </p>
      ) : (
        <ul className="cr-docs" data-testid="director-activity">
          {(page?.activity ?? []).map((row) => (
            <li key={row.event.id} data-testid="director-activity-row">
              <span>{row.event.type.replace(/_/g, ' ')}</span>
              <span
                className="cr-dim"
                title={[row.session, row.event.at].filter(Boolean).join(' · ')}
              >
                {' '}
                · {activityDelivery(row, [], 'Director')} · {eventTime(row.event.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
