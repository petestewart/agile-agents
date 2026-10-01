/**
 * `agile vendors install <vendor>` (T500): downloads a vendor's pinned ACP
 * server into the home (Antigravity's), the same as Install in Settings.
 *
 * `agile vendors` and `agile vendors check [vendor]` (T489, D58): the vendor
 * self-check over the daemon's `vendors.*` RPC, the same service as
 * Settings → Agents → Vendors. `agile vendors` prints each vendor's latest
 * result; `check` runs the checks (every installed vendor, or the one named),
 * one at a time, and prints the table when they are done. Each check opens
 * one session with no node and sends one tiny prompt.
 */

import {
  type BridgeManifest,
  SESSION_VENDORS,
  type VendorCheckResult,
  type VendorCheckRow,
  type VendorCheckSetting,
  type VendorChecksStatus,
  isSessionVendor,
  resumeMark,
  settingMark,
  vendorLoginHow,
} from '@agile-agents/shared';
import { callRpc } from '../client';
import { printJson, printTable } from '../format';

/** A check per vendor can take a couple of minutes; every installed vendor, longer. */
const CHECK_TIMEOUT_MS = 30 * 60 * 1000;
/** A download of a server archive (tens of MB) and its unpacking. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/** What usage a check saw, in a few words; the field names are in `--json`. */
export function usageShort(row: VendorCheckRow): string {
  const usage = row.last?.usage;
  if (usage === undefined) return 'none';
  const parts = [
    ...(usage.turn_tokens ? ['per turn'] : []),
    ...(usage.context ? ['context'] : []),
    ...(usage.cost !== undefined ? ['cost'] : []),
  ];
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** One vendor's row of `agile vendors`, in words: short cells only (T494). */
export function vendorRowCells(row: VendorCheckRow): string[] {
  const last = row.last;
  const version = last?.cli_version ?? row.cli_version ?? '—';
  if (last === undefined) {
    return [
      row.label,
      version,
      row.running
        ? 'checking…'
        : row.queued
          ? 'waiting'
          : row.installed
            ? 'never'
            : row.cli_version !== undefined
              ? 'can’t start'
              : 'not installed',
      '—',
      '—',
      '—',
      '—',
    ];
  }
  return [
    row.label,
    version,
    row.running ? 'checking…' : last.finished_at.slice(0, 16).replace('T', ' '),
    last.logged_in ? settingMark(last.model.outcome) : '—',
    last.logged_in ? settingMark(last.effort.outcome) : '—',
    last.logged_in ? resumeMark(last.resume.outcome) : '—',
    last.logged_in ? usageShort(row) : '—',
  ];
}

/** A setting that didn't take, in words (a refusal is in the errors, with its model). */
function settingNote(what: string, s: VendorCheckSetting): string | undefined {
  if (s.outcome === 'kept') {
    return `${what}: kept its own${s.after !== undefined ? ` (${s.after})` : ''}; didn’t take ${s.to ?? 'the pick'}`;
  }
  if (s.outcome === 'unclear') return `${what}: didn’t say whether it took ${s.to ?? 'the pick'}`;
  return undefined;
}

/** T500: a downloaded server's install, in one line: what is installed, or what Install fetches. */
export function installNote(row: VendorCheckRow): string | undefined {
  const install = row.install;
  if (install === undefined) return undefined;
  if (install.installing) return `Installing its ACP server ${install.version}…`;
  const m = install.manifest;
  const done =
    m !== undefined
      ? `ACP server ${m.version} (${m.platform}) installed ${m.installed_at.slice(0, 10)}, SHA-256 ${m.sha256}`
      : `ACP server ${install.version} not installed: agile vendors install ${row.vendor}`;
  return install.error !== undefined ? `${done}. Last install: ${install.error}` : done;
}

/** The notes under a vendor's row (T494): what didn't take, rate limits, errors. */
export function vendorRowNotes(row: VendorCheckRow): string[] {
  const last = row.last;
  const install = installNote(row);
  if (last === undefined) {
    return [
      ...(install !== undefined ? [install] : []),
      ...(!row.installed && row.missing !== undefined ? [row.missing] : []),
    ];
  }
  return [
    ...(install !== undefined ? [install] : []),
    ...(last.logged_in
      ? [settingNote('Model', last.model), settingNote('Effort', last.effort)].filter(
          (n): n is string => n !== undefined,
        )
      : []),
    ...(last.rate_limits.length > 0
      ? [`Rate limits: ${last.rate_limits.map((f) => `${f.name}=${f.value}`).join(', ')}`]
      : []),
    ...last.errors,
    ...(!row.installed && row.missing !== undefined ? [row.missing] : []),
  ];
}

/** `text` wrapped at word boundaries to `width`, each line indented by `indent`. */
export function wrapNote(text: string, width: number, indent = '  '): string[] {
  const room = Math.max(20, width - indent.length);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (word === '') continue;
    if (line !== '' && line.length + 1 + word.length > room) {
      lines.push(indent + line);
      line = '';
    }
    line = line === '' ? word : `${line} ${word}`;
  }
  if (line !== '') lines.push(indent + line);
  return lines;
}

const HEADERS = ['VENDOR', 'VERSION', 'CHECKED', 'MODEL', 'EFFORT', 'RESUME', 'USAGE'];

export function printVendorTable(status: VendorChecksStatus): void {
  const width = process.stdout.columns ?? 100;
  printTable(
    HEADERS,
    status.vendors.map(vendorRowCells),
    status.vendors.map((row) => vendorRowNotes(row).flatMap((note) => wrapNote(note, width))),
  );
  console.log(
    `\nAutomatic checks: ${status.mode === 'auto' ? 'on (after a CLI update or a new version)' : 'off (manual)'}`,
  );
  console.log('Every usage and rate-limit field by name: agile vendors --json');
}

/** `agile vendors`: each vendor's latest self-check. */
export async function runVendors(socketPath: string, json: boolean): Promise<number> {
  const status = await callRpc<VendorChecksStatus>(socketPath, 'vendors.status', {});
  if (json) printJson(status);
  else printVendorTable(status);
  return 0;
}

/** `agile vendors check [vendor]`: runs the checks, waits, prints the results. */
export async function runVendorsCheck(
  socketPath: string,
  vendor: string | undefined,
  json: boolean,
): Promise<number> {
  if (vendor !== undefined && !isSessionVendor(vendor)) {
    throw new Error(`agile vendors check: ${vendor} is not one of ${SESSION_VENDORS.join(', ')}`);
  }
  if (!json) {
    console.log(
      vendor !== undefined
        ? `Checking ${vendor} (one session, one tiny prompt)…`
        : 'Checking every installed vendor, one at a time (one session and one tiny prompt each)…',
    );
  }
  const { results, status } = await callRpc<{
    results: VendorCheckResult[];
    status: VendorChecksStatus;
  }>(socketPath, 'vendors.check', vendor !== undefined ? { vendor } : {}, {
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  if (json) {
    printJson({ results, status });
    return 0;
  }
  printVendorTable(status);
  return results.some((r) => !r.logged_in || !r.opened) ? 1 : 0;
}

/** The manifest in a few lines. */
export function manifestLines(manifest: BridgeManifest): string[] {
  return [
    `Installed ${manifest.registry_id} ${manifest.version} (${manifest.platform})`,
    `  from    ${manifest.url}`,
    `  SHA-256 ${manifest.sha256}`,
    `  size    ${manifest.size} bytes`,
    `  server  ${manifest.command}`,
  ];
}

/**
 * `agile vendors install <vendor>` (T500): downloads the vendor's pinned ACP
 * server into the home and waits. It never runs the server; sign in with the
 * vendor's own CLI, then `agile vendors check <vendor>`.
 */
export async function runVendorsInstall(
  socketPath: string,
  vendor: string | undefined,
  json: boolean,
): Promise<number> {
  if (vendor === undefined || !isSessionVendor(vendor)) {
    throw new Error(
      `agile vendors install: name a vendor (${vendor === undefined ? 'none given' : `${vendor} is not one of ${SESSION_VENDORS.join(', ')}`})`,
    );
  }
  if (!json) console.log(`Downloading ${vendor}\u2019s ACP server…`);
  const { manifest, status } = await callRpc<{
    manifest: BridgeManifest;
    status: VendorChecksStatus;
  }>(socketPath, 'vendors.install', { vendor }, { timeoutMs: INSTALL_TIMEOUT_MS });
  if (json) {
    printJson({ manifest, status });
    return 0;
  }
  for (const line of manifestLines(manifest)) console.log(line);
  const label = status.vendors.find((row) => row.vendor === vendor)?.label ?? vendor;
  console.log(
    `Next: sign in (${vendorLoginHow(vendor, label)}), then run \`agile vendors check ${vendor}\`.`,
  );
  return 0;
}
