/**
 * Vite build for the control room SPA (T025 — design agile-agents-design.md
 * §17 "Control room"). Separate from `tsconfig.json`/`src/index.ts` (the
 * T020 static-feed-page package entry, compiled by plain `tsc`): this is a
 * React app, `src/` stays a non-JSX Bun/tsc target so the two build
 * pipelines never collide.
 *
 * `base: '/control-room/'` is absolute rather than `'./'` — the daemon
 * (`packages/daemon/src/http.ts`) serves this bundle under the
 * `/control-room` path prefix, not site root (`/` and `/feed` stay the T020
 * static page), and a relative base breaks the moment a viewer navigates to
 * `/control-room` with no trailing slash: the browser then resolves
 * `./assets/...` against `/` (the last path *segment*, "control-room", is
 * dropped), 404ing every asset. An absolute base is correct regardless of
 * the trailing slash.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'app',
  base: '/control-room/',
  plugins: [react()],
  build: {
    outDir: '../dist-app',
    emptyOutDir: true,
  },
});
