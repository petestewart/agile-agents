/**
 * T367: "Add repository" — a dialog any screen can open (Settings →
 * Repositories, and later New project and New node).
 *
 * Two ways in (Pete: "Repo selection should be file picker not free text.
 * Should also accept gh url"):
 *  - **Local folder**: a path field that autocompletes as you type
 *    (`GET /api/fs/dirs` with the last segment as the prefix) over a folder
 *    browser (breadcrumb, Up, Home; git repositories marked). The folder
 *    must be a git repository's top level; the name defaults to its folder.
 *  - **Clone from URL**: https, `git@host:owner/repo`, `ssh://`, GitHub's
 *    `owner/repo` or a local path, previewed as you type (`lib/repos.ts`
 *    reads it the way the daemon will), cloned into a folder you can change
 *    with the same browser (`POST /api/repos/clone`).
 * A URL typed or pasted into the folder field switches to cloning.
 *
 * Embed: `<AddRepoDialog open={open} onClose={() => setOpen(false)}
 * onAdded={(name, repos) => …} />`. It renders nothing while closed, and
 * starts fresh each time it opens.
 */

import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  type DirEntry,
  type DirListing,
  type RepoRow,
  addRepo,
  cloneRepo,
  listDirs,
  listRepos,
} from '../lib/api';
import {
  type RepoSource,
  type TypedPath,
  baseName,
  breadcrumbs,
  cleanDaemonError,
  cloneParentCandidates,
  describeCloneError,
  joinPath,
  looksLikeGithubShorthand,
  looksLikeRepoUrl,
  parseRepoSource,
  sourceRemote,
  splitTypedPath,
  tildify,
} from '../lib/repos';
import { Icon, type IconName } from './Icon';
import {
  Badge,
  Button,
  Dialog,
  Field,
  IconButton,
  RepoIcon,
  Segmented,
  Spinner,
  repoKindLabel,
  useToast,
} from './ui';

export interface AddRepoDialogProps {
  open: boolean;
  onClose: () => void;
  /** After a repo is registered (added or cloned): its name, and every repo as the daemon now has them. */
  onAdded?: (name: string, repos: RepoRow[]) => void;
  /** Which way in the dialog opens on (default: a local folder). */
  initialMode?: AddRepoMode;
}

export type AddRepoMode = 'local' | 'clone';

export function AddRepoDialog({
  open,
  onClose,
  onAdded,
  initialMode = 'local',
}: AddRepoDialogProps): JSX.Element | null {
  if (!open) return null;
  // A portal, so it can open from inside another dialog's form (New project, New node)
  // without nesting one form in another; its submit stops here instead of reaching that form.
  return createPortal(
    <div className="cr-ar-portal" onSubmit={(e) => e.stopPropagation()}>
      <AddRepoForm onClose={onClose} onAdded={onAdded} initialMode={initialMode} />
    </div>,
    document.body,
  );
}

function messageOf(err: unknown): string {
  const text = cleanDaemonError(err instanceof Error ? err.message : String(err));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------- the folder picker

interface Chosen {
  path: string;
  git: boolean;
}

interface FolderPicker {
  text: string;
  query: TypedPath;
  /** The newest listing (possibly for an earlier query while the next one loads). */
  listing: DirListing | undefined;
  /** `listing` answers the current query. */
  fresh: boolean;
  loading: boolean;
  /** The daemon's refusal for the current query (a missing folder, a relative path). */
  error: string | undefined;
  picked: DirEntry | undefined;
  highlight: number;
  /** The folder the field names, once known: the listed folder, or a picked or exactly typed child. */
  chosen: Chosen | undefined;
  home: string | undefined;
  type(text: string): void;
  /** Lists `path` (the field follows, ending in `/`). */
  open(path: string, home?: string): void;
  /** Selects a child of the listed folder; the list stays as it is. */
  pick(entry: DirEntry): void;
  setHighlight(index: number): void;
}

function useFolderPicker(): FolderPicker {
  const [text, setText] = useState('');
  const [query, setQuery] = useState<TypedPath>({ dir: undefined, prefix: '' });
  const [listing, setListing] = useState<{ key: string; value: DirListing } | undefined>();
  const [error, setError] = useState<{ key: string; message: string } | undefined>();
  const [picked, setPicked] = useState<DirEntry | undefined>();
  const [highlight, setHighlight] = useState(-1);
  const seq = useRef(0);
  const first = useRef(true);
  const key = `${query.dir ?? ''}\u0000${query.prefix}`;

  useEffect(() => {
    const n = ++seq.current;
    const delay = first.current ? 0 : 120;
    first.current = false;
    const timer = setTimeout(() => {
      listDirs(query.dir, false, query.prefix || undefined)
        .then((value) => {
          if (n !== seq.current) return;
          setListing({ key, value });
          setError(undefined);
        })
        .catch((err: unknown) => {
          if (n === seq.current) setError({ key, message: messageOf(err) });
        });
    }, delay);
    return () => clearTimeout(timer);
  }, [key, query.dir, query.prefix]);

  const fresh = listing?.key === key;
  const current = error?.key === key ? error.message : undefined;
  const value = listing?.value;
  const home = value?.home;

  const chosen = useMemo<Chosen | undefined>(() => {
    if (picked) return { path: picked.path, git: picked.git };
    if (!fresh || !value || text.trim() === '') return undefined;
    if (query.prefix === '') return { path: value.path, git: value.is_git };
    const exact = value.entries.find((e) => e.name === query.prefix);
    return exact ? { path: exact.path, git: exact.git } : undefined;
  }, [picked, fresh, value, text, query.prefix]);

  const type = useCallback((next: string) => {
    setText(next);
    setQuery(splitTypedPath(next));
    setPicked(undefined);
    setHighlight(-1);
  }, []);

  const open = useCallback(
    (path: string, homeHint?: string) => {
      setText(path === '/' ? '/' : `${tildify(path, homeHint ?? home)}/`);
      setQuery({ dir: path, prefix: '' });
      setPicked(undefined);
      setHighlight(-1);
    },
    [home],
  );

  const pick = useCallback(
    (entry: DirEntry) => {
      setPicked(entry);
      setText(tildify(entry.path, home));
      setHighlight(value?.entries.findIndex((e) => e.path === entry.path) ?? -1);
    },
    [home, value],
  );

  return {
    text,
    query,
    listing: value,
    fresh,
    loading: !fresh && current === undefined,
    error: current,
    picked,
    highlight,
    chosen,
    home,
    type,
    open,
    pick,
    setHighlight,
  };
}

/** Arrow keys move through the folders, Enter opens the highlighted one, Tab completes. */
function onPathKeyDown(picker: FolderPicker, event: KeyboardEvent<HTMLInputElement>): void {
  const entries = picker.listing?.entries ?? [];
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (entries.length === 0) return;
    event.preventDefault();
    const at = picker.highlight;
    picker.setHighlight(
      event.key === 'ArrowDown' ? (at + 1) % entries.length : at <= 0 ? entries.length - 1 : at - 1,
    );
    return;
  }
  const lit = picker.highlight >= 0 ? entries[picker.highlight] : undefined;
  if (event.key === 'Enter' && lit && picker.picked?.path !== lit.path) {
    event.preventDefault();
    picker.open(lit.path);
    return;
  }
  if (
    event.key === 'Tab' &&
    !event.shiftKey &&
    picker.query.prefix !== '' &&
    picker.picked === undefined &&
    entries.length > 0
  ) {
    const target = lit ?? entries[0];
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    picker.open(target.path);
  }
}

function FolderBrowser({
  picker,
  listId,
  testid,
  label,
}: {
  picker: FolderPicker;
  listId: string;
  testid: string;
  label: string;
}): JSX.Element {
  const list = useRef<HTMLDivElement>(null);
  const listing = picker.listing;
  const crumbs = listing ? breadcrumbs(listing.path, listing.home) : [];
  const crumbBar = useRef<HTMLElement>(null);

  // Keep the highlighted folder in view, and the deepest crumb visible.
  useEffect(() => {
    if (picker.highlight < 0) return;
    list.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(`${listId}-${picker.highlight}`)}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [picker.highlight, listId]);
  useEffect(() => {
    const bar = crumbBar.current;
    if (bar) bar.scrollLeft = bar.scrollWidth;
  });

  const entries = listing?.entries ?? [];
  return (
    <div
      className="cr-fb"
      data-testid={testid}
      data-path={listing?.path}
      data-loading={picker.loading ? 'true' : undefined}
    >
      <div className="cr-fb-bar">
        <IconButton
          icon="folder-up"
          label="Up one folder"
          size="sm"
          data-testid={`${testid}-up`}
          disabled={!listing?.parent}
          onClick={() => listing?.parent && picker.open(listing.parent)}
        />
        <IconButton
          icon="home"
          label="Home folder"
          size="sm"
          data-testid={`${testid}-home`}
          onClick={() => listing && picker.open(listing.home)}
        />
        <nav className="cr-fb-crumbs" aria-label={`${label}: current folder`} ref={crumbBar}>
          {crumbs.map((c, i) => (
            <span key={c.path} className="cr-fb-crumb">
              {i > 0 && c.label !== '/' && crumbs[i - 1]?.label !== '/' ? (
                <span className="cr-fb-sep" aria-hidden="true">
                  /
                </span>
              ) : null}
              <button
                type="button"
                aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                onClick={() => picker.open(c.path)}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        {listing?.is_git ? (
          <Badge tone="accent" icon="git-branch" title="This folder is a git repository">
            git
          </Badge>
        ) : null}
        {picker.loading ? <Spinner size={12} /> : null}
      </div>
      {picker.error && !picker.fresh ? (
        <div className="cr-fb-empty" data-testid={`${testid}-error`}>
          {picker.error}
        </div>
      ) : entries.length === 0 ? (
        <div className="cr-fb-empty">
          {picker.query.prefix
            ? `No folder here starts with “${picker.query.prefix}”`
            : listing
              ? 'No folders in here'
              : 'Loading…'}
        </div>
      ) : (
        <div
          className="cr-fb-list"
          id={listId}
          // biome-ignore lint/a11y/useSemanticElements: a combobox's list of folders; a native <select> can't hold the per-row Open button.
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          ref={list}
        >
          {entries.map((entry, i) => {
            const selected = picker.chosen?.path === entry.path;
            return (
              <div
                key={entry.path}
                role="presentation"
                className="cr-fb-row"
                data-active={picker.highlight === i ? 'true' : undefined}
                data-selected={selected ? 'true' : undefined}
                data-git={entry.git ? 'true' : 'false'}
              >
                <div
                  id={`${listId}-${i}`}
                  // biome-ignore lint/a11y/useSemanticElements: an option of the listbox above, styled as a folder row.
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  className="cr-fb-item"
                  data-testid="add-repo-dir"
                  data-path={entry.path}
                  data-name={entry.name}
                  data-git={entry.git ? 'true' : 'false'}
                  title={entry.git ? `${entry.name} — a git repository` : entry.name}
                  onClick={() => picker.pick(entry)}
                  onDoubleClick={() => picker.open(entry.path)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') picker.open(entry.path);
                    if (e.key === ' ') {
                      e.preventDefault();
                      picker.pick(entry);
                    }
                  }}
                >
                  <Icon name={entry.git ? 'folder-git' : 'folder'} size={16} />
                  <span className="cr-fb-name">{entry.name}</span>
                  {entry.git ? <Badge tone="accent">git</Badge> : null}
                </div>
                <button
                  type="button"
                  className="cr-fb-open"
                  tabIndex={-1}
                  aria-label={`Open ${entry.name}`}
                  title={`Open ${entry.name}`}
                  data-testid="add-repo-dir-open"
                  onClick={() => picker.open(entry.path)}
                >
                  <Icon name="chevron-right" size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {listing?.truncated ? (
        <div className="cr-fb-more">Showing the first 500 folders. Type to narrow the list.</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- the dialog

function Alert({
  message,
  testid,
  clone = false,
}: {
  message: string | undefined;
  testid: string;
  clone?: boolean;
}): JSX.Element | null {
  if (!message) return null;
  const text = clone ? describeCloneError(message) : { title: messageOf(message) };
  return (
    <div className="cr-ar-alert" role="alert" data-testid={testid}>
      <Icon name="alert-circle" size={16} />
      <div className="cr-ar-alert-text">
        <div className="cr-ar-alert-title">{text.title}</div>
        {'hint' in text && text.hint ? <div className="cr-ar-alert-hint">{text.hint}</div> : null}
        {'detail' in text && text.detail ? <pre>{text.detail}</pre> : null}
      </div>
    </div>
  );
}

function SourcePreview({ source }: { source: RepoSource }): JSX.Element {
  const remote = sourceRemote(source);
  return (
    <div
      className="cr-ar-preview"
      data-testid="add-repo-clone-preview"
      data-kind={remote?.kind ?? 'local'}
      data-protocol={source.protocol}
    >
      <RepoIcon remote={remote} size={18} />
      <div className="cr-ar-preview-text">
        <div className="cr-ar-preview-name">
          {source.owner ? <span className="cr-ar-owner">{source.owner}/</span> : null}
          {source.name}
        </div>
        <div className="cr-ar-preview-meta">
          {remote ? repoKindLabel(remote) : 'A repository on this machine'}
          {source.host && remote?.kind === 'other' ? ` · ${source.host}` : ''}
        </div>
      </div>
    </div>
  );
}

function AddRepoForm({
  onClose,
  onAdded,
  initialMode,
}: {
  onClose: () => void;
  onAdded: AddRepoDialogProps['onAdded'];
  initialMode: AddRepoMode;
}): JSX.Element {
  const toast = useToast();
  const ids = useId();
  const [mode, setMode] = useState<AddRepoMode>(initialMode);
  const [repos, setRepos] = useState<RepoRow[] | undefined>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    listRepos()
      .then(setRepos)
      .catch(() => setRepos([]));
  }, []);

  // ---- local folder
  const local = useFolderPicker();
  const [nameEdit, setNameEdit] = useState<string | undefined>();
  const [protectedRaw, setProtectedRaw] = useState('');
  const [addError, setAddError] = useState<string | undefined>();
  const pathRef = useRef<HTMLInputElement>(null);
  const chosen = local.chosen;
  const existing = chosen ? repos?.find((r) => r.path === chosen.path) : undefined;
  const localName = (nameEdit ?? (chosen ? baseName(chosen.path) : '')).trim();
  const localNameTaken =
    localName !== '' && repos?.some((r) => r.name === localName) === true && !existing;
  const canAdd =
    chosen?.git === true &&
    existing === undefined &&
    localName !== '' &&
    !localNameTaken &&
    repos !== undefined &&
    !busy;
  const branches = protectedRaw
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  // ---- clone from URL
  const dest = useFolderPicker();
  const [url, setUrl] = useState('');
  const [switched, setSwitched] = useState(false);
  const [cloneNameEdit, setCloneNameEdit] = useState<string | undefined>();
  const [cloneError, setCloneError] = useState<string | undefined>();
  const [destOpen, setDestOpen] = useState(false);
  const destTouched = useRef(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const parsed = parseRepoSource(url);
  const source = parsed?.ok ? parsed.source : undefined;
  const cloneName = (cloneNameEdit ?? source?.name ?? '').trim();
  const cloneNameTaken = cloneName !== '' && repos?.some((r) => r.name === cloneName) === true;
  const destEmpty = dest.text.trim() === '';
  const destParent = dest.chosen?.path;
  const target = destParent && cloneName ? joinPath(destParent, cloneName) : undefined;
  const destListed = dest.fresh && dest.query.prefix === '' && dest.picked === undefined;
  const targetExists =
    destListed && cloneName !== '' && dest.listing?.entries.some((e) => e.name === cloneName);
  const destError =
    !destEmpty && dest.fresh && !dest.chosen
      ? `No folder named “${dest.query.prefix}” there`
      : !destEmpty && dest.error
        ? dest.error
        : undefined;
  const canClone =
    source !== undefined &&
    cloneName !== '' &&
    !cloneNameTaken &&
    (destEmpty || destParent !== undefined) &&
    repos !== undefined &&
    !busy;

  // The destination defaults to where the daemon would clone: next to the
  // last repo added, else ~/Projects, else home (the first that exists).
  const destInit = useRef(false);
  const openDest = useRef(dest.open);
  openDest.current = dest.open;
  useEffect(() => {
    if (mode !== 'clone' || repos === undefined || destInit.current) return;
    destInit.current = true;
    void (async () => {
      for (const candidate of cloneParentCandidates(repos)) {
        try {
          const found = await listDirs(candidate);
          if (mounted.current && !destTouched.current) openDest.current(found.path, found.home);
          return;
        } catch {
          // not there: try the next
        }
      }
    })();
  }, [mode, repos]);

  // A different folder chosen: its own name, and no stale refusal.
  const chosenPath = chosen?.path;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new folder, by path.
  useEffect(() => {
    setNameEdit(undefined);
    setAddError(undefined);
  }, [chosenPath]);

  // Moving between the two ways in puts the cursor in the new one's first field.
  const lastMode = useRef(mode);
  useEffect(() => {
    if (lastMode.current === mode) return;
    lastMode.current = mode;
    (mode === 'clone' ? urlRef : pathRef).current?.focus();
  }, [mode]);

  function switchToClone(value: string): void {
    setMode('clone');
    setUrl(value.trim());
    setSwitched(true);
    setCloneNameEdit(undefined);
    setCloneError(undefined);
  }

  const cloneTarget = ((): { state: string; icon: IconName; body: JSX.Element } | undefined => {
    if (cloneNameTaken) {
      return {
        state: 'taken',
        icon: 'alert-circle',
        body: (
          <>
            A repository named <strong>{cloneName}</strong> is already registered. Pick another
            name.
          </>
        ),
      };
    }
    if (destError) return { state: 'missing', icon: 'alert-circle', body: <>{destError}</> };
    if (!source) return undefined;
    if (destEmpty) {
      return {
        state: 'default',
        icon: 'folder-open',
        body: <>Clones next to your other repositories.</>,
      };
    }
    if (!target) return undefined;
    return {
      state: targetExists ? 'exists' : 'ok',
      icon: targetExists ? 'alert-circle' : 'folder-open',
      body: (
        <>
          Creates <code title={target}>{tildify(target, dest.home)}</code>
          {targetExists ? ' — that folder exists, so it must be empty.' : ''}
        </>
      ),
    };
  })();

  async function submitLocal(): Promise<void> {
    if (!canAdd || !chosen || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setAddError(undefined);
    try {
      const next = await addRepo({
        name: localName,
        path: chosen.path,
        ...(branches.length > 0 ? { protected_branches: branches } : {}),
      });
      toast({
        title: `Added ${localName}`,
        body: tildify(chosen.path, local.home),
        tone: 'success',
      });
      onAdded?.(localName, next);
      onClose();
    } catch (err) {
      if (mounted.current) setAddError(err instanceof Error ? err.message : String(err));
      else toast({ title: `Could not add ${localName}`, body: messageOf(err), tone: 'error' });
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function submitClone(): Promise<void> {
    if (!canClone || !source || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setDestOpen(false);
    setCloneError(undefined);
    try {
      const res = await cloneRepo({
        url: url.trim(),
        name: cloneName,
        ...(target ? { dest: target } : {}),
      });
      toast({
        title: `Cloned and added ${res.repo}`,
        body: tildify(res.path, dest.home),
        tone: 'success',
      });
      onAdded?.(res.repo, res.repos);
      onClose();
    } catch (err) {
      if (mounted.current) setCloneError(err instanceof Error ? err.message : String(err));
      else toast({ title: `Could not clone ${source.name}`, body: messageOf(err), tone: 'error' });
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const localStatus = ((): { state: string; body: JSX.Element } => {
    if (local.text.trim() === '') {
      return {
        state: 'idle',
        body: <>Pick a folder below or type its path. Git repositories are marked.</>,
      };
    }
    if (local.error && !local.fresh) return { state: 'missing', body: <>{local.error}</> };
    if (!chosen) {
      if (!local.fresh) return { state: 'looking', body: <>Looking…</> };
      return local.listing && local.listing.entries.length > 0
        ? {
            state: 'partial',
            body: (
              <>
                Keep typing, or press <kbd className="cr-kbd">Tab</kbd> to complete and{' '}
                <kbd className="cr-kbd">↑</kbd>
                <kbd className="cr-kbd">↓</kbd> to choose.
              </>
            ),
          }
        : { state: 'missing', body: <>No folder named “{local.query.prefix}” here.</> };
    }
    if (!chosen.git && local.query.prefix === '' && local.picked === undefined) {
      // The folder being browsed: point at the repositories in it rather than warn.
      const inside = local.listing?.entries.filter((e) => e.git).length ?? 0;
      return {
        state: 'browse',
        body:
          inside > 0 ? (
            <>
              Pick a repository below (marked <strong>git</strong>), or open a folder to look
              inside.
            </>
          ) : (
            <>No git repositories directly in here. Open a folder to look inside.</>
          ),
      };
    }
    if (!chosen.git) {
      const parent = local.listing;
      const inside = parent?.is_git && parent.path !== chosen.path ? parent : undefined;
      return {
        state: 'not-git',
        body: (
          <>
            This folder isn’t a git repository.
            {inside ? (
              <>
                {' '}
                It’s inside <strong>{baseName(inside.path)}</strong>, which is.{' '}
                <button
                  type="button"
                  className="cr-link"
                  data-testid="add-repo-use-parent"
                  onClick={() => local.open(inside.path)}
                >
                  Use {baseName(inside.path)}
                </button>
              </>
            ) : null}
          </>
        ),
      };
    }
    if (existing) {
      return {
        state: 'added',
        body: (
          <>
            Already added as <strong>{existing.name}</strong>.
          </>
        ),
      };
    }
    return {
      state: 'ok',
      body: (
        <>
          <strong>{baseName(chosen.path)}</strong> is a git repository.
        </>
      ),
    };
  })();

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add repository"
      description="A git repository your nodes can work in: a folder on this machine, or one to clone."
      size="md"
      testid="add-repo-dialog"
      label="Add repository"
      onSubmit={() => void (mode === 'local' ? submitLocal() : submitClone())}
      footer={
        <>
          <Button onClick={onClose} data-testid="add-repo-cancel">
            Cancel
          </Button>
          {mode === 'local' ? (
            <Button
              type="submit"
              variant="primary"
              icon="plus"
              busy={busy}
              disabled={!canAdd}
              data-testid="settings-repo-add-save"
            >
              Add repository
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              icon="download"
              busy={busy}
              disabled={!canClone}
              data-testid="add-repo-clone-submit"
            >
              {busy ? 'Cloning…' : 'Clone and add'}
            </Button>
          )}
        </>
      }
    >
      <div className="cr-ar" data-mode={mode}>
        <Segmented
          label="How to add it"
          testid="add-repo-mode"
          value={mode}
          onChange={(next) => {
            if (busy) return;
            setMode(next);
            if (next === 'local') setSwitched(false);
          }}
          items={[
            {
              id: 'local',
              testid: 'add-repo-mode-local',
              label: (
                <>
                  <Icon name="folder" size={14} />
                  Local folder
                </>
              ),
            },
            {
              id: 'clone',
              testid: 'add-repo-mode-clone',
              label: (
                <>
                  <Icon name="download" size={14} />
                  Clone from URL
                </>
              ),
            },
          ]}
        />

        {mode === 'local' ? (
          <div className="cr-ar-pane" data-testid="add-repo-local">
            <Field label="Folder" htmlFor={`${ids}-path`}>
              <div className="cr-ar-input">
                <Icon name="folder" size={15} />
                <input
                  ref={pathRef}
                  id={`${ids}-path`}
                  data-testid="settings-repo-add-path"
                  data-autofocus
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={`${ids}-dirs`}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    local.highlight >= 0 ? `${ids}-dirs-${local.highlight}` : undefined
                  }
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="~/Projects/my-app"
                  value={local.text}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (looksLikeRepoUrl(next)) {
                      switchToClone(next);
                      return;
                    }
                    local.type(next);
                  }}
                  onPaste={(e: ClipboardEvent<HTMLInputElement>) => {
                    const pasted = e.clipboardData.getData('text');
                    if (looksLikeRepoUrl(pasted) || looksLikeGithubShorthand(pasted)) {
                      e.preventDefault();
                      switchToClone(pasted);
                    }
                  }}
                  onKeyDown={(e) => onPathKeyDown(local, e)}
                />
              </div>
            </Field>
            <FolderBrowser
              picker={local}
              listId={`${ids}-dirs`}
              testid="add-repo-browser"
              label="Folders"
            />
            <p
              className="cr-ar-status"
              data-testid="add-repo-status"
              data-state={localStatus.state}
            >
              <Icon
                name={
                  localStatus.state === 'ok'
                    ? 'check-circle'
                    : localStatus.state === 'not-git' || localStatus.state === 'missing'
                      ? 'alert-circle'
                      : localStatus.state === 'added'
                        ? 'info'
                        : 'folder-open'
                }
                size={14}
              />
              <span>{localStatus.body}</span>
            </p>
            {chosen?.git && !existing ? (
              <div className="cr-ar-grid">
                <Field
                  label="Name"
                  htmlFor={`${ids}-name`}
                  hint="What nodes and the CLI call it."
                  error={
                    localNameTaken
                      ? `A repository named ${localName} is already registered`
                      : undefined
                  }
                >
                  <input
                    id={`${ids}-name`}
                    data-testid="settings-repo-add-name"
                    value={nameEdit ?? baseName(chosen.path)}
                    disabled={busy}
                    spellCheck={false}
                    onChange={(e) => setNameEdit(e.target.value)}
                  />
                </Field>
                <Field
                  label="Protected branches"
                  htmlFor={`${ids}-protected`}
                  hint="Agents never commit to these. Empty: main and master."
                >
                  <input
                    id={`${ids}-protected`}
                    data-testid="settings-repo-add-protected"
                    placeholder="main, master"
                    value={protectedRaw}
                    disabled={busy}
                    spellCheck={false}
                    onChange={(e) => setProtectedRaw(e.target.value)}
                  />
                </Field>
              </div>
            ) : null}
            <Alert message={addError} testid="settings-repo-add-error" />
          </div>
        ) : (
          <div className="cr-ar-pane" data-testid="add-repo-clone">
            {switched ? (
              <p className="cr-ar-note" data-testid="add-repo-switched">
                <Icon name="info" size={14} />
                <span>
                  That looks like a repository URL, so this clones it.{' '}
                  <button
                    type="button"
                    className="cr-link"
                    onClick={() => {
                      setMode('local');
                      setSwitched(false);
                    }}
                  >
                    Pick a local folder instead
                  </button>
                </span>
              </p>
            ) : null}
            <Field
              label="Repository URL"
              htmlFor={`${ids}-url`}
              hint={
                parsed === undefined
                  ? 'An https or SSH URL, GitHub’s owner/repo, or a path to a repository on this machine.'
                  : undefined
              }
              error={parsed?.ok === false ? parsed.reason : undefined}
            >
              <div className="cr-ar-input">
                <Icon name="link" size={15} />
                <input
                  ref={urlRef}
                  id={`${ids}-url`}
                  data-testid="add-repo-clone-url"
                  data-autofocus={mode === 'clone' ? true : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="git@github.com:owner/repo.git"
                  value={url}
                  disabled={busy}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setCloneNameEdit(undefined);
                    setCloneError(undefined);
                  }}
                />
              </div>
            </Field>
            {source ? <SourcePreview source={source} /> : null}
            <div className="cr-ar-dest">
              <Field label="Clone into" htmlFor={`${ids}-dest`}>
                <div className="cr-ar-input">
                  <Icon name="folder" size={15} />
                  <input
                    id={`${ids}-dest`}
                    data-testid="add-repo-clone-dest"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="~/Projects"
                    value={dest.text}
                    disabled={busy}
                    onChange={(e) => {
                      destTouched.current = true;
                      dest.type(e.target.value);
                    }}
                    onKeyDown={(e) => onPathKeyDown(dest, e)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="add-repo-clone-browse"
                    aria-expanded={destOpen}
                    disabled={busy}
                    onClick={() => setDestOpen((v) => !v)}
                  >
                    {destOpen ? 'Done' : 'Browse'}
                  </Button>
                </div>
              </Field>
              <span className="cr-ar-slash" aria-hidden="true">
                /
              </span>
              <Field label="Name" htmlFor={`${ids}-clone-name`}>
                <input
                  id={`${ids}-clone-name`}
                  data-testid="add-repo-clone-name"
                  placeholder="repo"
                  value={cloneNameEdit ?? source?.name ?? ''}
                  disabled={busy}
                  spellCheck={false}
                  aria-invalid={cloneNameTaken || undefined}
                  onChange={(e) => setCloneNameEdit(e.target.value)}
                />
              </Field>
            </div>
            {cloneTarget ? (
              <p
                className="cr-ar-status"
                data-testid="add-repo-clone-target"
                data-state={cloneTarget.state}
              >
                <Icon name={cloneTarget.icon} size={14} />
                <span>{cloneTarget.body}</span>
              </p>
            ) : null}
            {destOpen ? (
              <FolderBrowser
                picker={{
                  ...dest,
                  pick: (entry) => {
                    destTouched.current = true;
                    dest.pick(entry);
                  },
                  open: (path, home) => {
                    destTouched.current = true;
                    dest.open(path, home);
                  },
                }}
                listId={`${ids}-dest-dirs`}
                testid="add-repo-dest-browser"
                label="Destination folders"
              />
            ) : null}
            {busy ? (
              <output className="cr-ar-progress" data-testid="add-repo-clone-progress">
                <Spinner size={14} />
                <span>
                  Cloning <strong>{source?.name}</strong>… this can take a minute.
                </span>
              </output>
            ) : null}
            <Alert message={cloneError} testid="add-repo-clone-error" clone />
          </div>
        )}
      </div>
    </Dialog>
  );
}
