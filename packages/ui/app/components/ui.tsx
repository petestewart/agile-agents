/**
 * T360: the cockpit's primitives (design/cockpit-ui.md §5). Every screen
 * builds from these so a button, a menu or a dialog looks and behaves the
 * same everywhere. Styling lives in `styles.css` ("Primitives" section);
 * these components only choose classes and wire behaviour (focus, keys,
 * outside clicks).
 */

import {
  type ButtonHTMLAttributes,
  type PropsWithChildren,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { type NodeStatus, type StatusInput, type StatusTone, nodeStatus } from '../lib/status';
import { streamDot } from '../lib/streams';
import { Icon, type IconName } from './Icon';

// ---------------------------------------------------------------- buttons

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName;
  iconRight?: IconName;
  /** Shows a spinner and disables the button. */
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon,
    iconRight,
    busy = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      className={`cr-btn${className ? ` ${className}` : ''}`}
      data-variant={variant}
      data-size={size}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
      {iconRight && !busy ? <Icon name={iconRight} size={size === 'sm' ? 14 : 16} /> : null}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** The accessible name and the tooltip. */
  label: string;
  variant?: 'ghost' | 'secondary' | 'primary' | 'danger';
  size?: 'sm' | 'md';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'ghost', size = 'md', className, type = 'button', ...rest },
  ref,
): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      className={`cr-icon-btn${className ? ` ${className}` : ''}`}
      data-variant={variant}
      data-size={size}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : 16} />
    </button>
  );
});

export function Spinner({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <span
      className="cr-spinner"
      style={{ width: size, height: size }}
      aria-hidden="true"
      data-testid="spinner"
    />
  );
}

export function Kbd({ children }: PropsWithChildren): JSX.Element {
  return <kbd className="cr-kbd">{children}</kbd>;
}

// ---------------------------------------------------------------- badges and status

export type BadgeTone = StatusTone | 'accent' | 'neutral';

export function Badge({
  tone = 'neutral',
  icon,
  children,
  title,
  testid,
}: PropsWithChildren<{
  tone?: BadgeTone;
  icon?: IconName;
  title?: string;
  testid?: string;
}>): JSX.Element {
  return (
    <span className="cr-badge" data-tone={tone} title={title} data-testid={testid}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

/**
 * A node's status as a small shape: filled for "your move", a spinner ring
 * for working, hollow for not started / stopped. Keeps `.cr-dot` and
 * `data-dot` (the e2e suites read the colour name from `streamDot`).
 */
export function StatusDot({
  row,
  status,
  className,
}: {
  row: StatusInput;
  status?: NodeStatus;
  className?: string;
}): JSX.Element {
  const s = status ?? nodeStatus(row);
  return (
    <span
      className={`cr-dot${className ? ` ${className}` : ''}`}
      data-dot={streamDot(row)}
      data-status={s.key}
      data-tone={s.tone}
      role="img"
      aria-label={s.label}
      title={`${s.label} — ${s.hint}`}
    />
  );
}

export function StatusPill({
  row,
  status,
  testid,
}: {
  row: StatusInput;
  status?: NodeStatus;
  testid?: string;
}): JSX.Element {
  const s = status ?? nodeStatus(row);
  return (
    <span
      className="cr-status-pill"
      data-status={s.key}
      data-tone={s.tone}
      title={s.hint}
      data-testid={testid}
    >
      <StatusDot row={row} status={s} />
      {s.label}
    </span>
  );
}

// ---------------------------------------------------------------- layout helpers

export function PageHeader({
  title,
  icon,
  subtitle,
  actions,
  children,
  testid,
}: PropsWithChildren<{
  title: ReactNode;
  icon?: IconName;
  subtitle?: ReactNode;
  actions?: ReactNode;
  testid?: string;
}>): JSX.Element {
  return (
    <header className="cr-page-hd" data-testid={testid}>
      <div className="cr-page-hd-main">
        {subtitle ? <div className="cr-page-sub">{subtitle}</div> : null}
        <h1 className="cr-page-title">
          {icon ? <Icon name={icon} size={18} className="cr-page-icon" /> : null}
          {title}
        </h1>
        {children}
      </div>
      {actions ? <div className="cr-page-actions">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({
  icon = 'inbox',
  title,
  children,
  actions,
  testid,
}: PropsWithChildren<{
  icon?: IconName;
  title: ReactNode;
  actions?: ReactNode;
  testid?: string;
}>): JSX.Element {
  return (
    <div className="cr-empty" data-testid={testid}>
      <div className="cr-empty-icon">
        <Icon name={icon} size={22} />
      </div>
      <div className="cr-empty-title">{title}</div>
      {children ? <div className="cr-empty-body">{children}</div> : null}
      {actions ? <div className="cr-empty-actions">{actions}</div> : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: PropsWithChildren<{
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  htmlFor?: string;
}>): JSX.Element {
  return (
    <div className="cr-field" data-invalid={error ? 'true' : undefined}>
      <label className="cr-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <div className="cr-field-error" role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="cr-field-hint">{hint}</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- tabs and segmented

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  count?: number;
  icon?: IconName;
  testid?: string;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}): JSX.Element {
  return (
    <nav className={`cr-tabs${className ? ` ${className}` : ''}`} aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          data-tab={item.id}
          data-testid={item.testid}
          aria-current={value === item.id ? 'page' : undefined}
          className={value === item.id ? 'on' : undefined}
          onClick={() => onChange(item.id)}
        >
          {item.icon ? <Icon name={item.icon} size={14} /> : null}
          {item.label}
          {item.count !== undefined ? <span className="cr-tab-count">{item.count}</span> : null}
        </button>
      ))}
    </nav>
  );
}

export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  testid,
}: {
  items: ReadonlyArray<{ id: T; label: ReactNode; count?: number; testid?: string }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  testid?: string;
}): JSX.Element {
  return (
    <div className="cr-seg" role="radiogroup" aria-label={label} data-testid={testid}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: a segmented control is buttons with radio semantics; native radios can't be styled as one.
          role="radio"
          aria-checked={value === item.id}
          data-value={item.id}
          data-testid={item.testid}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count !== undefined ? <span className="cr-seg-count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- popover and menu

/** Closes on Escape and on a mousedown outside `ref`. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement>, onDismiss: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, ref, onDismiss]);
}

export interface PopoverProps {
  /** Renders the trigger; spread `props` onto the element that opens it. */
  trigger: (props: {
    onClick: () => void;
    'aria-expanded': boolean;
    'aria-haspopup': 'menu' | 'dialog';
    ref: React.Ref<HTMLButtonElement>;
  }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  placement?: 'bottom' | 'top';
  role?: 'menu' | 'dialog';
  className?: string;
  testid?: string;
  label?: string;
}

export function Popover({
  trigger,
  children,
  align = 'start',
  placement = 'bottom',
  role = 'dialog',
  className,
  testid,
  label,
}: PopoverProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  useDismiss(open, wrap, close);
  return (
    <span className="cr-pop-wrap" ref={wrap}>
      {trigger({
        onClick: () => setOpen((v) => !v),
        'aria-expanded': open,
        'aria-haspopup': role === 'menu' ? 'menu' : 'dialog',
        ref: triggerRef,
      })}
      {open ? (
        <div
          className={`cr-pop${className ? ` ${className}` : ''}`}
          data-align={align}
          data-placement={placement}
          role={role}
          aria-label={label}
          data-testid={testid}
        >
          {children(close)}
        </div>
      ) : null}
    </span>
  );
}

export type MenuItem =
  | 'separator'
  | {
      label: ReactNode;
      icon?: IconName;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
      /** A short right-aligned hint (a shortcut, a count). */
      hint?: ReactNode;
      /** Why it is disabled, or what it does; the item's tooltip. */
      title?: string;
      testid?: string;
      hidden?: boolean;
    };

export function Menu({
  items,
  label,
  align = 'end',
  placement = 'bottom',
  trigger,
  testid,
}: {
  items: ReadonlyArray<MenuItem>;
  /** The trigger's accessible name (and tooltip, for the default ⋯ trigger). */
  label: string;
  align?: 'start' | 'end';
  placement?: 'bottom' | 'top';
  /** Custom trigger; the default is a ghost ⋯ icon button. */
  trigger?: PopoverProps['trigger'];
  testid?: string;
}): JSX.Element {
  const shown = items.filter((i) => i === 'separator' || !i.hidden);
  return (
    <Popover
      role="menu"
      align={align}
      placement={placement}
      label={label}
      testid={testid}
      trigger={
        trigger ??
        ((props) => (
          <IconButton
            icon="more"
            label={label}
            data-testid={testid ? `${testid}-trigger` : undefined}
            {...props}
          />
        ))
      }
    >
      {(close) => <MenuList items={shown} close={close} />}
    </Popover>
  );
}

function MenuList({
  items,
  close,
}: {
  items: ReadonlyArray<MenuItem>;
  close: () => void;
}): JSX.Element {
  const list = useRef<HTMLDivElement>(null);
  // Focus the first item once, on open (not on every re-render of the page behind it).
  useEffect(() => {
    list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'ArrowDown'
        ? buttons[(at + 1) % buttons.length]
        : buttons[(at - 1 + buttons.length) % buttons.length];
    next?.focus();
  };
  return (
    <div className="cr-menu" ref={list} onKeyDown={onKeyDown}>
      {items.map((item, i) =>
        item === 'separator' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: separators are positional.
          <hr key={`sep-${i}`} className="cr-menu-sep" />
        ) : (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: items are positional.
            key={i}
            type="button"
            role="menuitem"
            className="cr-menu-item"
            data-danger={item.danger ? 'true' : undefined}
            data-testid={item.testid}
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              close();
              item.onSelect();
            }}
          >
            {item.icon ? <Icon name={item.icon} size={15} /> : <span className="cr-menu-noicon" />}
            <span className="cr-menu-label">{item.label}</span>
            {item.hint ? <span className="cr-menu-hint">{item.hint}</span> : null}
          </button>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  testid,
  onSubmit,
  label,
  className,
}: PropsWithChildren<{
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  testid?: string;
  /** When set, the dialog body is a form and Enter in a field submits it. */
  onSubmit?: () => void;
  /** The form's accessible name (defaults to the title when it is text). */
  label?: string;
  /** T368: an extra class on the panel, for a dialog with its own layout (the command palette). */
  className?: string;
}>): JSX.Element | null {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const restore = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement;
    const el = panel.current;
    const first =
      el?.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ??
      el?.querySelector<HTMLElement>('input, textarea, select') ??
      el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      const back = restore.current as HTMLElement | null;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const body = (
    <>
      <div className="cr-dialog-hd">
        <h2 id={titleId}>{title}</h2>
        <IconButton icon="x" label="Close" size="sm" onClick={onClose} />
      </div>
      {description ? <p className="cr-dialog-desc">{description}</p> : null}
      <div className="cr-dialog-body">{children}</div>
      {footer ? <div className="cr-dialog-ft">{footer}</div> : null}
    </>
  );

  // T373: in a portal, so a dialog opened from inside another dialog's form
  // (New project → Add repository) never nests one form in another; React
  // still bubbles its submit through the component tree, so it stops here.
  return createPortal(
    <div
      className="cr-modal"
      data-testid={testid}
      onSubmit={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={className ? `cr-dialog ${className}` : 'cr-dialog'}
        data-size={size}
        // biome-ignore lint/a11y/useSemanticElements: a native <dialog> needs showModal() and the top layer; this one renders in place with its own focus trap.
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        {onSubmit ? (
          <form
            aria-label={label ?? (typeof title === 'string' ? title : undefined)}
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {body}
          </form>
        ) : (
          body
        )}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
  testid,
}: PropsWithChildren<{
  open: boolean;
  title: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testid?: string;
}>): JSX.Element | null {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      testid={testid}
      onSubmit={onConfirm}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            type="submit"
            variant={danger ? 'danger' : 'primary'}
            busy={busy}
            data-testid={testid ? `${testid}-confirm` : undefined}
            data-autofocus
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

// ---------------------------------------------------------------- toasts

export interface ToastInput {
  title: ReactNode;
  body?: ReactNode;
  tone?: 'info' | 'success' | 'error';
  action?: { label: string; onClick: () => void };
  /** ms; default 5s (errors 8s). */
  duration?: number;
}

interface ToastEntry extends ToastInput {
  id: number;
}

const ToastContext = createContext<((toast: ToastInput) => void) | undefined>(undefined);

export function ToastProvider({ children }: PropsWithChildren): JSX.Element {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);
  const push = useCallback(
    (toast: ToastInput) => {
      const id = ++seq.current;
      setToasts((all) => [...all.slice(-3), { ...toast, id }]);
      const ms = toast.duration ?? (toast.tone === 'error' ? 8000 : 5000);
      setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="cr-toasts" aria-live="polite" data-testid="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="cr-toast" data-tone={t.tone ?? 'info'} data-testid="toast">
            <Icon
              name={
                t.tone === 'error' ? 'alert-circle' : t.tone === 'success' ? 'check-circle' : 'info'
              }
              size={16}
            />
            <div className="cr-toast-text">
              <div className="cr-toast-title">{t.title}</div>
              {t.body ? <div className="cr-toast-body">{t.body}</div> : null}
            </div>
            {t.action ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="toast-action"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </Button>
            ) : null}
            <IconButton icon="x" label="Dismiss" size="sm" onClick={() => dismiss(t.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** `toast({...})`; a no-op outside a provider (a component rendered on its own in a test). */
export function useToast(): (toast: ToastInput) => void {
  const push = useContext(ToastContext);
  return useMemo(() => push ?? (() => {}), [push]);
}

/** Copies text and says so. */
export function useCopy(): (text: string, what?: string) => void {
  const toast = useToast();
  return useCallback(
    (text: string, what = 'Copied') => {
      navigator.clipboard
        ?.writeText(text)
        .then(() => toast({ title: what, tone: 'success', duration: 2000 }))
        .catch(() => toast({ title: 'Could not copy', tone: 'error' }));
    },
    [toast],
  );
}

// ---------------------------------------------------------------- repos

/** T362's remote on a repo row (structural, so it reads before the field exists). */
export interface RepoRemoteLike {
  kind: string;
  protocol?: string;
  url?: string;
  owner?: string;
  name?: string;
}

/** "Local", "GitHub · SSH", "GitLab · HTTPS", "Remote · SSH". */
export function repoKindLabel(remote: RepoRemoteLike | undefined): string {
  if (remote === undefined) return 'Local only';
  // T373: a clone of a folder on this machine (a `file` remote) is local too.
  if (remote.protocol === 'file') return 'Local clone';
  const host =
    remote.kind === 'github'
      ? 'GitHub'
      : remote.kind === 'gitlab'
        ? 'GitLab'
        : remote.kind === 'bitbucket'
          ? 'Bitbucket'
          : 'Remote';
  const via = remote.protocol === 'ssh' ? 'SSH' : remote.protocol === 'https' ? 'HTTPS' : undefined;
  return via ? `${host} · ${via}` : host;
}

/**
 * T360 (Pete: "an icon next to each repo — local or GitHub, or SSH"): the
 * host's glyph, and a small SSH mark when the remote is reached over SSH.
 */
export function RepoIcon({
  remote,
  size = 16,
}: {
  remote: RepoRemoteLike | undefined;
  size?: number;
}): JSX.Element {
  const icon: IconName =
    remote === undefined
      ? 'hard-drive'
      : remote.kind === 'github'
        ? 'github'
        : remote.kind === 'gitlab'
          ? 'gitlab'
          : remote.protocol === 'file'
            ? 'folder'
            : 'globe';
  const label = repoKindLabel(remote);
  return (
    <span
      className="cr-repo-icon"
      data-kind={remote?.kind ?? 'local'}
      data-protocol={remote?.protocol}
      data-testid="repo-icon"
      title={remote?.url ? `${label} — ${remote.url}` : label}
    >
      <Icon name={icon} size={size} label={label} />
      {remote?.protocol === 'ssh' ? (
        <span className="cr-repo-icon-ssh" aria-hidden="true">
          <Icon name="key" size={9} strokeWidth={2.5} />
        </span>
      ) : null}
    </span>
  );
}
