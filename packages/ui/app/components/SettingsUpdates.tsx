/**
 * T481 (D50): Settings → Agents → Updates. Keeping each vendor's own CLI up
 * to date: **Off** (no check at all), **Alert** (the default: a check at
 * start and daily; a new version waits in Needs me with Update) or **Auto**
 * (installed in the background; a failure waits in Needs me). A vendor can
 * override it. Each CLI's row says what the last check found (installed,
 * newest, how it was installed) with Update where one can run; Check now
 * runs the check. The ACP bridges show their pinned and newest versions as
 * information only: a bridge moves by a code change, never by the updater.
 * Running agents keep the version they started on.
 */

import type {
  HarnessId,
  HarnessStatus,
  HarnessUpdateMode,
  HarnessUpdatesStatus,
} from '@agile-agents/shared';
import { HARNESS_UPDATE_MODES } from '@agile-agents/shared';
import { useEffect, useState } from 'react';
import {
  checkHarnessUpdates,
  getHarnessUpdates,
  setHarnessUpdateMode,
  updateHarness,
} from '../lib/api';
import { ago } from '../lib/status';
import { MODE_HINTS, MODE_WORDS, methodText, offersUpdate, updateState } from '../lib/updates';
import { FormError, SavedNote, SetCard, SetRow, errorText, useSavedFlash } from './SettingsCard';
import { Badge, Button, Segmented, Spinner } from './ui';

export function UpdatesCard(): JSX.Element {
  const [status, setStatus] = useState<HarnessUpdatesStatus | undefined>();
  /** What runs now: `mode`, `check`, `vendor:<v>` or `update:<id>`. */
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  /** The last Update pressed here, per CLI, in words. */
  const [results, setResults] = useState<
    Partial<Record<HarnessId, { ok: boolean; message: string }>>
  >({});
  const flash = useSavedFlash();

  useEffect(() => {
    getHarnessUpdates()
      .then(setStatus)
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  async function run(key: string, fn: () => Promise<HarnessUpdatesStatus>, saved = false) {
    setBusy(key);
    setError(undefined);
    flash.clear();
    try {
      setStatus(await fn());
      if (saved) flash.markSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(undefined);
    }
  }

  async function update(h: HarnessStatus): Promise<void> {
    setBusy(`update:${h.id}`);
    setError(undefined);
    try {
      const result = await updateHarness(h.id);
      setResults((prev) => ({ ...prev, [h.id]: { ok: result.ok, message: result.message } }));
      setStatus((prev) =>
        prev === undefined
          ? prev
          : {
              ...prev,
              harnesses: prev.harnesses.map((x) => (x.id === h.id ? result.status : x)),
            },
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(undefined);
    }
  }

  const mode = status?.mode ?? 'alert';
  const locked = busy !== undefined || status === undefined;
  const checking = busy === 'check' || status?.checking === true;
  return (
    <SetCard
      title="Updates"
      icon="download"
      description="Keeps each agent’s own command-line tool up to date. Running agents keep the version they started on; the next start uses the new one."
      testid="settings-updates"
      status={<SavedNote show={flash.saved} testid="settings-updates-saved" />}
    >
      <SetRow label="Every agent" hint={MODE_HINTS[mode]} testid="settings-updates-mode-row">
        {status === undefined && error === undefined ? (
          <span className="cr-set-muted">
            <Spinner size={12} /> Loading…
          </span>
        ) : (
          <Segmented<HarnessUpdateMode>
            label="Updates"
            testid="settings-updates-mode"
            value={mode}
            onChange={(next) => void run('mode', () => setHarnessUpdateMode(next), true)}
            items={HARNESS_UPDATE_MODES.map((id) => ({
              id,
              label: MODE_WORDS[id],
              testid: `settings-updates-mode-${id}`,
              title: MODE_HINTS[id],
              disabled: locked,
            }))}
          />
        )}
      </SetRow>
      {status !== undefined && (
        <>
          <ul className="cr-set-updates" data-testid="settings-updates-list">
            {status.harnesses.map((h) => (
              <UpdateRow
                key={h.id}
                harness={h}
                own={status.vendors[h.vendor]}
                global={mode}
                busy={busy}
                locked={locked}
                result={results[h.id]}
                onUpdate={() => void update(h)}
                onMode={(next) =>
                  void run(`vendor:${h.vendor}`, () => setHarnessUpdateMode(next, h.vendor), true)
                }
              />
            ))}
          </ul>
          <div className="cr-set-updates-check">
            <Button
              size="sm"
              icon="refresh"
              data-testid="settings-updates-check"
              busy={checking}
              disabled={locked}
              title="Read each agent’s installed and newest version now"
              onClick={() => void run('check', checkHarnessUpdates)}
            >
              Check now
            </Button>
            <span className="cr-set-muted" data-testid="settings-updates-checked">
              {checking
                ? 'Checking…'
                : status.checked_at !== undefined
                  ? `Last checked ${ago(status.checked_at) === 'now' ? 'just now' : `${ago(status.checked_at)} ago`}`
                  : 'Not checked yet'}
            </span>
          </div>
          {status.bridges.length > 0 && (
            <SetRow
              label="ACP bridges"
              hint="Claude Code and Codex run through a bridge this app pins. It moves with a new version of this app, never by an update here."
              testid="settings-updates-bridges"
              stack
            >
              <ul className="cr-set-bridges">
                {status.bridges.map((b) => (
                  <li key={b.package} data-testid={`settings-updates-bridge-${b.vendor}`}>
                    <span className="cr-set-updates-name">{b.label}</span>
                    <code title={b.package}>{b.package}</code>
                    <span>
                      {b.pinned}
                      {b.latest !== undefined && b.latest !== b.pinned
                        ? ` (newest ${b.latest})`
                        : b.latest !== undefined
                          ? ' (the newest)'
                          : ''}
                    </span>
                    {b.error !== undefined && (
                      <span className="cr-set-muted" title={b.error}>
                        Couldn’t check
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </SetRow>
          )}
        </>
      )}
      <FormError error={error} />
    </SetCard>
  );
}

/** One CLI: its versions, how it was installed, its state, its own mode and Update. */
function UpdateRow({
  harness: h,
  own,
  global,
  busy,
  locked,
  result,
  onUpdate,
  onMode,
}: {
  harness: HarnessStatus;
  /** Its vendor's own mode, when it sets one. */
  own: HarnessUpdateMode | undefined;
  global: HarnessUpdateMode;
  busy: string | undefined;
  locked: boolean;
  result: { ok: boolean; message: string } | undefined;
  onUpdate: () => void;
  onMode: (next: HarnessUpdateMode | null) => void;
}): JSX.Element {
  const state = updateState(h);
  const shown = result ?? h.last_update;
  return (
    <li className="cr-set-updates-row" data-testid={`settings-updates-row-${h.id}`}>
      <div className="cr-set-updates-main">
        <span className="cr-set-updates-name">{h.label}</span>
        <span className="cr-set-updates-version" data-testid={`settings-updates-version-${h.id}`}>
          {h.version ?? '—'}
          {h.latest !== undefined && h.latest !== h.version ? ` → ${h.latest}` : ''}
        </span>
        <span className="cr-set-muted" title={h.path}>
          {methodText(h)}
        </span>
        <Badge tone={state.tone} testid={`settings-updates-state-${h.id}`}>
          {state.text}
        </Badge>
        <span className="cr-set-updates-controls">
          <select
            aria-label={`Updates for ${h.label}`}
            data-testid={`settings-updates-vendor-${h.id}`}
            value={own ?? ''}
            disabled={locked}
            onChange={(e) =>
              onMode(e.target.value === '' ? null : (e.target.value as HarnessUpdateMode))
            }
          >
            <option value="">Same as all ({MODE_WORDS[global]})</option>
            {HARNESS_UPDATE_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_WORDS[m]}
              </option>
            ))}
          </select>
          {offersUpdate(h) && (
            <Button
              size="sm"
              variant={h.behind ? 'primary' : 'secondary'}
              icon="download"
              data-testid={`settings-updates-update-${h.id}`}
              busy={busy === `update:${h.id}` || h.updating === true}
              disabled={locked}
              title={h.command !== undefined ? `Runs ${h.command}` : undefined}
              onClick={onUpdate}
            >
              Update
            </Button>
          )}
        </span>
      </div>
      {state.hint !== undefined && (
        <p className="cr-set-updates-hint" data-testid={`settings-updates-hint-${h.id}`}>
          {state.hint}
        </p>
      )}
      {shown !== undefined && (
        <p
          className="cr-set-updates-result"
          data-ok={shown.ok ? 'true' : 'false'}
          data-testid={`settings-updates-result-${h.id}`}
        >
          {shown.message}
        </p>
      )}
    </li>
  );
}
