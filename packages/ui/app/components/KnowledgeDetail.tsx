/**
 * T366: one knowledge item, in the Knowledge screen's side panel (a peek,
 * as Linear opens an issue): its text, where it applies, how it is
 * enforced and checked, where it came from, how often it fired — and the
 * actions: Accept, Retire, Edit, Test examples.
 *
 * "Test examples" runs each example through the classifier (`rule.test`,
 * T153/T155): per example the expected verdict, the one it got and its
 * probability. No confidence (D14). Enabled only when the daemon holds a
 * classifier key (T167) and the item is accepted.
 */

import {
  type KnowledgeItem,
  classifierCheckOf,
  classifierQuestion,
  examplesOf,
  patternOf,
} from '@agile-agents/shared';
import { useState } from 'react';
import { decideRule, testRule } from '../lib/api';
import type { RuleEvalReport, RuleReportRow, RulesPayload } from '../lib/feed-types';
import {
  ENFORCEMENT_INFO,
  KIND_HINT,
  KIND_LABEL,
  type KnowledgeNames,
  STATUS_LABEL,
  acceptBlocker,
  bandWords,
  checkWords,
  evalDeadlineMs,
  evalSummary,
  flagWords,
  formatFiredAt,
  isEnforced,
  patternSentence,
  patternWords,
  plainError,
  plainFinding,
  scopeHint,
  scopeWords,
  sourceWords,
  titleOf,
} from '../lib/rules';
import { useShell } from '../lib/shell';
import { ago } from '../lib/status';
import { Icon } from './Icon';
import { CriticalMark, EnforcementBadge, itemIcon } from './KnowledgeList';
import { Markdown } from './Markdown';
import { Badge, type BadgeTone, Button, IconButton, Menu, useCopy, useToast } from './ui';

const STATUS_TONE: Record<KnowledgeItem['status'], BadgeTone> = {
  proposed: 'amber',
  accepted: 'green',
  retired: 'neutral',
};

function message(err: unknown): string {
  return plainError(err instanceof Error ? err.message : String(err));
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function KnowledgeDetail({
  item,
  row,
  days,
  evals,
  names,
  onEdit,
  onClose,
  onChanged,
}: {
  item: KnowledgeItem;
  row: RuleReportRow | undefined;
  days: number;
  evals: RulesPayload['evals'];
  names: KnowledgeNames;
  onEdit: () => void;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState<'accept' | 'retire' | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<RuleEvalReport | undefined>(undefined);
  const [testing, setTesting] = useState(false);
  const toast = useToast();
  const copy = useCopy();
  const { setView } = useShell();

  const classifier = classifierCheckOf(item);
  const pattern = patternOf(item);
  const enforced = isEnforced(item);
  const title = titleOf(item);
  const blocker = acceptBlocker(item);
  const flag =
    enforced && item.status === 'accepted' && row ? flagWords(row.flag, days) : undefined;

  async function decide(decision: 'accept' | 'retire'): Promise<void> {
    setBusy(decision);
    setError(undefined);
    try {
      await decideRule(item.id, decision);
      toast({
        tone: 'success',
        title: decision === 'accept' ? 'Accepted' : 'Retired',
        body: title,
        duration: 3000,
      });
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(undefined);
    }
  }

  async function runTest(): Promise<void> {
    setTesting(true);
    setError(undefined);
    setReport(undefined);
    try {
      setReport(await testRule(item.id, evalDeadlineMs(examplesOf(item).length, evals.timeout_ms)));
    } catch (err) {
      setError(`Test examples failed: ${message(err)}`);
    } finally {
      setTesting(false);
    }
  }

  const testable = classifier !== undefined && item.status === 'accepted';
  const testBlocked = !evals.available
    ? 'needs-key'
    : !testable
      ? 'not-accepted'
      : classifier.examples.length === 0
        ? 'no-examples'
        : undefined;

  return (
    <div className="cr-kn-detail" data-testid="rules-detail" data-rule={item.id}>
      <div className="cr-kn-panel-bar">
        <span className="cr-kn-panel-crumb">
          <Icon name={itemIcon(item)} size={14} />
          {enforced ? 'Rule' : KIND_LABEL[item.kind]}
          {enforced && <span className="cr-faint"> · {KIND_LABEL[item.kind]}</span>}
        </span>
        <Menu
          label="More actions"
          testid="rules-more"
          items={[
            {
              label: 'Copy id',
              icon: 'copy',
              hint: item.id.slice(0, 8),
              onSelect: () => copy(item.id, 'Id copied'),
              testid: 'rules-copy-id',
            },
            {
              label: 'Copy text',
              icon: 'file-text',
              onSelect: () => copy(item.text, 'Text copied'),
            },
          ]}
        />
        <IconButton
          icon="x"
          label="Close (Esc)"
          data-testid="rules-detail-close"
          onClick={onClose}
        />
      </div>

      <div className="cr-kn-detail-head">
        <h2 className="cr-kn-detail-title" title={item.id}>
          {title}
        </h2>
        <div className="cr-kn-detail-status">
          <Badge tone={STATUS_TONE[item.status]} testid="rules-status">
            {STATUS_LABEL[item.status]}
          </Badge>
          {item.decided_at !== undefined && item.status !== 'proposed' && (
            <span className="cr-faint">
              {item.decided_by === 'human' ? 'by you ' : ''}on {when(item.decided_at)}
            </span>
          )}
        </div>
        <div className="cr-kn-detail-actions">
          {item.status !== 'accepted' && (
            <Button
              variant={blocker === undefined ? 'primary' : 'secondary'}
              icon="check"
              data-testid="rules-accept"
              busy={busy === 'accept'}
              disabled={busy !== undefined || blocker !== undefined}
              title={
                blocker ??
                (item.status === 'retired'
                  ? 'Apply it again: agents in scope follow it from now on'
                  : 'Agents in scope follow it from now on')
              }
              onClick={() => decide('accept')}
            >
              Accept
            </Button>
          )}
          {item.status !== 'retired' && (
            <Button
              icon="archive"
              data-testid="rules-retire"
              busy={busy === 'retire'}
              disabled={busy !== undefined}
              title="Stop applying it; it is kept for the record"
              onClick={() => decide('retire')}
            >
              Retire
            </Button>
          )}
          <Button
            icon="pencil"
            variant={blocker === undefined ? 'secondary' : 'primary'}
            data-testid="rules-edit"
            aria-expanded={false}
            onClick={onEdit}
          >
            Edit
          </Button>
        </div>
        {blocker !== undefined && (
          <p className="cr-kn-note" data-tone="amber" data-testid="rules-blocker">
            <Icon name="info" size={14} />
            {blocker}
          </p>
        )}
        {error && (
          <p className="cr-kn-note" data-tone="red" role="alert" data-testid="rules-error">
            <Icon name="alert-circle" size={14} />
            {error}
          </p>
        )}
      </div>

      <div className="cr-kn-detail-body">
        <Markdown className="cr-kn-text" text={item.text} testId="rules-text" />

        <dl className="cr-kn-facts">
          <dt>Applies to</dt>
          <dd>
            <span data-testid="rules-detail-scope">{scopeWords(item.scope, names)}</span>
            <span className="cr-kn-fact-hint">{scopeHint(item.scope)}</span>
          </dd>
          {item.paths !== undefined && item.paths.length > 0 && (
            <>
              <dt>Only paths</dt>
              <dd className="cr-kn-paths" data-testid="rules-detail-paths">
                {item.paths.map((path) => (
                  <code key={path}>{path}</code>
                ))}
              </dd>
            </>
          )}
          <dt>Enforcement</dt>
          <dd>
            <span className="cr-kn-fact-badges">
              <EnforcementBadge item={item} testid="rules-detail-tier" />
              {item.critical && enforced && <CriticalMark withLabel />}
            </span>
            <span className="cr-kn-fact-hint">
              {ENFORCEMENT_INFO[item.enforcement].hint}
              {checkWords(item) ? ` Checked ${checkWords(item)}.` : ''}
            </span>
          </dd>
          <dt>Kind</dt>
          <dd>
            {KIND_LABEL[item.kind]}
            <span className="cr-kn-fact-hint">{KIND_HINT[item.kind]}</span>
          </dd>
          <dt>Source</dt>
          <dd>
            <span data-testid="rules-source">{sourceWords(item.source, names)}</span>
            <span className="cr-kn-fact-hint" title={item.created_at}>
              {when(item.created_at)}
            </span>
          </dd>
          {item.source.finding !== undefined && (
            <>
              <dt>Why</dt>
              <dd className="cr-kn-finding" data-testid="rules-finding">
                {plainFinding(item.source.finding)}
              </dd>
            </>
          )}
        </dl>

        {pattern !== undefined && (
          <section className="cr-kn-block">
            <h3>The check</h3>
            <div
              className="cr-kn-pattern"
              data-testid="rules-pattern"
              title={patternSentence(pattern)}
            >
              <p>{patternWords(pattern).lead}</p>
              {patternWords(pattern).args.length > 0 && (
                <ul className="cr-kn-pattern-args">
                  {patternWords(pattern).args.map((arg) => (
                    <li key={arg}>
                      <code>{arg}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="cr-kn-fact-hint">
              A fixed pattern: no classifier call, always the same answer.
            </p>
          </section>
        )}

        {classifier !== undefined && (
          <section className="cr-kn-block">
            <h3>The check</h3>
            <p className="cr-kn-fact-hint">
              The classifier is asked, of each {item.enforcement === 'ship' ? 'diff' : 'action'}:
            </p>
            <blockquote className="cr-kn-question" data-testid="rules-question">
              {classifierQuestion(item)}
            </blockquote>
            {classifier.question === undefined && (
              <p className="cr-kn-fact-hint">The default question, built from the text.</p>
            )}
            {classifier.criteria !== undefined && (
              <dl className="cr-kn-criteria" data-testid="rules-criteria">
                <dt>Yes means</dt>
                <dd>{classifier.criteria.true}</dd>
                <dt>No means</dt>
                <dd>{classifier.criteria.false}</dd>
              </dl>
            )}
            <div className="cr-kn-block-hd">
              <h4>
                Examples <span className="cr-faint">{classifier.examples.length}</span>
              </h4>
              <Button
                size="sm"
                icon="flask"
                data-testid="rules-test"
                busy={testing}
                disabled={testBlocked !== undefined}
                title={
                  testBlocked === 'needs-key'
                    ? 'No classifier key loaded: set one in Settings (or TYPESAFE_API_KEY)'
                    : testBlocked === 'not-accepted'
                      ? 'Only accepted checks are tested: accept it first'
                      : testBlocked === 'no-examples'
                        ? 'Add examples first'
                        : `One classifier call per example (${classifier.examples.length})`
                }
                onClick={runTest}
              >
                {testing ? 'Testing…' : 'Test examples'}
              </Button>
            </div>
            {testBlocked === 'needs-key' && (
              <p className="cr-kn-fact-hint">
                Testing needs a classifier key.{' '}
                <button type="button" className="cr-link" onClick={() => setView('settings')}>
                  Set one in Settings
                </button>
              </p>
            )}
            {report ? (
              // The results list each example with its verdict: no second list.
              <EvalResults report={report} />
            ) : classifier.examples.length === 0 ? (
              <p className="cr-kn-fact-hint">No examples yet. Edit to add some.</p>
            ) : (
              <ul className="cr-kn-examples" data-testid="rules-examples">
                {classifier.examples.map((example, index) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: examples have no identity but their place
                    key={index}
                    data-testid="rules-example"
                    data-violates={example.violates ? 'yes' : 'no'}
                  >
                    <span className="cr-kn-expect" data-violates={example.violates ? 'yes' : 'no'}>
                      {example.violates ? 'Violates' : 'Allowed'}
                    </span>
                    <code>{example.action}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {enforced && item.status !== 'proposed' && (
          <section className="cr-kn-block">
            <h3>Activity</h3>
            <div className="cr-kn-stat-grid" data-testid="rules-detail-stats">
              <Stat value={item.stats.fired} label={item.stats.fired === 1 ? 'check' : 'checks'} />
              <Stat
                value={item.stats.violated}
                label={item.stats.violated === 1 ? 'violation' : 'violations'}
              />
              <Stat value={item.stats.routed} label="asked you" />
              <Stat
                value={item.stats.last_fired_at ? ago(item.stats.last_fired_at) : '—'}
                label="last fired"
                title={
                  item.stats.last_fired_at
                    ? `${formatFiredAt(item.stats.last_fired_at)} UTC`
                    : undefined
                }
              />
            </div>
            {flag && row && (
              <p
                className="cr-kn-note"
                data-tone="amber"
                data-testid="rules-detail-flag"
                data-flag={row.flag}
              >
                <Icon name="alert-triangle" size={14} />
                {flag}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({
  value,
  label,
  title,
}: {
  value: number | string;
  label: string;
  title?: string;
}): JSX.Element {
  return (
    <div className="cr-kn-stat" title={title}>
      <span className="cr-kn-stat-value">
        {typeof value === 'number' ? value.toLocaleString('en-US') : value}
      </span>
      <span className="cr-kn-stat-label">{label}</span>
    </div>
  );
}

function EvalResults({ report }: { report: RuleEvalReport }): JSX.Element {
  const rule = report.rules[0];
  const allAgree = report.agreed === report.total && report.errors === 0;
  return (
    <div className="cr-kn-evals" data-testid="rules-evals" data-all-agree={allAgree ? 'yes' : 'no'}>
      <div className="cr-kn-evals-hd">
        <Icon name={allAgree ? 'check-circle' : 'alert-triangle'} size={15} />
        <span className="cr-kn-evals-sum">{evalSummary(report)}</span>
      </div>
      {rule && (
        <p className="cr-kn-evals-asked" data-testid="rules-evals-asked">
          Asked: {rule.question}
        </p>
      )}
      <ul>
        {(rule?.examples ?? []).map((example, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: one row per example, in order
            key={index}
            data-testid="rules-eval"
            data-agree={example.agree ? 'yes' : 'no'}
            data-band={example.band ?? 'error'}
          >
            <span className="cr-kn-verdict">
              <Icon name={example.agree ? 'check' : 'x'} size={13} />
              {example.agree ? 'Agrees' : 'Disagrees'}
            </span>{' '}
            <span className="cr-kn-eval-body">
              <code>{example.action.replace(/\s+/g, ' ').slice(0, 160)}</code>
              <span className="cr-kn-eval-got">
                {' — '}expected {bandWords(example.expected_band)}, got{' '}
                {example.error !== undefined
                  ? `an error: ${example.error}`
                  : `${bandWords(example.band)} (p ${example.probability?.toFixed(2)})`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
