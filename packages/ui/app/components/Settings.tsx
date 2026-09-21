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

import { GATE_KINDS, type GateKind, type GateOwner, type Policy } from '@agile-agents/shared';
import { useState } from 'react';
import { putPolicy } from '../lib/api';
import { type FeedEmInfo, type FeedQuotaInfo, emLabel } from '../lib/feed-types';
import { PopOutIcon } from './icons';

/** One row per gate kind, worded as the mockup words them (`#s5`). */
// T121: the three surviving gate kinds (cockpit design §3.1). Every other
// row — approve_plan, approve_decision, unblock, sprint_review, demo — is
// deleted with the ceremony that needed it.
const GATE_ROWS: ReadonlyArray<{ gate: GateKind; title: string; what: string }> = [
  {
    gate: 'land',
    title: 'Landing a stream',
    what: 'Merging a finished stream into its target branch.',
  },
  {
    gate: 'rule_accept',
    title: 'A proposed rule',
    what: 'A lesson from a finished stream, or a rule an agent proposed. Accept, edit or retire.',
  },
  {
    gate: 'classifier_review',
    title: 'Guardrail routed an action to you',
    what: 'An agent tried something the rules are unsure about. Allow once or deny.',
  },
];

/**
 * The three presets, from §17 journey step 4 ("ask everything, plans and
 * reviews only, unattended") under the mockup's own labels (`#s5`'s choices
 * row: "Everything" / "Plans and reviews" / "Nothing, just tell me").
 *
 * DECISION (see `.pipeline-report.md`): the ticket's parenthetical reads
 * "gates to EM → every gate `em`; hands off → the design's unattended
 * mapping", which would make the middle and last presets identical. The
 * design and the mockup define three distinct mappings and CLAUDE.md says the
 * design wins, so the middle preset is the mockup's *rendered* state for the
 * "Plans and reviews" chip, gate row by gate row (`#s5`): plan, rule change
 * (`approve_decision`) and sprint review are "Ask me"; the guardrail block
 * (`unblock`) and the demo are "EM decides". Review round 1 blocker 2: this
 * preset previously put `approve_decision` on `em`, which is not what that
 * screen shows.
 *
 * The mockup's other three rows — engineer escalation, halt, and the spend
 * threshold — have no gate name in `GATE_KINDS`/§16 yet, so nothing here
 * writes them; when they get one, "Ask me" / "Ask me" / "EM decides, then
 * tells me" is what that screen shows for them.
 */
export const POLICY_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  help: string;
  gates: Record<string, GateOwner>;
}> = [
  {
    id: 'everything-to-me',
    label: 'Everything',
    help: 'Every gate stops and waits for you.',
    gates: Object.fromEntries(GATE_KINDS.map((g) => [g, 'human' as GateOwner])),
  },
  {
    id: 'gates-to-em',
    label: 'Landing and rules',
    help: 'You decide what lands and which rules stick; the EM handles the guardrail routes.',
    // T121: the middle preset keeps the two gates that change the record with
    // the human and delegates the per-action one (cockpit design §3.1).
    gates: {
      land: 'human',
      rule_accept: 'human',
      classifier_review: 'em',
    },
  },
  {
    id: 'hands-off',
    label: 'Nothing, just tell me',
    help: 'The EM decides every gate. Nothing waits on you; it all shows up in the review.',
    gates: Object.fromEntries(GATE_KINDS.map((g) => [g, 'em' as GateOwner])),
  },
];

/** Which preset (if any) the current gates block equals — so the chooser reflects hand edits honestly. */
export function matchPreset(policy: Policy | undefined): string | undefined {
  if (!policy) return undefined;
  return POLICY_PRESETS.find((preset) =>
    GATE_KINDS.every((gate) => (policy.gates[gate] ?? 'human') === preset.gates[gate]),
  )?.id;
}

function ownerOf(policy: Policy | undefined, gate: GateKind): GateOwner {
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
  em,
  onChanged,
}: {
  policy: Policy | undefined;
  quota: FeedQuotaInfo[];
  /** T049: the resident EM session's vendor/model, shown read-only — see the row below. */
  em?: FeedEmInfo;
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
  // Until `GET /api/policy` has landed there is nothing to merge into, and a
  // save would write the one edited gate over a gates block it never saw.
  const locked = busy || policy === undefined;

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

      {/*
        T049 defect 5: the EM session's vendor/model, read-only.
        `.agile/vendors.yaml` (`packages/shared/src/vendors.ts`) has no
        per-role model field at all — a vendor entry is `accounts`,
        `requires_sandbox` and `sandbox_enabled`, nothing else — and neither
        `policy.yaml` nor the provider registry carries one. So there is
        nothing for a picker here to write to, and inventing a config field
        would be a new convention this ticket has no approval for. The row
        reports what the live session is on; choosing it needs a schema
        change first (see the ticket report).
      */}
      <div className="cr-rule cr-spend-row" data-testid="settings-em-model">
        <div style={{ flex: 1 }}>
          <b>EM session</b>
          <div className="what">
            {em
              ? `${emLabel(em)} — reported by the resident session on its handshake.`
              : 'No resident EM session has reported yet — it spawns on the first chat message.'}
          </div>
        </div>
        <span
          className="cr-badge"
          title="Read-only: .agile/vendors.yaml has no per-role model field to write a choice to"
        >
          read-only
        </span>
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
              disabled={locked}
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
                disabled={locked}
                onClick={() => save({ [row.gate]: 'human' })}
              >
                Ask me
              </button>
              <button
                type="button"
                className={owner === 'em' ? 'on' : undefined}
                aria-pressed={owner === 'em'}
                data-testid={`gate-${row.gate}-em`}
                disabled={locked}
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
