/**
 * Responsibility: Downloads the full demo data held in this browser as one
 *   JSON file, for moving a demo program to the cloud.
 * Layer: UI. React component; shown in demo mode only.
 * Dependencies: react, src/domain/model.ts, src/data/store.ts,
 *   src/data/demoBackup.ts, ./ui.tsx.
 */
import { useState } from "react";
import { localDate, type Snapshot } from "../domain/model";
import { useWorkspace } from "../data/store";
import { createDemoBackup } from "../data/demoBackup";
import { errorText } from "./ui";

// A full backup can be large; the browser keeps reading the URL after the
// click returns.
const DOWNLOAD_URL_LIFETIME_MS = 60_000;

type Backup = Awaited<ReturnType<typeof createDemoBackup>>;

/**
 * The "Full demo backup" panel: downloads every saved program, record and
 * uploaded file in this browser, then reports what to resolve before a cloud
 * import. Renders nothing outside demo mode or before a snapshot loads.
 */
export function DemoBackup() {
  const { demo, snapshot, namespace } = useWorkspace();
  const { busy, message, error, download } = useBackupDownload();
  if (!demo || !snapshot) return null;
  return (
    <div className="panel">
      <h3>Full demo backup for cloud transfer</h3>
      <p>
        Download all saved Flight Programs, aircraft, work orders, components,
        job cards and uploaded files from this browser. Demo users have no login
        passwords; real accounts will be configured during cloud setup.
      </p>
      <button
        type="button"
        className="button primary"
        disabled={busy}
        onClick={() => void download(namespace, snapshot)}
      >
        {busy ? "Preparing full backup…" : "Download full demo backup"}
      </button>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function useBackupDownload() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function download(namespace: string, snapshot: Snapshot) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const backup = await createDemoBackup(namespace, snapshot);
      saveBackup(backup);
      setMessage(summarizeBackup(backup));
    } catch (e) {
      setError(errorText(e, "Could not export the demo data."));
    } finally {
      setBusy(false);
    }
  }
  return { busy, message, error, download };
}

function saveBackup(backup: Backup) {
  const blob = new Blob([JSON.stringify(backup)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `angel-one-demo-backup-${localDate()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}

function summarizeBackup({
  snapshot,
  pendingOperations,
  missingManualFiles,
}: Backup): string {
  const components =
    snapshot.management?.filter((r) => r.kind === "component").length ?? 0;
  const pending = pendingOperations.length
    ? `${pendingOperations.length} pending entries included; resolve these before cloud import. `
    : "";
  const missing = missingManualFiles.length
    ? `${missingManualFiles.length} manual files are unavailable in this browser; their metadata is included.`
    : "";
  return `Backup download started: ${snapshot.aircraft.length} aircraft, ${snapshot.workOrders?.length ?? 0} work orders, ${components} components. ${pending}${missing}`;
}
