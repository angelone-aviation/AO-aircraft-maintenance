/**
 * Responsibility: Downloads everything this browser's demo holds as one JSON
 *   file, for the person who tried the demo to keep.
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
 * The "Download this demo's data" panel: downloads every saved program,
 * record and uploaded file in this browser, then says what it held. No live
 * deployment reads the file. Renders nothing outside demo mode or before a
 * snapshot loads.
 */
export function DemoBackup() {
  const { demo, snapshot, namespace } = useWorkspace();
  const { busy, message, error, download } = useBackupDownload();
  if (!demo || !snapshot) return null;
  return (
    <div className="panel">
      <h3>Download this demo&apos;s data</h3>
      <p className="set-hint">
        Saves everything this browser&apos;s demo holds (Flight Programs,
        aircraft, work orders, components, job cards and uploaded files) as one
        JSON file. It cannot be imported into a live deployment.
      </p>
      <button
        type="button"
        className="button small"
        disabled={busy}
        onClick={() => void download(namespace, snapshot)}
      >
        {busy ? "Preparing the file…" : "Download demo data"}
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
  a.download = `angel-one-demo-data-${localDate()}.json`;
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
    ? `${pendingOperations.length} pending entries included. `
    : "";
  const missing = missingManualFiles.length
    ? `${missingManualFiles.length} manual files are unavailable in this browser; their metadata is included.`
    : "";
  return `Download started: ${snapshot.aircraft.length} aircraft, ${snapshot.workOrders?.length ?? 0} work orders, ${components} components. ${pending}${missing}`;
}
