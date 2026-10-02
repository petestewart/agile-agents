/**
 * T170 (**D17**), T423 (audit finding 5): the session choice — vendor,
 * model and effort — and the one model picker.
 *
 *  - `ModelChoice` — the models by name, grouped by vendor (`modelGroups`),
 *    "Other model…" for an id typed by hand, and Effort as a segmented
 *    control where the vendor takes one. The composer's chip and the
 *    Start with… dialog both show it.
 *  - `ModelChip` — the composer's chip: what the next message runs, and a
 *    popover with `ModelChoice`. Choosing starts nothing: the next message
 *    starts the agent with it (or restarts the live one), then the chip
 *    goes back to the default.
 *  - `SessionPicker` — the dialog behind the header's Start with…, Ask an
 *    agent to review… and Resolve. Prefilled with what the session would
 *    resolve to (the node's project, else its repo entry, else the home
 *    defaults, else the built-in), so Start with no edits attaches exactly
 *    the default.
 *    T487: New node shows the same chip (with its own heading and note)
 *    and `EffortChip` beside it; its pick goes on the new node's first start.
 *  - `SessionFields` — three selects (agent, model, effort) by name for
 *    Settings (with what each inherits).
 */

import {
  EFFORT_LEVELS,
  type Effort,
  type ProjectSessionDefaults,
  type ResolvedSessionDefaults,
  type SessionDefaultsStatus,
  type SessionVendor,
  resolveSessionDefaults,
  vendorTakesEffort,
} from '@agile-agents/shared';
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { getSessionDefaults, setFavouriteModel } from '../lib/api';
import {
  agentLabel,
  effortInModel,
  modelLabel,
  noEffortLine,
  sessionIdText,
  uncheckedWarning,
  vendorLabel,
} from '../lib/chat';
import {
  type ModelChipState,
  type ModelRef,
  effortWord,
  modelForVendor,
  modelGroups,
  modelSelectOptions,
  resolvedFor,
  sameModel,
} from '../lib/defaults';
import { pickerView, toggleFold } from '../lib/favourites';
import { useFavouriteModels, usePickerPrefs } from '../lib/use-favourites';
import { Icon } from './Icon';
import { Switch } from './SettingsCard';
import { Button, Dialog, Popover, Segmented, Spinner, UncheckedMark } from './ui';

export interface SessionChoice {
  vendor: string;
  model: string;
  effort: string;
}

/** The Model select's value for "Other…" (never a model id: ids have no spaces). */
const OTHER = 'other model';

// ---------------------------------------------------------------- the model list

/** Arrow keys move between the rows of a list (as a menu does). */
function onArrows(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('.cr-mpick-row:not(:disabled)'),
  ];
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (at === -1) return;
  event.preventDefault();
  const next =
    event.key === 'ArrowDown'
      ? rows[(at + 1) % rows.length]
      : rows[(at - 1 + rows.length) % rows.length];
  next?.focus();
}

/** T469: a key that types (a letter, a digit, a dash), not a move or a press. */
function typesText(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return (
    event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey
  );
}

/**
 * T469: a model's star: adds it to the favourites, or takes it out. A
 * button with its name in its label, so the keyboard reaches it.
 */
export function ModelStar({
  row,
  onError,
}: {
  row: { vendor: string; model?: string; label: string; favourite: boolean };
  /** A failed save, in words (`undefined` clears it). */
  onError: (message: string | undefined) => void;
}): JSX.Element {
  const toggle = async (): Promise<void> => {
    onError(undefined);
    try {
      await setFavouriteModel(
        {
          vendor: row.vendor as SessionVendor,
          ...(row.model !== undefined ? { model: row.model } : {}),
        },
        !row.favourite,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <button
      type="button"
      className="cr-mpick-star"
      data-testid="model-star"
      aria-pressed={row.favourite}
      aria-label={
        row.favourite ? `Remove ${row.label} from favourites` : `Add ${row.label} to favourites`
      }
      title={row.favourite ? 'Remove from favourites' : 'Add to favourites'}
      onClick={() => void toggle()}
    >
      <Icon name="star" size={14} />
    </button>
  );
}

/**
 * T423: the model list, by name and grouped by vendor, with "Other model…"
 * and the effort. `marks` tags the rows for what runs and the default.
 *
 * T469: each row has a star. With any favourites, the list is those (and
 * the pick and what runs), with Show all at the bottom; each vendor folds
 * (kept per browser); typing searches every model.
 */
export function ModelChoice({
  status,
  value,
  onChange,
  marks = {},
  testid,
  autoFocus = false,
}: {
  status: SessionDefaultsStatus;
  value: ResolvedSessionDefaults;
  onChange: (next: ResolvedSessionDefaults) => void;
  marks?: { running?: ModelRef; default?: ModelRef };
  testid: string;
  /** Focus the chosen row on mount (the popover; a dialog focuses `data-autofocus`). */
  autoFocus?: boolean;
}): JSX.Element {
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [other, setOther] = useState<{ vendor: string; model: string } | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [starError, setStarError] = useState<string | undefined>(undefined);
  const favourites = useFavouriteModels(status);
  const [prefs, setPrefs] = usePickerPrefs();
  const view = pickerView({
    known: status.known_models,
    vendors: status.vendors,
    ...(status.vendor_models !== undefined ? { lists: status.vendor_models } : {}),
    favourites,
    keep: [value, marks.running].filter((ref): ref is ModelRef => ref !== undefined),
    extra: marks.default !== undefined ? [marks.default] : [],
    showAll: prefs.showAll,
    query,
    folded: prefs.folded,
  });
  const choose = (ref: ModelRef): void =>
    onChange({
      vendor: ref.vendor,
      ...(ref.model !== undefined && ref.model !== '' ? { model: ref.model } : {}),
      effort: value.effort,
    });
  const applyOther = (): void => {
    const model = other?.model.trim() ?? '';
    if (!other || model === '') return;
    choose({ vendor: other.vendor, model });
    setOther(undefined);
  };
  useEffect(() => {
    if (!autoFocus) return;
    const chosen = list.current?.querySelector<HTMLButtonElement>(
      '.cr-mpick-row[aria-checked="true"]',
    );
    // The pick sits in a folded group: the search box, so typing still finds it.
    (chosen ?? search.current)?.focus();
  }, [autoFocus]);

  return (
    <div className="cr-mpick" data-testid={testid}>
      <div className="cr-mpick-search">
        <Icon name="search" size={14} />
        <input
          ref={search}
          type="text"
          aria-label="Search models"
          data-testid="model-search"
          placeholder="Search every model…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // Enter takes the first match; it never sends the message or submits the dialog.
              e.preventDefault();
              e.stopPropagation();
              const first = view.groups.find((g) => g.rows.length > 0)?.rows[0];
              if (first) {
                choose(first);
                setQuery('');
              }
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              list.current?.querySelector<HTMLButtonElement>('.cr-mpick-row')?.focus();
            }
          }}
        />
      </div>
      <div
        className="cr-mpick-list"
        role="radiogroup"
        aria-label="Model"
        ref={list}
        onKeyDown={(e) => {
          onArrows(e);
          if (e.defaultPrevented) return;
          const tag = (e.target as HTMLElement).tagName;
          if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
          // T469: typing on a row goes to the search box.
          if (typesText(e)) {
            e.preventDefault();
            e.stopPropagation();
            setQuery((q) => q + e.key);
            search.current?.focus();
          }
        }}
      >
        {view.groups.map((group) => (
          <div
            key={group.key}
            className="cr-mpick-group"
            // biome-ignore lint/a11y/useSemanticElements: a labelled run of rows inside the radiogroup, not a form fieldset.
            role="group"
            aria-label={group.label}
            data-testid="model-group"
            data-group={group.key}
            data-folded={group.folded ? 'true' : undefined}
          >
            <button
              type="button"
              className="cr-mpick-group-hd"
              data-testid="model-group-toggle"
              aria-expanded={!group.folded}
              disabled={view.searching}
              title={
                view.searching
                  ? undefined
                  : group.folded
                    ? `Show ${group.label}'s models`
                    : `Fold ${group.label}'s models`
              }
              onClick={() => setPrefs(toggleFold(prefs, group.key))}
            >
              <Icon
                name={group.folded ? 'chevron-right' : 'chevron-down'}
                size={12}
                className="cr-mpick-caret"
              />
              <span className="cr-mpick-group-name">{group.label}</span>
              {group.folded ? <span className="cr-mpick-group-count">{group.count}</span> : null}
            </button>
            {group.rows.map((option) => {
              const on = sameModel(option, value);
              // T437: a vendor whose command isn't on the daemon's PATH says so (still pickable).
              const missing = status.not_installed?.[option.vendor as SessionVendor];
              const tag =
                marks.running && sameModel(option, marks.running)
                  ? 'Running'
                  : marks.default && sameModel(option, marks.default)
                    ? 'Default'
                    : missing !== undefined
                      ? 'Not installed'
                      : // T469: a favourite its vendor no longer lists.
                        option.unlisted !== undefined
                        ? option.unlisted
                        : // T467 (D46): its default alone, because it never said what it has.
                          option.hint !== undefined
                          ? 'No list yet'
                          : undefined;
              return (
                <div key={`${option.vendor}/${option.model ?? ''}`} className="cr-mpick-item">
                  <button
                    type="button"
                    // biome-ignore lint/a11y/useSemanticElements: see the radiogroup above.
                    role="radio"
                    aria-checked={on}
                    className="cr-mpick-row"
                    data-testid="model-option"
                    data-vendor={option.vendor}
                    data-model={option.model ?? ''}
                    data-missing={missing !== undefined ? 'true' : undefined}
                    data-no-list={option.hint !== undefined ? 'true' : undefined}
                    data-unlisted={option.unlisted !== undefined ? 'true' : undefined}
                    data-autofocus={on ? true : undefined}
                    title={
                      missing ??
                      option.unlisted ??
                      option.hint ??
                      sessionIdText({ vendor: option.vendor, model: option.model })
                    }
                    onClick={() => {
                      setOther(undefined);
                      setQuery('');
                      choose(option);
                    }}
                  >
                    <Icon name="check" size={14} className="cr-mpick-check" />
                    <span className="cr-mpick-name">{option.label}</span>
                    {/* T505: its shell commands run unchecked. */}
                    <UncheckedMark
                      warning={uncheckedWarning(option.vendor)}
                      testid="model-option-unchecked"
                    />
                    {tag && <span className="cr-mpick-tag">{tag}</span>}
                  </button>
                  <ModelStar row={option} onError={setStarError} />
                </div>
              );
            })}
          </div>
        ))}
        {view.searching && view.groups.length === 0 ? (
          <p className="cr-mpick-empty" data-testid="model-search-empty">
            No model matches “{query.trim()}”.
          </p>
        ) : null}
        <button
          type="button"
          className="cr-mpick-row cr-mpick-other-btn"
          data-testid="model-other"
          aria-expanded={other !== undefined}
          onClick={() => setOther(other ? undefined : { vendor: value.vendor, model: '' })}
        >
          <Icon name="plus" size={14} className="cr-mpick-check" />
          <span className="cr-mpick-name">Other model…</span>
        </button>
        {other && (
          <div className="cr-mpick-other" data-testid="model-other-form">
            <select
              aria-label="Agent"
              data-testid="model-other-vendor"
              value={other.vendor}
              onChange={(e) => setOther({ ...other, vendor: e.target.value })}
            >
              {status.vendors.map((v) => (
                <option key={v} value={v} title={status.not_installed?.[v]}>
                  {vendorLabel(v)}
                  {status.not_installed?.[v] !== undefined ? ' (not installed)' : ''}
                </option>
              ))}
            </select>
            <input
              aria-label="Model id"
              data-testid="model-other-input"
              placeholder="model id"
              // biome-ignore lint/a11y/noAutofocus: the user just asked to type one.
              autoFocus
              value={other.model}
              onChange={(e) => setOther({ ...other, model: e.target.value })}
              onKeyDown={(e) => {
                // Enter uses it; it never sends the message or submits the dialog.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  applyOther();
                }
              }}
            />
            <Button
              size="sm"
              data-testid="model-other-use"
              disabled={other.model.trim() === ''}
              onClick={applyOther}
            >
              Use
            </Button>
          </div>
        )}
      </div>
      {starError ? (
        <p className="cr-error cr-mpick-error" role="alert" data-testid="model-star-error">
          {starError}
        </p>
      ) : null}
      {view.hasFavourites ? (
        <div className="cr-mpick-showall">
          <Switch
            label={view.hidden > 0 ? `Show all (${view.hidden} more)` : 'Show all'}
            data-testid="model-show-all"
            checked={prefs.showAll}
            disabled={view.searching}
            onChange={(e) => setPrefs({ ...prefs, showAll: e.target.checked })}
          />
        </div>
      ) : null}
      <div className="cr-mpick-effort">
        <span className="cr-mpick-effort-label">Effort</span>
        {vendorTakesEffort(value.vendor) ? (
          <Segmented<Effort>
            label="Effort"
            testid={`${testid}-effort`}
            items={EFFORT_LEVELS.map((level) => ({
              id: level,
              label: effortWord(level),
              testid: `effort-${level}`,
            }))}
            value={value.effort}
            onChange={(effort) => onChange({ ...value, effort })}
          />
        ) : (
          <span className="cr-mpick-noeffort" data-testid={`${testid}-no-effort`}>
            {noEffortLine(value.vendor)}.
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the composer's chip

/**
 * T423: the composer's model chip and its popover. Choosing sets what the
 * next message runs; it never starts or restarts anything by itself.
 */
export function ModelChip({
  status,
  chip,
  running,
  fallback,
  onPick,
  onReset,
  placement = 'top',
  modelOnly = false,
  testid = 'composer-model',
  heading = 'Model for your next message',
  note,
}: {
  status: SessionDefaultsStatus | undefined;
  chip: ModelChipState;
  /** T472: where the list opens; below where the chip sits near the top (the Ask box). */
  placement?: 'top' | 'bottom';
  /** T468: the model alone; the effort has its own chip (`EffortChip`). */
  modelOnly?: boolean;
  /** T487: the chip's test id, when it is not the composer's (New node). */
  testid?: string;
  /** T487: the popover's heading, when the pick is not for a next message (New node). */
  heading?: string;
  /** T487: the note under the list, in place of the composer's. */
  note?: string;
  /** The live agent's model, if one runs. */
  running?: ResolvedSessionDefaults;
  /** The default here. */
  fallback: ResolvedSessionDefaults;
  onPick: (next: ResolvedSessionDefaults) => void;
  onReset: () => void;
}): JSX.Element {
  const face = (
    <>
      {chip.state === 'live' ? (
        <span className="cr-model-dot" aria-hidden="true" />
      ) : (
        <Icon name={chip.state === 'chosen' ? 'sliders' : 'sparkles'} size={12} />
      )}
      <span className="cr-model-chip-text">
        {modelOnly
          ? agentLabel({ vendor: chip.shows.vendor, model: chip.shows.model })
          : chip.label}
      </span>
    </>
  );
  // The list comes with the defaults; until then the chip only names what runs.
  if (status === undefined) {
    return (
      <span
        className="cr-model-chip"
        data-testid={testid}
        data-live={chip.state === 'live' ? 'true' : undefined}
        title={chip.title}
      >
        {face}
      </span>
    );
  }
  return (
    <Popover
      align="start"
      placement={placement}
      label={heading}
      testid="model-popover"
      className="cr-mpick-pop"
      trigger={(props) => (
        <button
          type="button"
          className="cr-model-chip"
          data-testid={testid}
          data-live={chip.state === 'live' ? 'true' : undefined}
          data-chosen={chip.state === 'chosen' ? 'true' : undefined}
          title={chip.title}
          {...props}
        >
          {face}
          <Icon name="chevron-down" size={12} />
        </button>
      )}
    >
      {() => (
        <div className="cr-mpick-panel">
          <div className="cr-mpick-hd">
            <span className="cr-mpick-title">{heading}</span>
            {chip.pending && (
              <button
                type="button"
                className="cr-link"
                data-testid="model-reset"
                title={`Back to ${agentLabel(running ?? fallback)}${running ? ', the model that runs' : ', the default'}`}
                onClick={onReset}
              >
                Reset
              </button>
            )}
          </div>
          <ModelChoice
            status={status}
            value={chip.shows}
            onChange={onPick}
            marks={{
              ...(running ? { running } : {}),
              default: fallback,
            }}
            testid="model-choice"
            autoFocus
          />
          <p className="cr-mpick-note" data-testid="model-note">
            {note !== undefined
              ? note
              : running
                ? 'Nothing changes until you send: another model restarts the agent with your message.'
                : 'Nothing starts until you send. After that it goes back to the default.'}
          </p>
        </div>
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------- the dialog

const PICKER_COPY: Record<
  'worker' | 'reviewer' | 'resolve',
  { title: string; description: string; submit: string }
> = {
  worker: {
    title: 'Start with…',
    description: 'Pick the model this node’s agent starts with. The defaults come from Settings.',
    submit: 'Start agent',
  },
  // T413: an agent that reviews; you review on the Changes tab.
  reviewer: {
    title: 'Start a reviewer agent',
    description:
      'A read-only agent reads the branch’s changes and reports findings here. It changes nothing.',
    submit: 'Start reviewer',
  },
  resolve: {
    title: 'Resolve the conflict',
    description: 'A worker merges the target in and fixes the conflicted files.',
    submit: 'Start resolving',
  },
};

export function SessionPicker({
  role,
  repo,
  busy,
  onStart,
  onCancel,
  purpose,
  project,
  submitLabel,
}: {
  role: 'worker' | 'reviewer';
  repo: string | undefined;
  busy: boolean;
  onStart: (choice: Partial<SessionChoice>) => void;
  onCancel: () => void;
  /** What the dialog says; defaults to the role's. */
  purpose?: 'worker' | 'reviewer' | 'resolve';
  /** T379: the node's project's session defaults, which come before the repo's. */
  project?: ProjectSessionDefaults;
  /** The submit button's words ("Restart agent"), when not the purpose's. */
  submitLabel?: string;
}): JSX.Element {
  const [status, setStatus] = useState<SessionDefaultsStatus | undefined>(undefined);
  // Read once when the defaults arrive: a frame refresh must not reset the choice.
  const projectRef = useRef(project);
  projectRef.current = project;
  const [value, setValue] = useState<ResolvedSessionDefaults | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const copy = PICKER_COPY[purpose ?? role];

  useEffect(() => {
    let live = true;
    getSessionDefaults()
      .then((next) => {
        if (!live) return;
        setStatus(next);
        setValue(resolvedFor(next, repo, projectRef.current));
      })
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [repo]);

  const resolved = status ? resolvedFor(status, repo, project) : undefined;
  return (
    <Dialog
      open
      onClose={onCancel}
      title={copy.title}
      description={copy.description}
      size="sm"
      testid="session-picker-dialog"
      label={role === 'worker' ? 'Start a worker' : 'Start a reviewer agent'}
      onSubmit={() => {
        if (!value) return;
        onStart({
          vendor: value.vendor,
          effort: value.effort,
          ...(value.model !== undefined ? { model: value.model } : {}),
        });
      }}
      footer={
        <>
          <Button data-testid="picker-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon={role === 'worker' ? 'play' : 'eye'}
            data-testid="picker-start"
            busy={busy}
            disabled={!value}
          >
            {submitLabel ?? copy.submit}
          </Button>
        </>
      }
    >
      <div className="cr-picker" data-testid="session-picker" data-role={role}>
        {error && (
          <p className="cr-error" role="alert">
            {error}
          </p>
        )}
        {status && value ? (
          <>
            <ModelChoice
              status={status}
              value={value}
              onChange={setValue}
              {...(resolved ? { marks: { default: resolved } } : {})}
              testid="picker-model"
            />
            {resolved && (
              <p className="cr-picker-default" title={sessionIdText(resolved)}>
                Default here: {agentLabel(resolved)}
              </p>
            )}
          </>
        ) : (
          !error && (
            <p className="cr-dim cr-picker-loading">
              <Spinner /> Loading the defaults…
            </p>
          )
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Settings

/**
 * The three controls, by name: the agent, its model (the known ones, the
 * empty value — what it inherits, or the vendor's default — and "Other…"
 * to type an id), and the effort. `onChange` follows every edit; `onCommit`
 * (Settings, which saves on change) runs when a select changes or a typed
 * id is done (Enter, or leaving the field).
 */
export function SessionFields({
  status,
  value,
  onChange,
  onCommit,
  inherit,
  testid,
}: {
  status: SessionDefaultsStatus;
  value: SessionChoice;
  onChange: (next: SessionChoice) => void;
  onCommit?: (next: SessionChoice) => void;
  /** Settings: what an empty field falls through to, named in its option ("Inherits Claude"). */
  inherit?: ResolvedSessionDefaults;
  testid: string;
}): JSX.Element {
  const vendor = value.vendor || inherit?.vendor || status.builtin.vendor;
  const [typing, setTyping] = useState(false);
  // The model before Other… was picked: Esc goes back to it.
  const before = useRef('');
  const change = (next: SessionChoice, commit = true): void => {
    onChange(next);
    if (commit) onCommit?.(next);
  };
  // T402: the model an empty field inherits, for the vendor picked here (another
  // vendor never takes the inherited one).
  const inheritedModel =
    inherit &&
    modelLabel(
      vendor,
      resolveSessionDefaults({
        ...(value.vendor ? { flags: { vendor: value.vendor } } : {}),
        home: {
          default_vendor: inherit.vendor,
          ...(inherit.model !== undefined ? { default_model: inherit.model } : {}),
        },
      }).model,
    );
  const models = modelSelectOptions(
    status.known_models,
    vendor,
    value.model,
    inheritedModel,
    status.vendor_models,
  );
  // T401: a vendor with no effort setting never gets the level; say so rather than offer it.
  const noEffort = vendorTakesEffort(vendor)
    ? undefined
    : `${noEffortLine(vendor)}; the level is not used`;
  const shown = typing ? OTHER : value.model.trim();
  return (
    <div className="cr-sf" data-testid={testid}>
      <select
        className="cr-sf-vendor"
        aria-label="Agent"
        data-testid={`${testid}-vendor`}
        value={value.vendor}
        onChange={(e) => {
          const next = e.target.value;
          setTyping(false);
          change({
            ...value,
            vendor: next,
            model: modelForVendor(
              status.known_models,
              next || inherit?.vendor || '',
              value.model,
              status.vendor_models,
            ),
          });
        }}
      >
        {inherit && <option value="">Inherits {vendorLabel(inherit.vendor)}</option>}
        {status.vendors.map((v) => (
          <option key={v} value={v} title={status.not_installed?.[v]}>
            {vendorLabel(v)}
            {status.not_installed?.[v] !== undefined ? ' (not installed)' : ''}
          </option>
        ))}
      </select>
      <span className="cr-sf-model" data-typing={typing ? 'true' : undefined}>
        <select
          aria-label="Model"
          data-testid={`${testid}-model`}
          value={shown}
          title={
            value.model.trim() !== '' ? sessionIdText({ vendor, model: value.model }) : undefined
          }
          onChange={(e) => {
            if (e.target.value === OTHER) {
              before.current = value.model;
              setTyping(true);
              return;
            }
            setTyping(false);
            change({ ...value, model: e.target.value });
          }}
        >
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
          <option value={OTHER}>Other…</option>
        </select>
        {typing && (
          <input
            aria-label="Model id"
            data-testid={`${testid}-model-other`}
            placeholder="model id"
            // biome-ignore lint/a11y/noAutofocus: the user just picked Other… to type one.
            autoFocus
            value={value.model}
            onChange={(e) => change({ ...value, model: e.target.value }, false)}
            onBlur={() => {
              onCommit?.(value);
              if (value.model.trim() !== '') setTyping(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onCommit?.(value);
                if (value.model.trim() !== '') setTyping(false);
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                change({ ...value, model: before.current }, false);
                setTyping(false);
              }
            }}
          />
        )}
      </span>
      <select
        className="cr-sf-effort"
        aria-label="Effort"
        data-testid={`${testid}-effort`}
        disabled={noEffort !== undefined}
        {...(noEffort !== undefined ? { title: noEffort } : {})}
        value={value.effort}
        onChange={(e) => change({ ...value, effort: e.target.value })}
      >
        {inherit && <option value="">Inherits {effortWord(inherit.effort)}</option>}
        {EFFORT_LEVELS.map((level) => (
          <option key={level} value={level}>
            {effortWord(level)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** T468: the next effort after `level`, round from max back to low. */
export function nextEffort(level: Effort): Effort {
  const at = EFFORT_LEVELS.indexOf(level);
  return EFFORT_LEVELS[(at + 1) % EFFORT_LEVELS.length] as Effort;
}

/**
 * T468: the composer's effort, on the right of its bar. A click (or
 * Shift+Tab in the composer) steps low → medium → high → max; the pick is
 * for the next message, like the model chip's. Absent for a vendor with no
 * effort setting (T401).
 */
export function EffortChip({
  value,
  vendor,
  chosen,
  onStep,
  testid = 'composer-effort',
  title,
}: {
  value: Effort;
  vendor: string;
  /** Not what runs (or the default): a pick for the next message. */
  chosen: boolean;
  onStep: () => void;
  /** T487: the chip's test id, when it is not the composer's (New node). */
  testid?: string;
  /** T487: the tooltip, when the step is not for a next message (New node). */
  title?: string;
}): JSX.Element | null {
  if (!vendorTakesEffort(vendor)) {
    // T488: Cursor's effort is in its model ids; say so where the chip would be.
    if (!effortInModel(vendor)) return null;
    return (
      <span
        className="cr-effort-chip"
        data-static="true"
        data-testid={testid}
        title={`${noEffortLine(vendor)}.`}
      >
        <Icon name="zap" size={12} />
        In the model
      </span>
    );
  }
  return (
    <button
      type="button"
      className="cr-effort-chip"
      data-testid={testid}
      data-effort={value}
      data-chosen={chosen ? 'true' : undefined}
      title={
        title ??
        `${effortWord(value)} effort for your next message. Click or Shift+Tab for ${effortWord(nextEffort(value))}.`
      }
      onClick={onStep}
    >
      <Icon name="zap" size={12} />
      {effortWord(value)}
    </button>
  );
}
