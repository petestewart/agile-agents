/**
 * T489 (D58): Settings → Agents → Vendors. The daemon checks each vendor
 * itself: one short session with no node, a model and an effort set and read
 * back, one tiny prompt, a resume. One row per vendor: its version, when it
 * was checked, whether a model pick and an effort took (✓ ✗ —), the usage
 * fields it reported, whether resume worked, any rate-limit fields, and what
 * went wrong in words. **Check** per row, **Check all**, and the switch for
 * the automatic check (after a CLI update or a new version). Choose leaves
 * out a vendor whose last check kept its own model.
 *
 * T500: a vendor whose ACP server this app downloads (Antigravity) has
 * **Install** while it is missing, and once installed the row shows the
 * version, the platform and the archive's SHA-256 from its manifest.
 */

import type { SessionVendor, VendorCheckMode, VendorChecksStatus } from '@agile-agents/shared';
import { VENDOR_CHECK_MODES } from '@agile-agents/shared';
import { useEffect, useRef, useState } from 'react';
import { getVendorChecks, installVendor, runVendorChecks, setVendorCheckMode } from '../lib/api';
import {
  CHECK_MODE_HINTS,
  CHECK_MODE_WORDS,
  type CheckMark,
  vendorRowView,
} from '../lib/vendor-checks';
import { FormError, SavedNote, SetCard, SetRow, errorText, useSavedFlash } from './SettingsCard';
import { Badge, Button, Segmented, Spinner } from './ui';

/** How often the card reads the status again while a check runs. */
const POLL_MS = 1000;

export function VendorChecksCard(): JSX.Element {
  const [status, setStatus] = useState<VendorChecksStatus | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const flash = useSavedFlash();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    getVendorChecks()
      .then(setStatus)
      .catch((err: unknown) => setError(errorText(err)));
    return () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, []);

  // While a check (or an install, T500) runs or waits, read the status again until it's done.
  useEffect(() => {
    const installing = status?.vendors.some((v) => v.install?.installing === true) === true;
    if (status?.running !== true && !installing) return;
    timer.current = setTimeout(() => {
      getVendorChecks()
        .then(setStatus)
        .catch((err: unknown) => setError(errorText(err)));
    }, POLL_MS);
    return () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, [status]);

  async function run(key: string, fn: () => Promise<VendorChecksStatus>, saved = false) {
    setBusy(key);
    setError(undefined);
    flash.clear();
    try {
      setStatus(await fn());
      if (saved) flash.markSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(undefined);
    }
  }

  const mode = status?.mode ?? 'auto';
  const running = status?.running === true;
  const anyInstalled = status?.vendors.some((v) => v.installed) === true;
  return (
    <SetCard
      title="Vendors"
      icon="shield-check"
      description="Checks what each agent really does with your login: whether it takes a model and an effort you pick, what usage it reports, whether a session resumes. Model choice leaves out an agent that keeps its own model."
      testid="settings-vendors"
      status={<SavedNote show={flash.saved} testid="settings-vendors-saved" />}
    >
      <SetRow label="Check" hint={CHECK_MODE_HINTS[mode]} testid="settings-vendors-mode-row">
        {status === undefined && error === undefined ? (
          <span className="cr-set-muted">
            <Spinner size={12} /> Loading…
          </span>
        ) : (
          <Segmented<VendorCheckMode>
            label="When to check vendors"
            testid="settings-vendors-mode"
            value={mode}
            onChange={(next) => void run('mode', () => setVendorCheckMode(next), true)}
            items={VENDOR_CHECK_MODES.map((id) => ({
              id,
              label: CHECK_MODE_WORDS[id],
              testid: `settings-vendors-mode-${id}`,
              title: CHECK_MODE_HINTS[id],
              disabled: busy !== undefined || status === undefined,
            }))}
          />
        )}
      </SetRow>
      {status !== undefined && (
        <>
          <ul className="cr-set-vendors" data-testid="settings-vendors-list">
            {status.vendors.map((row) => {
              const view = vendorRowView(row);
              const vendor: SessionVendor = row.vendor;
              return (
                <li
                  key={vendor}
                  className="cr-set-vendors-row"
                  data-testid={`settings-vendors-row-${vendor}`}
                  data-installed={row.installed ? 'true' : 'false'}
                >
                  <div className="cr-set-vendors-main">
                    <span className="cr-set-updates-name">{row.label}</span>
                    <span
                      className="cr-set-updates-version"
                      data-testid={`settings-vendors-version-${vendor}`}
                    >
                      {view.version}
                    </span>
                    <Badge tone={view.state.tone} testid={`settings-vendors-state-${vendor}`}>
                      {view.state.text}
                    </Badge>
                    <span className="cr-set-muted" data-testid={`settings-vendors-when-${vendor}`}>
                      {view.when}
                    </span>
                    <span className="cr-set-updates-controls">
                      {view.install !== undefined &&
                        (view.install.canInstall || view.install.installing) && (
                          <Button
                            size="sm"
                            icon="download"
                            data-testid={`settings-vendors-install-${vendor}`}
                            busy={busy === `install:${vendor}` || view.install.installing}
                            disabled={busy !== undefined || view.install.installing}
                            title={`Download ${row.label}’s ACP server into this app’s home. It isn’t run until you check or use ${row.label}.`}
                            onClick={() =>
                              void run(`install:${vendor}`, () => installVendor(vendor))
                            }
                          >
                            Install
                          </Button>
                        )}
                      <Button
                        size="sm"
                        icon="refresh"
                        data-testid={`settings-vendors-check-${vendor}`}
                        busy={busy === `check:${vendor}` || row.running}
                        disabled={!view.canCheck || busy !== undefined}
                        title={
                          row.installed
                            ? `Check ${row.label} now: one short session and one tiny prompt`
                            : `${row.label} isn’t installed here`
                        }
                        onClick={() => void run(`check:${vendor}`, () => runVendorChecks(vendor))}
                      >
                        Check
                      </Button>
                    </span>
                  </div>
                  {row.last !== undefined && (
                    <dl className="cr-set-vendors-facts">
                      <Fact
                        label="Model"
                        mark={view.model}
                        testid={`settings-vendors-model-${vendor}`}
                      />
                      <Fact
                        label="Effort"
                        mark={view.effort}
                        testid={`settings-vendors-effort-${vendor}`}
                      />
                      <Fact
                        label="Resume"
                        mark={view.resume}
                        testid={`settings-vendors-resume-${vendor}`}
                      />
                      <div className="cr-set-vendors-fact cr-set-vendors-usage">
                        <dt>Usage</dt>
                        <dd data-testid={`settings-vendors-usage-${vendor}`}>{view.usage}</dd>
                      </div>
                    </dl>
                  )}
                  {view.install !== undefined && (
                    <p
                      className="cr-set-updates-hint"
                      data-testid={`settings-vendors-install-line-${vendor}`}
                    >
                      {view.install.line}
                      {view.install.sha256 !== undefined && (
                        <>
                          {' · SHA-256 '}
                          <code data-testid={`settings-vendors-sha-${vendor}`}>
                            {view.install.sha256}
                          </code>
                        </>
                      )}
                    </p>
                  )}
                  {view.install?.error !== undefined && (
                    <p
                      className="cr-set-updates-result"
                      data-ok="false"
                      data-testid={`settings-vendors-install-error-${vendor}`}
                    >
                      {view.install.error}
                    </p>
                  )}
                  {view.leftOut !== undefined && (
                    <p
                      className="cr-set-updates-hint"
                      data-testid={`settings-vendors-left-out-${vendor}`}
                    >
                      {view.leftOut}
                    </p>
                  )}
                  {view.rateLimits.length > 0 && (
                    <p
                      className="cr-set-updates-hint"
                      data-testid={`settings-vendors-limits-${vendor}`}
                    >
                      Plan and rate limits it reported: {view.rateLimits.join(' · ')}
                    </p>
                  )}
                  {view.errors.map((line) => (
                    <p
                      key={line}
                      className="cr-set-updates-result"
                      data-ok="false"
                      data-testid={`settings-vendors-error-${vendor}`}
                    >
                      {line}
                    </p>
                  ))}
                </li>
              );
            })}
          </ul>
          <div className="cr-set-updates-check">
            <Button
              size="sm"
              icon="shield-check"
              data-testid="settings-vendors-check-all"
              busy={busy === 'all' || running}
              disabled={busy !== undefined || running || !anyInstalled}
              title="Check every installed agent, one at a time"
              onClick={() => void run('all', () => runVendorChecks())}
            >
              Check all
            </Button>
            <span className="cr-set-muted" data-testid="settings-vendors-running">
              {running ? 'Checking, one agent at a time…' : ''}
            </span>
          </div>
        </>
      )}
      <FormError error={error} />
    </SetCard>
  );
}

function Fact({
  label,
  mark,
  testid,
}: {
  label: string;
  mark: CheckMark;
  testid: string;
}): JSX.Element {
  return (
    <div className="cr-set-vendors-fact" title={mark.words}>
      <dt>{label}</dt>
      <dd data-testid={testid} data-mark={mark.mark} aria-label={mark.words}>
        {mark.mark}
      </dd>
    </div>
  );
}
