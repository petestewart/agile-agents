/**
 * T363: a work node's delivery (§14.7; the CLI's `land`, the UI's Merge).
 *
 * `useDelivery` owns the Merge / Check now / Mark landed calls and their
 * last result, so the page header's Merge button and the details panel's
 * Delivery section read one state. `DeliveryPanel` is the section: the
 * state in words (the "before": would a merge go through, and which ship
 * check rules it runs), the open PR with its review and checks, a
 * conflict's files and Resolve, and the "after" (the result line, or the
 * refusal's reason).
 */

import { useCallback, useEffect, useState } from 'react';
import { checkStreamPr, landStream, markStreamLanded } from '../lib/api';
import { deliveryBadge } from '../lib/chat';
import type { LandOutcome, StreamPagePayload } from '../lib/feed-types';
import { isLiveSession } from '../lib/streams';
import { Icon } from './Icon';
import { Linked } from './Markdown';
import { Badge, Button } from './ui';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** T340: a PR url is GitHub data; it is a link only when it is http(s). */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** T338: how a delivery result reads: a pushed PR is a success, a gate is news, not an error. */
const OUTCOME_TONE: Record<LandOutcome['status'], 'ok' | 'info' | 'bad'> = {
  landed: 'ok',
  pr_open: 'ok',
  gated: 'info',
  refused: 'bad',
  blocked: 'bad',
};

/** T347 (D36 D9): a ship-check or waits-on hold is news, not an error; real refusals stay red. */
export function outcomeTone(outcome: LandOutcome): 'ok' | 'info' | 'bad' {
  return outcome.status === 'refused' && outcome.held ? 'info' : OUTCOME_TONE[outcome.status];
}

export interface Delivery {
  busy: boolean;
  outcome: LandOutcome | undefined;
  refused: string | undefined;
  land(): Promise<void>;
  checkPr(): Promise<void>;
  markLanded(): Promise<void>;
}

/**
 * One node's delivery calls. `resetKey` starts it over (another node, or a
 * new session: the last result is stale); `onChanged` re-reads the page.
 */
export function useDelivery(
  id: string,
  resetKey: string,
  onChanged: () => void,
  onResult?: (result: { outcome?: LandOutcome; refused?: string }) => void,
): Delivery {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<LandOutcome | undefined>(undefined);
  const [refused, setRefused] = useState<string | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `resetKey` is the trigger.
  useEffect(() => {
    setOutcome(undefined);
    setRefused(undefined);
  }, [resetKey]);

  const run = useCallback(
    async (fn: () => Promise<LandOutcome | undefined>, clearOutcome: boolean): Promise<void> => {
      setBusy(true);
      if (clearOutcome) setOutcome(undefined);
      setRefused(undefined);
      try {
        const result = await fn();
        if (result !== undefined) {
          setOutcome(result);
          onResult?.({ outcome: result });
        }
      } catch (err) {
        setRefused(errorText(err));
        onResult?.({ refused: errorText(err) });
      } finally {
        setBusy(false);
        onChanged();
      }
    },
    [onChanged, onResult],
  );

  return {
    busy,
    outcome,
    refused,
    land: () => run(() => landStream(id), true),
    checkPr: () =>
      run(async () => {
        await checkStreamPr(id);
        return undefined;
      }, true),
    markLanded: () =>
      run(async () => {
        await markStreamLanded(id);
        return undefined;
      }, false),
  };
}

/** Merge has something to do: commits ahead, a conflict to redo, or a result on show. */
export function isMergeable(page: StreamPagePayload, delivery: Delivery): boolean {
  const { stream, land } = page;
  if (stream.repo === undefined || land === undefined) return false;
  if (stream.human.status === 'landed' || stream.human.status === 'closed') return false;
  if (land.merged) return false;
  const pr = stream.delivery_state?.pr;
  if (stream.delivery_state?.mode === 'pr' && pr?.state === 'open') return false;
  return (
    (land.ahead ?? 0) > 0 ||
    (land.conflicts?.length ?? 0) > 0 ||
    delivery.outcome !== undefined ||
    delivery.refused !== undefined
  );
}

export function DeliveryPanel({
  page,
  delivery,
  onResolve,
}: {
  page: StreamPagePayload;
  delivery: Delivery;
  /** T176: opens the session picker for a Resolve worker. */
  onResolve: () => void;
}): JSX.Element | null {
  const { stream, land } = page;
  const { busy, outcome, refused } = delivery;
  if (stream.repo === undefined) return null;
  const finished = stream.human.status === 'landed' || stream.human.status === 'closed';
  // T176: a failed land's own line replaces the preflight, never "Ready" beside it.
  const failed =
    refused !== undefined || (outcome !== undefined && OUTCOME_TONE[outcome.status] === 'bad');
  const pr = stream.delivery_state?.pr;
  const conflicts = land?.conflicts;
  // T340 (§4.1, P19): with a PR open the merge happens on GitHub; the panel shows the PR, not Merge.
  const openPr =
    stream.delivery_state?.mode === 'pr' && stream.delivery_state.pr?.state === 'open'
      ? stream.delivery_state.pr
      : undefined;
  // The open PR's own line (land-before) is showing: not landed, no conflict, no failure.
  const prAbove =
    openPr !== undefined &&
    stream.human.status !== 'landed' &&
    !(conflicts && conflicts.length > 0) &&
    !failed;
  const badge = deliveryBadge({
    landed: stream.human.status === 'landed',
    closed: stream.human.status === 'closed',
    conflict: (conflicts?.length ?? 0) > 0,
    prOpen: openPr !== undefined,
    held: stream.delivery_state?.status === 'held',
    ready: land?.ready === true,
    mergedOutside: land?.merged === true,
  });

  return (
    <section className="cr-dsec cr-delivery" data-testid="land-panel">
      <div className="cr-dsec-hd">
        <h3>Delivery</h3>
        <Badge tone={badge.tone} testid="delivery-badge">
          {badge.label}
        </Badge>
      </div>
      {stream.human.status === 'landed' ? (
        <p className="cr-delivery-line" data-testid="land-before" data-ready="landed">
          Merged.
        </p>
      ) : conflicts && conflicts.length > 0 ? (
        <div className="cr-delivery-conflict" data-testid="land-conflict">
          <p className="cr-delivery-line" data-testid="land-before" data-ready="conflict">
            Conflict: merging into {land?.target ?? 'the target'} conflicted in {conflicts.length}{' '}
            file{conflicts.length === 1 ? '' : 's'}. Resolve attaches a worker to merge the target
            in and fix them; then merge again.
          </p>
          <ul className="cr-delivery-files">
            {conflicts.map((file) => (
              <li key={file} data-testid="land-conflict-file">
                <code>{file}</code>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            icon="git-merge"
            data-testid="stream-resolve"
            disabled={
              busy || page.stream.sessions.some((s) => s.role === 'worker' && isLiveSession(s))
            }
            onClick={onResolve}
          >
            Resolve
          </Button>
        </div>
      ) : failed ? null : openPr ? (
        <p className="cr-delivery-line" data-testid="land-before" data-ready="pr">
          PR #{openPr.number}
          {openPr.draft ? ' (draft)' : ''} into {openPr.base}:{' '}
          {openPr.review === 'none' ? 'no review' : openPr.review.replace(/_/g, ' ')} · CI{' '}
          {openPr.checks} · auto-merge {openPr.auto_merge}
          {openPr.mergeable !== 'clean' && openPr.mergeable !== 'unknown'
            ? ` · ${openPr.mergeable}`
            : ''}
          . It merges on GitHub.{' '}
          {isWebUrl(openPr.url) ? (
            <a data-testid="stream-pr-link" href={openPr.url} target="_blank" rel="noreferrer">
              Open PR
              <Icon name="external-link" size={12} />
            </a>
          ) : (
            <span data-testid="stream-pr-link">{openPr.url}</span>
          )}
        </p>
      ) : land?.merged ? (
        <p className="cr-delivery-line" data-testid="land-before" data-ready="merged">
          Already merged into {land.target}.
        </p>
      ) : land ? (
        <p
          className="cr-delivery-line"
          data-testid="land-before"
          data-ready={land.ready ? 'yes' : 'no'}
        >
          {land.ready
            ? `Ready: ${land.branch} is ${land.ahead} commit${land.ahead === 1 ? '' : 's'} ahead of ${land.target}${
                land.gated ? ' — this repo asks you to approve each merge' : ''
              }.`
            : `Can’t merge yet: ${land.reason}`}
        </p>
      ) : null}
      {outcome && !(conflicts && conflicts.length > 0) && (
        <p
          className={`cr-land-result ${outcomeTone(outcome)}`}
          data-testid="land-result"
          data-status={outcome.status}
          aria-live="polite"
        >
          <Linked text={outcome.line} />
        </p>
      )}
      {refused && (
        <p
          className="cr-land-result bad"
          data-testid="land-result"
          data-status="refused"
          role="alert"
        >
          {openPr ? 'Check failed' : 'Merge refused'}: {refused}
        </p>
      )}
      {stream.delivery_state && (
        <p
          className="cr-delivery-meta"
          data-testid="delivery-state"
          data-status={stream.delivery_state.status}
        >
          Delivery: {stream.delivery_state.mode} · {stream.delivery_state.status.replace('_', ' ')}
          {/* T341: the result line above already says why; the reason reads once. */}
          {(outcome === undefined && refused === undefined
            ? (stream.delivery_state.held_by ?? [])
            : []
          ).map((h) => (
            <span key={`${h.reason}:${h.detail}`}>
              {' — '}
              <Linked text={h.detail} />
            </span>
          ))}
        </p>
      )}
      {/* T341: an open PR already reads on the line above; this line is for the rest (merged, closed). */}
      {pr && !prAbove && (
        <p className="cr-delivery-meta" data-testid="delivery-pr" data-state={pr.state}>
          {isWebUrl(pr.url) ? (
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="delivery-pr-link"
            >
              PR #{pr.number}
            </a>
          ) : (
            <span data-testid="delivery-pr-link">PR #{pr.number}</span>
          )}{' '}
          {pr.state}
          {pr.draft ? ' (draft)' : ''} · review {pr.review.replace(/_/g, ' ')} · checks {pr.checks}{' '}
          · auto-merge {pr.auto_merge}
          {pr.mergeable !== 'clean' && pr.mergeable !== 'unknown' ? ` · ${pr.mergeable}` : ''}
        </p>
      )}
      {!finished && (
        <p className="cr-delivery-meta" data-testid="land-diff-rules">
          {page.diff_rules.length === 0
            ? 'No diff-stage rules in scope.'
            : `Ship check rules: ${page.diff_rules
                // T341: a named item reads by its name.
                .map((id) => page.rules.find((r) => r.id === id)?.name ?? id)
                .join(', ')}`}
        </p>
      )}
      {!finished && (land?.merged || openPr) && (
        <div className="cr-dsec-actions">
          {land?.merged && (
            <Button
              size="sm"
              icon="check"
              data-testid="stream-mark-landed"
              busy={busy}
              onClick={() => void delivery.markLanded()}
            >
              Mark landed
            </Button>
          )}
          {openPr && (
            <Button
              size="sm"
              icon="refresh"
              data-testid="stream-pr-check"
              disabled={busy}
              onClick={() => void delivery.checkPr()}
            >
              {busy ? 'Checking…' : 'Check now'}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
