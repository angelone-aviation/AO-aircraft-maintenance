import { PdfReader } from "./PdfReader";
import { MaintenanceCsvImportButton } from "./MaintenanceCsvImport";
import { ManualDiscoveryButton } from "./ManualDiscovery";
import { createPortal } from "react-dom";
import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import { can } from "../domain/model";
import type { Manual, ManualReference } from "../domain/manuals";
import { manualInputSchema } from "../domain/manuals";
import { AsyncForm, Field, Modal, value } from "./ui";
import {
  EmptyState,
  NoticeBar,
  PageHeader,
  SearchField,
  Toolbar,
} from "./design";
import { ShopLead, ShopTableCard } from "./ShopList";
import {
  ArrowSquareOut,
  BookOpen,
  DownloadSimple,
  FilePdf,
  Info,
  UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";

export function ManualLink({
  reference,
}: {
  reference?: ManualReference | null;
}) {
  const manuals = useWorkspace((s) => s.snapshot?.manuals);
  const [preview, setPreview] = useState(false);
  if (!reference) return null;
  const m = manuals?.find((m) => m.uuid === reference.manualUuid);
  return m ? (
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
        {m.title} · {m.revision}
        {reference.section && ` · § ${reference.section}`}
        {reference.printedPage && ` · printed page ${reference.printedPage}`} ·
        PDF page {reference.pdfPage}
      </Link>
      {preview &&
        createPortal(
          <Modal title="Manual reference" onClose={() => setPreview(false)}>
            <ManualViewer uuid={m.uuid} page={reference.pdfPage} />
          </Modal>,
          document.body,
        )}
    </>
  ) : (
    <span className="muted">
      Referenced manual is unavailable in this workspace.
    </span>
  );
}

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
      <Field label="Reference library manual">
        <select
          name="manualUuid"
          value={ref.manualUuid}
          onChange={(e) =>
            update({ ...ref, manualUuid: e.target.value, pdfPage: 1 })
          }
        >
          <option value="">No linked manual</option>
          {ref.manualUuid && !selected && (
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
      <Field label="Manual section">
        <input
          name="manualSection"
          maxLength={200}
          value={ref.section}
          onChange={(e) => update({ ...ref, section: e.target.value })}
          placeholder="5-12-02"
        />
      </Field>
      <Field label="Printed page label">
        <input
          name="manualPrintedPage"
          maxLength={100}
          value={ref.printedPage}
          onChange={(e) => update({ ...ref, printedPage: e.target.value })}
          placeholder="1"
        />
      </Field>
      <Field label="PDF page number">
        <input
          name="manualPdfPage"
          type="number"
          min={1}
          max={selected?.pageCount}
          required={!!ref.manualUuid}
          value={ref.pdfPage || ""}
          onChange={(e) => update({ ...ref, pdfPage: Number(e.target.value) })}
        />
      </Field>
      {ref.manualUuid && <ManualLink reference={ref} />}
    </div>
  );
}
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
export function ReferenceLibrary({ aircraftUuid }: { aircraftUuid?: string }) {
  const { snapshot: s, backend, online, connected, demo } = useWorkspace();
  const [upload, setUpload] = useState(false);
  const [renaming, setRenaming] = useState<Manual | null>(null);
  const [search, setSearch] = useState("");
  const [progress, setProgress] = useState("");
  const aircraft = s!.aircraft.filter(
    (a) =>
      can(s!, a.uuid, "maintenance") &&
      (!aircraftUuid || a.uuid === aircraftUuid),
  );
  const manuals = (s!.manuals ?? []).filter(
    (m) =>
      (!aircraftUuid || m.aircraftUuid === aircraftUuid) &&
      `${m.title} ${m.documentNumber} ${m.revision} ${m.filename}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const uploadButton = (
    <button
      type="button"
      className="button primary"
      disabled={!online || !connected || !aircraft.length}
      onClick={() => setUpload(true)}
    >
      <UploadSimple size={18} weight="bold" aria-hidden="true" />
      Upload manual
    </button>
  );
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
          onChange={setSearch}
        />
      </Toolbar>
      {demo && (
        <NoticeBar tone="neutral" icon={Info}>
          Demo manuals are saved in this browser. Connected workspaces store
          manuals in the shared reference library.
        </NoticeBar>
      )}
      {manuals.length ? (
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
                <tr key={m.uuid}>
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
                      {
                        s!.aircraft.find((a) => a.uuid === m.aircraftUuid)
                          ?.registration
                      }
                    </strong>
                    <small className="shop-icon-text">
                      <FilePdf size={16} aria-hidden="true" />
                      {`${m.pageCount.toLocaleString()} pages · ${(m.size / 1024 / 1024).toFixed(1)} MB`}
                    </small>
                  </td>
                  <td className="shop-actions-cell">
                    <span className="shop-actions shop-manual-actions">
                      <Link
                        className="button small"
                        to="/manuals/$manualUuid"
                        params={{ manualUuid: m.uuid }}
                        search={{ page: 1 }}
                      >
                        Open manual
                      </Link>
                      {can(s!, m.aircraftUuid, "maintenance") && (
                        <button
                          className="button small"
                          disabled={!online || !connected}
                          onClick={() => setRenaming(m)}
                        >
                          Edit reference
                        </button>
                      )}
                      <ManualDiscoveryButton manual={m} />
                      <MaintenanceCsvImportButton manual={m} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ShopTableCard>
      ) : (
        <EmptyState title="No manuals found">
          Upload an aircraft manual to keep it available for maintenance
          references.
        </EmptyState>
      )}
      {renaming && (
        <Modal title="Edit manual reference" onClose={() => setRenaming(null)}>
          <AsyncForm
            submitLabel="Save reference"
            disabled={!online || !connected}
            onSubmit={async (d) => {
              await backend!.editManual(renaming.uuid, {
                title: value(d, "title"),
                documentNumber: value(d, "documentNumber"),
                revision: value(d, "revision"),
                revisionDate: value(d, "revisionDate"),
                aircraftUuid: value(d, "aircraft"),
                applicability: value(d, "kind")
                  ? {
                      kind: value(d, "kind") as "aircraft" | "component",
                      manufacturer: value(d, "manufacturer"),
                      model: value(d, "model"),
                      partNumber: value(d, "partNumber"),
                    }
                  : undefined,
              });
              setRenaming(null);
            }}
          >
            <Field label="Manual name">
              <input
                name="title"
                defaultValue={renaming.title}
                required
                maxLength={300}
                autoFocus
              />
            </Field>
            <Field label="Document number">
              <input
                name="documentNumber"
                defaultValue={renaming.documentNumber}
                maxLength={200}
              />
            </Field>
            <Field label="Revision / temporary revisions">
              <input
                name="revision"
                defaultValue={renaming.revision}
                required
                maxLength={300}
              />
            </Field>
            <Field label="Revision date">
              <input
                type="date"
                name="revisionDate"
                defaultValue={renaming.revisionDate}
              />
            </Field>
            <Field label="Aircraft">
              <select
                name="aircraft"
                defaultValue={renaming.aircraftUuid}
                required
              >
                {s!.aircraft
                  .filter(
                    (a) =>
                      can(s!, a.uuid, "maintenance") &&
                      a.programUuid ===
                        s!.aircraft.find(
                          (a) => a.uuid === renaming.aircraftUuid,
                        )?.programUuid,
                  )
                  .map((a) => (
                    <option key={a.uuid} value={a.uuid}>
                      {a.registration}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Applicability type">
              <select
                name="kind"
                defaultValue={renaming.applicability?.kind ?? ""}
              >
                <option value="">Not specified</option>
                <option value="aircraft">Aircraft</option>
                <option value="component">Component</option>
              </select>
            </Field>
            <Field label="Manufacturer">
              <input
                name="manufacturer"
                defaultValue={renaming.applicability?.manufacturer ?? ""}
                maxLength={150}
              />
            </Field>
            <Field label="Model">
              <input
                name="model"
                defaultValue={renaming.applicability?.model ?? ""}
                maxLength={150}
              />
            </Field>
            <Field label="Part number">
              <input
                name="partNumber"
                defaultValue={renaming.applicability?.partNumber ?? ""}
                maxLength={100}
              />
            </Field>
            <p className="muted">
              PDF: {renaming.filename} · {renaming.pageCount.toLocaleString()}{" "}
              pages. To replace the PDF, upload a new manual revision.
            </p>
          </AsyncForm>
        </Modal>
      )}
      {upload && (
        <Modal
          title="Upload reference manual"
          onClose={() => {
            if (!progress) setUpload(false);
          }}
        >
          <AsyncForm
            submitLabel={progress || "Save manual"}
            onSubmit={async (d) => {
              const file = d.get("pdf");
              if (!(file instanceof File) || !file.size)
                throw new Error("Choose a PDF manual.");
              try {
                setProgress("Reading PDF…");
                const { inspectManualPdf } = await import("../data/manualPdf");
                const pageCount = await inspectManualPdf(file);
                const owner = s!.aircraft.find(
                  (a) => a.uuid === (aircraftUuid || value(d, "aircraft")),
                );
                const input = manualInputSchema.parse({
                  applicability: owner?.model
                    ? {
                        kind: "aircraft",
                        manufacturer: owner.make,
                        model: owner.model,
                        partNumber: "",
                      }
                    : undefined,
                  aircraftUuid: aircraftUuid || value(d, "aircraft"),
                  title: value(d, "title"),
                  documentNumber: value(d, "documentNumber"),
                  revision: value(d, "revision"),
                  revisionDate: value(d, "revisionDate"),
                  filename: file.name,
                  size: file.size,
                  pageCount,
                });
                setProgress("Uploading manual…");
                await backend!.uploadManual(input, file);
                setUpload(false);
              } finally {
                setProgress("");
              }
            }}
          >
            <p>
              PDF up to 200 MB. Each upload is saved separately to preserve
              references to earlier revisions.
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
            <Field label="Manual title">
              <input
                name="title"
                required
                maxLength={300}
                placeholder="Cessna 441 Maintenance Manual"
              />
            </Field>
            <Field label="Document number">
              <input
                name="documentNumber"
                maxLength={200}
                placeholder="D2518-15-13"
              />
            </Field>
            <Field label="Revision / temporary revisions">
              <input
                name="revision"
                required
                maxLength={300}
                placeholder="Revision 15; TR 5-1 and 5-2"
              />
            </Field>
            <Field label="Revision date">
              <input type="date" name="revisionDate" />
            </Field>
            <Field label="PDF manual">
              <input
                type="file"
                name="pdf"
                accept="application/pdf,.pdf"
                required
              />
            </Field>
            {progress && <p role="status">{progress}</p>}
          </AsyncForm>
        </Modal>
      )}
    </>
  );
}
export function ManualViewer({ uuid, page }: { uuid: string; page: number }) {
  const { snapshot, backend } = useWorkspace();
  const manual = snapshot?.manuals?.find((m) => m.uuid === uuid);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let canceled = false;
    let objectUrl = "";
    setUrl("");
    setError("");
    if (manual && backend)
      backend
        .openManual(uuid)
        .then((url) => {
          objectUrl = url;
          if (canceled) {
            if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          } else setUrl(url);
        })
        .catch((e) => {
          if (!canceled)
            setError(e instanceof Error ? e.message : "Unable to open manual.");
        });
    return () => {
      canceled = true;
      if (objectUrl.startsWith("blob:")) URL.revokeObjectURL(objectUrl);
    };
  }, [uuid, backend, !!manual]);
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
      {error && (
        <NoticeBar tone="danger" icon={WarningCircle} role="alert">
          {error}
        </NoticeBar>
      )}
      {!url && !error && (
        <p role="status" className="muted">
          Opening manual…
        </p>
      )}
      {url && (
        <>
          <div className="shop-viewer-actions">
            <a
              className="button small"
              href={`${url}#page=${page}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ArrowSquareOut size={17} aria-hidden="true" />
              Open PDF in browser
            </a>
            <a className="button small" href={url} download={manual.filename}>
              <DownloadSimple size={17} aria-hidden="true" />
              Download PDF
            </a>
          </div>
          <PdfReader url={url} initialPage={page} title={manual.title} />
        </>
      )}
    </>
  );
}
