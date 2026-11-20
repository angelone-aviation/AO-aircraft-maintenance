/**
 * Responsibility: The read-only blocks of Settings → System: which optional
 *   features the deployment has turned on, and the off-site backup status.
 * Layer: UI. React components; system administrators only (Settings checks).
 * Dependencies: react, src/data (store, deviceManuals), src/domain (alerts,
 *   model, offsiteBackups, signInMethods), ./design, ./SettingsBlock,
 *   ./useDeploymentFeatures.
 */
import { useEffect, useState } from "react";
import { useWorkspace } from "../data/store";
import { formatBytes } from "../data/deviceManuals";
import type { Snapshot } from "../domain/model";
import { wantsAlertEmails } from "../domain/alerts";
import {
  offsiteFreshness,
  OFFSITE_STALE_AFTER_MS,
  type OffsiteCopy,
} from "../domain/offsiteBackups";
import { GOOGLE, MICROSOFT } from "../domain/signInMethods";
import { StatusPill, type Tone } from "./design";
import { Block, settingsDateTime } from "./SettingsBlock";
import type { DeploymentFeatures } from "./useDeploymentFeatures";

const MS_PER_HOUR = 3_600_000;
const STALE_HOURS = OFFSITE_STALE_AFTER_MS / MS_PER_HOUR;

/**
 * Each optional feature of the deployment, on or not set up, and who turns
 * them on. The demo has none of them and says so.
 *
 * @param props.features - What the deployment offers, as far as known.
 */
export function DeploymentStatus({
  features,
}: {
  features: DeploymentFeatures;
}) {
  const demo = useWorkspace((s) => s.demo);
  const rows: [string, boolean | undefined][] = [
    ["Alert email (Resend)", features.email],
    ["Alerts on devices (Web Push)", features.devicePush],
    ["Google sign-in", features.signIn?.includes(GOOGLE)],
    ["Microsoft sign-in", features.signIn?.includes(MICROSOFT)],
    ["Browser error reporting (Sentry)", features.errorReporting],
  ];
  return (
    <Block
      title="Deployment status"
      description="Whoever deploys Angel One turns these on, together with the site address used in email links and the key that encrypts saved credentials. Ask them to follow “Settings that live on the deployment” in the README."
    >
      {demo ? (
        <p className="set-empty">
          The demo sends no email or device alerts, signs in with passwords only
          and reports no errors.
        </p>
      ) : (
        <ul className="set-status-list">
          {rows.map(([label, on]) => (
            <li key={label}>
              <span>{label}</span>
              <StatusPill tone={statusTone(on)}>{statusText(on)}</StatusPill>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

/** The newest nightly off-site backup (ADR-0008), which the backup job
 * records through backups:recordOffsiteCopy. */
export function OffsiteBackups() {
  const { snapshot, connected, demo } = useWorkspace();
  const s = snapshot!;
  const { loaded, failed } = useOffsiteCopy();
  const freshness = loaded && offsiteFreshness(loaded.copy, loaded.at);
  return (
    <Block
      title="Off-site backups"
      description={`Every night a copy of all records and files is uploaded to Cloudflare R2 (not encrypted unless a backup key is set). If the newest copy is more than ${STALE_HOURS} hours old, this panel shows a warning; system administrators who get the daily alert email are also emailed, when email is set up.`}
    >
      {demo ? (
        <p className="set-empty">
          Off-site backups run only on the production deployment.
        </p>
      ) : freshness ? (
        <BackupStatus s={s} copy={loaded.copy} freshness={freshness} />
      ) : (
        <p className="set-hint">{backupWaitText(failed, connected)}</p>
      )}
      <p className="set-hint">
        Restoring a backup is done by whoever runs the deployment, following the
        backup and restore runbook.
      </p>
    </Block>
  );
}

// The newest copy and when it was loaded, so its age is shown as of then.
// The demo has no backups; a reply after the page closes is dropped.
function useOffsiteCopy() {
  const { backend, connected, demo } = useWorkspace();
  const [loaded, setLoaded] = useState<{
    copy: OffsiteCopy | null;
    at: number;
  }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (!demo && backend && connected)
      backend.latestOffsiteCopy().then(
        (copy) => {
          if (!active) return;
          setLoaded({ copy, at: Date.now() });
          setFailed(false);
        },
        () => {
          if (active) setFailed(true);
        },
      );
    return () => {
      active = false;
    };
  }, [backend, connected, demo]);
  return { loaded, failed };
}

function BackupStatus({
  s,
  copy,
  freshness,
}: {
  s: Snapshot;
  copy: OffsiteCopy | null;
  freshness: ReturnType<typeof offsiteFreshness>;
}) {
  return (
    <>
      <div className="set-backup-status">
        <StatusPill tone={freshness.status === "ok" ? "good" : "warn"}>
          {freshness.status === "ok" ? "OK" : "Warning"}
        </StatusPill>
        <p>{freshness.message}</p>
      </div>
      {copy && <BackupFacts copy={copy} />}
      {!wantsAlertEmails(s.user, s.groups, s.activeProgramUuid) && (
        <p className="set-hint">
          Your alert email is off, so backup warnings show only here. Turn on
          “Email me a daily alert digest” under Alerts to get them by email.
        </p>
      )}
    </>
  );
}

function BackupFacts({ copy }: { copy: OffsiteCopy }) {
  return (
    <dl className="set-facts">
      <div>
        <dt>Last copy</dt>
        <dd>{settingsDateTime(copy.completedAt)}</dd>
      </div>
      <div>
        <dt>Size</dt>
        <dd>{formatBytes(copy.bytes)}</dd>
      </div>
      <div>
        <dt>Last monthly copy</dt>
        <dd>
          {copy.monthlyCompletedAt
            ? settingsDateTime(copy.monthlyCompletedAt)
            : "None yet"}
        </dd>
      </div>
    </dl>
  );
}

function statusText(on: boolean | undefined) {
  if (on === undefined) return "Unknown";
  return on ? "On" : "Not set up";
}

function statusTone(on: boolean | undefined): Tone {
  if (on === undefined) return "neutral";
  return on ? "good" : "warn";
}

function backupWaitText(failed: boolean, connected: boolean) {
  if (failed)
    return "Could not load the off-site backup status. Reconnect and reload.";
  return connected
    ? "Checking off-site backups…"
    : "Reconnect to see the off-site backup status.";
}
