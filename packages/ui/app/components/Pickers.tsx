/**
 * T365: the pickers the rail's dialogs share — a searchable list of
 * choices (`PickList`: New node's Parent and Repository, Move to…'s
 * target) and a form field that opens one in a popover (`PickerField`).
 * The input keeps focus; the arrow keys move the highlight and Enter
 * picks it (the combobox pattern), so Enter never submits the dialog
 * behind it.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Icon } from './Icon';
import { Popover } from './ui';

export interface PickOption {
  /** What `onPick` receives; `''` is fine (Top level, No repository). */
  value: string;
  /** What the search matches, and the label when `label` is absent. */
  text: string;
  label?: ReactNode;
  icon?: ReactNode;
  /** Muted text after the label (a repo's kind, a node's status). */
  sub?: ReactNode;
  /** Indentation under its root, in levels (dropped while searching). */
  depth?: number;
  /** A small tag at the end ("current"). */
  tag?: ReactNode;
  /** A section title shown above the first option of each group (not while searching). */
  group?: string;
  /** Shown whatever the search (Top level, No repository). */
  pinned?: boolean;
  disabled?: boolean;
  /** Extra attributes for tests: `data-node`, `data-repo`. */
  attrs?: Record<string, string>;
}

export function PickList({
  options,
  value,
  onPick,
  testid,
  label,
  placeholder = 'Search…',
  search = true,
  autoFocus = false,
  empty = 'Nothing matches.',
}: {
  options: readonly PickOption[];
  value: string;
  onPick: (value: string) => void;
  testid: string;
  /** The list's accessible name. */
  label: string;
  placeholder?: string;
  /** Show the search box (off for a short list). */
  search?: boolean;
  autoFocus?: boolean;
  empty?: string;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      q === '' ? options : options.filter((o) => o.pinned || o.text.toLowerCase().includes(q)),
    [options, q],
  );
  const pickable = shown.filter((o) => !o.disabled);
  const [active, setActive] = useState<string>(value);
  const activeValue = pickable.some((o) => o.value === active) ? active : pickable[0]?.value;
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) (inputRef.current ?? listRef.current)?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (activeValue === undefined) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-pick-value="${CSS.escape(activeValue)}"]`,
    );
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeValue]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const at = pickable.findIndex((o) => o.value === activeValue);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (pickable.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = pickable[(at + step + pickable.length) % pickable.length];
      if (next) setActive(next.value);
    } else if (event.key === 'Enter') {
      // Never the dialog's submit: Enter here picks.
      event.preventDefault();
      if (activeValue !== undefined) onPick(activeValue);
    }
  };

  const optionId = (v: string): string => `${listId}-${encodeURIComponent(v) || 'none'}`;
  let lastGroup: string | undefined;
  return (
    <div className="cr-picklist" data-testid={testid ? `${testid}-list` : undefined}>
      {search ? (
        <div className="cr-picklist-search">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeValue !== undefined ? optionId(activeValue) : undefined}
            aria-label={`Search ${label.toLowerCase()}`}
            data-testid={`${testid}-search`}
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      ) : null}
      <div
        ref={listRef}
        id={listId}
        className="cr-picklist-list"
        // biome-ignore lint/a11y/useSemanticElements: rows with icons and tags, searched from the box above; a <select> can't.
        role="listbox"
        aria-label={label}
        tabIndex={search ? -1 : 0}
        onKeyDown={search ? undefined : onKeyDown}
      >
        {shown.length === 0 || (q !== '' && shown.every((o) => o.pinned)) ? (
          <>
            {shown.map((o) => renderOption(o))}
            <div className="cr-picklist-empty">{empty}</div>
          </>
        ) : (
          shown.map((o) => {
            const header = q === '' && o.group !== undefined && o.group !== lastGroup;
            lastGroup = o.group;
            return (
              <div key={o.value || '__none'} className="cr-picklist-item">
                {header ? <div className="cr-picklist-group">{o.group}</div> : null}
                {renderOption(o)}
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  function renderOption(o: PickOption): JSX.Element {
    const selected = o.value === value;
    return (
      <button
        key={o.value || '__none'}
        type="button"
        id={optionId(o.value)}
        // biome-ignore lint/a11y/useSemanticElements: a clickable row with an icon and a tag; <option> only lives in a <select>.
        role="option"
        tabIndex={-1}
        className="cr-pick"
        aria-selected={selected}
        data-active={o.value === activeValue ? 'true' : undefined}
        data-pick-value={o.value}
        data-testid={`${testid}-option`}
        disabled={o.disabled}
        style={q === '' && o.depth ? { paddingLeft: 8 + o.depth * 16 } : undefined}
        onMouseMove={() => {
          if (!o.disabled && o.value !== activeValue) setActive(o.value);
        }}
        onClick={() => onPick(o.value)}
        {...o.attrs}
      >
        {o.icon ? <span className="cr-pick-icon">{o.icon}</span> : null}
        <span className="cr-pick-label">{o.label ?? o.text}</span>
        {o.sub ? <span className="cr-pick-sub">{o.sub}</span> : null}
        {o.tag ? <span className="cr-pick-tag">{o.tag}</span> : null}
        {selected ? <Icon name="check" size={14} className="cr-pick-check" /> : null}
      </button>
    );
  }
}

/**
 * A form field whose control is a button showing the current choice; it
 * opens a `PickList` in a popover as wide as the field. `testid` names the
 * button (with `data-value`), `<testid>-search` and `<testid>-option`.
 */
export function PickerField({
  testid,
  value,
  display,
  options,
  onPick,
  label,
  placeholder,
  search = true,
  id,
}: {
  testid: string;
  value: string;
  display: ReactNode;
  options: readonly PickOption[];
  onPick: (value: string) => void;
  label: string;
  placeholder?: string;
  search?: boolean;
  id?: string;
}): JSX.Element {
  return (
    <div className="cr-pickfield">
      <Popover
        align="start"
        className="cr-pickfield-pop"
        label={label}
        trigger={(props) => (
          <button
            {...props}
            id={id}
            type="button"
            className="cr-pickfield-btn"
            data-testid={testid}
            data-value={value}
          >
            <span className="cr-pickfield-value">{display}</span>
            <Icon name="chevron-down" size={14} className="cr-pickfield-caret" />
          </button>
        )}
      >
        {(close) => (
          <PickList
            options={options}
            value={value}
            label={label}
            testid={testid}
            search={search}
            autoFocus
            {...(placeholder !== undefined ? { placeholder } : {})}
            onPick={(next) => {
              onPick(next);
              close();
            }}
          />
        )}
      </Popover>
    </div>
  );
}
