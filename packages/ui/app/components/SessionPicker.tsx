/**
 * T170 (**D17**): the session choice — vendor, model and effort.
 *
 *  - `SessionFields` — the three controls: vendor (the provider registry's
 *    ids), model (free text, the known ids suggested through a datalist)
 *    and effort (`EFFORT_LEVELS`). Settings uses them with an "inherit"
 *    option; the picker without.
 *  - `SessionPicker` — what Attach and Review open on the stream page:
 *    prefilled with what the session would resolve to (the stream's repo
 *    entry, else the home defaults, else the built-in), so Start with no
 *    edits attaches exactly the default.
 *  - `sessionModelText` — the session strip's model, never a bare "default".
 */

import {
  EFFORT_LEVELS,
  type ResolvedSessionDefaults,
  type SessionDefaultsStatus,
} from '@agile-agents/shared';
import { useEffect, useId, useState } from 'react';
import { getSessionDefaults } from '../lib/api';

export interface SessionChoice {
  vendor: string;
  model: string;
  effort: string;
}

/** A session record's model for display: the provider's own default is named as such. */
export function sessionModelText(session: { vendor: string; model: string }): string {
  return session.model === 'default' ? `${session.vendor} default model` : session.model;
}

/** What a stream in `repo` (or no repo) resolves to with nothing named. */
export function resolvedFor(
  status: SessionDefaultsStatus,
  repo: string | undefined,
): ResolvedSessionDefaults {
  return (repo !== undefined ? status.repos[repo]?.resolved : undefined) ?? status.resolved;
}

export function SessionFields({
  status,
  value,
  onChange,
  inherit,
  testid,
}: {
  status: SessionDefaultsStatus;
  value: SessionChoice;
  onChange: (next: SessionChoice) => void;
  /** Settings: the placeholder/empty option names what an unset field falls through to. */
  inherit?: ResolvedSessionDefaults;
  testid: string;
}): JSX.Element {
  const listId = useId();
  const vendor = value.vendor || inherit?.vendor || status.builtin.vendor;
  const suggestions = status.known_models[vendor as keyof typeof status.known_models] ?? [];
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

export function SessionPicker({
  role,
  repo,
  busy,
  onStart,
  onCancel,
}: {
  role: 'worker' | 'reviewer';
  repo: string | undefined;
  busy: boolean;
  onStart: (choice: Partial<SessionChoice>) => void;
  onCancel: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<SessionDefaultsStatus | undefined>(undefined);
  const [value, setValue] = useState<SessionChoice | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    getSessionDefaults()
      .then((next) => {
        if (!live) return;
        const resolved = resolvedFor(next, repo);
        setStatus(next);
        setValue({ vendor: resolved.vendor, model: resolved.model ?? '', effort: resolved.effort });
      })
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [repo]);

  return (
    <form
      className="cr-picker"
      data-testid="session-picker"
      data-role={role}
      aria-label={role === 'worker' ? 'Start a worker' : 'Start a review'}
      onSubmit={(e) => {
        e.preventDefault();
        if (!value) return;
        const model = value.model.trim();
        onStart({
          vendor: value.vendor,
          effort: value.effort,
          ...(model.length > 0 ? { model } : {}),
        });
      }}
    >
      {error && (
        <p className="cr-error" role="alert">
          {error}
        </p>
      )}
      {status && value ? (
        <SessionFields status={status} value={value} onChange={setValue} testid="picker" />
      ) : (
        !error && <p className="cr-dim">Loading defaults…</p>
      )}
      <div className="cr-actions">
        <button
          type="submit"
          className="cr-btn signal"
          data-testid="picker-start"
          disabled={busy || !value}
        >
          {role === 'worker' ? 'Start' : 'Review'}
        </button>
        <button type="button" className="cr-btn" data-testid="picker-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
