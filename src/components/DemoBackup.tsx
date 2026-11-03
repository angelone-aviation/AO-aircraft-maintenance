import { useState } from "react";
import { localDate } from "../domain/model";
import { useWorkspace } from "../data/store";
import { createDemoBackup } from "../data/demoBackup";

export function DemoBackup() {
  const { demo, snapshot, namespace } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
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
        onClick={async () => {
          setBusy(true);
          setError("");
          setMessage("");
          try {
            const backup = await createDemoBackup(namespace, snapshot);
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
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            setMessage(
              `Backup download started: ${backup.snapshot.aircraft.length} aircraft, ${backup.snapshot.workOrders?.length ?? 0} work orders, ${backup.snapshot.management?.filter((r) => r.kind === "component").length ?? 0} components. ${backup.pendingOperations.length ? `${backup.pendingOperations.length} pending entries included; resolve these before cloud import. ` : ""}${backup.missingManualFiles.length ? `${backup.missingManualFiles.length} manual files are unavailable in this browser; their metadata is included.` : ""}`,
            );
          } catch (e) {
            setError(
              e instanceof Error
                ? e.message
                : "Could not export the demo data.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Preparing full backup…" : "Download full demo backup"}
      </button>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
