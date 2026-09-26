/**
 * T394: one component throwing must never blank the cockpit. Each view (in
 * `App`), a node page's tab body (in `StreamPage`), each overlay, and the
 * whole app (in `main.tsx`) sit in an `ErrorBoundary`. What it caught is
 * said in a calm card in words — Try again, Reload, Copy details — while
 * the sidebar stays usable, and navigating away (`resetKey`) resets it.
 *
 * A lazily loaded view whose chunk is gone (a rebuild replaced it while the
 * page was open) is not a bug: the card says a new version is available
 * and offers Reload, since React never retries a failed lazy import.
 *
 * Also here: `lazyNamed` for the views that load on demand, and their
 * quiet Suspense fallbacks, which show a small spinner only when loading
 * takes longer than a moment.
 */

import {
  Component,
  type ComponentProps,
  type ComponentType,
  type ErrorInfo,
  type PropsWithChildren,
  type ReactNode,
  Suspense,
  createElement,
  lazy,
  useEffect,
  useRef,
  useState,
} from 'react';
import { errorDetails, errorMessage, isChunkLoadError } from '../lib/boundary';
import { Icon } from './Icon';
import { Button, Spinner, useToast } from './ui';

/**
 * Where a boundary sits, which decides its card: `page` (a view in the
 * main column), `tab` (a node page's tab body), `overlay` (a dialog or the
 * palette: it closes and a toast says why), `app` (everything; the last
 * resort, whole-screen).
 */
export type BoundaryArea = 'page' | 'tab' | 'overlay' | 'app';

interface BoundaryProps {
  children?: ReactNode;
  area: BoundaryArea;
  /** A change resets a caught error: the view and node (or tab) shown. */
  resetKey?: string;
}

interface BoundaryState {
  caught: boolean;
  error: unknown;
  componentStack: string | undefined;
}

const CLEAR: BoundaryState = { caught: false, error: undefined, componentStack: undefined };

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = CLEAR;

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { caught: true, error, componentStack: undefined };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[cockpit] the ${this.props.area} failed to render:`, error, info.componentStack);
    // Always a string once caught: the overlay's toast waits for it.
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  override componentDidUpdate(prev: BoundaryProps): void {
    if (this.state.caught && prev.resetKey !== this.props.resetKey) this.setState(CLEAR);
  }

  private reset = (): void => this.setState(CLEAR);

  override render(): ReactNode {
    if (!this.state.caught) return this.props.children;
    const { error, componentStack } = this.state;
    if (this.props.area === 'overlay') {
      return <OverlayFailed error={error} componentStack={componentStack} />;
    }
    return (
      <ErrorCard
        area={this.props.area}
        error={error}
        componentStack={componentStack}
        onRetry={this.reset}
      />
    );
  }
}

/** Reload the page: a new build's page and chunks, and everything re-read. */
function reload(): void {
  window.location.reload();
}

function detailsOf(error: unknown, componentStack: string | undefined): string {
  return errorDetails({
    error,
    componentStack,
    where: `${window.location.pathname}${window.location.search}`,
    at: new Date(),
    agent: navigator.userAgent,
  });
}

/**
 * Copies to the clipboard and says so on the button itself, so it works
 * outside the toast provider (the app-wide boundary sits above it).
 */
function useCopyDetails(
  error: unknown,
  componentStack: string | undefined,
): [label: string, copy: () => void] {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (): void => {
    const done = (next: 'copied' | 'failed'): void => {
      setState(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), 2000);
    };
    const text = detailsOf(error, componentStack);
    if (!navigator.clipboard) {
      done('failed');
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => done('copied'),
      () => done('failed'),
    );
  };
  const label =
    state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : 'Copy details';
  return [label, copy];
}

const TITLE: Record<Exclude<BoundaryArea, 'overlay'>, string> = {
  page: 'Something went wrong on this page',
  tab: 'Something went wrong in this tab',
  app: 'Something went wrong',
};

const BODY: Record<Exclude<BoundaryArea, 'overlay'>, string> = {
  page: 'The rest of the cockpit still works. Try again, or reload if it keeps happening.',
  tab: 'The other tabs still work. Try again, or reload if it keeps happening.',
  app: 'The cockpit hit an error it couldn’t recover from. Reload to start it again.',
};

/** What a boundary shows in place of the part that failed. */
function ErrorCard({
  area,
  error,
  componentStack,
  onRetry,
}: {
  area: Exclude<BoundaryArea, 'overlay'>;
  error: unknown;
  componentStack?: string | undefined;
  onRetry: () => void;
}): JSX.Element {
  const [copyLabel, copy] = useCopyDetails(error, componentStack);
  const update = isChunkLoadError(error);
  const copyButton = (
    <Button
      variant="ghost"
      icon={copyLabel === 'Copied' ? 'check' : 'copy'}
      onClick={copy}
      data-testid="error-boundary-copy"
    >
      {copyLabel}
    </Button>
  );
  return (
    <section
      className="cr-boundary"
      data-area={area}
      data-kind={update ? 'update' : 'error'}
      data-testid="error-boundary"
    >
      <div className="cr-boundary-card" role="alert">
        <div className="cr-boundary-icon" aria-hidden="true">
          <Icon name={update ? 'sparkles' : 'alert-triangle'} size={20} />
        </div>
        <h2 className="cr-boundary-title" data-testid="error-boundary-title">
          {update ? 'A new version of the cockpit is available' : TITLE[area]}
        </h2>
        <p className="cr-boundary-body">
          {update
            ? 'This part of the cockpit changed since the page was opened. Reload to get the new version.'
            : BODY[area]}
        </p>
        {update ? null : (
          <p className="cr-boundary-msg" data-testid="error-boundary-message">
            {errorMessage(error)}
          </p>
        )}
        <div className="cr-boundary-actions">
          {update ? (
            <Button
              variant="primary"
              icon="refresh"
              onClick={reload}
              data-testid="error-boundary-reload"
            >
              Reload
            </Button>
          ) : area === 'app' ? (
            <>
              <Button
                variant="primary"
                icon="refresh"
                onClick={reload}
                data-testid="error-boundary-reload"
              >
                Reload
              </Button>
              <Button onClick={onRetry} data-testid="error-boundary-retry">
                Try again
              </Button>
            </>
          ) : (
            <>
              {/* A node's page already has its primary action in the header. */}
              <Button
                variant={area === 'tab' ? 'secondary' : 'primary'}
                onClick={onRetry}
                data-testid="error-boundary-retry"
              >
                Try again
              </Button>
              <Button icon="refresh" onClick={reload} data-testid="error-boundary-reload">
                Reload
              </Button>
            </>
          )}
          {copyButton}
        </div>
      </div>
    </section>
  );
}

/**
 * A dialog or the palette failed: it closes (nothing renders until the next
 * navigation resets it) and a toast says so, with the details to copy.
 */
function OverlayFailed({
  error,
  componentStack,
}: {
  error: unknown;
  componentStack: string | undefined;
}): null {
  const toast = useToast();
  const said = useRef(false);
  useEffect(() => {
    // The component stack lands a moment after the error: say it once, with both.
    if (said.current || componentStack === undefined) return;
    said.current = true;
    const update = isChunkLoadError(error);
    toast({
      title: update
        ? 'A new version of the cockpit is available'
        : 'That window closed after an error',
      body: update ? 'Reload to get it.' : errorMessage(error),
      tone: update ? 'info' : 'error',
      action: update
        ? { label: 'Reload', onClick: reload }
        : {
            label: 'Copy details',
            onClick: () => void navigator.clipboard?.writeText(detailsOf(error, componentStack)),
          },
    });
  }, [error, componentStack, toast]);
  return null;
}

// ---------------------------------------------------------------- lazy views

// biome-ignore lint/suspicious/noExplicitAny: the props are the component's own, as React's `lazy` types them.
type AnyComponent = ComponentType<any>;

/** A view that loads on demand; `preload()` fetches its code ahead of the first render. */
export type LazyView<C extends AnyComponent> = ((props: ComponentProps<C>) => JSX.Element) & {
  preload(): Promise<unknown>;
};

/**
 * A lazily loaded named export: `lazyNamed(() => import('./Settings'), 'Settings')`.
 * The chunk downloads the first time the view renders, or earlier through
 * `preload()` (the warm-up, a deep link). Once its code is here a view
 * mounts at once, with no fallback frame; a failed download is caught by
 * the nearest `ErrorBoundary` as a new version to reload.
 */
export function lazyNamed<K extends string, M extends Record<K, AnyComponent>>(
  load: () => Promise<M>,
  name: K,
): LazyView<M[K]> {
  let ready: M[K] | undefined;
  const preload = (): Promise<M[K]> =>
    load().then((module) => {
      const view = module[name];
      ready = view;
      return view;
    });
  const Lazy = lazy(async () => ({ default: await preload() }));
  function View(props: ComponentProps<M[K]>): JSX.Element {
    // Decided once per mount: switching between the two would remount the view and lose its state.
    const [direct] = useState(() => ready);
    return createElement(direct ?? Lazy, props);
  }
  return Object.assign(View, { preload });
}

// ---------------------------------------------------------------- lazy fallbacks

/** True once `ms` have passed since mount: a spinner only when loading is slow enough to notice. */
function useDelayed(ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return late;
}

/** How long a lazy view may take before its fallback shows a spinner. */
export const LOADING_SPINNER_DELAY_MS = 150;

/**
 * A lazy view on its way: the page header's space, so nothing jumps when
 * the view lands, and a small spinner in it once loading is noticeable.
 */
export function PageLoading(): JSX.Element {
  const late = useDelayed(LOADING_SPINNER_DELAY_MS);
  return (
    <section className="cr-page cr-lazy" aria-busy="true" data-testid="view-loading">
      <header className="cr-page-hd">
        <div className="cr-page-hd-main">
          <div className="cr-page-title">
            {late ? <Spinner size={16} /> : null}
            {late ? <span className="cr-lazy-text">Loading…</span> : null}
          </div>
        </div>
      </header>
    </section>
  );
}

/** A lazy tab (Changes, Overview) on its way: the empty pane, and a small spinner once noticeable. */
export function PaneLoading(): JSX.Element {
  const late = useDelayed(LOADING_SPINNER_DELAY_MS);
  return (
    <div className="cr-node-pane cr-lazy-pane" aria-busy="true" data-testid="pane-loading">
      {late ? <Spinner size={16} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- a node's tab

/**
 * A node page's tab body (`StreamPage`'s `.cr-node-body`) in its own
 * boundary: a tab that throws leaves the header, the tabs and the details
 * panel working, and another tab (or node) resets it. Its lazy parts load
 * behind a quiet fallback.
 */
export function TabBoundary({
  tab,
  node,
  children,
}: PropsWithChildren<{ tab: string; node: string }>): JSX.Element {
  return (
    <div className="cr-node-body" data-tab={tab}>
      <ErrorBoundary area="tab" resetKey={`${node}:${tab}`}>
        <Suspense fallback={<PaneLoading />}>{children}</Suspense>
      </ErrorBoundary>
    </div>
  );
}
