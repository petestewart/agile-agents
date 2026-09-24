/**
 * The Director page (T300, projects-design §12, P16): the Director's own
 * thread with a composer, and its activity (the `director_request`s routed
 * to it and what carried them). Re-read on every pushed frame.
 */

import { type FormEvent, useEffect, useState } from 'react';
import { type DirectorPayload, getDirector, sayToDirector } from '../lib/api';
import { useFeed } from '../lib/feed-context';
import { Markdown } from './Markdown';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
              <Markdown text={entry.body} />
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
              <span className="cr-dim">
                {' '}
                · {row.status}
                {row.session ? ` in session ${row.session}` : ''} · {row.event.at}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
