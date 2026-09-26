/**
 * T367: the pieces every Settings section is built from — a section
 * header, a card (a form when it saves), a label-left row, a switch, and
 * the inline "Saved" note. Styles: the Settings section of `styles.css`.
 */

import {
  type FormEvent,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { cleanDaemonError } from '../lib/repos';
import { Icon, type IconName } from './Icon';

/** A thrown thing as one readable line (the daemon's RPC prefix dropped). */
export function errorText(err: unknown): string {
  return cleanDaemonError(err instanceof Error ? err.message : String(err));
}

export function SetSection({
  title,
  description,
  actions,
  children,
  testid,
}: PropsWithChildren<{
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  testid?: string;
}>): JSX.Element {
  return (
    <section className="cr-set-section" data-testid={testid}>
      <header className="cr-set-section-hd">
        <div className="cr-set-section-text">
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="cr-set-section-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function SetCard({
  title,
  icon,
  description,
  status,
  children,
  footer,
  testid,
  onSubmit,
  label,
}: PropsWithChildren<{
  title?: ReactNode;
  icon?: IconName | ReactNode;
  description?: ReactNode;
  /** Right of the title: a status pill. */
  status?: ReactNode;
  footer?: ReactNode;
  testid?: string;
  /** When set the card is a `<form>`; Enter in a field submits it. */
  onSubmit?: () => void;
  /** The form's accessible name. */
  label?: string;
}>): JSX.Element {
  const head =
    title !== undefined ? (
      <div className="cr-set-card-hd">
        {icon !== undefined ? (
          <span className="cr-set-card-icon">
            {typeof icon === 'string' ? <Icon name={icon as IconName} size={16} /> : icon}
          </span>
        ) : null}
        <div className="cr-set-card-titles">
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        {status ? <div className="cr-set-card-status">{status}</div> : null}
      </div>
    ) : null;
  const body = (
    <>
      {head}
      {children ? <div className="cr-set-card-body">{children}</div> : null}
      {footer ? <div className="cr-set-card-ft">{footer}</div> : null}
    </>
  );
  if (onSubmit) {
    return (
      <form
        className="cr-set-card"
        data-testid={testid}
        aria-label={label ?? (typeof title === 'string' ? title : undefined)}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        {body}
      </form>
    );
  }
  return (
    <div className="cr-set-card" data-testid={testid}>
      {body}
    </div>
  );
}

/** A setting inside a card: its name and a line on what it does, left; the control, right. */
export function SetRow({
  label,
  hint,
  htmlFor,
  children,
  testid,
  stack = false,
}: PropsWithChildren<{
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  testid?: string;
  /** The control goes under the label (wide controls: session fields, a project list). */
  stack?: boolean;
}>): JSX.Element {
  return (
    <div className="cr-set-row" data-stack={stack ? 'true' : undefined} data-testid={testid}>
      <div className="cr-set-row-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint ? <div className="cr-set-row-hint">{hint}</div> : null}
      </div>
      <div className="cr-set-row-control">{children}</div>
    </div>
  );
}

/** A checkbox drawn as a switch; the `input` keeps its testid and its checkbox semantics. */
export function Switch({
  label,
  ...rest
}: { label: ReactNode } & InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <label className="cr-set-switch" data-disabled={rest.disabled ? 'true' : undefined}>
      <input type="checkbox" role="switch" aria-checked={rest.checked} {...rest} />
      <span className="cr-set-switch-track" aria-hidden="true">
        <span className="cr-set-switch-thumb" />
      </span>
      <span className="cr-set-switch-label">{label}</span>
    </label>
  );
}

/** "Saved", for a moment after a save (inline, next to the button that saved). */
export function SavedNote({ show, testid }: { show: boolean; testid?: string }): JSX.Element {
  return (
    <output className="cr-set-saved" data-show={show ? 'true' : 'false'} data-testid={testid}>
      {show ? (
        <>
          <Icon name="check" size={14} />
          Saved
        </>
      ) : null}
    </output>
  );
}

/** `saved` turns on after `markSaved()` and off 4 s later (or on the next edit). */
export function useSavedFlash(): { saved: boolean; markSaved: () => void; clear: () => void } {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const markSaved = useCallback(() => {
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), 4000);
  }, []);
  const clear = useCallback(() => {
    clearTimeout(timer.current);
    setSaved(false);
  }, []);
  return { saved, markSaved, clear };
}

/** An inline error under a form (the daemon's words, one line). */
export function FormError({
  error,
  testid,
}: {
  error: string | undefined;
  testid?: string;
}): JSX.Element | null {
  if (!error) return null;
  return (
    <p className="cr-set-error" role="alert" data-testid={testid}>
      <Icon name="alert-circle" size={14} />
      <span>{error}</span>
    </p>
  );
}
