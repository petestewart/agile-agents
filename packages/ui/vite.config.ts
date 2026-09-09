/**
 * Vite build for the control room SPA (T025 — design agile-agents-design.md
 * §17 "Control room"). Separate from `tsconfig.json`/`src/index.ts` (the
 * T020 static-feed-page package entry, compiled by plain `tsc`): this is a
 * React app, `src/` stays a non-JSX Bun/tsc target so the two build
 * pipelines never collide.
 *
 * `base: './control-room/'` keeps every built asset URL relative, since the
 * daemon (`packages/daemon/src/http.ts`) serves this bundle under the
 * `/control-room` path prefix, not site root (`/` and `/feed` stay the T020
 * static page).
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'app',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist-app',
    emptyOutDir: true,
  },
});
