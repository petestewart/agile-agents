/**
 * T394: the pure half of the cockpit's error boundaries
 * (`components/ErrorBoundary.tsx`). What a caught error says to the person
 * looking at the page, whether it is a view's code that failed to download
 * (a rebuild replaced the chunk the open page points at), and the details
 * "Copy details" puts on the clipboard for a bug report. No DOM, so plain
 * `bun test` covers it.
 */

/**
 * The words each browser (and Vite's preload helper) uses when a lazily
 * loaded chunk can't be fetched: Chromium, Firefox, Safari, then Vite.
 */
const CHUNK_FAILURES = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
];

/**
 * True when `error` is a lazily loaded view that could not be downloaded.
 * After a rebuild the hashed chunk the open page points at is gone; a
 * reload picks up the new page and its new chunks. React caches a failed
 * lazy import, so trying again without a reload never helps.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === 'ChunkLoadError') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && CHUNK_FAILURES.some((re) => re.test(message));
}

/** The longest message the card shows; the full text is in Copy details. */
export const MESSAGE_MAX_CHARS = 280;

/**
 * What went wrong, in one line for the card: the error's message (or what
 * was thrown, when it was not an Error), whitespace collapsed, clipped.
 */
export function errorMessage(error: unknown): string {
  let text: string;
  if (error instanceof Error) text = error.message;
  else if (typeof error === 'string') text = error;
  else if (typeof error === 'object' && error !== null && 'message' in error)
    text = String((error as { message: unknown }).message);
  else text = String(error);
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '') return 'An unknown error was thrown.';
  return line.length <= MESSAGE_MAX_CHARS ? line : `${line.slice(0, MESSAGE_MAX_CHARS - 1)}…`;
}

export interface ErrorDetailsInput {
  error: unknown;
  /** React's component stack from `componentDidCatch`. */
  componentStack?: string | null | undefined;
  /** Where it happened: the page's path and query. */
  where?: string;
  /** When it was caught. */
  at?: Date;
  /** The browser, from `navigator.userAgent`. */
  agent?: string;
}

/**
 * The text "Copy details" puts on the clipboard: the full message, the
 * stack, React's component stack, and where and when, for a bug report.
 */
export function errorDetails({
  error,
  componentStack,
  where,
  at,
  agent,
}: ErrorDetailsInput): string {
  const lines: string[] = [];
  const full =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
        ? error
        : String(error);
  lines.push(full);
  if (where !== undefined) lines.push(`Page: ${where}`);
  if (at !== undefined) lines.push(`Time: ${at.toISOString()}`);
  if (agent !== undefined) lines.push(`Browser: ${agent}`);
  const stack = error instanceof Error ? error.stack?.trim() : undefined;
  if (stack) {
    // Chromium's stack starts with the message again; keep the frames only.
    const frames = stack.startsWith(full) ? stack.slice(full.length).trim() : stack;
    if (frames !== '') lines.push('', 'Stack:', frames);
  }
  const components = componentStack?.trim();
  if (components) lines.push('', 'Components:', components);
  return lines.join('\n');
}
