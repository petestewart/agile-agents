/**
 * Chromium discovery for the Playwright e2e tests (`feed.e2e.test.ts`,
 * `control-room.e2e.test.ts`).
 *
 * These tests used to call `describe.skip` when no browser was found, which
 * made a machine with no Chromium report a green run with the entire SPA
 * suite silently missing — a false green. `resolveChromiumExecutable` throws
 * instead, so a missing browser fails the file loudly and says how to fix it.
 *
 * Discovery order:
 *   1. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` — an explicit override wins, and a
 *      value pointing at nothing is an error rather than a silent fallback.
 *   2. playwright-core's own `chromium.executablePath()` — the build this
 *      exact playwright-core was pinned against, when it is installed.
 *   3. A scan of the known browser roots for any installed `chromium-<build>`
 *      across every platform layout. The previous implementation knew only
 *      the Linux one (`chrome-linux/chrome` under `/opt/pw-browsers`), which
 *      is why every macOS run skipped.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

/**
 * Per-platform paths to the browser binary inside one `chromium-<build>`
 * directory. Playwright has used several layouts (`chrome-mac` became
 * `chrome-mac-arm64` on Apple silicon, and newer builds ship "Google Chrome
 * for Testing" rather than "Chromium"), so every known one is tried.
 */
const BINARY_LAYOUTS: Record<string, readonly string[]> = {
  darwin: [
    join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    join('chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    join(
      'chrome-mac',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ),
    join(
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ),
  ],
  linux: [join('chrome-linux', 'chrome'), join('chrome-linux', 'headless_shell')],
  win32: [join('chrome-win', 'chrome.exe')],
};

/** Directories that may hold `chromium-<build>` installs, most specific first. */
function browserRoots(): string[] {
  const roots: string[] = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  // The container path this repo's e2e tests were originally written for.
  roots.push('/opt/pw-browsers');
  // Playwright's own per-platform default cache.
  const home = homedir();
  if (process.platform === 'darwin') roots.push(join(home, 'Library', 'Caches', 'ms-playwright'));
  else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) roots.push(join(localAppData, 'ms-playwright'));
  } else roots.push(join(home, '.cache', 'ms-playwright'));
  return roots;
}

/** Build number out of a `chromium-1208` directory name, or -1 when it has none. */
function buildNumber(dirName: string): number {
  const parsed = Number.parseInt(dirName.slice('chromium-'.length), 10);
  return Number.isNaN(parsed) ? -1 : parsed;
}

/** Newest installed Chromium under `root`, or undefined when there is none. */
function scanRoot(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  const layouts = BINARY_LAYOUTS[process.platform] ?? BINARY_LAYOUTS.linux ?? [];
  const candidates = entries
    .filter((name) => name.startsWith('chromium-'))
    // Newest build first: closest to whatever playwright-core expects.
    .sort((a, b) => buildNumber(b) - buildNumber(a));
  for (const dir of candidates) {
    for (const layout of layouts) {
      const candidate = join(root, dir, layout);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Absolute path to a Chromium the e2e tests can launch.
 *
 * @throws when no browser can be found — deliberately, so the suite fails
 * loudly rather than skipping the whole SPA surface.
 */
export function resolveChromiumExecutable(): string {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(
      `PLAYWRIGHT_CHROMIUM_EXECUTABLE is set to "${override}", but nothing exists there. Point it at a Chromium binary or unset it to fall back to discovery.`,
    );
  }

  // The build this playwright-core was pinned against, when installed.
  try {
    const pinned = chromium.executablePath();
    if (pinned && existsSync(pinned)) return pinned;
  } catch {
    // playwright-core throws when it has no registry entry for this
    // platform; fall through to the scan below.
  }

  const roots = browserRoots();
  for (const root of roots) {
    const found = scanRoot(root);
    if (found) return found;
  }

  throw new Error(
    [
      'No Chromium executable found, so the Playwright e2e tests cannot run.',
      `Searched: ${roots.join(', ')}`,
      'Install one with `bunx playwright-core install chromium`, or point',
      'PLAYWRIGHT_CHROMIUM_EXECUTABLE at an existing Chromium binary.',
    ].join('\n'),
  );
}
