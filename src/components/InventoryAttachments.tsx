import { useEffect, useState } from "react";
import { useWorkspace } from "../data/store";
import { programPermission } from "../domain/programs";
import {
  validateInventoryFile,
  type InventoryAttachment,
} from "../domain/inventoryAttachments";
import { AsyncForm, DeleteFileButton, Field } from "./ui";
function Attachment({
  file,
  onDelete,
}: {
  file: InventoryAttachment;
  onDelete?: () => Promise<unknown>;
}) {
  const [downloadError, setDownloadError] = useState("");
  const [url, setUrl] = useState(file.url.startsWith("data:") ? "" : file.url);
  useEffect(() => {
    if (!file.url.startsWith("data:")) {
      setUrl(file.url);
      return;
    }
    // Browsers block top-level data URL navigation. Demo files use blob URLs for viewing.
    const encoded = file.url.slice(file.url.indexOf(",") + 1);
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const localUrl = URL.createObjectURL(
      new Blob([bytes], { type: file.type }),
    );
    setUrl(localUrl);
    return () => URL.revokeObjectURL(localUrl);
  }, [file.url, file.type]);
  return (
    <li className="panel">
      {url && file.type.startsWith("image/") && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={`View ${file.name}`}
        >
          <img
            src={url}
            alt={file.name}
            loading="lazy"
            style={{ maxWidth: "100%", maxHeight: 200, objectFit: "contain" }}
          />
        </a>
      )}
      <p>
        <strong>{file.name}</strong> · {Math.ceil(file.size / 1024)} KB
        <br />
        <small>Uploaded {new Date(file.uploadedAt).toLocaleString()}</small>
      </p>
      {url ? (
        <>
          <a
            className="button small"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            Open {file.type === "application/pdf" ? "PDF" : "image"}
          </a>{" "}
          <a
            className="button small"
            href={url}
            download={file.name}
            onClick={async (event) => {
              event.preventDefault();
              setDownloadError("");
              try {
                const response = await fetch(url);
                if (!response.ok) throw new Error("Download failed");
                const downloadUrl = URL.createObjectURL(await response.blob());
                const link = document.createElement("a");
                link.href = downloadUrl;
                link.download = file.name;
                link.click();
                setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
              } catch {
                setDownloadError("Download failed. Reconnect and try again.");
              }
            }}
          >
            Download {file.name}
          </a>
        </>
      ) : (
        <p>File unavailable. Reconnect and reopen the item.</p>
      )}
      {onDelete && <DeleteFileButton name={file.name} onDelete={onDelete} />}
      {downloadError && <p role="alert">{downloadError}</p>}
    </li>
  );
}
// Stable React keys for picked files without changing the File[] shape.
const fileKeys = new WeakMap<File, string>();
function fileKey(file: File) {
  let key = fileKeys.get(file);
  if (!key) {
    key = crypto.randomUUID();
    fileKeys.set(file, key);
  }
  return key;
}
export function InventoryFilePicker({
  files,
  onChange,
}: {
  files: File[];
  onChange: (files: File[]) => void;
}) {
  return (
    <>
      <Field label="Inventory attachment file">
        <input
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.webp"
          onChange={(event) => {
            onChange([...files, ...Array.from(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
      </Field>
      {!!files.length && (
        <ul>
          {files.map((file, index) => (
            <li key={fileKey(file)}>
              {file.name} · {Math.ceil(file.size / 1024)} KB{" "}
              <button
                type="button"
                className="text-button"
                onClick={() => onChange(files.filter((_, i) => i !== index))}
              >
                Remove {file.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
export function InventoryAttachments({
  stockUuid,
  initialFiles = [],
  onUploaded,
}: {
  stockUuid: string;
  initialFiles?: File[];
  onUploaded?: () => void;
}) {
  const { snapshot, online, connected, backend } = useWorkspace();
  const [pendingFiles, setPendingFiles] = useState<File[]>(initialFiles);
  const [message, setMessage] = useState("");
  const files = (snapshot?.inventoryAttachments ?? []).filter(
    (f) => f.stockUuid === stockUuid,
  );
  const admin = !!snapshot && programPermission(snapshot, "admin");
  return (
    <section aria-label="Inventory attachments">
      <h3>Attachments</h3>
      <p>
        Attach item photos, invoices, certificates or other supporting
        documents. PDF, JPEG, PNG or WebP, up to 7 MB per file.
      </p>
      {!online || !connected ? (
        <p className="notice">
          Reconnect to upload attachments or open stored files.
        </p>
      ) : null}
      {files.length ? (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {files.map((f) => (
            <Attachment
              key={f.uuid}
              file={f}
              onDelete={
                admin && online && connected
                  ? () => backend!.removeInventoryFile(f.uuid)
                  : undefined
              }
            />
          ))}
        </ul>
      ) : (
        <p>No attachments yet.</p>
      )}
      {admin && (
        <AsyncForm
          submitLabel="Upload attachment"
          disabled={!online || !connected}
          onSubmit={async () => {
            if (!pendingFiles.length)
              throw new Error("Choose an image or PDF to attach.");
            for (const file of pendingFiles)
              validateInventoryFile(file.name, file.type, file.size);
            for (let index = 0; index < pendingFiles.length; index++) {
              const file = pendingFiles[index];
              await backend!.attachInventoryFile(stockUuid, file);
              setPendingFiles(pendingFiles.slice(index + 1));
              setMessage(`${file.name} uploaded.`);
            }
            onUploaded?.();
          }}
        >
          <InventoryFilePicker
            files={pendingFiles}
            onChange={(files) => {
              setPendingFiles(files);
              setMessage("");
            }}
          />
        </AsyncForm>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
