/**
 * Responsibility: The Import logbook button: previews a flight logbook file
 *   and saves its rows as flights.
 * Layer: UI. React component; parsing and planning live in src/domain.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts,
 *   src/domain/model.ts, src/domain/flightLogImport.ts, ./ui, ./design,
 *   ./engineTrends.css.
 */
import "./engineTrends.css";
import { useState } from "react";
import { UploadSimple } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import {
  can,
  hours,
  type FlightInput,
  type Operation,
  type QueuedOperation,
  type Snapshot,
} from "../domain/model";
import {
  LOGBOOK_MAX_MEGABYTES,
  logbookFormatLabels,
  parseLogbook,
  planLogbookImport,
  sequenceImport,
  type LogbookFormat,
  type PlannedRow,
} from "../domain/flightLogImport";
import { AsyncForm, Badge, Field, errorText, value } from "./ui";
import { Dialog } from "./design";

const OPERATIONS: FlightInput["operation"][] = [
  "Private",
  "Mission",
  "Mission medical",
  "Gov medical",
  "Commercial",
];
const PAGE_SIZE = 200;
const BYTES_PER_MEGABYTE = 1024 * 1024;

interface Preview {
  fileName: string;
  format: LogbookFormat;
  rows: PlannedRow[];
  otherAircraft: number;
}
type ImportResult = { saved: number; errors: string[] };
type Draft = ReturnType<typeof usePreviewDraft>;
type PreviewRowProps = { row: PlannedRow; draft: Draft; registration: string };

/**
 * The Import logbook button and its dialog: preview a ForeFlight or Garmin
 * Pilot CSV, choose rows, and queue them as flights by the signed-in pilot.
 * Rows with an error or a possible duplicate start unselected.
 *
 * @returns Nothing unless the user may log a flight on some aircraft.
 */
export function FlightLogImportButton() {
  const { snapshot: s } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (!s!.aircraft.some((a) => can(s!, a.uuid, "flight"))) return null;
  return (
    <>
      <button type="button" className="button" onClick={() => setOpen(true)}>
        <UploadSimple size={18} aria-hidden="true" /> Import logbook
      </button>
      {open && (
        <Dialog
          size="wide"
          className="rec-dialog"
          title="Import logbook flights"
          dismissOnScrim={false}
          onClose={() => setOpen(false)}
        >
          <FlightLogImportForm />
        </Dialog>
      )}
    </>
  );
}

function FlightLogImportForm() {
  const { snapshot: s, queue, enqueue } = useWorkspace();
  const draft = usePreviewDraft(s!);
  const [result, setResult] = useState<ImportResult>();
  const reset = () => {
    draft.show(undefined);
    setResult(undefined);
  };
  const importSelected = async () => {
    setResult(await enqueueFlights(draft.sequence, s!.user.id, enqueue));
    draft.show(undefined);
  };
  return (
    <>
      <ImportHelp />
      <AsyncForm
        submitLabel="Preview flights"
        onChange={reset}
        onSubmit={async (data) => {
          reset();
          draft.show(await planLogbookFile(data, s!, queue));
        }}
      >
        <ImportOptions />
      </AsyncForm>
      {result && <ImportOutcome result={result} />}
      {draft.preview && (
        <ImportPreview
          draft={draft}
          preview={draft.preview}
          onImport={importSelected}
        />
      )}
    </>
  );
}

function usePreviewDraft(s: Snapshot) {
  const [preview, setPreview] = useState<Preview>();
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [limit, setLimit] = useState(PAGE_SIZE);
  const sequence = preview
    ? sequenceImport(
        s,
        preview.rows.filter((r) => selected.has(r.row)),
      )
    : [];
  const show = (next?: Preview) => {
    setPreview(next);
    if (!next) return;
    setSelected(new Set(importableRows(next.rows)));
    setLimit(PAGE_SIZE);
  };
  const toggle = (row: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(row)) next.add(row);
      return next;
    });
  const showMore = () => setLimit((n) => n + PAGE_SIZE);
  const review = new Map(sequence.map((e) => [e.row.row, e.reviewReason]));
  return { preview, selected, limit, sequence, review, show, toggle, showMore };
}

function importableRows(rows: PlannedRow[]) {
  return rows.filter((r) => !r.error && !r.duplicate).map((r) => r.row);
}

async function planLogbookFile(
  data: FormData,
  s: Snapshot,
  queue: QueuedOperation[],
): Promise<Preview> {
  const file = data.get("logbook");
  if (
    !(file instanceof File) ||
    !file.size ||
    file.size > LOGBOOK_MAX_MEGABYTES * BYTES_PER_MEGABYTE
  )
    throw new Error(`Choose a logbook CSV up to ${LOGBOOK_MAX_MEGABYTES} MB.`);
  const parsed = parseLogbook(
    new TextDecoder().decode(await file.arrayBuffer()),
  );
  const pending = queue.flatMap((q) =>
    q.operation.kind === "flight" ? [q.operation.input] : [],
  );
  const plan = planLogbookImport(
    s,
    parsed.rows,
    {
      pilotId: s.user.id,
      operation: value(data, "operation") as FlightInput["operation"],
      flightRules: value(data, "rules") as FlightInput["flightRules"],
    },
    pending,
    parsed.format,
  );
  return { fileName: file.name, format: parsed.format, ...plan };
}

// The outbox orders by enqueue time, so each entry waits for a new
// millisecond: the server then sees the flights in chronological order.
async function enqueueFlights(
  sequence: Draft["sequence"],
  authorId: string,
  enqueue: (operation: Operation) => Promise<void>,
): Promise<ImportResult> {
  const errors: string[] = [];
  let saved = 0;
  let lastQueuedAt = 0;
  for (const entry of sequence) {
    while (Date.now() === lastQueuedAt)
      await new Promise((r) => setTimeout(r, 1));
    lastQueuedAt = Date.now();
    try {
      await enqueue({
        kind: "flight",
        uuid: crypto.randomUUID(),
        authorId,
        baseVersion: entry.baseVersion,
        input: entry.input,
      });
      saved++;
    } catch (e) {
      errors.push(`Row ${entry.row.row}: ${errorText(e, "Not saved.")}`);
    }
  }
  return { saved, errors };
}

function ImportHelp() {
  return (
    <p className="muted">
      Export your logbook as CSV from ForeFlight (Logbook › Export) or Garmin
      Pilot. Rows are matched to aircraft by registration and validated like a
      manually logged flight. Logbooks rarely record Hobbs or tach; rows without
      this aircraft&apos;s required meter reading cannot be imported.
    </p>
  );
}

function ImportOptions() {
  return (
    <div className="form-grid">
      <Field label="Logbook CSV">
        <input name="logbook" type="file" accept=".csv,text/csv" required />
      </Field>
      <Field label="Operation for imported flights">
        <select name="operation" defaultValue="Private">
          {OPERATIONS.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </Field>
      <Field label="Flight rules">
        <select name="rules" defaultValue="VFR">
          <option>VFR</option>
          <option>IFR</option>
        </select>
      </Field>
    </div>
  );
}

function ImportOutcome({ result }: { result: ImportResult }) {
  return (
    <div role="status">
      <p>
        {result.saved} flight{result.saved === 1 ? "" : "s"} saved on this
        device and queued for sync.
      </p>
      {result.errors.map((e) => (
        <p key={e} className="error">
          {e}
        </p>
      ))}
    </div>
  );
}

function ImportPreview({
  draft,
  preview,
  onImport,
}: {
  draft: Draft;
  preview: Preview;
  onImport: () => Promise<void>;
}) {
  const { selected, limit } = draft;
  return (
    <AsyncForm
      submitLabel={`Import ${selected.size} selected flight${selected.size === 1 ? "" : "s"}`}
      disabled={!selected.size}
      onSubmit={onImport}
    >
      <PreviewSummary
        preview={preview}
        held={[...draft.review.values()].filter(Boolean).length}
      />
      <PreviewTable draft={draft} rows={preview.rows.slice(0, limit)} />
      {limit < preview.rows.length && (
        <button type="button" className="button" onClick={draft.showMore}>
          Show more rows
        </button>
      )}
    </AsyncForm>
  );
}

function PreviewSummary({ preview, held }: { preview: Preview; held: number }) {
  const errors = preview.rows.filter((r) => r.error).length;
  const duplicates = preview.rows.filter((r) => r.duplicate).length;
  return (
    <p role="status">
      <strong>{preview.fileName}</strong> ({logbookFormatLabels[preview.format]}
      ): {preview.rows.length} rows for aircraft in this Flight Program,{" "}
      {errors} with errors, {duplicates} possible duplicates.{" "}
      {preview.otherAircraft} rows for other aircraft were skipped.
      {held > 0 &&
        ` ${held} selected flights predate existing records or readings and will be held for administrator review.`}
    </p>
  );
}

function PreviewTable({ draft, rows }: { draft: Draft; rows: PlannedRow[] }) {
  const { snapshot: s } = useWorkspace();
  const registration = (uuid: string) =>
    s!.aircraft.find((a) => a.uuid === uuid)?.registration ?? "";
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Logbook rows to import</caption>
        <thead>
          <tr>
            <th scope="col">Import</th>
            <th scope="col">Row</th>
            <th scope="col">Aircraft / date</th>
            <th scope="col">Route</th>
            <th scope="col">Total</th>
            <th scope="col">Landings</th>
            <th scope="col">Hobbs / tach end</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <PreviewRow
              key={r.row}
              row={r}
              draft={draft}
              registration={registration(r.aircraftUuid)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PreviewRow({ row: r, draft, registration }: PreviewRowProps) {
  const selected = draft.selected.has(r.row);
  return (
    <tr>
      <td>
        <input
          type="checkbox"
          aria-label={`Import row ${r.row}`}
          disabled={!!r.error}
          checked={selected}
          onChange={() => draft.toggle(r.row)}
        />
      </td>
      <td>{r.row}</td>
      <td>
        <strong>{registration}</strong>
        <small className="block">{r.date}</small>
      </td>
      <td>
        {r.from || "—"} → {r.to || "—"}
      </td>
      <td>
        {r.totalSeconds === undefined ? "—" : `${hours(r.totalSeconds)} h`}
      </td>
      <td>{r.landings}</td>
      <td>
        {r.hobbsEnd === undefined ? "—" : hours(r.hobbsEnd)} /{" "}
        {r.tachEnd === undefined ? "—" : hours(r.tachEnd)}
      </td>
      <td>
        <RowStatus
          row={r}
          selected={selected}
          review={draft.review.get(r.row)}
        />
      </td>
    </tr>
  );
}

function RowStatus({
  row,
  selected,
  review,
}: {
  row: PlannedRow;
  selected: boolean;
  review?: string;
}) {
  if (row.error)
    return (
      <span className="import-row-error">
        Row {row.row}: {row.error}
      </span>
    );
  if (row.duplicate) return <Badge tone="warning">Possible duplicate</Badge>;
  if (review)
    return (
      <>
        <Badge tone="warning">Held for review</Badge> {review}
      </>
    );
  if (selected) return <Badge tone="good">Ready</Badge>;
  return "Not selected";
}
