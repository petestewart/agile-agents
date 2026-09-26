/**
 * T363: the Changes tab — the node's branch against its landing target.
 * A summary (files, lines added and removed, the branch and its worktree),
 * a file list that jumps to each file, then each file's hunks with line
 * numbers. Every line keeps `data-line` (add/del/hunk/meta/ctx) for the e2e
 * suites.
 *
 * T393: a review, as on GitHub. Hovering a line shows a + in its gutter
 * (a click on its line number does the same; Shift extends the comment to a
 * range); from the keyboard, the lines of a file are one Tab stop, ↑/↓ move
 * between them and C (or Enter) comments on the focused one. Comments show
 * under their line with Edit and Delete, and collect in a review bar at the
 * bottom: "Add to message" puts them in the node's composer as one message
 * (`formatReview`) and opens the chat; nothing is sent until you press Send.
 * Comments live per node for the session (`lib/review.ts`); one whose lines
 * changed since reads "Outdated".
 */

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getStreamDiff } from '../lib/api';
import { type DiffFile, type DiffRow, diffTotals, parseDiff } from '../lib/chat';
import type { StreamDiff } from '../lib/feed-types';
import { modKeyLabel } from '../lib/palette';
import {
  MESSAGE_MAX,
  type ReviewComment,
  type ReviewDraft,
  formatReview,
  isOutdated,
  lineLabel,
  lineRef,
  newComment,
  reviewSummary,
  reviews,
  rowKey,
  rowsBetween,
  useReview,
} from '../lib/review';
import { Icon, type IconName } from './Icon';
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Kbd, useCopy, useToast } from './ui';

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

/** A comment is at most this long, so one always fits in a message with its line. */
const COMMENT_MAX = 500;

function Counts({ file }: { file: Pick<DiffFile, 'additions' | 'deletions'> }): JSX.Element {
  return (
    <span className="cr-diff-counts">
      {file.additions > 0 && <span className="add">+{file.additions}</span>}
      {file.deletions > 0 && <span className="del">−{file.deletions}</span>}
    </span>
  );
}

/** What the review does, handed down to each file. */
interface ReviewActions {
  /** Comment on the line `key` of `file`; with `extend`, stretch the open comment to it. */
  open(file: DiffFile, key: string, extend: boolean): void;
  edit(comment: ReviewComment): void;
  remove(comment: ReviewComment): void;
  setText(text: string): void;
  submit(): void;
  cancel(): void;
}

function focusRow(path: string, key: string): void {
  const file = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="diff-file"]')).find(
    (el) => el.dataset.path === path,
  );
  file?.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus();
}

/** The comment box: a new comment under its line, or an edit in place of the comment. */
function CommentBox({
  draft,
  where,
  actions,
}: {
  draft: ReviewDraft;
  where: string;
  actions: ReviewActions;
}): JSX.Element {
  const mod = modKeyLabel(typeof navigator === 'undefined' ? '' : navigator.platform);
  const empty = draft.text.trim() === '';
  const area = useRef<HTMLTextAreaElement>(null);
  // Opened (or moved to another line): the caret goes after the text.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const back = (): void => {
    // The keyboard goes back to the line it came from.
    requestAnimationFrame(() => focusRow(draft.path, draft.end));
  };
  return (
    <form
      className="cr-diff-compose"
      data-testid="diff-comment-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (empty) return;
        actions.submit();
        back();
      }}
    >
      <textarea
        className="cr-diff-compose-input"
        data-testid="diff-comment-input"
        aria-label={`Comment on ${where.toLowerCase()}`}
        placeholder={draft.editing ? 'Edit your comment…' : 'Leave a comment for the agent…'}
        ref={area}
        value={draft.text}
        maxLength={COMMENT_MAX}
        rows={3}
        onChange={(e) => actions.setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            actions.cancel();
            back();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (empty) return;
            actions.submit();
            back();
          }
        }}
      />
      <div className="cr-diff-compose-bar">
        <span className="cr-diff-compose-where">{where}</span>
        <span className="cr-diff-compose-keys" aria-hidden="true">
          <Kbd>{mod}</Kbd>
          <Kbd>Enter</Kbd> {draft.editing ? 'save' : 'add'} · <Kbd>Esc</Kbd> cancel
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={actions.cancel}
          data-testid="diff-comment-cancel"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={empty}
          data-testid="diff-comment-submit"
        >
          {draft.editing ? 'Save' : 'Add comment'}
        </Button>
      </div>
    </form>
  );
}

/** An added comment, as on a GitHub review: where, the text, Edit and Delete. */
function Comment({
  comment,
  outdated,
  editing,
  actions,
}: {
  comment: ReviewComment;
  outdated: boolean;
  editing: ReviewDraft | undefined;
  actions: ReviewActions;
}): JSX.Element {
  const where = lineLabel(comment);
  if (editing) return <CommentBox draft={editing} where={where} actions={actions} />;
  const quote = comment.quote.find((l) => l.trim() !== '')?.trim();
  return (
    <article
      className="cr-diff-comment"
      data-testid="diff-comment"
      data-outdated={outdated ? 'true' : undefined}
    >
      <header className="cr-diff-comment-hd">
        <span className="cr-diff-comment-who">You</span>
        <span className="cr-diff-comment-where">{where}</span>
        {outdated && (
          <Badge
            tone="amber"
            title="These lines changed since you commented"
            testid="diff-outdated"
          >
            Outdated
          </Badge>
        )}
        <span className="cr-diff-comment-tools">
          <IconButton
            icon="pencil"
            label="Edit comment"
            size="sm"
            data-testid="diff-comment-edit"
            onClick={() => actions.edit(comment)}
          />
          <IconButton
            icon="trash"
            label="Delete comment"
            size="sm"
            data-testid="diff-comment-delete"
            onClick={() => actions.remove(comment)}
          />
        </span>
      </header>
      {outdated && quote && <code className="cr-diff-comment-quote">{quote}</code>}
      <div className="cr-diff-comment-body">{comment.body}</div>
    </article>
  );
}

function Thread({
  comments,
  outdated,
  draft,
  newDraft,
  actions,
}: {
  comments: readonly ReviewComment[];
  outdated: ReadonlySet<string>;
  draft: ReviewDraft | undefined;
  /** The new comment's box goes here, with its "Comment on …" label. */
  newDraft?: string;
  actions: ReviewActions;
}): JSX.Element {
  return (
    <div className="cr-diff-thread">
      {comments.map((c) => (
        <Comment
          key={c.id}
          comment={c}
          outdated={outdated.has(c.id)}
          editing={draft?.editing === c.id ? draft : undefined}
          actions={actions}
        />
      ))}
      {newDraft !== undefined && draft && (
        <CommentBox draft={draft} where={newDraft} actions={actions} />
      )}
    </div>
  );
}

function FileBlock({
  file,
  id,
  review,
}: {
  file: DiffFile;
  id: string;
  /** Absent: this node takes no messages, so its lines take no comments. */
  review?: {
    comments: readonly ReviewComment[];
    outdated: ReadonlySet<string>;
    draft: ReviewDraft | undefined;
    actions: ReviewActions;
  };
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const copy = useCopy();
  const status = STATUS_ICON[file.status];

  // Comments under the line they end on; outdated ones at the top of the file.
  const { byLine, stale } = useMemo(() => {
    const byLine = new Map<string, ReviewComment[]>();
    const stale: ReviewComment[] = [];
    for (const c of review?.comments ?? []) {
      if (c.path !== file.path) continue;
      if (review?.outdated.has(c.id)) stale.push(c);
      else byLine.set(c.end, [...(byLine.get(c.end) ?? []), c]);
    }
    return { byLine, stale };
  }, [review?.comments, review?.outdated, file.path]);

  // The open new comment on this file: the lines it covers and the one its box sits under.
  const draft = review?.draft;
  const drafting = draft && !draft.editing && draft.path === file.path ? draft : undefined;
  const range = drafting ? rowsBetween(file, drafting.start, drafting.end) : undefined;
  const selected = new Set(range?.map(rowKey));
  const boxAt = range?.length ? rowKey(range[range.length - 1] as DiffRow) : undefined;
  const boxWhere = range ? `Comment on ${lineLabel(lineRef(range)).toLowerCase()}` : '';

  const firstKey = useMemo(() => {
    for (const row of file.rows) {
      const key = rowKey(row);
      if (key) return key;
    }
    return undefined;
  }, [file.rows]);
  const tabKey = focusKey !== undefined && hasKey(file, focusKey) ? focusKey : firstKey;

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
        {review?.comments.some((c) => c.path === file.path) && (
          <span
            className="cr-diff-file-comments"
            title="Your comments on this file"
            data-testid="diff-file-comments"
          >
            <Icon name="message-square" size={12} />
            {review.comments.filter((c) => c.path === file.path).length}
          </span>
        )}
        <Counts file={file} />
        <IconButton
          icon="copy"
          label="Copy the path"
          size="sm"
          onClick={() => copy(file.path, 'Copied the path')}
        />
      </header>
      {open && (
        <div className="cr-diff" data-commentable={review ? 'true' : undefined}>
          {review && stale.length > 0 && (
            <Thread
              comments={stale}
              outdated={review.outdated}
              draft={review.draft}
              actions={review.actions}
            />
          )}
          {file.rows.map((row, i) => {
            const key = review ? rowKey(row) : undefined;
            const here = key ? byLine.get(key) : undefined;
            const label = key ? lineLabel(lineRef([row])) : '';
            return (
              <DiffLine
                // biome-ignore lint/suspicious/noArrayIndexKey: a patch's lines are positional and never reordered.
                key={i}
                row={row}
                rowKey={key}
                label={label}
                tabbable={key !== undefined && key === tabKey}
                selected={key !== undefined && selected.has(key)}
                onFocus={() => key && setFocusKey(key)}
                onComment={(extend) => key && review?.actions.open(file, key, extend)}
              >
                {review && key && (here || boxAt === key) && (
                  <Thread
                    comments={here ?? []}
                    outdated={review.outdated}
                    draft={review.draft}
                    {...(boxAt === key ? { newDraft: boxWhere } : {})}
                    actions={review.actions}
                  />
                )}
              </DiffLine>
            );
          })}
          {file.rows.length === 0 && <div className="cr-diff-row cr-dim">No line changes.</div>}
        </div>
      )}
    </section>
  );
}

function hasKey(file: DiffFile, key: string): boolean {
  return file.rows.some((row) => rowKey(row) === key);
}

/** One diff line; with a key it takes comments (the gutter's + or its number, C or Enter). */
function DiffLine({
  row,
  rowKey: key,
  label,
  tabbable,
  selected,
  onFocus,
  onComment,
  children,
}: {
  row: DiffRow;
  rowKey: string | undefined;
  label: string;
  tabbable: boolean;
  selected: boolean;
  onFocus: () => void;
  onComment: (extend: boolean) => void;
  children?: ReactNode;
}): JSX.Element {
  if (key === undefined) {
    return (
      <>
        <div className="cr-diff-row" data-line={row.kind}>
          <span className="cr-diff-ln" aria-hidden="true">
            {row.old ?? ''}
          </span>
          <span className="cr-diff-ln" aria-hidden="true">
            {row.new ?? ''}
          </span>
          <span className="cr-diff-code">{row.text}</span>
        </div>
        {children}
      </>
    );
  }
  return (
    <>
      <div
        className="cr-diff-row"
        data-line={row.kind}
        data-key={key}
        data-selected={selected ? 'true' : undefined}
        tabIndex={tabbable ? 0 : -1}
        aria-keyshortcuts="c"
        onFocus={(e) => {
          if (e.target === e.currentTarget) onFocus();
        }}
        onClick={(e) => {
          // The gutter comments; a click on the code is left to select text.
          if (!(e.target as Element).closest('.cr-diff-ln, .cr-diff-add')) return;
          e.preventDefault();
          onComment(e.shiftKey);
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const lines = Array.from(
              e.currentTarget.closest('.cr-diff')?.querySelectorAll<HTMLElement>('[data-key]') ??
                [],
            );
            lines[lines.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
          } else if (e.key === 'c' || e.key === 'C' || e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            onComment(e.shiftKey);
          }
        }}
      >
        <span className="cr-diff-ln" aria-hidden="true">
          {row.old ?? ''}
        </span>
        <span className="cr-diff-ln" aria-hidden="true">
          {row.new ?? ''}
        </span>
        <button
          type="button"
          className="cr-diff-add"
          tabIndex={-1}
          aria-label={`Comment on ${label.toLowerCase()}`}
          title="Comment (C) · Shift-click to comment on a range"
          data-testid="diff-comment-add"
        >
          <Icon name="plus" size={12} strokeWidth={2.5} />
        </button>
        <span className="cr-diff-code">{row.text}</span>
      </div>
      {children}
    </>
  );
}

/** The sticky bar once there is a comment: how many, Discard, and Add to message. */
function ReviewBar({
  comments,
  message,
  fits,
  room,
  onAdd,
  onDiscard,
}: {
  comments: readonly ReviewComment[];
  message: string;
  fits: boolean;
  /** What the message may take: the cap, less the draft already in the composer. */
  room: number;
  onAdd: () => void;
  onDiscard: () => void;
}): JSX.Element {
  const over = message.length - room;
  const draftTaken = room < MESSAGE_MAX;
  return (
    <section className="cr-review-bar" data-testid="review-bar" aria-label="Your review">
      <span className="cr-review-bar-icon" aria-hidden="true">
        <Icon name="message-square" size={15} />
      </span>
      <div className="cr-review-bar-text">
        <span className="cr-review-bar-count" data-testid="review-count">
          {reviewSummary(comments)}
        </span>
        {fits ? (
          <span className="cr-review-bar-sub">
            Goes to the chat as one message. You read it before sending.
          </span>
        ) : (
          <span className="cr-review-bar-warn" data-testid="review-too-long">
            {over} character{over === 1 ? '' : 's'} too long for one message
            {draftTaken ? ' with your draft' : ''}. Shorten or delete a comment
            {draftTaken ? ', or send the draft first' : ''}.
          </span>
        )}
      </div>
      <div className="cr-review-bar-actions">
        <Button size="sm" variant="ghost" onClick={onDiscard} data-testid="review-discard">
          Discard
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon="corner-down-left"
          disabled={!fits}
          onClick={onAdd}
          data-testid="review-add"
        >
          Add to message
        </Button>
      </div>
    </section>
  );
}

export function DiffView({
  id,
  version,
  onAddToMessage,
  room = MESSAGE_MAX,
}: {
  id: string;
  version: unknown;
  /** T393: present when the node takes messages — its lines take comments, sent as one message. */
  onAddToMessage?: (text: string) => void;
  /** The characters the review may take in the composer (the cap less any draft there). */
  room?: number;
}): JSX.Element {
  const [diff, setDiff] = useState<StreamDiff | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [seq, setSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const review = useReview(id);
  const toast = useToast();
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

  const files = useMemo(() => (diff ? parseDiff(diff.patch) : []), [diff]);
  const outdated = useMemo(
    () => new Set(review.comments.filter((c) => isOutdated(c, files)).map((c) => c.id)),
    [review.comments, files],
  );

  const idRef = useRef(id);
  idRef.current = id;
  const update = useCallback(
    (fn: Parameters<typeof reviews.update>[1]) => reviews.update(idRef.current, fn),
    [],
  );
  const actions = useMemo<ReviewActions>(
    () => ({
      open(file, key, extend) {
        update((r) => {
          const d = r.draft;
          if (
            extend &&
            d &&
            !d.editing &&
            d.path === file.path &&
            rowsBetween(file, d.start, key)
          ) {
            return { ...r, draft: { ...d, end: key } };
          }
          // A new comment elsewhere: text being written comes along; an edit is dropped.
          const text = d && !d.editing ? d.text : '';
          return { ...r, draft: { path: file.path, start: key, end: key, text } };
        });
      },
      edit(comment) {
        update((r) => ({
          ...r,
          draft: {
            path: comment.path,
            start: comment.start,
            end: comment.end,
            text: comment.body,
            editing: comment.id,
          },
        }));
      },
      remove(comment) {
        update((r) => ({ ...r, comments: r.comments.filter((c) => c.id !== comment.id) }));
        toast({
          title: 'Comment deleted',
          tone: 'info',
          action: {
            label: 'Undo',
            onClick: () => update((r) => ({ ...r, comments: [...r.comments, comment] })),
          },
        });
      },
      setText(text) {
        update((r) => (r.draft ? { ...r, draft: { ...r.draft, text } } : r));
      },
      submit() {
        update((r) => {
          const d = r.draft;
          if (!d || d.text.trim() === '') return r;
          if (d.editing) {
            return {
              comments: r.comments.map((c) =>
                c.id === d.editing ? { ...c, body: d.text.trim() } : c,
              ),
            };
          }
          const file = files.find((f) => f.path === d.path);
          const made = file && newComment(file, d.start, d.end, d.text, reviews.nextId());
          return made ? { comments: [...r.comments, made] } : r;
        });
      },
      cancel() {
        update((r) => ({ comments: r.comments }));
      },
    }),
    [update, files, toast],
  );

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
  const totals = diffTotals(files);
  const canComment = onAddToMessage !== undefined;
  const fileReview = canComment
    ? { comments: review.comments, outdated, draft: review.draft, actions }
    : undefined;
  const orphans = review.comments.filter((c) => !files.some((f) => f.path === c.path));
  const message = formatReview(review.comments, files, room);
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
          {canComment && review.comments.length === 0 && !review.draft && (
            <p className="cr-diff-hint" data-testid="diff-hint">
              <Icon name="message-square" size={13} />
              <span className="cr-diff-hint-pointer">
                Hover a line and click + to comment on it. Your comments go to the agent as one
                message.
              </span>
              <span className="cr-diff-hint-touch">
                Tap a line number to comment on it. Your comments go to the agent as one message.
              </span>
            </p>
          )}
          {files.map((file, i) => (
            <FileBlock
              key={file.path}
              file={file}
              id={`diff-file-${i}`}
              {...(fileReview ? { review: fileReview } : {})}
            />
          ))}
        </>
      )}
      {canComment && orphans.length > 0 && (
        <section className="cr-diff-file" data-testid="diff-orphans">
          <header className="cr-diff-file-hd">
            <span className="cr-diff-orphans-title">
              <Icon name="message-square" size={13} /> Comments on files no longer changed
            </span>
          </header>
          {orphans.map((c) => (
            <div key={c.id} className="cr-diff-orphan">
              <span className="cr-diff-path">{c.path}</span>
              <Thread comments={[c]} outdated={outdated} draft={review.draft} actions={actions} />
            </div>
          ))}
        </section>
      )}
      {diff.truncated && (
        <p className="cr-diff-note">
          <Icon name="info" size={13} /> Truncated — the patch is over the page’s cap. Open the
          worktree to see the rest.
        </p>
      )}
      {canComment && review.comments.length > 0 && (
        <ReviewBar
          comments={review.comments}
          message={message.text}
          fits={message.fits}
          room={room}
          onAdd={() => {
            if (!message.fits) return;
            onAddToMessage(message.text);
            update((r) => (r.draft ? { comments: [], draft: r.draft } : { comments: [] }));
          }}
          onDiscard={() => setDiscarding(true)}
        />
      )}
      <ConfirmDialog
        open={discarding}
        title={`Discard ${review.comments.length === 1 ? 'your comment' : `${review.comments.length} comments`}?`}
        confirmLabel="Discard"
        danger
        testid="discard-review"
        onCancel={() => setDiscarding(false)}
        onConfirm={() => {
          setDiscarding(false);
          update(() => ({ comments: [] }));
        }}
      >
        {review.comments.length === 1 ? 'It hasn’t' : 'They haven’t'} been sent to the agent. This
        can’t be undone.
      </ConfirmDialog>
    </div>
  );
}
