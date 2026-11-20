/**
 * Responsibility: The "Paper check (month)" button: picks an aircraft and a
 *   month, then saves the paper check as a PDF or a CSV.
 * Layer: UI. Reads the snapshot it is given; the rows and the PDF are built
 *   in src/domain and src/data.
 * Dependencies: react, @phosphor-icons/react, src/domain (model,
 *   retention), src/data (store, historyLoads, paperCheckReport loaded on
 *   first export), ./design.tsx, ./ui.tsx.
 *
 * The report module pulls in jsPDF, so it loads only when someone exports.
 */
import { useState, type SyntheticEvent } from "react";
import { ListChecks } from "@phosphor-icons/react";
import { can, localDate, type Snapshot } from "../domain/model";
import { RETENTION_DAYS, retentionCutoff } from "../domain/retention";
import { useWorkspace } from "../data/store";
import { loadMonthHistory } from "../data/historyLoads";
import { Dialog } from "./design";
import { Field, download, errorText, useRevealError } from "./ui";

const CSV_TYPE = "text/csv";
const YEAR_MONTH_LENGTH = "YYYY-MM".length;
const YEAR_MONTH_PATTERN = /^\d{4}-\d{2}$/;
const OLDER_MONTH_OFFLINE =
  "Older records need a connection. Reconnect to check this month.";

type PaperCheckFormat = "pdf" | "csv";

/**
 * Button that opens the paper check dialog for the aircraft the user can
 * read: one fixed aircraft, or a choice when none is given.
 *
 * @param props.state - Snapshot holding the aircraft and their records.
 * @param props.aircraftUuid - The aircraft, when the button sits on one.
 * @returns The button, or null when the user can read no aircraft.
 */
export function PaperCheckButton({
  state,
  aircraftUuid,
}: {
  state: Snapshot;
  aircraftUuid?: string;
}) {
  const [open, setOpen] = useState(false);
  const readable = state.aircraft.filter(
    (a) =>
      can(state, a.uuid, "read") && (!aircraftUuid || a.uuid === aircraftUuid),
  );
  if (!readable.length) return null;
  return (
    <>
      <button type="button" className="button" onClick={() => setOpen(true)}>
        <ListChecks size={18} aria-hidden="true" /> Paper check (month)
      </button>
      {open && (
        <PaperCheckDialog
          state={state}
          aircraft={readable}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function PaperCheckDialog({
  state,
  aircraft,
  onClose,
}: {
  state: Snapshot;
  aircraft: Snapshot["aircraft"];
  onClose: () => void;
}) {
  const [aircraftUuid, setAircraft] = useState(aircraft[0].uuid);
  const [month, setMonth] = useState(localDate().slice(0, YEAR_MONTH_LENGTH));
  const { busy, error, save, alertRef } = usePaperCheckSave(
    state,
    aircraftUuid,
    month,
  );
  return (
    <Dialog
      title="Paper check"
      subtitle="The month's flights and completed work orders as recorded, with a Checked column to tick against the paper logbook."
      size="narrow"
      onClose={onClose}
    >
      {aircraft.length > 1 && (
        <AircraftSelect
          aircraft={aircraft}
          value={aircraftUuid}
          onChange={setAircraft}
        />
      )}
      <MonthField value={month} onChange={setMonth} />
      <SaveButtons busy={busy} disabled={busy || !month} onSave={save} />
      {error && (
        <p ref={alertRef} role="alert" className="error">
          {error}
        </p>
      )}
    </Dialog>
  );
}

function usePaperCheckSave(
  state: Snapshot,
  aircraftUuid: string,
  month: string,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { alertRef, rememberOrigin } = useRevealError(error);
  async function save(
    from: SyntheticEvent<HTMLElement>,
    format: PaperCheckFormat,
  ) {
    rememberOrigin(from);
    setBusy(true);
    setError("");
    try {
      await savePaperCheck(state, aircraftUuid, month, format);
    } catch (e) {
      setError(errorText(e, "Unable to build the paper check."));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, save, alertRef };
}

function AircraftSelect({
  aircraft,
  value,
  onChange,
}: {
  aircraft: Snapshot["aircraft"];
  value: string;
  onChange: (uuid: string) => void;
}) {
  return (
    <Field label="Aircraft">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {aircraft.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration}
          </option>
        ))}
      </select>
    </Field>
  );
}

function MonthField({
  value,
  onChange,
}: {
  value: string;
  onChange: (month: string) => void;
}) {
  return (
    <Field label="Month">
      <input
        type="month"
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function SaveButtons({
  busy,
  disabled,
  onSave,
}: {
  busy: boolean;
  disabled: boolean;
  onSave: (
    from: SyntheticEvent<HTMLElement>,
    format: PaperCheckFormat,
  ) => Promise<void>;
}) {
  return (
    <div className="form-footer">
      <button
        type="button"
        className="button primary"
        disabled={disabled}
        onClick={(e) => void onSave(e, "pdf")}
      >
        {busy ? "Building…" : "Save PDF"}
      </button>
      <button
        type="button"
        className="button"
        disabled={disabled}
        onClick={(e) => void onSave(e, "csv")}
      >
        Save CSV
      </button>
    </div>
  );
}

async function savePaperCheck(
  workspace: Snapshot,
  aircraftUuid: string,
  month: string,
  format: PaperCheckFormat,
) {
  const report = await import("../data/paperCheckReport");
  const state = await monthRecords(workspace, aircraftUuid, month);
  const registration =
    state.aircraft.find((a) => a.uuid === aircraftUuid)?.registration ?? "";
  const name = report.paperCheckFileName(registration, month, format);
  if (format === "csv")
    download(name, report.paperCheckCsv(state, aircraftUuid, month), CSV_TYPE);
  else report.paperCheckPdf(state, aircraftUuid, month).save(name);
}

// The month may be older than the workspace keeps (ADR-0013). Connected, its
// flights and work orders load whole; offline, a month starting before the
// window is refused rather than checked against records the device lacks.
async function monthRecords(
  workspace: Snapshot,
  aircraftUuid: string,
  month: string,
): Promise<Snapshot> {
  const { backend, online, connected } = useWorkspace.getState();
  if (!YEAR_MONTH_PATTERN.test(month)) return workspace;
  if (backend && online && connected)
    return loadMonthHistory(backend, workspace, aircraftUuid, month);
  const [year, number] = month.split("-").map(Number);
  const start = new Date(year, number - 1, 1).getTime();
  if (start < retentionCutoff(Date.now(), RETENTION_DAYS))
    throw new Error(OLDER_MONTH_OFFLINE);
  return workspace;
}
