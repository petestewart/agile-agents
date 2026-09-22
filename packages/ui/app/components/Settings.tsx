/**
 * Settings (T043's view, cut to what the cockpit has left in T160): who
 * decides each of the three surviving gate kinds (§3.1), read from
 * `policy.yaml` through `GET /api/policy`.
 *
 * Read-only for now: T043's per-row "ask me / EM decides" switch chose
 * between the human and the EM delegate, and the EM was deleted in T122,
 * so the only owner left that a gate can actually reach is the human.
 */

import type { Policy } from '@agile-agents/shared';
import { GATE_KINDS } from '@agile-agents/shared';
import { useEffect, useState } from 'react';
import { getPolicy } from '../lib/api';

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
