import "./engineTrends.css";
import { useState } from "react";
import { UploadSimple } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { can, hours, type FlightInput } from "../domain/model";
import {
  LOGBOOK_MAX_MEGABYTES,
  logbookFormatLabels,
  parseLogbook,
  planLogbookImport,
  sequenceImport,
  type LogbookFormat,
  type PlannedRow,
} from "../domain/flightLogImport";
import { AsyncForm, Badge, Field, value } from "./ui";
import { Dialog } from "./design";

const operations: FlightInput["operation"][] = [
  "Private",
  "Mission",
  "Mission medical",
  "Gov medical",
  "Commercial",
];
const PAGE_SIZE = 200;
interface Preview {
  fileName: string;
  format: LogbookFormat;
  rows: PlannedRow[];
  otherAircraft: number;
}

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
  const [preview, setPreview] = useState<Preview>();
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [result, setResult] = useState<{ saved: number; errors: string[] }>();
  const sequence = preview
    ? sequenceImport(
        s!,
        preview.rows.filter((r) => selected.has(r.row)),
      )
    : [];
  const review = new Map(sequence.map((e) => [e.row.row, e.reviewReason]));
  const toggle = (row: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(row)) next.add(row);
      return next;
    });
  return (
    <>
      <p className="muted">
        Export your logbook as CSV from ForeFlight (Logbook › Export) or Garmin
        Pilot. Rows are matched to aircraft by registration and validated like a
        manually logged flight. Logbooks rarely record Hobbs or tach; rows
        without this aircraft&apos;s required meter reading cannot be imported.
      </p>
      <AsyncForm
        submitLabel="Preview flights"
        onChange={() => {
          setPreview(undefined);
          setResult(undefined);
        }}
        onSubmit={async (d) => {
          setPreview(undefined);
          setResult(undefined);
          const file = d.get("logbook");
          if (
            !(file instanceof File) ||
            !file.size ||
            file.size > LOGBOOK_MAX_MEGABYTES * 1024 * 1024
          )
            throw new Error(
              `Choose a logbook CSV up to ${LOGBOOK_MAX_MEGABYTES} MB.`,
            );
          const parsed = parseLogbook(
            new TextDecoder().decode(await file.arrayBuffer()),
          );
          const pending = queue.flatMap((q) =>
            q.operation.kind === "flight" ? [q.operation.input] : [],
          );
          const plan = planLogbookImport(
            s!,
            parsed.rows,
            {
              pilotId: s!.user.id,
              operation: value(d, "operation") as FlightInput["operation"],
              flightRules: value(d, "rules") as FlightInput["flightRules"],
            },
            pending,
            parsed.format,
          );
          setPreview({ fileName: file.name, format: parsed.format, ...plan });
          setSelected(
            new Set(
              plan.rows
                .filter((r) => !r.error && !r.duplicate)
                .map((r) => r.row),
            ),
          );
          setLimit(PAGE_SIZE);
        }}
      >
        <div className="form-grid">
          <Field label="Logbook CSV">
            <input name="logbook" type="file" accept=".csv,text/csv" required />
          </Field>
          <Field label="Operation for imported flights">
            <select name="operation" defaultValue="Private">
              {operations.map((o) => (
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
      </AsyncForm>
      {result && (
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
      )}
      {preview && (
        <ImportPreview
          preview={preview}
          selected={selected}
          review={review}
          limit={limit}
          onToggle={toggle}
          onMore={() => setLimit((n) => n + PAGE_SIZE)}
          onImport={async () => {
            const errors: string[] = [];
            let saved = 0,
              lastQueuedAt = 0;
            for (const entry of sequence) {
              // The outbox orders by enqueue time; keep each entry distinct so
              // the server sees the flights in chronological order.
              while (Date.now() === lastQueuedAt)
                await new Promise((r) => setTimeout(r, 1));
              lastQueuedAt = Date.now();
              try {
                await enqueue({
                  kind: "flight",
                  uuid: crypto.randomUUID(),
                  authorId: s!.user.id,
                  baseVersion: entry.baseVersion,
                  input: entry.input,
                });
                saved++;
              } catch (e) {
                errors.push(
                  `Row ${entry.row.row}: ${e instanceof Error ? e.message : "Not saved."}`,
                );
              }
            }
            setResult({ saved, errors });
            setPreview(undefined);
          }}
        />
      )}
    </>
  );
}

function ImportPreview({
  preview,
  selected,
  review,
  limit,
  onToggle,
  onMore,
  onImport,
}: {
  preview: Preview;
  selected: ReadonlySet<number>;
  review: Map<number, string | undefined>;
  limit: number;
  onToggle: (row: number) => void;
  onMore: () => void;
  onImport: () => Promise<void>;
}) {
  const { snapshot: s } = useWorkspace();
  const registration = (uuid: string) =>
    s!.aircraft.find((a) => a.uuid === uuid)?.registration ?? "";
  const errors = preview.rows.filter((r) => r.error).length;
  const duplicates = preview.rows.filter((r) => r.duplicate).length;
  const held = [...review.values()].filter(Boolean).length;
  return (
    <AsyncForm
      submitLabel={`Import ${selected.size} selected flight${selected.size === 1 ? "" : "s"}`}
      disabled={!selected.size}
      onSubmit={onImport}
    >
      <p role="status">
        <strong>{preview.fileName}</strong> (
        {logbookFormatLabels[preview.format]}
        ): {preview.rows.length} rows for aircraft in this Flight Program,{" "}
        {errors} with errors, {duplicates} possible duplicates.{" "}
        {preview.otherAircraft} rows for other aircraft were skipped.
        {held > 0 &&
          ` ${held} selected flights predate existing records or readings and will be held for administrator review.`}
      </p>
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
            {preview.rows.slice(0, limit).map((r) => (
              <tr key={r.row}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Import row ${r.row}`}
                    disabled={!!r.error}
                    checked={selected.has(r.row)}
                    onChange={() => onToggle(r.row)}
                  />
                </td>
                <td>{r.row}</td>
                <td>
                  <strong>{registration(r.aircraftUuid)}</strong>
                  <small className="block">{r.date}</small>
                </td>
                <td>
                  {r.from || "—"} → {r.to || "—"}
                </td>
                <td>
                  {r.totalSeconds === undefined
                    ? "—"
                    : `${hours(r.totalSeconds)} h`}
                </td>
                <td>{r.landings}</td>
                <td>
                  {r.hobbsEnd === undefined ? "—" : hours(r.hobbsEnd)} /{" "}
                  {r.tachEnd === undefined ? "—" : hours(r.tachEnd)}
                </td>
                <td>
                  {r.error ? (
                    <span className="import-row-error">
                      Row {r.row}: {r.error}
                    </span>
                  ) : r.duplicate ? (
                    <Badge tone="warning">Possible duplicate</Badge>
                  ) : review.get(r.row) ? (
                    <>
                      <Badge tone="warning">Held for review</Badge>{" "}
                      {review.get(r.row)}
                    </>
                  ) : selected.has(r.row) ? (
                    <Badge tone="good">Ready</Badge>
                  ) : (
                    "Not selected"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {limit < preview.rows.length && (
        <button type="button" className="button" onClick={onMore}>
          Show more rows
        </button>
      )}
    </AsyncForm>
  );
}
