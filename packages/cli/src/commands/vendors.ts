/**
 * `agile vendors` and `agile vendors check [vendor]` (T489, D58): the vendor
 * self-check over the daemon's `vendors.*` RPC, the same service as
 * Settings → Agents → Vendors. `agile vendors` prints each vendor's latest
 * result; `check` runs the checks (every installed vendor, or the one named),
 * one at a time, and prints the table when they are done. Each check opens
 * one session with no node and sends one tiny prompt.
 */

import {
  SESSION_VENDORS,
  type VendorCheckResult,
  type VendorCheckRow,
  type VendorChecksStatus,
  isSessionVendor,
  resumeMark,
  settingMark,
  usageWords,
} from '@agile-agents/shared';
import { callRpc } from '../client';
import { printJson, printTable } from '../format';

/** A check per vendor can take a couple of minutes; every installed vendor, longer. */
const CHECK_TIMEOUT_MS = 30 * 60 * 1000;

/** One vendor's row of `agile vendors`, in words. */
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
            : 'not installed',
      '—',
      '—',
      '—',
      '—',
      '',
    ];
  }
  return [
    row.label,
    version,
    row.running ? 'checking…' : last.finished_at.slice(0, 16).replace('T', ' '),
    last.logged_in ? settingMark(last.model.outcome) : '—',
    last.logged_in ? settingMark(last.effort.outcome) : '—',
    last.logged_in ? usageWords(last.usage) : '—',
    last.logged_in ? resumeMark(last.resume.outcome) : '—',
    [
      ...(last.rate_limits.length > 0
        ? [`rate limits: ${last.rate_limits.map((f) => `${f.name}=${f.value}`).join(', ')}`]
        : []),
      ...last.errors,
    ].join(' · '),
  ];
}

const HEADERS = ['VENDOR', 'VERSION', 'CHECKED', 'MODEL', 'EFFORT', 'USAGE', 'RESUME', 'NOTES'];

export function printVendorTable(status: VendorChecksStatus): void {
  printTable(HEADERS, status.vendors.map(vendorRowCells));
  console.log(
    `\nAutomatic checks: ${status.mode === 'auto' ? 'on (after a CLI update or a new version)' : 'off (manual)'}`,
  );
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
