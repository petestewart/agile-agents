/**
 * T170 (**D17**): the session choice — vendor, model and effort.
 *
 *  - `SessionFields` — the three controls: vendor (the provider registry's
 *    ids), model (free text, the known ids suggested through a datalist)
 *    and effort (`EFFORT_LEVELS`). Settings uses them with an "inherit"
 *    option; the picker without.
 *  - `SessionPicker` — the optional choice behind a node's Start agent
 *    chevron, Review changes… and Resolve (T363: a dialog; one click on
 *    Start agent never needs it). Prefilled with what the session would
 *    resolve to (the node's project, else its repo entry, else the home defaults, else the
 *    built-in), so Start with no edits attaches exactly the default.
 *  - `sessionModelText` — the session strip's model, never a bare "default".
 */

import {
  EFFORT_LEVELS,
  type ProjectSessionDefaults,
  type ResolvedSessionDefaults,
  type SessionDefaultsStatus,
} from '@agile-agents/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { getSessionDefaults } from '../lib/api';
import { sessionLabel } from '../lib/chat';
import { resolvedFor } from '../lib/defaults';
import { Button, Dialog, Field, Spinner } from './ui';

export interface SessionChoice {
  vendor: string;
  model: string;
  effort: string;
}

/** A session record's model for display: the provider's own default is named as such. */
export function sessionModelText(session: { vendor: string; model: string }): string {
  return session.model === 'default' ? `${session.vendor} default model` : session.model;
}

export function SessionFields({
  status,
  value,
  onChange,
  inherit,
  testid,
  layout = 'row',
}: {
  status: SessionDefaultsStatus;
  value: SessionChoice;
  onChange: (next: SessionChoice) => void;
  /** Settings: the placeholder/empty option names what an unset field falls through to. */
  inherit?: ResolvedSessionDefaults;
  testid: string;
  /** T363: `stack` puts each control under its label (the picker dialog). */
  layout?: 'row' | 'stack';
}): JSX.Element {
  const listId = useId();
  const vendor = value.vendor || inherit?.vendor || status.builtin.vendor;
  const suggestions = status.known_models[vendor as keyof typeof status.known_models] ?? [];
  if (layout === 'stack') {
    return (
      <div className="cr-picker-fields" data-testid={testid}>
        <Field label="Vendor" htmlFor={`${listId}-vendor`}>
          <select
            id={`${listId}-vendor`}
            aria-label="Vendor"
            data-testid={`${testid}-vendor`}
            value={value.vendor}
            onChange={(e) => onChange({ ...value, vendor: e.target.value })}
          >
            {status.vendors.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Model"
          htmlFor={`${listId}-model`}
          hint="Leave it empty for the vendor's own default."
        >
          <input
            id={`${listId}-model`}
            aria-label="Model"
            data-testid={`${testid}-model`}
            list={listId}
            value={value.model}
            placeholder="model id"
            onChange={(e) => onChange({ ...value, model: e.target.value })}
          />
        </Field>
        <datalist id={listId}>
          {suggestions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Field label="Effort" htmlFor={`${listId}-effort`}>
          <select
            id={`${listId}-effort`}
            aria-label="Effort"
            data-testid={`${testid}-effort`}
            value={value.effort}
            onChange={(e) => onChange({ ...value, effort: e.target.value })}
          >
            {EFFORT_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </Field>
      </div>
    );
  }
  return (
    <div className="cr-actions" data-testid={testid}>
      <select
        aria-label="Vendor"
        data-testid={`${testid}-vendor`}
        value={value.vendor}
        onChange={(e) => onChange({ ...value, vendor: e.target.value })}
      >
        {inherit && <option value="">inherit ({inherit.vendor})</option>}
        {status.vendors.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      <input
        aria-label="Model"
        data-testid={`${testid}-model`}
        list={listId}
        value={value.model}
        placeholder={
          inherit ? `inherit (${inherit.model ?? `${inherit.vendor} default model`})` : 'model id'
        }
        onChange={(e) => onChange({ ...value, model: e.target.value })}
      />
      <datalist id={listId}>
        {suggestions.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <select
        aria-label="Effort"
        data-testid={`${testid}-effort`}
        value={value.effort}
        onChange={(e) => onChange({ ...value, effort: e.target.value })}
      >
        {inherit && <option value="">inherit ({inherit.effort})</option>}
        {EFFORT_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </div>
  );
}

const PICKER_COPY: Record<
  'worker' | 'reviewer' | 'resolve',
  { title: string; description: string; submit: string }
> = {
  worker: {
    title: 'Start the agent',
    description: 'Pick what runs this node. The defaults come from Settings.',
    submit: 'Start agent',
  },
  reviewer: {
    title: 'Review the changes',
    description: 'A read-only reviewer reads the diff and reports findings.',
    submit: 'Start review',
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
}): JSX.Element {
  const [status, setStatus] = useState<SessionDefaultsStatus | undefined>(undefined);
  // Read once when the defaults arrive: a frame refresh must not reset the fields.
  const projectRef = useRef(project);
  projectRef.current = project;
  const [value, setValue] = useState<SessionChoice | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const copy = PICKER_COPY[purpose ?? role];

  useEffect(() => {
    let live = true;
    getSessionDefaults()
      .then((next) => {
        if (!live) return;
        const resolved = resolvedFor(next, repo, projectRef.current);
        setStatus(next);
        setValue({ vendor: resolved.vendor, model: resolved.model ?? '', effort: resolved.effort });
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
      label={role === 'worker' ? 'Start a worker' : 'Start a review'}
      onSubmit={() => {
        if (!value) return;
        const model = value.model.trim();
        onStart({
          vendor: value.vendor,
          effort: value.effort,
          ...(model.length > 0 ? { model } : {}),
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
            {copy.submit}
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
            <SessionFields
              status={status}
              value={value}
              onChange={setValue}
              testid="picker"
              layout="stack"
            />
            {resolved && (
              <p className="cr-picker-default">
                Default here: {sessionLabel({ ...resolved })} ({resolved.vendor})
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
