import { useEffect, useId, useState } from "react";
import { FileText, UploadSimple } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { can, type Aircraft, type Snapshot } from "../domain/model";
import {
  validateAircraftFile,
  type AircraftFile,
} from "../domain/aircraftFiles";
import { DeleteFileButton } from "./ui";
import "../styles/screens/dashboard.css";

/** Opens stored files; demo data URLs become blob URLs, since browsers block
 * top-level data URL navigation. */
function useOpenableUrl(file: AircraftFile) {
  const [url, setUrl] = useState(file.url.startsWith("data:") ? "" : file.url);
  useEffect(() => {
    if (!file.url.startsWith("data:")) {
      setUrl(file.url);
      return;
    }
    const encoded = file.url.slice(file.url.indexOf(",") + 1);
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const local = URL.createObjectURL(new Blob([bytes], { type: file.type }));
    setUrl(local);
    return () => URL.revokeObjectURL(local);
  }, [file.url, file.type]);
  return url;
}

function Form337Row({
  file,
  onDelete,
}: {
  file: AircraftFile;
  onDelete?: () => Promise<unknown>;
}) {
  const url = useOpenableUrl(file);
  return (
    <li className="dash-file">
      <FileText size={20} aria-hidden="true" />
      <span className="dash-file-text">
        <strong>{file.name}</strong>
        <small>
          Uploaded {new Date(file.uploadedAt).toLocaleDateString()} ·{" "}
          {Math.ceil(file.size / 1024)} KB
        </small>
      </span>
      <span className="dash-file-actions">
        {url ? (
          <a
            className="button small"
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${file.name}`}
          >
            Open
          </a>
        ) : (
          <small>Reconnect to open.</small>
        )}
        {onDelete && <DeleteFileButton name={file.name} onDelete={onDelete} />}
      </span>
    </li>
  );
}

/** Form 337 copies (major repair and alteration) on the aircraft record:
 * readers see them; maintenance permission uploads and deletes. */
export function AircraftForm337({
  state: s,
  aircraft: a,
}: {
  state: Snapshot;
  aircraft: Aircraft;
}) {
  const { backend, online, connected } = useWorkspace();
  const heading = useId();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const files = (s.aircraftFiles ?? [])
    .filter((f) => f.aircraftUuid === a.uuid && f.category === "form-337")
    .sort((x, z) => z.uploadedAt - x.uploadedAt);
  const writer = can(s, a.uuid, "maintenance") && !!backend;
  const live = online && connected;
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      validateAircraftFile(file.name, file.type, file.size);
      await backend!.uploadAircraftFile(a.uuid, "form-337", file);
      setMessage(`${file.name} uploaded.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to upload the file.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="dash-detail-section" aria-labelledby={heading}>
      <h3 className="dash-detail-label" id={heading}>
        Form 337 copies
      </h3>
      <p className="dash-files-note">
        FAA Form 337 major repair and alteration records kept with this
        aircraft.
      </p>
      {files.length ? (
        <ul
          className="dash-files-list"
          aria-label={`${a.registration} Form 337 copies`}
        >
          {files.map((f) => (
            <Form337Row
              key={f.uuid}
              file={f}
              onDelete={
                writer && live
                  ? () => backend!.removeAircraftFile(f.uuid)
                  : undefined
              }
            />
          ))}
        </ul>
      ) : (
        <p className="dash-detail-empty">No Form 337 copies on file.</p>
      )}
      {writer && (
        <div className="dash-files-upload">
          <label className="button small dash-file-button">
            <UploadSimple size={18} aria-hidden="true" />
            {busy ? "Uploading…" : "Upload Form 337 copy"}
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              className="dash-file-input"
              aria-describedby={heading + "-hint"}
              disabled={busy || !live}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                void upload(file);
              }}
            />
          </label>
          <small id={heading + "-hint"}>
            {live
              ? "PDF, JPEG, PNG or WebP, up to 7 MB."
              : "Reconnect to upload or delete Form 337 copies."}
          </small>
        </div>
      )}
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
    </section>
  );
}
