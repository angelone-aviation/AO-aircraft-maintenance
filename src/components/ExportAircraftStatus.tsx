import { useState } from "react";
import { localDate } from "../domain/model";
import type { Snapshot } from "../domain/model";
export function ExportAircraftStatus({
  state,
  aircraftUuid,
}: {
  state: Snapshot;
  aircraftUuid: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div>
      <button
        className="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const { aircraftStatusReport } =
              await import("../data/aircraftStatusReport");
            const registration =
              state.aircraft.find((a) => a.uuid === aircraftUuid)
                ?.registration || "aircraft";
            aircraftStatusReport(state, aircraftUuid).save(
              `${registration.replace(/[^a-z0-9-]/gi, "_")}-status-${localDate()}.pdf`,
            );
          } catch (e) {
            setError(
              e instanceof Error ? e.message : "Unable to export status sheet.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Generating PDF…" : "Export status sheet"}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
