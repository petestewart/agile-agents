/**
 * T421 (D42): Send to parent — a conversation's conclusion, sent up to the
 * node it was asked under. It arrives there as your line, which that node's
 * agent reads as it reads its composer (a coordinator then acts at its
 * autonomy level). Prefilled with the words you picked (a reply's hover
 * action) or the conversation's last reply; yours to edit before it goes.
 *
 * T435: Enter sends and Shift+Enter is a new line, as in Ask and the
 * composer (Ctrl/⌘+Enter still sends). Near its cap (`SEND_UP_MAX_CHARS`)
 * the box counts; past it Send is off and says "Shorten it, or send the key
 * point". A refusal reads in words (`sendUpFailure`), never the schema's.
 */

import { SEND_UP_MAX_CHARS } from '@agile-agents/shared';
import { useEffect, useRef, useState } from 'react';
import { sendUp } from '../lib/api';
import { TOO_LONG_FIX, lengthBudget, sendUpFailure } from '../lib/errors';
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
  const budget = lengthBudget(text.trim().length, SEND_UP_MAX_CHARS);

  const send = async (): Promise<void> => {
    if (busy || text.trim() === '' || budget.over) return;
    setBusy(true);
    setError(undefined);
    try {
      const { parent } = await sendUp(node, text.trim());
      onSent(parent);
    } catch (err) {
      setError(sendUpFailure(err, SEND_UP_MAX_CHARS));
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
            <Kbd>↵</Kbd> to send · <Kbd>Shift</Kbd>
            <Kbd>↵</Kbd> new line
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={text.trim() === '' || budget.over}
            title={budget.over ? TOO_LONG_FIX : undefined}
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
        aria-invalid={budget.over ? true : undefined}
        aria-describedby={budget.show ? 'send-up-count' : undefined}
        rows={8}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(undefined);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
          e.preventDefault();
          void send();
        }}
      />
      {budget.show && (
        <p
          id="send-up-count"
          className="cr-charcount"
          data-testid="send-up-count"
          data-over={budget.over ? 'true' : undefined}
          aria-live="polite"
        >
          {budget.over && <span className="cr-charcount-fix">{TOO_LONG_FIX}</span>}
          <span className="cr-charcount-num">{budget.count}</span>
        </p>
      )}
      {error && (
        <p className="cr-error" role="alert" data-testid="send-up-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
