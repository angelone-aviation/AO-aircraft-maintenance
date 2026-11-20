/**
 * Responsibility: Reference manuals: links and reference fields on records,
 *   an aircraft's manuals, the reference library and the manual viewer.
 * Layer: UI. React components; manual files come through the workspace
 *   backend or a copy kept on this device.
 * Dependencies: react, react-dom, @tanstack/react-router,
 *   @phosphor-icons/react, src/data/store.ts, src/data/deviceManuals.ts,
 *   src/data/manualPdf.ts (lazy), src/domain (model, manuals), ./PdfReader,
 *   ./MaintenanceCsvImport, ./ManualDiscovery, ./KeepOnDevice, ./ui,
 *   ./design, ./ShopList, ./manuals.css.
 */
import { PdfReader } from "./PdfReader";
import { MaintenanceCsvImportButton } from "./MaintenanceCsvImport";
import { ManualDiscoveryButton } from "./ManualDiscovery";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import { can, type Aircraft, type Snapshot } from "../domain/model";
import type { Manual, ManualReference } from "../domain/manuals";
import { MAX_MANUAL_BYTES, manualInputSchema } from "../domain/manuals";
import { AsyncForm, Field, Modal, errorText, value } from "./ui";
import {
  EmptyState,
  NoticeBar,
  PageHeader,
  SearchField,
  Toolbar,
} from "./design";
import { ShopLead, ShopTableCard } from "./ShopList";
import {
  DeviceCopyNotice,
  KeepManualButton,
  KeepManualError,
  KeepManualPanel,
  KeepManualStatus,
  KeptManualsSummary,
  openManualFile,
  useKeptManualsRefresh,
} from "./KeepOnDevice";
import { keptManualsSupported } from "../data/deviceManuals";
import {
  ArrowSquareOut,
  BookOpen,
  DownloadSimple,
  FilePdf,
  Info,
  UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import "./manuals.css";

// The lengths manualInputSchema, manualReferenceSchema and
// manualApplicabilitySchema allow.
const MAX_LENGTH = {
  title: 300,
  documentNumber: 200,
  revision: 300,
  section: 200,
  printedPage: 100,
  manufacturer: 150,
  model: 150,
  partNumber: 100,
};
const BYTES_PER_MEGABYTE = 1024 * 1024;

type ManualFile = ReturnType<typeof useManualFile>;
type ReferenceProps = {
  reference: ManualReference;
  onChange: (reference: ManualReference) => void;
};
type RowProps = {
  s: Snapshot;
  manual: Manual;
  keeping: boolean;
  writable: boolean;
  onEdit: (manual: Manual) => void;
};

/**
 * A record's manual reference: title, revision, section, printed page and PDF
 * page, opening the page in a window. Says so when the manual is not in this
 * workspace; renders nothing without a reference.
 */
export function ManualLink({
  reference,
}: {
  reference?: ManualReference | null;
}) {
  const manuals = useWorkspace((s) => s.snapshot?.manuals);
  const [preview, setPreview] = useState(false);
  if (!reference) return null;
  const m = manuals?.find((m) => m.uuid === reference.manualUuid);
  if (!m)
    return (
      <span className="muted">
        Referenced manual is unavailable in this workspace.
      </span>
    );
  return (
    <>
      <Link
        to="/manuals/$manualUuid"
        params={{ manualUuid: m.uuid }}
        search={{ page: reference.pdfPage }}
        onClick={(e) => {
          e.preventDefault();
          setPreview(true);
        }}
      >
        {referenceLabel(m, reference)}
      </Link>
      {preview &&
        createPortal(
          <Modal title="Manual reference" onClose={() => setPreview(false)}>
            <ManualViewer uuid={m.uuid} page={reference.pdfPage} />
          </Modal>,
          document.body,
        )}
    </>
  );
}

/**
 * Form fields linking a record to a page of a library manual. A reference
 * stays shown when its manual is no longer available; choosing another manual
 * starts at PDF page 1.
 *
 * @param props.onChange - Receives each edit, or null while no manual is
 *   chosen. The fields also post their values for
 *   {@link manualReferenceFromForm}.
 */
export function ManualReferenceFields({
  initial,
  onChange,
}: {
  initial?: ManualReference | null;
  onChange?: (ref: ManualReference | null) => void;
}) {
  const manuals = useWorkspace((s) => s.snapshot?.manuals) ?? [];
  const [ref, setRef] = useState<ManualReference>(
    initial ?? { manualUuid: "", section: "", printedPage: "", pdfPage: 1 },
  );
  const update = (next: ManualReference) => {
    setRef(next);
    onChange?.(next.manualUuid ? next : null);
  };
  const selected = manuals.find((m) => m.uuid === ref.manualUuid);
  return (
    <div className="form-grid">
      <ManualChoice
        manuals={manuals}
        known={!!selected}
        reference={ref}
        onChange={update}
      />
      <PageFields
        reference={ref}
        pageCount={selected?.pageCount}
        onChange={update}
      />
      {ref.manualUuid && <ManualLink reference={ref} />}
    </div>
  );
}

/**
 * Reads the reference {@link ManualReferenceFields} posted.
 *
 * @returns The trimmed reference, or null when no manual was chosen.
 */
export function manualReferenceFromForm(
  data: FormData,
): ManualReference | null {
  const manualUuid = value(data, "manualUuid");
  return manualUuid
    ? {
        manualUuid,
        section: value(data, "manualSection"),
        printedPage: value(data, "manualPrintedPage"),
        pdfPage: Number(value(data, "manualPdfPage")),
      }
    : null;
}

/** An aircraft's Manuals button, opening its {@link ReferenceLibrary}. */
export function AircraftManuals({ aircraftUuid }: { aircraftUuid: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="button" onClick={() => setOpen(true)}>
        Manuals
      </button>
      {open && (
        <Modal
          title="Aircraft reference manuals"
          onClose={() => setOpen(false)}
        >
          <ReferenceLibrary aircraftUuid={aircraftUuid} />
        </Modal>
      )}
    </>
  );
}

/**
 * The reference library page, or with `aircraftUuid` one aircraft's manuals:
 * search, open, keep on this device, and (connected, with maintenance
 * access) upload a manual or edit its reference. Each upload is a separate
 * manual, so references to earlier revisions keep working.
 */
export function ReferenceLibrary({ aircraftUuid }: { aircraftUuid?: string }) {
  const { snapshot: s, online, connected, demo } = useWorkspace();
  const [upload, setUpload] = useState(false);
  const [renaming, setRenaming] = useState<Manual | null>(null);
  const [search, setSearch] = useState("");
  useKeptManualsRefresh();
  const keeping = keptManualsSupported();
  const writable = online && connected;
  const aircraft = maintainedAircraft(s!, aircraftUuid);
  const manuals = libraryManuals(s!, aircraftUuid, search);
  const canUpload = writable && !!aircraft.length;
  return (
    <>
      <LibraryHeader
        aircraftUuid={aircraftUuid}
        upload={{ disabled: !canUpload, onClick: () => setUpload(true) }}
        search={search}
        onSearch={setSearch}
      />
      <LibraryNotices demo={demo} kept={keeping && !!s!.manuals?.length} />
      <ManualTable
        rows={{ s: s!, keeping, writable, onEdit: setRenaming }}
        manuals={manuals}
      />
      {renaming && (
        <EditReference manual={renaming} onClose={() => setRenaming(null)} />
      )}
      {upload && (
        <UploadManual
          aircraftUuid={aircraftUuid}
          aircraft={aircraft}
          onDone={() => setUpload(false)}
        />
      )}
    </>
  );
}

/**
 * A manual opened at a page, with links to open or download the PDF. A copy
 * kept on this device opens first; if it fails to load, the online file
 * opens instead.
 */
export function ManualViewer({ uuid, page }: { uuid: string; page: number }) {
  const { snapshot } = useWorkspace();
  const manual = snapshot?.manuals?.find((m) => m.uuid === uuid);
  const file = useManualFile(uuid, manual);
  if (!manual)
    return (
      <EmptyState title="Manual unavailable">
        Manual is unavailable in the active Flight Program.
      </EmptyState>
    );
  if (page > manual.pageCount)
    return (
      <EmptyState title="Page out of range">
        This manual has {manual.pageCount} pages. The reference page is out of
        range.
      </EmptyState>
    );
  return (
    <>
      <ViewerHeader manual={manual} page={page} />
      <KeepManualPanel manual={manual} fromDevice={file.fromDevice} />
      {file.deviceFailed && <DeviceCopyNotice />}
      {file.error && (
        <NoticeBar tone="danger" icon={WarningCircle} role="alert">
          {file.error}
        </NoticeBar>
      )}
      {!file.url && !file.error && (
        <p role="status" className="muted">
          Opening manual…
        </p>
      )}
      {file.url && <ManualPdf manual={manual} page={page} file={file} />}
    </>
  );
}

function referenceLabel(m: Manual, r: ManualReference) {
  const section = r.section ? ` · § ${r.section}` : "";
  const printed = r.printedPage ? ` · printed page ${r.printedPage}` : "";
  return `${m.title} · ${m.revision}${section}${printed} · PDF page ${r.pdfPage}`;
}

// An unavailable manual stays listed so the stored reference is kept.
function ManualChoice({
  manuals,
  known,
  reference: ref,
  onChange,
}: ReferenceProps & { manuals: Manual[]; known: boolean }) {
  return (
    <Field label="Reference library manual">
      <select
        name="manualUuid"
        value={ref.manualUuid}
        onChange={(e) =>
          onChange({ ...ref, manualUuid: e.target.value, pdfPage: 1 })
        }
      >
        <option value="">No linked manual</option>
        {ref.manualUuid && !known && (
          <option value={ref.manualUuid}>
            Previously linked manual (unavailable)
          </option>
        )}
        {manuals.map((m) => (
          <option key={m.uuid} value={m.uuid}>
            {m.title} · {m.revision}
          </option>
        ))}
      </select>
    </Field>
  );
}

function PageFields({
  reference: ref,
  pageCount,
  onChange,
}: ReferenceProps & { pageCount?: number }) {
  return (
    <>
      <Field label="Manual section">
        <input
          name="manualSection"
          maxLength={MAX_LENGTH.section}
          value={ref.section}
          onChange={(e) => onChange({ ...ref, section: e.target.value })}
          placeholder="5-12-02"
        />
      </Field>
      <Field label="Printed page label">
        <input
          name="manualPrintedPage"
          maxLength={MAX_LENGTH.printedPage}
          value={ref.printedPage}
          onChange={(e) => onChange({ ...ref, printedPage: e.target.value })}
          placeholder="1"
        />
      </Field>
      <PdfPageField reference={ref} pageCount={pageCount} onChange={onChange} />
    </>
  );
}

function PdfPageField({
  reference: ref,
  pageCount,
  onChange,
}: ReferenceProps & { pageCount?: number }) {
  return (
    <Field label="PDF page number">
      <input
        name="manualPdfPage"
        type="number"
        min={1}
        max={pageCount}
        required={!!ref.manualUuid}
        value={ref.pdfPage || ""}
        onChange={(e) => onChange({ ...ref, pdfPage: Number(e.target.value) })}
      />
    </Field>
  );
}

function maintainedAircraft(s: Snapshot, aircraftUuid?: string) {
  return s.aircraft.filter(
    (a) =>
      can(s, a.uuid, "maintenance") &&
      (!aircraftUuid || a.uuid === aircraftUuid),
  );
}

function libraryManuals(
  s: Snapshot,
  aircraftUuid: string | undefined,
  search: string,
) {
  return (s.manuals ?? []).filter(
    (m) =>
      (!aircraftUuid || m.aircraftUuid === aircraftUuid) &&
      `${m.title} ${m.documentNumber} ${m.revision} ${m.filename}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
}

function UploadButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="button primary"
      disabled={disabled}
      onClick={onClick}
    >
      <UploadSimple size={18} weight="bold" aria-hidden="true" />
      Upload manual
    </button>
  );
}

// The library page carries the upload button in its header; an aircraft's
// window, in the toolbar.
function LibraryHeader({
  aircraftUuid,
  upload,
  search,
  onSearch,
}: {
  aircraftUuid?: string;
  upload: { disabled: boolean; onClick: () => void };
  search: string;
  onSearch: (search: string) => void;
}) {
  const uploadButton = <UploadButton {...upload} />;
  return (
    <>
      {!aircraftUuid && (
        <PageHeader
          eyebrow="REFERENCE"
          title="Reference library"
          description="Saved PDF manuals and revisions your team relies on, linked to maintenance records by aircraft."
          actions={uploadButton}
        />
      )}
      <Toolbar
        className="shop-toolbar"
        end={aircraftUuid ? uploadButton : undefined}
      >
        <SearchField
          label="Search manuals"
          placeholder="Title, document number, revision"
          value={search}
          onChange={onSearch}
        />
      </Toolbar>
    </>
  );
}

function LibraryNotices({ demo, kept }: { demo: boolean; kept: boolean }) {
  return (
    <>
      {demo && (
        <NoticeBar tone="neutral" icon={Info}>
          Demo manuals are saved in this browser, so they open offline without
          keeping them. Connected workspaces store manuals in the shared
          reference library; Keep on this device works the same way here.
        </NoticeBar>
      )}
      {kept && <KeptManualsSummary />}
    </>
  );
}

function ManualTable({
  rows,
  manuals,
}: {
  rows: Omit<RowProps, "manual">;
  manuals: Manual[];
}) {
  if (!manuals.length)
    return (
      <EmptyState title="No manuals found">
        Upload an aircraft manual to keep it available for maintenance
        references.
      </EmptyState>
    );
  return (
    <ShopTableCard
      label="Reference manuals"
      className="shop-list-look shop-manuals"
      stack
    >
      <table className="shop-table">
        <thead>
          <tr>
            <th>Manual / revision</th>
            <th>Aircraft / PDF</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {manuals.map((m) => (
            <ManualRow key={m.uuid} {...rows} manual={m} />
          ))}
        </tbody>
      </table>
    </ShopTableCard>
  );
}

function ManualRow(props: RowProps) {
  const { s, manual: m, keeping } = props;
  const megabytes = (m.size / BYTES_PER_MEGABYTE).toFixed(1);
  return (
    <tr>
      <td className="shop-lead-cell shop-wide">
        <ShopLead
          icon={BookOpen}
          title={m.title}
          sub={[m.documentNumber, m.revision, m.revisionDate]
            .filter(Boolean)
            .join(" · ")}
        />
      </td>
      <td className="shop-nowrap" data-label="Aircraft / PDF">
        <strong className="ds-list-meta">
          {s.aircraft.find((a) => a.uuid === m.aircraftUuid)?.registration}
        </strong>
        <small className="shop-icon-text">
          <FilePdf size={16} aria-hidden="true" />
          {`${m.pageCount.toLocaleString()} pages · ${megabytes} MB`}
        </small>
        {keeping && <KeepManualStatus manual={m} />}
      </td>
      <td className="shop-actions-cell">
        <ManualActions {...props} />
        {keeping && <KeepManualError manual={m} />}
      </td>
    </tr>
  );
}

function ManualActions({ s, manual: m, keeping, writable, onEdit }: RowProps) {
  return (
    <span className="manual-actions">
      <Link
        className="button small primary"
        to="/manuals/$manualUuid"
        params={{ manualUuid: m.uuid }}
        search={{ page: 1 }}
      >
        Open manual
      </Link>
      {keeping && <KeepManualButton manual={m} />}
      {can(s, m.aircraftUuid, "maintenance") && (
        <button
          className="button small"
          disabled={!writable}
          onClick={() => onEdit(m)}
        >
          Edit reference
        </button>
      )}
      <ManualDiscoveryButton manual={m} />
      <MaintenanceCsvImportButton manual={m} />
    </span>
  );
}

// The PDF stays; replacing it means uploading a new manual revision.
function EditReference({
  manual,
  onClose,
}: {
  manual: Manual;
  onClose: () => void;
}) {
  const { backend, online, connected } = useWorkspace();
  return (
    <Modal title="Edit manual reference" onClose={onClose}>
      <AsyncForm
        submitLabel="Save reference"
        disabled={!online || !connected}
        onSubmit={async (d) => {
          await backend!.editManual(manual.uuid, editInput(d));
          onClose();
        }}
      >
        <EditDocumentFields manual={manual} />
        <EditAircraftField manual={manual} />
        <ApplicabilityFields manual={manual} />
        <p className="muted">
          PDF: {manual.filename} · {manual.pageCount.toLocaleString()} pages. To
          replace the PDF, upload a new manual revision.
        </p>
      </AsyncForm>
    </Modal>
  );
}

// No applicability type clears the applicability.
function editInput(d: FormData) {
  const kind = value(d, "kind");
  return {
    title: value(d, "title"),
    documentNumber: value(d, "documentNumber"),
    revision: value(d, "revision"),
    revisionDate: value(d, "revisionDate"),
    aircraftUuid: value(d, "aircraft"),
    applicability: kind
      ? {
          kind: kind as "aircraft" | "component",
          manufacturer: value(d, "manufacturer"),
          model: value(d, "model"),
          partNumber: value(d, "partNumber"),
        }
      : undefined,
  };
}

function EditDocumentFields({ manual }: { manual: Manual }) {
  return (
    <>
      <Field label="Manual name">
        <input
          name="title"
          defaultValue={manual.title}
          required
          maxLength={MAX_LENGTH.title}
          autoFocus
        />
      </Field>
      <Field label="Document number">
        <input
          name="documentNumber"
          defaultValue={manual.documentNumber}
          maxLength={MAX_LENGTH.documentNumber}
        />
      </Field>
      <Field label="Revision / temporary revisions">
        <input
          name="revision"
          defaultValue={manual.revision}
          required
          maxLength={MAX_LENGTH.revision}
        />
      </Field>
      <Field label="Revision date">
        <input
          type="date"
          name="revisionDate"
          defaultValue={manual.revisionDate}
        />
      </Field>
    </>
  );
}

// A manual moves only between maintained aircraft of its own program.
function EditAircraftField({ manual }: { manual: Manual }) {
  const { snapshot: s } = useWorkspace();
  const program = s!.aircraft.find(
    (a) => a.uuid === manual.aircraftUuid,
  )?.programUuid;
  const choices = s!.aircraft.filter(
    (a) => can(s!, a.uuid, "maintenance") && a.programUuid === program,
  );
  return (
    <Field label="Aircraft">
      <select name="aircraft" defaultValue={manual.aircraftUuid} required>
        {choices.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ApplicabilityFields({ manual }: { manual: Manual }) {
  const applicability = manual.applicability;
  return (
    <>
      <Field label="Applicability type">
        <select name="kind" defaultValue={applicability?.kind ?? ""}>
          <option value="">Not specified</option>
          <option value="aircraft">Aircraft</option>
          <option value="component">Component</option>
        </select>
      </Field>
      <Field label="Manufacturer">
        <input
          name="manufacturer"
          defaultValue={applicability?.manufacturer ?? ""}
          maxLength={MAX_LENGTH.manufacturer}
        />
      </Field>
      <Field label="Model">
        <input
          name="model"
          defaultValue={applicability?.model ?? ""}
          maxLength={MAX_LENGTH.model}
        />
      </Field>
      <Field label="Part number">
        <input
          name="partNumber"
          defaultValue={applicability?.partNumber ?? ""}
          maxLength={MAX_LENGTH.partNumber}
        />
      </Field>
    </>
  );
}

// The window cannot close while a file is being read or uploaded.
function UploadManual({
  aircraftUuid,
  aircraft,
  onDone,
}: {
  aircraftUuid?: string;
  aircraft: Aircraft[];
  onDone: () => void;
}) {
  const { snapshot: s, backend } = useWorkspace();
  const [progress, setProgress] = useState("");
  async function save(d: FormData) {
    const file = d.get("pdf");
    if (!(file instanceof File) || !file.size)
      throw new Error("Choose a PDF manual.");
    try {
      setProgress("Reading PDF…");
      const target = aircraftUuid || value(d, "aircraft");
      const input = await readManualInput(s!, target, d, file);
      setProgress("Uploading manual…");
      await backend!.uploadManual(input, file);
      onDone();
    } finally {
      setProgress("");
    }
  }
  return (
    <Modal
      title="Upload reference manual"
      onClose={() => {
        if (!progress) onDone();
      }}
    >
      <AsyncForm submitLabel={progress || "Save manual"} onSubmit={save}>
        <UploadFields aircraftUuid={aircraftUuid} aircraft={aircraft} />
        {progress && <p role="status">{progress}</p>}
      </AsyncForm>
    </Modal>
  );
}

// The PDF is counted in the browser; a manual for an aircraft with a model
// applies to that make and model.
async function readManualInput(
  s: Snapshot,
  aircraftUuid: string,
  d: FormData,
  file: File,
) {
  const { inspectManualPdf } = await import("../data/manualPdf");
  const pageCount = await inspectManualPdf(file);
  const owner = s.aircraft.find((a) => a.uuid === aircraftUuid);
  return manualInputSchema.parse({
    applicability: owner?.model
      ? {
          kind: "aircraft",
          manufacturer: owner.make,
          model: owner.model,
          partNumber: "",
        }
      : undefined,
    aircraftUuid,
    title: value(d, "title"),
    documentNumber: value(d, "documentNumber"),
    revision: value(d, "revision"),
    revisionDate: value(d, "revisionDate"),
    filename: file.name,
    size: file.size,
    pageCount,
  });
}

function UploadFields({
  aircraftUuid,
  aircraft,
}: {
  aircraftUuid?: string;
  aircraft: Aircraft[];
}) {
  return (
    <>
      <p>
        PDF up to {MAX_MANUAL_BYTES / BYTES_PER_MEGABYTE} MB. Each upload is
        saved separately to preserve references to earlier revisions.
      </p>
      {!aircraftUuid && (
        <Field label="Aircraft">
          <select name="aircraft" required>
            {aircraft.map((a) => (
              <option key={a.uuid} value={a.uuid}>
                {a.registration}
              </option>
            ))}
          </select>
        </Field>
      )}
      <UploadDocumentFields />
      <Field label="PDF manual">
        <input type="file" name="pdf" accept="application/pdf,.pdf" required />
      </Field>
    </>
  );
}

function UploadDocumentFields() {
  return (
    <>
      <Field label="Manual title">
        <input
          name="title"
          required
          maxLength={MAX_LENGTH.title}
          placeholder="Cessna 441 Maintenance Manual"
        />
      </Field>
      <Field label="Document number">
        <input
          name="documentNumber"
          maxLength={MAX_LENGTH.documentNumber}
          placeholder="D2518-15-13"
        />
      </Field>
      <Field label="Revision / temporary revisions">
        <input
          name="revision"
          required
          maxLength={MAX_LENGTH.revision}
          placeholder="Revision 15; TR 5-1 and 5-2"
        />
      </Field>
      <Field label="Revision date">
        <input type="date" name="revisionDate" />
      </Field>
    </>
  );
}

function useManualFile(uuid: string, manual?: Manual) {
  const { snapshot, backend, namespace } = useWorkspace();
  const userId = snapshot?.user.id;
  const [url, setUrl] = useState("");
  const [fromDevice, setFromDevice] = useState(false);
  // Set when the kept copy fails to open: use the online file instead.
  const [failedCopy, setFailedCopy] = useState("");
  const copyKey = `${namespace}\n${userId}\n${uuid}`;
  const deviceFailed = failedCopy === copyKey;
  const [error, setError] = useState("");
  useEffect(() => {
    let canceled = false;
    let objectUrl = "";
    setUrl("");
    setFromDevice(false);
    setError("");
    // A kept copy opens first, from this device and without waiting on the
    // network; otherwise the online file opens as before.
    if (manual && backend)
      openManualFile(uuid, { useDevice: !deviceFailed })
        .then((file) => {
          objectUrl = file.url;
          if (canceled) return revokeBlob(file.url);
          setFromDevice(file.fromDevice);
          setUrl(file.url);
        })
        .catch((e) => {
          if (!canceled) setError(errorText(e, "Unable to open manual."));
        });
    return () => {
      canceled = true;
      revokeBlob(objectUrl);
    };
  }, [uuid, backend, !!manual, namespace, userId, deviceFailed]);
  const onDeviceFailed = () => setFailedCopy(copyKey);
  return { url, fromDevice, deviceFailed, error, onDeviceFailed };
}

// Every manual opens from an object URL (a kept copy or a downloaded file);
// anything else is not the viewer's to release.
function revokeBlob(url: string) {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

function ViewerHeader({ manual, page }: { manual: Manual; page: number }) {
  return (
    <PageHeader
      eyebrow="REFERENCE LIBRARY"
      title={manual.title}
      description={`${manual.documentNumber} · ${manual.revision} · PDF page ${page}`}
      actions={
        <>
          <ManualDiscoveryButton manual={manual} />
          <MaintenanceCsvImportButton manual={manual} />
        </>
      }
    />
  );
}

// Only a kept copy falls back when the reader cannot load it.
function ManualPdf({
  manual,
  page,
  file,
}: {
  manual: Manual;
  page: number;
  file: ManualFile;
}) {
  return (
    <>
      <div className="manual-viewer-actions">
        <a
          className="button small"
          href={`${file.url}#page=${page}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ArrowSquareOut size={17} aria-hidden="true" />
          Open PDF in browser
        </a>
        <a className="button small" href={file.url} download={manual.filename}>
          <DownloadSimple size={17} aria-hidden="true" />
          Download PDF
        </a>
      </div>
      <PdfReader
        url={file.url}
        initialPage={page}
        title={manual.title}
        onLoadError={file.fromDevice ? file.onDeviceFailed : undefined}
      />
    </>
  );
}
