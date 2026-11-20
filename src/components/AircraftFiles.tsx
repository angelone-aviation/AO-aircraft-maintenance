/**
 * Responsibility: The Form 337 copies on an aircraft record: listing, opening,
 *   uploading and archiving them with a reason.
 * Layer: UI. React components; writes through the workspace backend.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts,
 *   src/data/backend.ts (types), src/domain/model.ts,
 *   src/domain/aircraftFiles.ts, ./FileLink.tsx, ./design.tsx, ./ui.tsx,
 *   src/styles/screens/dashboard.css.
 *
 * Copies are never deleted (ADR-0004): archiving hides one from the current
 * list and keeps its stored file.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Archive, FileText, UploadSimple } from "@phosphor-icons/react";
import type { Backend } from "../data/backend";
import { useWorkspace } from "../data/store";
import { can, type Aircraft, type Snapshot } from "../domain/model";
import {
  isCurrentAircraftFile,
  validateAircraftFile,
  type AircraftFile,
} from "../domain/aircraftFiles";
import { OpenLink, useFileLink } from "./FileLink";
import { Switch } from "./design";
import { errorText, useRevealError } from "./ui";
import "../styles/screens/dashboard.css";

const BYTES_PER_KB = 1024;
// aircraftFileArchive (src/domain/aircraftFiles.ts) refuses longer reasons.
const ARCHIVE_REASON_MAX_LENGTH = 500;

type Archiver = (reason: string) => Promise<unknown>;

/**
 * The aircraft's Form 337 copies (major repair and alteration). Everyone who
 * reads the aircraft can open them; maintenance permission uploads copies and
 * archives them, both only while online.
 *
 * @param props.state - The snapshot holding the files and permissions.
 * @returns The "Form 337 copies" region: current copies newest upload first,
 *   then a "Show archived (n)" switch when any copy is archived.
 */
export function AircraftForm337({
  state: s,
  aircraft: a,
}: {
  state: Snapshot;
  aircraft: Aircraft;
}) {
  const { backend, online, connected } = useWorkspace();
  const heading = useId();
  const actions = useForm337Actions(a, backend);
  const { files, archived } = form337Copies(s, a);
  const writer = can(s, a.uuid, "maintenance") && !!backend;
  const live = online && connected;
  return (
    <section className="dash-detail-section" aria-labelledby={heading}>
      <h3 className="dash-detail-label" id={heading}>
        Form 337 copies
      </h3>
      <p className="dash-files-note">
        FAA Form 337 major repair and alteration records kept with this
        aircraft.
      </p>
      <CurrentCopies
        files={files}
        registration={a.registration}
        onArchive={writer && live ? actions.archive : undefined}
      />
      <ArchivedCopies files={archived} registration={a.registration} />
      {writer && (
        <UploadButton
          hintId={heading + "-hint"}
          busy={actions.busy}
          live={live}
          onFile={actions.upload}
        />
      )}
      <Feedback message={actions.message} error={actions.error} />
    </section>
  );
}

function useForm337Actions(aircraft: Aircraft, backend: Backend | null) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      validateAircraftFile(file.name, file.type, file.size);
      await backend!.uploadAircraftFile(aircraft.uuid, "form-337", file);
      setMessage(`${file.name} uploaded.`);
    } catch (e) {
      setError(errorText(e, "Unable to upload the file."));
    } finally {
      setBusy(false);
    }
  }
  async function archive(file: AircraftFile, reason: string) {
    await backend!.archiveAircraftFile(file.uuid, reason);
    setMessage(`${file.name} archived.`);
  }
  return { busy, error, message, upload, archive };
}

function form337Copies(s: Snapshot, aircraft: Aircraft) {
  const all = (s.aircraftFiles ?? []).filter(
    (f) => f.aircraftUuid === aircraft.uuid && f.category === "form-337",
  );
  const files = all
    .filter(isCurrentAircraftFile)
    .sort((x, z) => z.uploadedAt - x.uploadedAt);
  const archived = all
    .filter((f) => !isCurrentAircraftFile(f))
    .sort((x, z) => (z.archivedAt ?? 0) - (x.archivedAt ?? 0));
  return { files, archived };
}

function CurrentCopies({
  files,
  registration,
  onArchive,
}: {
  files: AircraftFile[];
  registration: string;
  onArchive?: (file: AircraftFile, reason: string) => Promise<void>;
}) {
  if (!files.length)
    return <p className="dash-detail-empty">No Form 337 copies on file.</p>;
  return (
    <ul
      className="dash-files-list"
      aria-label={`${registration} Form 337 copies`}
    >
      {files.map((f) => (
        <Form337Row
          key={f.uuid}
          file={f}
          onArchive={onArchive && ((reason) => onArchive(f, reason))}
        />
      ))}
    </ul>
  );
}

// Stays mounted with no archived copies, so the switch keeps its setting if
// the list empties and fills again.
function ArchivedCopies({
  files,
  registration,
}: {
  files: AircraftFile[];
  registration: string;
}) {
  const [shown, setShown] = useState(false);
  if (!files.length) return null;
  return (
    <>
      <Switch
        className="dash-files-toggle"
        checked={shown}
        onChange={setShown}
        label={`Show archived (${files.length})`}
      />
      {shown && (
        <ul
          className="dash-files-list"
          aria-label={`${registration} archived Form 337 copies`}
        >
          {files.map((f) => (
            <Form337Row key={f.uuid} file={f} />
          ))}
        </ul>
      )}
    </>
  );
}

function Form337Row({
  file,
  onArchive,
}: {
  file: AircraftFile;
  onArchive?: Archiver;
}) {
  const link = useFileLink(
    { kind: "aircraftFile", id: file.uuid },
    { keepFresh: true },
  );
  const [archiving, setArchiving] = useState(false);
  return (
    <li className="dash-file">
      <FileText size={20} aria-hidden="true" />
      <FileDetails file={file} />
      <span className="dash-file-actions">
        <OpenLink link={link} name={file.name} />
        {onArchive && !archiving && (
          <button
            type="button"
            className="text-button"
            aria-label={`Archive ${file.name}`}
            onClick={() => setArchiving(true)}
          >
            <Archive size={16} aria-hidden="true" /> Archive
          </button>
        )}
      </span>
      {onArchive && archiving && (
        <AircraftFileArchiveForm
          file={file}
          onArchive={onArchive}
          onCancel={() => setArchiving(false)}
        />
      )}
    </li>
  );
}

function FileDetails({ file }: { file: AircraftFile }) {
  return (
    <span className="dash-file-text">
      <strong>{file.name}</strong>
      <small>
        Uploaded {new Date(file.uploadedAt).toLocaleDateString()} ·{" "}
        {Math.ceil(file.size / BYTES_PER_KB)} KB
      </small>
      {file.archivedAt !== undefined && (
        <small>
          Archived {new Date(file.archivedAt).toLocaleDateString()} by{" "}
          {file.archivedBy?.name ?? "Unknown user"}: {file.archiveReason}
        </small>
      )}
    </span>
  );
}

/**
 * The form that archives a current document with a reason; the copy and its
 * stored file are kept. It unmounts with the copy on success, so only a
 * failure ends its busy state.
 *
 * @param props.file - The document, named in the label.
 * @param props.onArchive - Archives it with the trimmed reason; its error is
 *   shown under the form.
 * @param props.onCancel - Closes the form without archiving.
 */
export function AircraftFileArchiveForm({
  file,
  onArchive,
  onCancel,
}: {
  file: Pick<AircraftFile, "name">;
  onArchive: Archiver;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const { busy, error, submit, alertRef } = useArchive(onArchive, reason);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <form className="dash-file-archive" onSubmit={(e) => void submit(e)}>
      <label htmlFor={id}>Reason for archiving {file.name}</label>
      <input
        ref={input}
        id={id}
        required
        maxLength={ARCHIVE_REASON_MAX_LENGTH}
        value={reason}
        disabled={busy}
        onChange={(e) => setReason(e.target.value)}
      />
      <ArchiveActions busy={busy} onCancel={onCancel} />
      {error && (
        <p ref={alertRef} role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}

function useArchive(onArchive: Archiver, reason: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { alertRef, rememberOrigin } = useRevealError(error);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    rememberOrigin(e);
    setBusy(true);
    setError("");
    try {
      await onArchive(reason);
    } catch (err) {
      setError(errorText(err, "Unable to archive."));
      // Only a failure ends the busy state: on success the copy leaves the
      // current list, which unmounts this form.
      setBusy(false);
    }
  }
  return { busy, error, submit, alertRef };
}

function ArchiveActions({
  busy,
  onCancel,
}: {
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <span className="dash-file-actions">
      <button className="button small primary" disabled={busy}>
        {busy ? "Archiving…" : "Archive copy"}
      </button>
      <button
        type="button"
        className="button small"
        disabled={busy}
        onClick={onCancel}
      >
        Cancel
      </button>
    </span>
  );
}

function UploadButton({
  hintId,
  busy,
  live,
  onFile,
}: {
  hintId: string;
  busy: boolean;
  live: boolean;
  onFile: (file?: File) => Promise<void>;
}) {
  return (
    <div className="dash-files-upload">
      <label className="button small dash-file-button">
        <UploadSimple size={18} aria-hidden="true" />
        {busy ? "Uploading…" : "Upload Form 337 copy"}
        <input
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,.webp"
          className="dash-file-input"
          aria-describedby={hintId}
          disabled={busy || !live}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared so choosing the same file again still fires onChange.
            e.target.value = "";
            void onFile(file);
          }}
        />
      </label>
      <small id={hintId}>
        {live
          ? "PDF, JPEG, PNG or WebP, up to 7 MiB."
          : "Reconnect to upload or archive Form 337 copies."}
      </small>
    </div>
  );
}

function Feedback({ message, error }: { message: string; error: string }) {
  return (
    <>
      {message && (
        <p role="status" className="dash-files-status">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </>
  );
}
