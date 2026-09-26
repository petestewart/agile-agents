/**
 * The rules screen (T163; cockpit design §5, §9): every rule with its
 * scope, tier, stage, status and §5.7's counters and pruning flag, filtered
 * by status, scope and — from the inbox's seed card — source.
 *
 *  - Accept / Retire per rule, or on a selection (one call per rule; a
 *    refusal, e.g. a classifier rule with fewer than two examples, is
 *    reported against that rule and the rest still go through).
 *  - Edit: text, question, criteria (T156), enforcement, stage, examples —
 *    `rule.update`'s patch, stamped `human` by the daemon.
 *  - Test examples: `rule.test {id}` (T153/T155), per example the expected
 *    band, the Noul value and the band it fell in. No confidence (D14).
 *    Enabled only when the daemon holds a classifier key (T167).
 *  - T167: a pattern rule shows its check under the text; the editor edits
 *    its kind and arguments and has Cancel (and Esc), which discards; "New
 *    rule" creates any rule as a proposal (`POST /api/rules`).
 *
 * Every write reaches the same `KnowledgeService` the CLI's `agile rules` does.
 */

import {
  KNOWLEDGE_ENFORCEMENTS,
  KNOWLEDGE_KINDS,
  type KnowledgeEnforcement,
  type KnowledgeKind,
  RULE_EXAMPLES_MAX,
  RULE_PATTERN_KINDS,
  type KnowledgeItem as Rule,
  type RulePatternKind,
  type KnowledgeStatus as RuleStatus,
  classifierCheckOf,
  examplesOf,
  formatRulePattern,
  formatKnowledgeScope as formatRuleScope,
  patternOf,
} from '@agile-agents/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRule, decideRule, getRules, testRule, updateRule } from '../lib/api';
import { useFeed } from '../lib/feed-context';
import type { RuleEvalReport, RuleReportRow, RulesPayload } from '../lib/feed-types';
import {
  RULE_STATUS_FILTERS,
  type RuleDraft,
  type RulesSort,
  createOf,
  draftOf,
  emptyDraft,
  evalDeadlineMs,
  filterRules,
  formatFiredAt,
  patchOf,
  ruleScopes,
  sortRules,
} from '../lib/rules';
import { useShell } from '../lib/shell';
import { Markdown } from './Markdown';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function Rules(): JSX.Element {
  const { rulesFilter: filter, setRulesFilter: setFilter } = useShell();
  const { onEvent } = useFeed();
  const [data, setData] = useState<RulesPayload | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [sort, setSort] = useState<RulesSort>('report');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    getRules()
      .then((payload) => {
        setData(payload);
        setError(undefined);
      })
      .catch((err: unknown) => setError(message(err)));
  }, []);

  useEffect(load, []);
  // Any rule write — here, in the inbox, from the CLI or an agent's
  // `propose_knowledge` — re-reads the list (one read per batch of events).
  useEffect(
    () =>
      onEvent((event) => {
        // T167: a key saved or removed in Settings changes "Test examples".
        if (event.kind.startsWith('rule') || event.kind === 'home_config_put') load();
      }),
    [onEvent, load],
  );

  const rows = useMemo(
    () => new Map<string, RuleReportRow>((data?.report.rows ?? []).map((row) => [row.id, row])),
    [data],
  );
  const shown = useMemo(
    () => sortRules(filterRules(data?.rules ?? [], filter), data?.report.rows ?? [], sort),
    [data, filter, sort],
  );
  const scopes = useMemo(() => ruleScopes(data?.rules ?? []), [data]);
  const picked = shown.filter((rule) => selected.has(rule.id));

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function bulk(decision: 'accept' | 'retire'): Promise<void> {
    setBusy(true);
    const failed: string[] = [];
    for (const rule of picked) {
      try {
        await decideRule(rule.id, decision);
      } catch (err) {
        failed.push(`${rule.name ?? rule.id}: ${message(err)}`);
      }
    }
    setBulkErrors(failed);
    setSelected(new Set());
    setBusy(false);
    load();
  }

  return (
    <section className="cr-rules-screen" data-testid="rules-screen">
      <div className="cr-inbox-hd">
        <h1>Knowledge</h1>
        <span className="cr-count" data-testid="rules-count">
          {shown.length}
        </span>
        <button
          type="button"
          className="cr-btn"
          data-testid="rules-new"
          aria-expanded={creating}
          onClick={() => setCreating((open) => !open)}
        >
          New rule
        </button>
      </div>
      {creating && (
        <RuleEditor
          mode="create"
          initial={emptyDraft()}
          submit={async (draft) => {
            const built = createOf(draft);
            if ('error' in built) throw new Error(built.error);
            await createRule(built.input);
          }}
          onDone={() => {
            setCreating(false);
            load();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      <div className="cr-rules-filters">
        <label>
          Status{' '}
          <select
            data-testid="rules-filter-status"
            value={filter.status}
            onChange={(e) => setFilter({ ...filter, status: e.target.value as RuleStatus | 'all' })}
          >
            {RULE_STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kind{' '}
          <select
            data-testid="rules-filter-kind"
            value={filter.kind ?? 'all'}
            onChange={(e) =>
              setFilter({ ...filter, kind: e.target.value as KnowledgeKind | 'all' })
            }
          >
            {['all', ...KNOWLEDGE_KINDS].map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label>
          Enforcement{' '}
          <select
            data-testid="rules-filter-enforcement"
            value={filter.enforcement ?? 'all'}
            onChange={(e) =>
              setFilter({ ...filter, enforcement: e.target.value as KnowledgeEnforcement | 'all' })
            }
          >
            {['all', ...KNOWLEDGE_ENFORCEMENTS].map((enforcement) => (
              <option key={enforcement} value={enforcement}>
                {enforcement}
              </option>
            ))}
          </select>
        </label>
        <label>
          Scope{' '}
          <select
            data-testid="rules-filter-scope"
            value={filter.scope}
            onChange={(e) => setFilter({ ...filter, scope: e.target.value })}
          >
            <option value="all">all</option>
            {scopes.map((scope) => (
              <option key={scope} value={scope}>
                {scope}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort{' '}
          <select
            data-testid="rules-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as RulesSort)}
          >
            <option value="report">flagged, then most fired</option>
            <option value="routed">most routed</option>
          </select>
        </label>
        {filter.source !== undefined && (
          <span className="cr-chip" data-testid="rules-filter-source">
            from {filter.source}
            <button
              type="button"
              className="cr-link"
              aria-label="Show every source"
              onClick={() => {
                const { source: _dropped, ...rest } = filter;
                setFilter(rest);
              }}
            >
              ×
            </button>
          </span>
        )}
        {filter.rule !== undefined && (
          <span className="cr-chip" data-testid="rules-filter-rule">
            rule {filter.rule}
            <button
              type="button"
              className="cr-link"
              aria-label="Show every rule"
              onClick={() => {
                const { rule: _dropped, ...rest } = filter;
                setFilter(rest);
              }}
            >
              ×
            </button>
          </span>
        )}
      </div>

      <div className="cr-actions cr-rules-bulk">
        <label>
          <input
            type="checkbox"
            data-testid="rules-select-all"
            checked={shown.length > 0 && picked.length === shown.length}
            onChange={(e) =>
              setSelected(e.target.checked ? new Set(shown.map((rule) => rule.id)) : new Set())
            }
          />{' '}
          {picked.length} selected
        </label>
        <button
          type="button"
          className="cr-btn signal"
          data-testid="rules-bulk-accept"
          disabled={busy || picked.length === 0}
          onClick={() => bulk('accept')}
        >
          Accept selected
        </button>
        <button
          type="button"
          className="cr-btn"
          data-testid="rules-bulk-retire"
          disabled={busy || picked.length === 0}
          onClick={() => bulk('retire')}
        >
          Retire selected
        </button>
      </div>
      {bulkErrors.length > 0 && (
        <ul className="cr-error" role="alert" data-testid="rules-bulk-errors">
          {bulkErrors.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      {error && (
        <p className="cr-error" role="alert">
          {error}
        </p>
      )}
      {data && shown.length === 0 && (
        <p className="cr-calm" data-testid="rules-empty">
          Nothing matches.
        </p>
      )}
      {data && (
        <p className="cr-dim">
          Pruning flags use a {data.report.days}-day window (§5.7): never fired, never violated,
          routes often.
        </p>
      )}
      {shown.map((rule) => (
        <RuleCard
          key={rule.id}
          rule={rule}
          row={rows.get(rule.id)}
          evals={data?.evals ?? { available: false }}
          checked={selected.has(rule.id)}
          onToggle={() => toggle(rule.id)}
          onChanged={load}
        />
      ))}
    </section>
  );
}

function RuleCard({
  rule,
  row,
  evals,
  checked,
  onToggle,
  onChanged,
}: {
  rule: Rule;
  row: RuleReportRow | undefined;
  evals: RulesPayload['evals'];
  checked: boolean;
  onToggle: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<RuleEvalReport | undefined>(undefined);
  const [testing, setTesting] = useState(false);

  async function act(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function runTest(): Promise<void> {
    setTesting(true);
    setError(undefined);
    setReport(undefined);
    try {
      setReport(await testRule(rule.id, evalDeadlineMs(examplesOf(rule).length, evals.timeout_ms)));
    } catch (err) {
      setError(message(err));
    } finally {
      setTesting(false);
    }
  }

  const classifier = classifierCheckOf(rule);
  const pattern = patternOf(rule);
  const testable = classifier !== undefined && rule.status === 'accepted';

  return (
    <article
      className="cr-card cr-rule"
      data-testid="rules-row"
      data-rule={rule.id}
      data-status={rule.status}
    >
      <div className="kind cr-rule-meta">
        <input
          type="checkbox"
          data-testid="rules-select"
          aria-label={`Select ${rule.name ?? rule.id}`}
          checked={checked}
          onChange={onToggle}
        />
        <span>{rule.name ?? rule.id}</span>
        <span data-testid="rules-scope">{formatRuleScope(rule.scope)}</span>
        {rule.paths !== undefined && rule.paths.length > 0 && (
          <span data-testid="rules-paths">{rule.paths.join(', ')}</span>
        )}
        <span data-testid="rules-tier">
          {rule.enforcement}
          {rule.check !== undefined ? ` · ${rule.check.by}` : ''}
          {rule.critical ? ' · critical' : ''}
        </span>
        <span data-testid="rules-kind">{rule.kind}</span>
        <span data-testid="rules-status">{rule.status}</span>
        <span>from {rule.source.by}</span>
      </div>
      <Markdown className="context" text={rule.text} />
      {rule.source.finding !== undefined && (
        <p className="cr-dim" data-testid="rules-finding">
          {rule.source.finding}
        </p>
      )}
      {pattern !== undefined && (
        <p className="cr-dim" data-testid="rules-pattern">
          <code>{formatRulePattern(pattern)}</code>
        </p>
      )}
      {classifier?.question !== undefined && (
        <p className="cr-dim" data-testid="rules-question">
          Q: {classifier.question}
        </p>
      )}
      {classifier?.criteria !== undefined && (
        <p className="cr-dim" data-testid="rules-criteria">
          yes = {classifier.criteria.true} · no = {classifier.criteria.false}
        </p>
      )}
      <div className="cr-dim cr-rule-stats" data-testid="rules-stats">
        fired {rule.stats.fired} · routed {rule.stats.routed} · violated {rule.stats.violated}
        {rule.stats.last_fired_at !== undefined && (
          <>
            {' · '}
            <span data-testid="rules-last-fired" title={rule.stats.last_fired_at}>
              last fired {formatFiredAt(rule.stats.last_fired_at)}
            </span>
          </>
        )}
        {row && row.flag !== '-' && (
          <span className="cr-rule-flag" data-testid="rules-flag" data-flag={row.flag}>
            {row.flag_detail}
          </span>
        )}
      </div>

      <div className="cr-actions">
        {rule.status === 'proposed' && (
          <button
            type="button"
            className="cr-btn signal"
            data-testid="rules-accept"
            disabled={busy}
            onClick={() => act(() => decideRule(rule.id, 'accept'))}
          >
            Accept
          </button>
        )}
        {rule.status !== 'retired' && (
          <button
            type="button"
            className="cr-btn"
            data-testid="rules-retire"
            disabled={busy}
            onClick={() => act(() => decideRule(rule.id, 'retire'))}
          >
            Retire
          </button>
        )}
        <button
          type="button"
          className="cr-btn"
          data-testid="rules-edit"
          aria-expanded={editing}
          onClick={() => setEditing((open) => !open)}
        >
          {editing ? 'Close editor' : 'Edit'}
        </button>
        {classifier !== undefined && (
          <button
            type="button"
            className="cr-btn"
            data-testid="rules-test"
            disabled={testing || !testable || !evals.available}
            title={
              !evals.available
                ? 'No classifier key loaded: set one in Settings (or TYPESAFE_API_KEY)'
                : !testable
                  ? 'Only accepted classifier rules are evaluated'
                  : `One classifier call per example (${classifier.examples.length})`
            }
            onClick={runTest}
          >
            {testing ? 'Testing…' : 'Test examples'}
          </button>
        )}
      </div>

      {editing && (
        <RuleEditor
          mode="edit"
          initial={draftOf(rule)}
          submit={async (draft) => {
            const built = patchOf(draft);
            if ('error' in built) throw new Error(built.error);
            await updateRule(rule.id, built.patch);
          }}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      )}
      {report && <EvalResults report={report} />}
      {error && (
        <p className="cr-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

/**
 * The rule form: the editor (`mode="edit"`) and "New rule" (`mode="create"`,
 * which adds scope and criticality). Cancel and Esc discard the draft and
 * close it; nothing is sent until Save / Create.
 */
function RuleEditor({
  mode,
  initial,
  submit,
  onDone,
  onCancel,
}: {
  mode: 'edit' | 'create';
  initial: RuleDraft;
  submit: (draft: RuleDraft) => Promise<void>;
  onDone: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const set = (patch: Partial<RuleDraft>): void => setDraft((prev) => ({ ...prev, ...patch }));
  const creating = mode === 'create';

  async function save(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await submit(draft);
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="cr-rule-editor"
      data-testid={creating ? 'rules-new-form' : 'rules-editor'}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      {creating && (
        <div className="cr-rule-editor-row">
          <label>
            Scope{' '}
            <input
              data-testid="rules-edit-scope"
              value={draft.scope}
              placeholder="global · repo:<name> · stream:<id>"
              onChange={(e) => set({ scope: e.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              data-testid="rules-edit-critical"
              checked={draft.critical}
              onChange={(e) => set({ critical: e.target.checked })}
            />{' '}
            critical
          </label>
        </div>
      )}
      <label>
        Text
        <textarea
          data-testid="rules-edit-text"
          value={draft.text}
          onChange={(e) => set({ text: e.target.value })}
        />
      </label>
      <label>
        Paths (globs, one per line; empty means all paths)
        <textarea
          data-testid="rules-edit-paths"
          value={draft.paths}
          onChange={(e) => set({ paths: e.target.value })}
        />
      </label>
      <label>
        Question (one yes/no question; yes means the rule is broken)
        <input
          data-testid="rules-edit-question"
          value={draft.question}
          placeholder={`Does this action violate: ${draft.text}?`}
          onChange={(e) => set({ question: e.target.value })}
        />
      </label>
      <label>
        Criteria — yes means
        <input
          data-testid="rules-edit-criteria-true"
          value={draft.criteriaTrue}
          onChange={(e) => set({ criteriaTrue: e.target.value })}
        />
      </label>
      <label>
        Criteria — no means
        <input
          data-testid="rules-edit-criteria-false"
          value={draft.criteriaFalse}
          onChange={(e) => set({ criteriaFalse: e.target.value })}
        />
      </label>
      <div className="cr-rule-editor-row">
        <label>
          Enforcement{' '}
          <select
            data-testid="rules-edit-enforcement"
            value={draft.enforcement}
            onChange={(e) => set({ enforcement: e.target.value as KnowledgeEnforcement })}
          >
            {KNOWLEDGE_ENFORCEMENTS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kind{' '}
          <select
            data-testid="rules-edit-kind"
            value={draft.kind}
            onChange={(e) => set({ kind: e.target.value as KnowledgeKind })}
          >
            {KNOWLEDGE_KINDS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="cr-rule-editor-row">
        <label>
          Pattern{' '}
          <select
            data-testid="rules-edit-pattern-kind"
            value={draft.patternKind}
            onChange={(e) => set({ patternKind: e.target.value as RulePatternKind | '' })}
          >
            <option value="">(none)</option>
            {RULE_PATTERN_KINDS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        {(draft.patternKind === 'path_deny' || draft.patternKind === 'command_deny') && (
          <label>
            {draft.patternKind === 'path_deny' ? 'Globs' : 'Command patterns'}, one per line
            <textarea
              data-testid="rules-edit-pattern-args"
              value={draft.patternArgs}
              onChange={(e) => set({ patternArgs: e.target.value })}
            />
          </label>
        )}
      </div>
      <fieldset>
        <legend>Examples</legend>
        {draft.examples.map((example, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: examples have no identity but their place
          <div className="cr-rule-example" key={index} data-testid="rules-edit-example">
            <input
              aria-label="Example action"
              value={example.action}
              onChange={(e) =>
                set({
                  examples: draft.examples.map((x, i) =>
                    i === index ? { ...x, action: e.target.value } : x,
                  ),
                })
              }
            />
            <label>
              <input
                type="checkbox"
                checked={example.violates}
                onChange={(e) =>
                  set({
                    examples: draft.examples.map((x, i) =>
                      i === index ? { ...x, violates: e.target.checked } : x,
                    ),
                  })
                }
              />{' '}
              violates
            </label>
            <button
              type="button"
              className="cr-link"
              onClick={() => set({ examples: draft.examples.filter((_, i) => i !== index) })}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="cr-link"
          data-testid="rules-edit-add-example"
          disabled={draft.examples.length >= RULE_EXAMPLES_MAX}
          title={`At most ${RULE_EXAMPLES_MAX} examples per rule`}
          onClick={() => set({ examples: [...draft.examples, { action: '', violates: true }] })}
        >
          Add example
        </button>
      </fieldset>
      <div className="cr-actions">
        <button
          type="submit"
          className="cr-btn signal"
          data-testid="rules-edit-save"
          disabled={busy}
        >
          {creating ? 'Propose rule' : 'Save'}
        </button>
        <button
          type="button"
          className="cr-btn"
          data-testid="rules-edit-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p className="cr-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function EvalResults({ report }: { report: RuleEvalReport }): JSX.Element {
  const rule = report.rules[0];
  return (
    <div className="cr-rule-evals" data-testid="rules-evals">
      <div className="cr-dim">
        {report.agreed}/{report.total} agree
        {report.errors > 0 ? ` · ${report.errors} error${report.errors === 1 ? '' : 's'}` : ''}
        {rule ? ` · asked: ${rule.question}` : ''}
      </div>
      <ul>
        {(rule?.examples ?? []).map((example, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: one row per example, in order
            key={index}
            data-testid="rules-eval"
            data-agree={example.agree ? 'yes' : 'no'}
            data-band={example.band ?? 'error'}
          >
            <span className="cr-rule-verdict">{example.agree ? 'agree' : 'disagree'}</span>{' '}
            <code>{example.action.replace(/\s+/g, ' ').slice(0, 120)}</code> — expected{' '}
            {example.expected_band}, got{' '}
            {example.error !== undefined
              ? `error: ${example.error}`
              : `${example.band} (p ${example.probability?.toFixed(2)})`}
          </li>
        ))}
      </ul>
    </div>
  );
}
