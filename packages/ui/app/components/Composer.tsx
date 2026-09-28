/**
 * T363: the composer (design/cockpit-ui.md §7): a rounded box with a
 * textarea that grows from one line to ten, Send (Enter; Shift+Enter is a
 * newline, never mid-IME composition), Stop while the agent works, a chip
 * slot (the model that runs or would start), a slot above the box (the
 * question being answered), and one hint line saying what Send will do.
 *
 * It knows nothing about streams: the page decides what Send means.
 * `DraftComposer` keeps a node's draft for it (T447).
 *
 * T461: given the agent's slash commands (`slash`), typing `/` opens a
 * menu of them (arrows, Enter or Tab to pick, Escape to close), the hint
 * says what a command line will do, and one the cockpit can't run
 * (`/login`) is held with what to do instead.
 */

import {
  type ReactNode,
  forwardRef,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type SlashContext, commandHint, commandMenu, heldCommand } from '../lib/commands';
import { useComposerDraft } from '../lib/drafts';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
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
  /**
   * T416: why Send is off for now (the daemon is away: "Reconnecting to the
   * daemon…"), as its tooltip. The text stays editable, and Enter still
   * calls `onSend`, so the page can say what happened.
   */
  sendBlocked?: string;
  /** T461: the agent's slash commands; absent, a `/` line is just text. */
  slash?: SlashContext;
  /** T461: a line started with `/` (the page re-reads the commands: they arrive after the start). */
  onSlash?: () => void;
}

export interface ComposerHandle {
  focus(): void;
  /** T393: focus with the caret after the last character, scrolled to it (text just added). */
  focusEnd(): void;
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
    sendBlocked,
    slash,
    onSlash,
  },
  ref,
): JSX.Element {
  const area = useRef<HTMLTextAreaElement>(null);
  const menuId = useId();
  // T461: the `/` menu's highlighted row, whether Escape closed it, and a held command's note.
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [held, setHeld] = useState<string | undefined>(undefined);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => area.current?.focus(),
      focusEnd: () => {
        const el = area.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        el.scrollTop = el.scrollHeight;
      },
    }),
    [],
  );
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

  const menu = slash && !dismissed && !disabled ? commandMenu(value, slash.commands) : undefined;
  const menuOpen = menu !== undefined && (menu.length > 0 || value === '/');
  const current = menu !== undefined && menu.length > 0 ? Math.min(active, menu.length - 1) : -1;
  const shownHint = (slash && commandHint(value, slash)) ?? hint;

  const change = (next: string): void => {
    setHeld(undefined);
    setActive(0);
    if (!next.startsWith('/')) setDismissed(false);
    else if (!value.startsWith('/')) onSlash?.();
    onChange(next);
  };

  const pick = (name: string): void => {
    change(`/${name} `);
    area.current?.focus();
  };

  const send = (): void => {
    if (busy || disabled || text.length === 0) return;
    const hold = slash ? heldCommand(text, slash) : undefined;
    if (hold !== undefined) {
      setHeld(hold);
      return;
    }
    onSend();
  };

  const onMenuKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!menuOpen || menu === undefined) return false;
    if (e.key === 'Escape') {
      setDismissed(true);
      return true;
    }
    if (menu.length === 0) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((current + step + menu.length) % menu.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === 'Tab') {
      const c = menu[current];
      if (c !== undefined) pick(c.name);
      return true;
    }
    return false;
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
        {menuOpen && menu !== undefined && (
          <div
            className="cr-slash-menu"
            id={menuId}
            // biome-ignore lint/a11y/useSemanticElements: a combobox's popup listbox; focus stays in the box (aria-activedescendant), which a native <select> can't do.
            role="listbox"
            aria-label="Commands"
            tabIndex={-1}
            data-testid="slash-menu"
          >
            {menu.length === 0 ? (
              <div className="cr-slash-empty" data-testid="slash-empty">
                {slash?.running
                  ? 'This agent offers no commands.'
                  : 'Commands load once the agent is running. Send a message to start it.'}
              </div>
            ) : (
              menu.map((c, i) => (
                <div
                  key={c.name}
                  id={`${menuId}-${i}`}
                  // biome-ignore lint/a11y/useSemanticElements: an option of the listbox above; a native <option> can't hold the name and its description.
                  role="option"
                  aria-selected={i === current}
                  tabIndex={-1}
                  className="cr-slash-item"
                  data-active={i === current ? 'true' : undefined}
                  data-testid="slash-item"
                  onMouseDown={(e) => {
                    // Keep the focus in the box.
                    e.preventDefault();
                    pick(c.name);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="cr-slash-name">
                    /{c.name}
                    {c.hint !== undefined && <span className="cr-slash-arg"> {c.hint}</span>}
                  </span>
                  {c.description !== '' && <span className="cr-slash-desc">{c.description}</span>}
                </div>
              ))
            )}
          </div>
        )}
        <textarea
          ref={area}
          data-testid={inputTestid}
          aria-label={label}
          rows={1}
          maxLength={maxLength}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => change(e.target.value)}
          {...(menuOpen
            ? {
                'aria-controls': menuId,
                'aria-expanded': true,
                ...(current >= 0 ? { 'aria-activedescendant': `${menuId}-${current}` } : {}),
              }
            : {})}
          onKeyDown={(e) => {
            if (onMenuKey(e)) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
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
            title={sendBlocked ?? 'Send (Enter)'}
            data-blocked={sendBlocked !== undefined ? 'true' : undefined}
            disabled={busy || disabled || text.length === 0 || sendBlocked !== undefined}
          >
            {busy ? <Spinner size={14} /> : <Icon name="arrow-up" size={16} strokeWidth={2.25} />}
          </button>
        </div>
      </form>
      {held !== undefined && (
        <div className="cr-compose-held" role="alert" data-testid="composer-held">
          <Markdown text={held} />
        </div>
      )}
      {shownHint !== undefined && (
        <div className="cr-compose-hint">
          <span data-testid="composer-hint">{shownHint}</span>
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

/**
 * T447 (audit r7 #15): a Composer that holds a node's kept draft itself
 * (`useComposerDraft`: per node, across a reload). A keystroke re-renders
 * this alone, not the page around it and its chat, which on a long thread
 * cost ~60 ms a key. `after` renders under it with the draft (a Retry that
 * needs text).
 */
export const DraftComposer = forwardRef<
  ComposerHandle,
  Omit<ComposerProps, 'value' | 'onChange'> & {
    node: string;
    after?: (draft: string) => ReactNode;
  }
>(function DraftComposer({ node, after, ...props }, ref) {
  const [draft, setDraft] = useComposerDraft(node);
  return (
    <>
      <Composer ref={ref} {...props} value={draft} onChange={setDraft} />
      {after?.(draft)}
    </>
  );
});
