/**
 * T481 (**D50**): keeping each vendor's own CLI up to date. A setting with
 * three modes, kept under `harness_updates:` in `<home>/config.yaml`:
 *
 *  - **off**: no version check at all (no command runs);
 *  - **alert** (the default): a check at daemon start and then daily puts a
 *    Needs me item for a CLI that is behind, with Update and Dismiss;
 *  - **auto**: the update runs in the background and leaves a line in
 *    Events; a failure becomes the Needs me item.
 *
 * A vendor may override the mode (`vendors.<vendor>`). A dismissed update is
 * remembered by the version it offered (`dismissed.<harness>`), so the next
 * version asks again. Running sessions keep the version they started on.
 *
 * The daemon's service is `packages/daemon/src/harness/`; this file holds
 * only the schemas and the shapes the cockpit reads.
 */

import { z } from 'zod';
import { type SessionVendor, SessionVendorSchema } from './session-defaults';

export const HARNESS_UPDATE_MODES = ['off', 'alert', 'auto'] as const;
export const HarnessUpdateModeSchema = z.enum(HARNESS_UPDATE_MODES);
export type HarnessUpdateMode = z.infer<typeof HarnessUpdateModeSchema>;

/** D50: Alert when the home sets nothing. */
export const DEFAULT_HARNESS_UPDATE_MODE: HarnessUpdateMode = 'alert';

/**
 * The CLIs the check reads: each vendor's own, as the operator installed it,
 * plus `pi-acp` (Pi's ACP adapter, which the daemon launches and which is
 * installed on its own).
 */
export const HARNESS_IDS = ['claude', 'codex', 'gemini', 'cursor', 'grok', 'pi', 'pi-acp'] as const;
export const HarnessIdSchema = z.enum(HARNESS_IDS);
export type HarnessId = z.infer<typeof HarnessIdSchema>;

/** The vendor a CLI belongs to: its mode is that vendor's. */
export const HARNESS_VENDOR: Record<HarnessId, SessionVendor> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  cursor: 'cursor',
  grok: 'grok',
  pi: 'pi',
  'pi-acp': 'pi',
};

/** A version as `--version`, npm or Homebrew print it: `2.3.1`, `0.32.1-preview.0`. */
export const HarnessVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'must be a version like 2.3.1')
  .max(64);

const modeFor = HarnessUpdateModeSchema.optional();
const dismissedFor = HarnessVersionSchema.optional();

export const HarnessUpdatesConfigSchema = z
  .object({
    /** Every vendor's mode unless it sets its own. Absent = `alert`. */
    mode: HarnessUpdateModeSchema.optional(),
    /** A vendor's own mode, over `mode`. */
    vendors: z
      .object({
        claude: modeFor,
        gemini: modeFor,
        cursor: modeFor,
        grok: modeFor,
        pi: modeFor,
        codex: modeFor,
      })
      .strict()
      .optional(),
    /** The version whose update was dismissed, per CLI: it asks again for a newer one. */
    dismissed: z
      .object({
        claude: dismissedFor,
        codex: dismissedFor,
        gemini: dismissedFor,
        cursor: dismissedFor,
        grok: dismissedFor,
        pi: dismissedFor,
        'pi-acp': dismissedFor,
      })
      .strict()
      .optional(),
  })
  .strict();
export type HarnessUpdatesConfig = z.infer<typeof HarnessUpdatesConfigSchema>;

/** A CLI's effective mode: its vendor's own, else the home's, else Alert. */
export function harnessModeOf(
  config: HarnessUpdatesConfig | undefined,
  harness: HarnessId,
): HarnessUpdateMode {
  return config?.vendors?.[HARNESS_VENDOR[harness]] ?? config?.mode ?? DEFAULT_HARNESS_UPDATE_MODE;
}

/**
 * `POST /api/settings/harness-updates`: `{mode}` sets every vendor's mode;
 * `{vendor, mode}` sets one vendor's, and `{vendor, mode: null}` puts it
 * back on the home's.
 */
export const HarnessUpdatesInputSchema = z
  .object({
    mode: HarnessUpdateModeSchema.nullable(),
    vendor: SessionVendorSchema.optional(),
  })
  .strict()
  .refine((input) => input.mode !== null || input.vendor !== undefined, {
    message: 'only a vendor’s mode can be cleared',
    path: ['mode'],
  });
export type HarnessUpdatesInput = z.infer<typeof HarnessUpdatesInputSchema>;

/**
 * How a CLI was installed, read from where its binary resolves: Homebrew,
 * a global npm package, the vendor's own installer (with its own update
 * command), or a way this app can't check.
 */
export const HARNESS_INSTALL_METHODS = ['brew', 'npm', 'native', 'unknown'] as const;
export type HarnessInstallMethod = (typeof HARNESS_INSTALL_METHODS)[number];

/** An install method in words, for Settings and `agile daemon status`. */
export const HARNESS_METHOD_WORDS: Record<HarnessInstallMethod, string> = {
  brew: 'Homebrew',
  npm: 'npm (global)',
  native: 'its own installer',
  unknown: 'not known',
};

/** One CLI's last check, as Settings and `agile daemon status` read it. */
export interface HarnessStatus {
  id: HarnessId;
  vendor: SessionVendor;
  /** Its name in words ("Claude Code"). */
  label: string;
  /** The mode it runs under (its vendor's own, else the home's). */
  mode: HarnessUpdateMode;
  /** Its command was found on the daemon's PATH. Unknown (false) until a check ran. */
  found: boolean;
  /** Where its binary resolves, symlinks followed. */
  path?: string;
  method?: HarnessInstallMethod;
  /** The Homebrew formula or cask, or the npm package. */
  package?: string;
  version?: string;
  /** The newest published version; absent when the method can't tell (Update still works). */
  latest?: string;
  /** A newer version is known. */
  behind: boolean;
  /** Update can run here (a known method with an update command). */
  can_update: boolean;
  /** The update command, as words to run by hand. */
  command?: string;
  /** A method this app can't check: how to update by hand. */
  manual?: string;
  checked_at?: string;
  /** What went wrong on the last check, in words. */
  error?: string;
  /** An update is running now. */
  updating?: boolean;
  /** The last update's result, in words. */
  last_update?: { ok: boolean; message: string; at: string };
  /** The version whose update you dismissed. */
  dismissed?: string;
}

/** An ACP bridge (Claude's and Codex's npx bridges): information only, never installed by the updater. */
export interface HarnessBridgeStatus {
  vendor: SessionVendor;
  label: string;
  package: string;
  /** The version the code pins (`providers.ts`). */
  pinned: string;
  /** The newest published version (`npm view`), when a check ran. */
  latest?: string;
  error?: string;
  checked_at?: string;
}

/** `GET /api/settings/harness-updates`. */
export interface HarnessUpdatesStatus {
  mode: HarnessUpdateMode;
  vendors: Partial<Record<SessionVendor, HarnessUpdateMode>>;
  harnesses: HarnessStatus[];
  bridges: HarnessBridgeStatus[];
  /** A check is running now. */
  checking: boolean;
  checked_at?: string;
}

/** `POST /api/harness-updates/:harness/update`: the result in words, and the CLI after it. */
export interface HarnessUpdateResult {
  ok: boolean;
  message: string;
  status: HarnessStatus;
}
