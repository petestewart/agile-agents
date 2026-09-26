/**
 * T421 (D42): Send to parent — a conversation's conclusion, sent up to the
 * node it was asked under. It arrives there as your line, which that node's
 * agent reads as it reads its composer (a coordinator then acts at its
 * autonomy level). Prefilled with the words you picked (a reply's hover
 * action) or the conversation's last reply; yours to edit before it goes.
 */

import { useEffect, useRef, useState } from 'react';
import { sendUp } from '../lib/api';
import { Button, Dialog, Kbd } from './ui';

export function SendUpDialog({
  node,
  parentTitle,
  initial,
  onClose,
  onSent,
}: {
  node: string;
  parentTitle: string;
  initial: string;
  onClose: () => void;
  onSent: (parent: string) => void;
}): JSX.Element {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const send = async (): Promise<void> => {
    if (busy || text.trim() === '') return;
    setBusy(true);
    setError(undefined);
    try {
      const { parent } = await sendUp(node, text.trim());
      onSent(parent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Send to ${parentTitle}`}
      description="It arrives there as your message; its agent reads it and acts on it."
      size="md"
      testid="send-up"
      label={`Send to ${parentTitle}`}
      onSubmit={() => void send()}
      footer={
        <>
          <span className="cr-newnode-keys">
            <Kbd>{navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>↵</Kbd> to send
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={text.trim() === ''}
            data-testid="send-up-send"
          >
            Send
          </Button>
        </>
      }
    >
      <textarea
        ref={box}
        className="cr-ask-input"
        data-testid="send-up-input"
        aria-label="What to send"
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {error && (
        <p className="cr-error" role="alert" data-testid="send-up-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
