/**
 * T481 (D50): the pure half of Settings → Agents → Updates: what each
 * mode means, and a CLI's state in words. No DOM, so plain `bun test`
 * covers it; `components/SettingsUpdates.tsx` only renders.
 */

import {
  HARNESS_METHOD_WORDS,
  type HarnessStatus,
  type HarnessUpdateMode,
} from '@agile-agents/shared';

export const MODE_WORDS: Record<HarnessUpdateMode, string> = {
  off: 'Off',
  alert: 'Alert',
  auto: 'Auto',
};

/** One line each on what the mode does. */
export const MODE_HINTS: Record<HarnessUpdateMode, string> = {
  off: 'No version checks: nothing runs.',
  alert:
    'Checks when the daemon starts and then daily. A new version shows in Needs me, with Update.',
  auto: 'Checks when the daemon starts and then daily, and installs a new version in the background. A failed update shows in Needs me.',
};

export type UpdateTone = 'green' | 'blue' | 'amber' | 'red' | 'gray';

/** A CLI's state for its row: a short status, its tone, and a longer line when there is more to say. */
export interface UpdateState {
  text: string;
  tone: UpdateTone;
  hint?: string;
}

export function updateState(h: HarnessStatus): UpdateState {
  if (h.mode === 'off') return { text: 'Off', tone: 'gray', hint: 'Not checked.' };
  if (h.updating === true) return { text: 'Updating…', tone: 'blue' };
  if (h.checked_at === undefined) return { text: 'Not checked yet', tone: 'gray' };
  if (!h.found) return { text: 'Not installed', tone: 'gray' };
  if (h.manual !== undefined) return { text: 'Can’t check', tone: 'gray', hint: h.manual };
  if (h.behind) return { text: 'Update available', tone: 'blue' };
  if (h.error !== undefined)
    return { text: 'Couldn’t check', tone: 'amber', hint: capital(h.error) };
  if (h.latest !== undefined) return { text: 'Up to date', tone: 'green' };
  if (h.can_update) {
    return {
      text: 'Newest unknown',
      tone: 'gray',
      hint: `Its own installer finds the newest version when you press Update${
        h.command !== undefined ? ` (${h.command})` : ''
      }.`,
    };
  }
  return { text: 'Not known', tone: 'gray' };
}

/** How it was installed, in words ("Homebrew"), with the package when it names one. */
export function methodText(h: HarnessStatus): string {
  if (h.method === undefined) return '—';
  const words = HARNESS_METHOD_WORDS[h.method];
  return h.package !== undefined && h.method !== 'native' ? `${words}: ${h.package}` : words;
}

/** Whether its row offers Update: a method that can update, and a newer version or one it can't tell. */
export function offersUpdate(h: HarnessStatus): boolean {
  if (!h.found || !h.can_update || h.mode === 'off') return false;
  return h.behind || h.latest === undefined;
}

function capital(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;
}
