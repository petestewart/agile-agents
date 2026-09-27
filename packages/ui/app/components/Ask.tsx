/**
 * T419 (D42): Ask — a question at the level you choose, as its own thread,
 * without leaving your flow. `a` (or "Ask about this…" on a node) opens one
 * box aimed at the open node; the picker re-aims it at any node or the
 * Director. Enter sends: about a node, it makes a conversation under it
 * (named for you, its agent started) and opens it; about the Director, it is
 * a line in the Director's thread. Shift+Enter is a new line.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createStream, sayToDirector } from '../lib/api';
import { DIRECTOR_TARGET, askHint, askTargets, focusComposerOn } from '../lib/ask';
import { useOptionalFeed } from '../lib/feed-context';
import type { CockpitProjectRow, CockpitStreamRow } from '../lib/feed-types';
import { isShortcut, useShell } from '../lib/shell';
import { titleFromGoal } from '../lib/tree';
import { Icon } from './Icon';
import { type PickOption, PickerField } from './Pickers';
import { ROLE_GLYPH } from './StreamTree';
import { Button, Dialog, Field, Kbd, StatusDot } from './ui';

export function Ask({
  rows,
  projects,
}: {
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
}): JSX.Element | null {
  const { askAbout, openAsk } = useShell();

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // A focused Needs me card takes A for its first choice (T416) and prevents the default.
      if (askAbout === undefined && !event.defaultPrevented && isShortcut(event, 'a')) {
        if (document.querySelector('.cr-modal')) return;
        event.preventDefault();
        openAsk();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [askAbout, openAsk]);

  if (askAbout === undefined) return null;
  // Each opening mounts a fresh box.
  return <AskBox key={askAbout} initial={askAbout} rows={rows} projects={projects} />;
}

function AskBox({
  initial,
  rows,
  projects,
}: {
  initial: string;
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
}): JSX.Element {
  const { openAsk, select, setView } = useShell();
  const feed = useOptionalFeed();
  const [target, setTarget] = useState(initial);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const box = useRef<HTMLTextAreaElement>(null);
  const targets = useMemo(() => askTargets(rows, projects), [rows, projects]);
  const chosen = targets.find((t) => t.value === target);
  const close = (): void => openAsk(null);

  useEffect(() => {
    box.current?.focus();
  }, []);

  // T435 (#20): each node with its status dot, as the rail shows it (merged and closed ones last).
  const options: PickOption[] = targets.map((t) => ({
    value: t.value,
    text: t.title,
    icon: (
      <span className="cr-ask-pick-icon">
        {t.row ? <StatusDot row={t.row} /> : <span className="cr-ask-pick-nodot" />}
        <Icon
          name={t.value === DIRECTOR_TARGET ? 'sparkles' : ROLE_GLYPH[t.role ?? 'work']}
          size={14}
        />
      </span>
    ),
    depth: t.depth,
    ...(t.project !== undefined ? { group: t.project } : {}),
    attrs: { 'data-target': t.value },
  }));

  const send = async (): Promise<void> => {
    const question = text.trim();
    if (busy || question === '') return;
    setBusy(true);
    setError(undefined);
    try {
      if (target === DIRECTOR_TARGET) {
        await sayToDirector(question);
        close();
        setView('director');
        return;
      }
      const created = await createStream({
        title: titleFromGoal(question) || 'Question',
        goal: question,
        parent: target,
        // Named for you (D41); its agent starts with the question.
        auto_title: true,
      });
      feed?.refresh();
      close();
      // T435 (#20): straight on to the conversation's composer, for a follow-up.
      focusComposerOn(created.id);
      select(created.id, { tab: 'thread' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Ask"
      size="md"
      testid="ask"
      label="Ask"
      onSubmit={() => void send()}
      footer={
        <>
          <span className="cr-newnode-keys">
            <Kbd>↵</Kbd> to ask · <Kbd>Shift</Kbd>
            <Kbd>↵</Kbd> new line
          </span>
          <Button onClick={close}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={text.trim() === ''}
            data-testid="ask-send"
          >
            Ask
          </Button>
        </>
      }
    >
      <div className="cr-ask">
        <Field label="About" hint={askHint(chosen)}>
          <PickerField
            testid="ask-target"
            label="Ask about"
            value={target}
            display={
              <span className="cr-ask-target">
                <Icon
                  name={
                    target === DIRECTOR_TARGET ? 'sparkles' : ROLE_GLYPH[chosen?.role ?? 'work']
                  }
                  size={14}
                />
                {chosen?.title ?? 'The Director'}
              </span>
            }
            options={options}
            placeholder="Search nodes…"
            onPick={setTarget}
          />
        </Field>
        <textarea
          ref={box}
          className="cr-ask-input"
          data-testid="ask-input"
          aria-label="Your question"
          rows={3}
          placeholder="Ask a question, or think something through…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {error && (
          <p className="cr-error" role="alert" data-testid="ask-error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
