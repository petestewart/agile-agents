/**
 * T363: the composer (design/cockpit-ui.md §7): a rounded box with a
 * textarea that grows from one line to ten, Send (Enter; Shift+Enter is a
 * newline, never mid-IME composition), Stop while the agent works, a chip
 * slot (the model that runs or would start), a slot above the box (the
 * question being answered), and one hint line saying what Send will do.
 *
 * It knows nothing about streams: the page decides what Send means.
 */

import { type ReactNode, forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Icon } from './Icon';
import { Kbd, Spinner } from './ui';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Present while the agent works: a Stop button beside Send. */
  onStop?: () => void;
  busy?: boolean;
  /** No sending at all (a merged or closed node); `hint` says why. */
  disabled?: boolean;
  placeholder: string;
  hint?: ReactNode;
  /** Above the text: the "Answering: …" chip. */
  above?: ReactNode;
  /** Left of the buttons: the model chip. */
  chip?: ReactNode;
  maxLength?: number;
  label?: string;
  inputTestid?: string;
  sendTestid?: string;
  /** Marks the box (e.g. `answer`) so it can take the question's accent. */
  mode?: string;
}

export interface ComposerHandle {
  focus(): void;
}

const MAX_LINES = 10;

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    value,
    onChange,
    onSend,
    onStop,
    busy = false,
    disabled = false,
    placeholder,
    hint,
    above,
    chip,
    maxLength = 800,
    label = 'Message',
    inputTestid = 'composer-input',
    sendTestid = 'composer-send',
    mode,
  },
  ref,
): JSX.Element {
  const area = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);
  const text = value.trim();

  // Grow with the text, one line to ten; past that it scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 22;
    const pad =
      Number.parseFloat(getComputedStyle(el).paddingTop) +
      Number.parseFloat(getComputedStyle(el).paddingBottom);
    const max = line * MAX_LINES + pad;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value]);

  const send = (): void => {
    if (busy || disabled || text.length === 0) return;
    onSend();
  };

  return (
    <div className="cr-composer-wrap">
      <form
        className="cr-compose"
        data-mode={mode}
        data-disabled={disabled ? 'true' : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        {above}
        <textarea
          ref={area}
          data-testid={inputTestid}
          aria-label={label}
          rows={1}
          maxLength={maxLength}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline; never mid-IME composition.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="cr-compose-bar">
          <div className="cr-compose-chips">{chip}</div>
          {onStop && (
            <button
              type="button"
              className="cr-compose-stop"
              data-testid="composer-stop"
              aria-label="Stop the agent"
              title="Stop the agent"
              onClick={onStop}
            >
              <Icon name="square" size={11} />
            </button>
          )}
          <button
            type="submit"
            className="cr-compose-send"
            data-testid={sendTestid}
            aria-label="Send"
            title="Send (Enter)"
            disabled={busy || disabled || text.length === 0}
          >
            {busy ? <Spinner size={14} /> : <Icon name="arrow-up" size={16} strokeWidth={2.25} />}
          </button>
        </div>
      </form>
      {hint !== undefined && (
        <div className="cr-compose-hint">
          <span data-testid="composer-hint">{hint}</span>
          {!disabled && (
            <span className="cr-compose-keys" aria-hidden="true">
              <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line
            </span>
          )}
        </div>
      )}
    </div>
  );
});
