/**
 * Responsibility: The "Export status sheet" button that saves an aircraft's
 *   status sheet as a PDF.
 * Layer: UI. Reads the snapshot it is given; the PDF is built in src/data.
 * Dependencies: src/domain/model.ts (localDate, Snapshot type),
 *   src/data/aircraftStatusReport.ts (loaded on first export), ./ui.tsx.
 *
 * The report module pulls in jsPDF, so it loads only when someone exports.
 */
import { useState } from "react";
import { localDate, type Snapshot } from "../domain/model";
import { errorText } from "./ui";

/**
 * Button that builds the aircraft's status sheet and saves it as
 * `<registration>-status-<today>.pdf`.
 *
 * @param props.state - Snapshot holding the aircraft and its records.
 * @param props.aircraftUuid - The aircraft to report on.
 * @returns The button, with an alert under it when the export fails.
 */
export function ExportAircraftStatus({
  state,
  aircraftUuid,
}: {
  state: Snapshot;
  aircraftUuid: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function exportSheet() {
    setBusy(true);
    setError("");
    try {
      await saveStatusSheet(state, aircraftUuid);
    } catch (e) {
      setError(errorText(e, "Unable to export status sheet."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button className="button" disabled={busy} onClick={exportSheet}>
        {busy ? "Generating PDF…" : "Export status sheet"}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

async function saveStatusSheet(state: Snapshot, aircraftUuid: string) {
  const { aircraftStatusReport } = await import("../data/aircraftStatusReport");
  const registration =
    state.aircraft.find((a) => a.uuid === aircraftUuid)?.registration ||
    "aircraft";
  aircraftStatusReport(state, aircraftUuid).save(
    `${registration.replace(/[^a-z0-9-]/gi, "_")}-status-${localDate()}.pdf`,
  );
}
