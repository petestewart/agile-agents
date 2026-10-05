/**
 * T489 (D58): the pure half of Settings → Agents → Vendors: one vendor's
 * latest self-check in words and marks, and what the switch means. No DOM,
 * so plain `bun test` covers it; `components/SettingsVendors.tsx` renders.
 */

import {
  type VendorCheckMode,
  type VendorCheckResult,
  type VendorCheckRow,
  type VendorCheckSetting,
  resumeMark,
  settingMark,
  uncheckedCommandsWarning,
  vendorRunsUnchecked,
} from '@agile-agents/shared';
import { ago } from './status';

export const CHECK_MODE_WORDS: Record<VendorCheckMode, string> = {
  auto: 'Automatic',
  manual: 'Only when I ask',
};

export const CHECK_MODE_HINTS: Record<VendorCheckMode, string> = {
  auto: 'Checks a vendor after its command-line tool updates, or when a version shows up that hasn’t been checked. Each check is one short session and one tiny prompt.',
  manual: 'Checks only when you press Check. Each check is one short session and one tiny prompt.',
};

export type CheckTone = 'green' | 'amber' | 'red' | 'gray' | 'blue';

/** A mark (✓ ✗ —) with its words for a tooltip and a screen reader. */
export interface CheckMark {
  mark: '✓' | '✗' | '—';
  words: string;
}

export interface VendorRowView {
  /** "2.3.1", or "—". */
  version: string;
  /** "Checked 5m ago", "Checking…", "Waiting", "Never checked", "Not installed". */
  when: string;
  state: { text: string; tone: CheckTone };
  model: CheckMark;
  effort: CheckMark;
  resume: CheckMark;
  /** The usage fields in a short list, or "none". */
  usage: string;
  /** Rate-limit or plan fields the vendor sent, as `name: value`. */
  rateLimits: string[];
  /** What went wrong, in words. */
  errors: string[];
  /** Why model choice leaves it out, when it does. */
  leftOut?: string;
  /** The check can run (installed, not running or waiting). */
  canCheck: boolean;
  /** T500: a server this app downloads (Antigravity's): Install, and what is installed. */
  install?: InstallView;
  /** T505: it runs shell commands that nothing checks, in words. */
  unchecked?: string;
}

/** T500: a downloaded server's install, in words. */
export interface InstallView {
  /** Install shows (nothing installed yet, or the install is incomplete). */
  canInstall: boolean;
  installing: boolean;
  /** "ACP server 1.2.1 (linux-x86_64), installed 2026-10-01", or what Install fetches. */
  line: string;
  /** The archive's SHA-256, once installed. */
  sha256?: string;
  /** Why the last install failed. */
  error?: string;
}

/** T500: the install half of a row, or `undefined` for a vendor this app doesn't download. */
export function installView(row: VendorCheckRow): InstallView | undefined {
  const install = row.install;
  if (install === undefined) return undefined;
  const m = install.manifest;
  const line = install.installing
    ? `Downloading its ACP server ${install.version}…`
    : m !== undefined
      ? `ACP server ${m.version} (${m.platform}), installed ${m.installed_at.slice(0, 10)}`
      : install.platform === undefined
        ? `Its ACP server ${install.version} has no build for this computer.`
        : `Its ACP server ${install.version} isn’t installed. Install downloads it from Google into this app’s home.`;
  return {
    canInstall:
      !install.installing && install.platform !== undefined && (m === undefined || !row.installed),
    installing: install.installing,
    line,
    ...(m !== undefined ? { sha256: m.sha256 } : {}),
    ...(install.error !== undefined ? { error: install.error } : {}),
  };
}

function settingWords(what: 'Model' | 'Effort', s: VendorCheckSetting): string {
  switch (s.outcome) {
    case 'honoured':
      return `${what}: took ${s.to ?? 'the pick'}`;
    case 'kept':
      return `${what}: kept its own${s.after !== undefined ? ` (${s.after})` : ''}; didn’t take ${s.to ?? 'the pick'}`;
    case 'refused':
      return `${what}: refused${s.detail !== undefined ? ` — ${s.detail}` : ''}`;
    case 'unclear':
      return `${what}: didn’t say whether it took ${s.to ?? 'the pick'}`;
    case 'not_applicable':
      return `${what}: ${s.detail ?? 'nothing to set'}`;
    default:
      return `${what}: not checked`;
  }
}

/** Short usage words for the row: the reply's fields first (what a budget counts). */
export function usageShort(last: VendorCheckResult): string {
  const u = last.usage;
  if (u === undefined) return last.prompt.outcome === 'finished' ? 'none' : '—';
  const fields = [
    ...u.reply_usage_fields,
    ...u.update_fields.filter((f) => !u.reply_usage_fields.includes(f)),
  ];
  if (fields.length === 0) return 'none';
  const shown = fields.slice(0, 6).join(', ');
  return fields.length > 6 ? `${shown} +${fields.length - 6}` : shown;
}

function sentence(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

export function vendorRowView(row: VendorCheckRow, now: number = Date.now()): VendorRowView {
  const last = row.last;
  const version = row.cli_version ?? last?.cli_version ?? '—';
  const dash: CheckMark = { mark: '—', words: 'Not checked' };
  const busy = row.running || row.queued;
  const when = row.running
    ? 'Checking…'
    : row.queued
      ? 'Waiting'
      : last !== undefined
        ? `Checked ${ago(last.finished_at, now) === 'now' ? 'just now' : `${ago(last.finished_at, now)} ago`}`
        : row.installed
          ? 'Never checked'
          : row.cli_version !== undefined
            ? 'Can’t start'
            : 'Not installed';
  if (last === undefined) {
    return {
      version,
      when,
      state: busy
        ? { text: row.running ? 'Checking' : 'Waiting', tone: 'blue' }
        : row.installed
          ? { text: 'Not checked yet', tone: 'gray' }
          : row.cli_version !== undefined
            ? { text: 'Can’t start', tone: 'amber' }
            : { text: 'Not installed', tone: 'gray' },
      model: dash,
      effort: dash,
      resume: dash,
      usage: '—',
      rateLimits: [],
      // T494: a CLI can be installed while its bridge can't run (Pi's runs through npx); say which command is missing.
      errors: !row.installed && row.missing !== undefined ? [row.missing] : [],
      canCheck: row.installed && !busy,
      ...rowExtras(row),
    };
  }
  const state: VendorRowView['state'] = busy
    ? { text: row.running ? 'Checking' : 'Waiting', tone: 'blue' }
    : !last.logged_in
      ? { text: 'Not logged in', tone: 'amber' }
      : !last.opened
        ? { text: 'Didn’t start', tone: 'red' }
        : last.model.outcome === 'kept'
          ? { text: 'Keeps its own model', tone: 'amber' }
          : last.model.outcome === 'refused'
            ? { text: 'Refused the model it was given', tone: 'amber' }
            : last.errors.length > 0
              ? { text: 'Checked, with problems', tone: 'amber' }
              : { text: 'Checked', tone: 'green' };
  const skipped = !last.logged_in || !last.opened;
  return {
    version,
    when,
    state,
    model: skipped
      ? dash
      : { mark: settingMark(last.model.outcome), words: settingWords('Model', last.model) },
    effort: skipped
      ? dash
      : { mark: settingMark(last.effort.outcome), words: settingWords('Effort', last.effort) },
    resume: skipped
      ? dash
      : {
          mark: resumeMark(last.resume.outcome),
          words: `Resume: ${last.resume.detail ?? last.resume.outcome.replace('_', ' ')}`,
        },
    usage: skipped ? '—' : usageShort(last),
    rateLimits: last.rate_limits.map((f) => `${f.name}: ${f.value}`),
    errors: last.errors.map(sentence),
    // T494: only a vendor that keeps its own model is left out; a refusal is
    // about the one model the check tried, and the vendor stays in.
    ...(!skipped && last.model.outcome === 'kept'
      ? { leftOut: `Model choice leaves ${last.label} out: a model picked for it doesn’t take.` }
      : {}),
    canCheck: row.installed && !busy,
    ...rowExtras(row),
  };
}

function rowExtras(row: VendorCheckRow): { install?: InstallView; unchecked?: string } {
  const install = installView(row);
  return {
    ...(install !== undefined ? { install } : {}),
    // T505: whatever its check says, its commands run unchecked.
    ...(vendorRunsUnchecked(row.vendor) ? { unchecked: uncheckedCommandsWarning(row.label) } : {}),
  };
}
