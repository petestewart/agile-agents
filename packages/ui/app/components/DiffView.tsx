/**
 * T363: the Changes tab — the node's branch against its landing target.
 * A summary (files, lines added and removed, the branch and its worktree),
 * a file list that jumps to each file, then each file's hunks with line
 * numbers. Every line keeps `data-line` (add/del/hunk/meta/ctx) for the e2e
 * suites.
 */

import { useEffect, useState } from 'react';
import { getStreamDiff } from '../lib/api';
import { type DiffFile, diffTotals, parseDiff } from '../lib/chat';
import type { StreamDiff } from '../lib/feed-types';
import { Icon, type IconName } from './Icon';
import { Button, EmptyState, IconButton, useCopy } from './ui';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const STATUS_ICON: Record<DiffFile['status'], { icon: IconName; label: string }> = {
  added: { icon: 'plus', label: 'Added' },
  deleted: { icon: 'x', label: 'Deleted' },
  modified: { icon: 'pencil', label: 'Modified' },
  renamed: { icon: 'arrow-right', label: 'Renamed' },
  binary: { icon: 'file-text', label: 'Binary' },
};

function Counts({ file }: { file: Pick<DiffFile, 'additions' | 'deletions'> }): JSX.Element {
  return (
    <span className="cr-diff-counts">
      {file.additions > 0 && <span className="add">+{file.additions}</span>}
      {file.deletions > 0 && <span className="del">−{file.deletions}</span>}
    </span>
  );
}

function FileBlock({ file, id }: { file: DiffFile; id: string }): JSX.Element {
  const [open, setOpen] = useState(true);
  const copy = useCopy();
  const status = STATUS_ICON[file.status];
  return (
    <section className="cr-diff-file" id={id} data-testid="diff-file" data-path={file.path}>
      <header className="cr-diff-file-hd">
        <button
          type="button"
          className="cr-diff-file-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
          <span className="cr-diff-status" data-status={file.status} title={status.label}>
            <Icon name={status.icon} size={12} />
          </span>
          <span className="cr-diff-path">
            {file.from ? `${file.from} → ` : ''}
            {file.path}
          </span>
        </button>
        <Counts file={file} />
        <IconButton
          icon="copy"
          label="Copy the path"
          size="sm"
          onClick={() => copy(file.path, 'Copied the path')}
        />
      </header>
      {open && (
        <div className="cr-diff">
          {file.rows.map((row, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a patch's lines are positional and never reordered.
              key={i}
              className="cr-diff-row"
              data-line={row.kind}
            >
              <span className="cr-diff-ln" aria-hidden="true">
                {row.old ?? ''}
              </span>
              <span className="cr-diff-ln" aria-hidden="true">
                {row.new ?? ''}
              </span>
              <span className="cr-diff-code">{row.text}</span>
            </div>
          ))}
          {file.rows.length === 0 && <div className="cr-diff-row cr-dim">No line changes.</div>}
        </div>
      )}
    </section>
  );
}

export function DiffView({ id, version }: { id: string; version: unknown }): JSX.Element {
  const [diff, setDiff] = useState<StreamDiff | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [seq, setSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` and `seq` are re-read triggers.
  useEffect(() => {
    let live = true;
    setLoading(true);
    getStreamDiff(id)
      .then((d) => {
        if (!live) return;
        setDiff(d);
        setError(undefined);
      })
      .catch((err: unknown) => live && setError(errorText(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [id, version, seq]);

  if (error && !diff) {
    return (
      <div data-testid="diff-empty">
        <EmptyState icon="alert-circle" title="Couldn’t read the changes">
          {error}
        </EmptyState>
      </div>
    );
  }
  if (!diff) {
    return (
      <div className="cr-skel-stack" aria-busy="true">
        <div className="cr-skel" style={{ width: '40%' }} />
        <div className="cr-skel" style={{ height: 120 }} />
      </div>
    );
  }
  const files = parseDiff(diff.patch);
  const totals = diffTotals(files);
  return (
    <div className="cr-diffview" data-testid="diff">
      <div className="cr-diff-summary">
        <div className="cr-diff-summary-main">
          <div className="cr-diff-branch">
            <Icon name="git-branch" size={14} />
            <code>{diff.branch}</code>
            <Icon name="arrow-right" size={12} className="cr-faint" />
            <code>{diff.target}</code>
          </div>
          {diff.worktree && (
            <div className="cr-diff-wt" title="The worktree on disk">
              <Icon name="folder" size={13} />
              <span>{diff.worktree}</span>
            </div>
          )}
        </div>
        <div className="cr-diff-summary-side">
          <span className="cr-dim">
            {files.length} file{files.length === 1 ? '' : 's'}
          </span>
          <Counts file={totals} />
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            busy={loading}
            onClick={() => setSeq((n) => n + 1)}
          >
            Refresh
          </Button>
        </div>
      </div>
      {files.length === 0 ? (
        <EmptyState icon="file-diff" title="No changes yet">
          Nothing is committed on {diff.branch} beyond {diff.target}.
        </EmptyState>
      ) : (
        <>
          {files.length > 1 && (
            <ul className="cr-diff-files" aria-label="Changed files">
              {files.map((file, i) => (
                <li key={file.path}>
                  <a
                    href={`#diff-file-${i}`}
                    onClick={(e) => {
                      e.preventDefault();
                      document
                        .getElementById(`diff-file-${i}`)
                        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                    }}
                  >
                    <span className="cr-diff-status" data-status={file.status}>
                      <Icon name={STATUS_ICON[file.status].icon} size={11} />
                    </span>
                    <span className="cr-diff-path">{file.path}</span>
                    <Counts file={file} />
                  </a>
                </li>
              ))}
            </ul>
          )}
          {files.map((file, i) => (
            <FileBlock key={file.path} file={file} id={`diff-file-${i}`} />
          ))}
        </>
      )}
      {diff.truncated && (
        <p className="cr-diff-note">
          <Icon name="info" size={13} /> Truncated — the patch is over the page’s cap. Open the
          worktree to see the rest.
        </p>
      )}
    </div>
  );
}
