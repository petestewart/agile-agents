/**
 * Settings (T043's view, cut to what the cockpit has left in T160): who
 * decides each of the three surviving gate kinds (§3.1), read from
 * `policy.yaml` through `GET /api/policy`.
 *
 * Read-only for now: T043's per-row "ask me / EM decides" switch chose
 * between the human and the EM delegate, and the EM was deleted in T122,
 * so the only owner left that a gate can actually reach is the human.
 *
 * T167: the classifier's "TypeSafe API key" — write-only. The daemon never
 * sends the key back; this shows only where it comes from (config.yaml, the
 * environment, or nowhere). Save writes it to config.yaml and it is live at
 * once; Remove deletes it from config.yaml (an env key still applies).
 */

import type { ClassifierKeyStatus, Policy } from '@agile-agents/shared';
import { GATE_KINDS } from '@agile-agents/shared';
import { useEffect, useState } from 'react';
import { getClassifierKey, getPolicy, removeClassifierKey, saveClassifierKey } from '../lib/api';

const GATE_TEXT: Record<(typeof GATE_KINDS)[number], { title: string; what: string }> = {
  land: { title: 'Landing a stream', what: 'Merging a finished stream into its target branch.' },
  rule_accept: {
    title: 'A proposed rule',
    what: 'A lesson from a finished stream, or a rule an agent proposed.',
  },
  classifier_review: {
    title: 'A routed tool call',
    what: 'The classifier was unsure about an action and routed it to you.',
  },
};

export function Settings(): JSX.Element {
  const [policy, setPolicy] = useState<Policy | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    getPolicy()
      .then(setPolicy)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <section className="cr-settings" data-testid="settings">
      <h1>Settings</h1>
      {error && <p className="cr-error">{error}</p>}
      <ClassifierKey />
      <h2>Who decides</h2>
      {GATE_KINDS.map((gate) => (
        <div className="cr-gate-row" key={gate} data-gate={gate}>
          <div>
            <div>{GATE_TEXT[gate].title}</div>
            <div className="what">{GATE_TEXT[gate].what}</div>
          </div>
          <code>{policy ? (policy.gates[gate] ?? 'human') : '…'}</code>
        </div>
      ))}
    </section>
  );
}

function keyText(status: ClassifierKeyStatus): string {
  if (status.source === 'none') return 'no key';
  const from = status.source === 'config' ? 'from config' : 'from environment';
  const off = status.loaded ? '' : ' — provider is off';
  return `key set (${from})${off}`;
}

function ClassifierKey(): JSX.Element {
  const [status, setStatus] = useState<ClassifierKeyStatus | undefined>(undefined);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    getClassifierKey()
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function act(fn: () => Promise<ClassifierKeyStatus>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await fn());
      setValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="cr-gate-row"
      data-testid="settings-classifier-key"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim().length > 0) void act(() => saveClassifierKey(value.trim()));
      }}
    >
      <div>
        <div>TypeSafe API key</div>
        <div className="what">
          The classifier&apos;s key (§6.2). Stored in config.yaml; never shown again.
        </div>
        <div className="what" data-testid="settings-key-status">
          {status ? keyText(status) : '…'}
          {status?.environment_also ? ' · an environment key is also set' : ''}
        </div>
        {error && (
          <p className="cr-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="cr-actions">
        <input
          type="password"
          autoComplete="off"
          aria-label="TypeSafe API key"
          data-testid="settings-key-input"
          value={value}
          placeholder={status?.source === 'none' ? 'paste a key' : 'replace the key'}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="submit"
          className="cr-btn signal"
          data-testid="settings-key-save"
          disabled={busy || value.trim().length === 0}
        >
          Save
        </button>
        <button
          type="button"
          className="cr-btn"
          data-testid="settings-key-remove"
          disabled={busy || status?.source !== 'config'}
          title={
            status?.source === 'environment'
              ? 'This key comes from TYPESAFE_API_KEY; unset it in the daemon environment'
              : 'Delete the key from config.yaml'
          }
          onClick={() => void act(removeClassifierKey)}
        >
          Remove
        </button>
      </div>
    </form>
  );
}
