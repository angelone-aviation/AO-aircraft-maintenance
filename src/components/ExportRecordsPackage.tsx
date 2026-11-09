/**
 * Responsibility: The "Export records package" button that saves one
 *   aircraft's complete records as a ZIP, with progress while it builds.
 * Layer: UI. Reads the snapshot it is given; the package is built in src/data.
 * Dependencies: react, src/data/store.ts, src/domain/model.ts (can),
 *   src/data/recordsPackage.ts (loaded on first export), ./ui.tsx.
 *
 * The package module pulls in jsPDF and fflate, so it loads only when someone
 * exports. Owners never see the button: the package holds flights, the change
 * log and work detail that the owner portal leaves out.
 */
import { useState } from "react";
import { useWorkspace } from "../data/store";
import { can, type Snapshot } from "../domain/model";
import { download, errorText } from "./ui";

const ZIP_TYPE = "application/zip";

/**
 * Button that builds the aircraft's records package and saves it as
 * `<registration>-records-<today>.zip`. Shown only to users with maintenance
 * permission on the aircraft (program and system administrators included);
 * renders nothing otherwise.
 *
 * @param props.state - Snapshot holding the aircraft and its records.
 * @param props.aircraftUuid - The aircraft to export.
 * @returns The button with a progress line while it works, then "Records
 *   package saved." (and how many files were left out, if any) or an alert.
 */
export function ExportRecordsPackage({
  state,
  aircraftUuid,
}: {
  state: Snapshot;
  aircraftUuid: string;
}) {
  const { backend, online, connected } = useWorkspace();
  const [progress, setProgress] = useState("");
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  if (!can(state, aircraftUuid, "maintenance")) return null;
  async function exportPackage() {
    setError("");
    setDone("");
    setProgress("Preparing…");
    try {
      const { exportRecordsPackage } = await import("../data/recordsPackage");
      const result = await exportRecordsPackage({
        snapshot: state,
        aircraftUuid,
        // The change log is paged from the backend only while connected.
        backend: online && connected ? backend : null,
        onProgress: setProgress,
      });
      download(result.name, result.blob, ZIP_TYPE);
      setDone(describeOutcome(result.skipped.length));
    } catch (e) {
      setError(errorText(e, "Unable to export the records package."));
    } finally {
      setProgress("");
    }
  }
  return (
    <div>
      <button className="button" disabled={!!progress} onClick={exportPackage}>
        {progress ? "Building package…" : "Export records package"}
      </button>
      {(progress || done) && <p role="status">{progress || done}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function describeOutcome(skipped: number): string {
  if (!skipped) return "Records package saved.";
  const files = skipped === 1 ? "1 file was" : `${skipped} files were`;
  return `Records package saved. ${files} left out; see README.txt in the package.`;
}
