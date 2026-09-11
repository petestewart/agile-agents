/**
 * @agile-agents/ui
 *
 * Static event feed UI served by the daemon (T020 — design
 * agile-agents-design.md §17 "Human UI": "v0 scope: ... CLI + event feed as
 * the only UI"; the control room in §17's "Control room" subsection is a
 * later ticket, not this one).
 *
 * No framework, no bundler: `static/feed.html` is one hand-written file
 * (inline CSS + vanilla JS). This package's only job is to hand the daemon
 * that file's absolute path — `static/` sits outside `src/` because
 * `tsconfig.json` sets `rootDir: src` (same reason `packages/daemon/briefs/`
 * lives outside that package's `src/`), so `import.meta.dir` (this file's
 * own directory, `src/`) is used to resolve it via `..`.
 */

import { join } from 'node:path';

export const PACKAGE_NAME = '@agile-agents/ui';

/** Absolute path to the static feed page; `packages/daemon` serves it as-is. */
export const FEED_HTML_PATH: string = join(import.meta.dir, '..', 'static', 'feed.html');

/**
 * Absolute path to the built control room SPA (T025 — `vite.config.ts`'s
 * `outDir: '../dist-app'`, `root: 'app'`). Populated by `bun run build`
 * (this package's `build` script chains `vite build` after `tsc`); until
 * that has run for this package, `packages/daemon`'s `/control-room` routes
 * 404 the same way a missing `static/feed.html` would.
 */
export const CONTROL_ROOM_DIST_DIR: string = join(import.meta.dir, '..', 'dist-app');
