/**
 * T043 — the Settings view (§17 journey step 4: "A settings card, one row
 * per gate kind (`approve_plan`, `approve_decision`, `unblock`,
 * `sprint_review`, `demo`), each `ask me` / `EM decides, tell me`. Presets
 * on top: ask everything, plans and reviews only, unattended. This is
 * `policy.yaml`'s gates block with a face."), and the new home of spend:
 * §17 v2 "Spend is not in the top bar; it is a Settings row and a pop-out
 * modal."
 *
 * Every edit here is a `PUT /api/policy` — validated through the shared
 * `PolicySchema` and written by `StateStore.putPolicy`, so it lands in
 * `events.jsonl` and is what the *next* gate resolves its owner against
 * (`gates/resolve.ts`). Nothing is kept client-side: the saved policy comes
 * back from the daemon and replaces what the page was showing.
 */

import { type GateOwner, KNOWN_GATES, type Policy } from '@agile-agents/shared';
import { useState } from 'react';
import { putPolicy } from '../lib/api';
import type { FeedQuotaInfo } from '../lib/feed-types';
import { PopOutIcon } from './icons';

/** One row per gate kind, worded as the mockup words them (`#s5`). */
const GATE_ROWS: ReadonlyArray<{ gate: string; title: string; what: string }> = [
  {
    gate: 'approve_plan',
    title: 'Plan for a sprint',
    what: "The architect's proposed tickets and rules before any work starts.",
  },
  {
    gate: 'approve_decision',
    title: 'Rule change mid-sprint',
    what: 'The architect wants to add or change a rule because the code contradicted the spec.',
  },
  {
    gate: 'unblock',
    title: 'Guardrail blocked an agent',
    what: 'An agent tried something the rules stop, like QA creating a file. Allow once or deny.',
  },
  {
    gate: 'sprint_review',
    title: 'Sprint review',
    what: 'The merged work and the report. Accept, or send tickets back.',
  },
  {
    gate: 'demo',
    title: 'Demo before main',
    what: "A walkthrough of the finished feature before it's promoted.",
  },
];

/**
 * The three presets, from §17 journey step 4 ("ask everything, plans and
 * reviews only, unattended") under the PLAN's names.
 *
 * DECISION (see `.pipeline-report.md`): the ticket's parenthetical reads
 * "gates to EM → every gate `em`; hands off → the design's unattended
 * mapping", which would make the middle and last presets identical. The
 * design and the mockup (`#s5`, middle chip "Plans and reviews") define
 * three distinct mappings, and CLAUDE.md says the design wins — so the
 * middle preset is "plans and reviews stay with you", and "hands off" is
 * the unattended one (every gate to the EM).
 */
export const POLICY_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  help: string;
  gates: Record<string, GateOwner>;
}> = [
  {
    id: 'everything-to-me',
    label: 'Everything to me',
    help: 'Every gate stops and waits for you.',
    gates: Object.fromEntries(KNOWN_GATES.map((g) => [g, 'human' as GateOwner])),
  },
  {
    id: 'gates-to-em',
    label: 'Plans and reviews',
    help: 'You approve the plan and the sprint review; the EM decides the rest and tells you.',
    gates: {
      approve_plan: 'human',
      approve_decision: 'em',
      unblock: 'em',
      sprint_review: 'human',
      demo: 'em',
    },
  },
  {
    id: 'hands-off',
    label: 'Hands off',
    help: 'The EM decides every gate. Nothing waits on you; it all shows up in the review.',
    gates: Object.fromEntries(KNOWN_GATES.map((g) => [g, 'em' as GateOwner])),
  },
];

/** Which preset (if any) the current gates block equals — so the chooser reflects hand edits honestly. */
export function matchPreset(policy: Policy | undefined): string | undefined {
  if (!policy) return undefined;
  return POLICY_PRESETS.find((preset) =>
    KNOWN_GATES.every((gate) => (policy.gates[gate] ?? 'human') === preset.gates[gate]),
  )?.id;
}

function ownerOf(policy: Policy | undefined, gate: string): GateOwner {
  return policy?.gates[gate] ?? 'human';
}

function spendTotal(quota: FeedQuotaInfo[]): number {
  return quota.reduce((sum, q) => sum + (q.spend_usd ?? 0), 0);
}

/** The spend / vendor-barometer body, shared by the modal and its popped-out window. */
export function SpendBody({ quota }: { quota: FeedQuotaInfo[] }): JSX.Element {
  if (quota.length === 0) {
    return <p style={{ color: 'var(--text-dim)', margin: 0 }}>No quota data yet.</p>;
  }
  return (
    <div data-testid="spend-body">
      {quota.map((q) => (
        <div key={`${q.vendor}/${q.account}`} className="cr-quota-row">
          <span className="cr-conf-dot" data-conf={q.confidence} />
          <span style={{ minWidth: 110 }}>
            {q.vendor}/{q.account}
          </span>
          <span className="cr-quota-bar" data-low={q.remaining_fraction < 0.15}>
            <span style={{ width: `${Math.round(q.remaining_fraction * 100)}%` }} />
          </span>
          <span style={{ fontSize: 11, minWidth: 34, textAlign: 'right' }}>
            {Math.round(q.remaining_fraction * 100)}%
          </span>
          {q.spend_usd !== undefined && (
            <span style={{ fontSize: 11, minWidth: 52, textAlign: 'right' }}>
              ${q.spend_usd.toFixed(2)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * `/control-room?view=spend` — the popped-out spend modal as its own page,
 * the same way T041's `/control-room/chat` pops the chat out. Same bundle,
 * same `/api/snapshot` read; `main.tsx` routes to it.
 */
export function SpendWindow({ quota }: { quota: FeedQuotaInfo[] }): JSX.Element {
  return (
    <div className="cr-root" data-view="spend">
      <div className="cr-main">
        <h1 style={{ fontSize: 15 }}>Spending</h1>
        <SpendBody quota={quota} />
      </div>
    </div>
  );
}

export function Settings({
  policy,
  quota,
  onChanged,
}: {
  policy: Policy | undefined;
  quota: FeedQuotaInfo[];
  onChanged: () => void;
}): JSX.Element {
  const [spendOpen, setSpendOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function save(gates: Record<string, GateOwner>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await putPolicy({
        gates: { ...(policy?.gates ?? {}), ...gates },
        breaker_signals: policy?.breaker_signals ?? [],
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const active = matchPreset(policy);

  return (
    <div className="cr-form" data-testid="settings">
      <div className="cr-dochd">
        <h2>Settings</h2>
        <span className="file">.agile/policy.yaml</span>
      </div>

      <div className="cr-rule cr-spend-row">
        <div style={{ flex: 1 }}>
          <b>Spending</b>
          <div className="what">
            ${spendTotal(quota).toFixed(2)} recorded · {quota.length} vendor
            {quota.length === 1 ? '' : 's'} on the barometer
          </div>
        </div>
        <button
          type="button"
          className="cr-btn"
          data-testid="open-spend"
          onClick={() => setSpendOpen(true)}
        >
          Open spending
        </button>
        <button
          type="button"
          className="cr-ib"
          data-testid="spend-popout"
          title="Pop spending out into its own window"
          aria-label="Pop spending out into its own window"
          onClick={() => window.open('/control-room?view=spend', 'agile-spend')}
        >
          <PopOutIcon />
        </button>
      </div>

      <h2 style={{ marginTop: 18 }}>How much should the team ask you?</h2>
      <div className="cr-field" style={{ marginTop: 10 }}>
        {/* `<fieldset>`, not a `role="group"` div — biome's useSemanticElements. */}
        <fieldset className="cr-choices" aria-label="Who decides preset">
          {POLICY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`cr-choice${active === preset.id ? ' on' : ''}`}
              data-testid={`preset-${preset.id}`}
              aria-pressed={active === preset.id}
              title={preset.help}
              disabled={busy}
              onClick={() => save(preset.gates)}
            >
              {preset.label}
            </button>
          ))}
        </fieldset>
        <div className="help">Presets set the rows below. Change any row on its own.</div>
      </div>

      {error && (
        <p style={{ color: 'var(--danger)' }} data-testid="settings-error">
          {error}
        </p>
      )}

      {GATE_ROWS.map((row) => {
        const owner = ownerOf(policy, row.gate);
        return (
          <div className="cr-gate-row" key={row.gate} data-gate={row.gate}>
            <div>
              <b>{row.title}</b>
              <div className="what">{row.what}</div>
            </div>
            <fieldset className="cr-seg" aria-label={`Who decides ${row.title}`}>
              <button
                type="button"
                className={owner === 'human' ? 'on' : undefined}
                aria-pressed={owner === 'human'}
                data-testid={`gate-${row.gate}-human`}
                disabled={busy}
                onClick={() => save({ [row.gate]: 'human' })}
              >
                Ask me
              </button>
              <button
                type="button"
                className={owner === 'em' ? 'on' : undefined}
                aria-pressed={owner === 'em'}
                data-testid={`gate-${row.gate}-em`}
                disabled={busy}
                onClick={() => save({ [row.gate]: 'em' })}
              >
                EM decides
              </button>
            </fieldset>
          </div>
        );
      })}

      {spendOpen && (
        <div
          className="cr-modal-backdrop"
          onClick={() => setSpendOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setSpendOpen(false)}
          role="presentation"
        >
          {/* Same shape every other modal in this app uses (BoardPanel,
              NeedsYou): a `role="presentation"` box inside the backdrop,
              closed by its own Close button or Escape on the backdrop. */}
          <div
            className="cr-modal"
            data-testid="spend-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <div className="cr-dochd">
              <h2>Spending</h2>
              <button
                type="button"
                className="cr-ib"
                data-testid="spend-modal-popout"
                title="Pop spending out into its own window"
                aria-label="Pop spending out into its own window"
                onClick={() => window.open('/control-room?view=spend', 'agile-spend')}
              >
                <PopOutIcon />
              </button>
            </div>
            <SpendBody quota={quota} />
            <div className="cr-modal-actions">
              <button type="button" className="cr-btn" onClick={() => setSpendOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
