/**
 * Responsibility: An inventory item's attached photos and documents: viewing,
 *   downloading, deleting, and picking and uploading new files.
 * Layer: UI. Reads attachments from the workspace snapshot; uploads and
 *   deletions go through the workspace backend.
 * Dependencies: react, src/data/store.ts (useWorkspace),
 *   src/domain/programs.ts (programPermission),
 *   src/domain/inventoryAttachments.ts, src/components/FileLink.tsx,
 *   src/components/ui.tsx.
 */
import { useState, type MouseEvent } from "react";
import { useWorkspace } from "../data/store";
import { programPermission } from "../domain/programs";
import {
  validateInventoryFile,
  type InventoryAttachment,
} from "../domain/inventoryAttachments";
import { useFileLink } from "./FileLink";
import { AsyncForm, DeleteFileButton, Field } from "./ui";

const BYTES_PER_KB = 1024;
const DOWNLOAD_URL_LIFETIME_MS = 1000;
const UNAVAILABLE = "File unavailable. Reconnect and reopen the item.";

// Stable React keys for picked files without changing the File[] shape.
const fileKeys = new WeakMap<File, string>();

type AttachmentsProps = {
  stockUuid: string;
  initialFiles?: File[];
  onUploaded?: () => void;
};
type Uploads = ReturnType<typeof useUploads>;

/**
 * A file input that adds to a list of picked attachments, each listed with
 * its size and a button to remove it.
 *
 * @param props.files - The files picked so far.
 * @param props.onChange - Called with the whole new list after each pick or
 *   removal; picking the same file again adds it again.
 * @returns The field and the list.
 */
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
              {file.name} · {sizeLabel(file.size)}{" "}
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

/**
 * An inventory item's attachments, with upload and delete for program
 * administrators while connected.
 *
 * @param props.stockUuid - The inventory item.
 * @param props.initialFiles - Files already picked for upload.
 * @param props.onUploaded - Called once every picked file is stored.
 * @returns The attachments section. Uploads go one at a time through the
 *   backend, each file leaving the picked list once stored.
 */
export function InventoryAttachments({
  stockUuid,
  initialFiles = [],
  onUploaded,
}: AttachmentsProps) {
  const { snapshot, online, connected, backend } = useWorkspace();
  const uploads = useUploads(stockUuid, initialFiles, onUploaded);
  const files = (snapshot?.inventoryAttachments ?? []).filter(
    (f) => f.stockUuid === stockUuid,
  );
  const admin = !!snapshot && programPermission(snapshot, "admin");
  const live = online && connected;
  return (
    <section aria-label="Inventory attachments">
      <h3>Attachments</h3>
      <p>
        Attach item photos, invoices, certificates or other supporting
        documents. PDF, JPEG, PNG or WebP, up to 7 MB per file.
      </p>
      {!live ? (
        <p className="notice">
          Reconnect to upload attachments or open stored files.
        </p>
      ) : null}
      <AttachmentList
        files={files}
        onDelete={
          admin && live
            ? (uuid) => backend!.removeInventoryFile(uuid)
            : undefined
        }
      />
      {admin && <UploadForm uploads={uploads} disabled={!live} />}
      {uploads.message && <p role="status">{uploads.message}</p>}
    </section>
  );
}

function useUploads(
  stockUuid: string,
  initialFiles: File[],
  onUploaded?: () => void,
) {
  const { backend } = useWorkspace();
  const [pending, setPending] = useState<File[]>(initialFiles);
  const [message, setMessage] = useState("");
  function pick(files: File[]) {
    setPending(files);
    setMessage("");
  }
  // Every file is checked before any is sent; a failure part-way leaves only
  // the files not yet stored in the list.
  async function upload() {
    if (!pending.length) throw new Error("Choose an image or PDF to attach.");
    for (const file of pending)
      validateInventoryFile(file.name, file.type, file.size);
    for (const [index, file] of pending.entries()) {
      await backend!.attachInventoryFile(stockUuid, file);
      setPending(pending.slice(index + 1));
      setMessage(`${file.name} uploaded.`);
    }
    onUploaded?.();
  }
  return { pending, message, pick, upload };
}

function UploadForm({
  uploads,
  disabled,
}: {
  uploads: Uploads;
  disabled: boolean;
}) {
  return (
    <AsyncForm
      submitLabel="Upload attachment"
      disabled={disabled}
      onSubmit={uploads.upload}
    >
      <InventoryFilePicker files={uploads.pending} onChange={uploads.pick} />
    </AsyncForm>
  );
}

function AttachmentList({
  files,
  onDelete,
}: {
  files: InventoryAttachment[];
  onDelete?: (uuid: string) => Promise<unknown>;
}) {
  if (!files.length) return <p>No attachments yet.</p>;
  return (
    <ul style={{ listStyle: "none", padding: 0 }}>
      {files.map((f) => (
        <Attachment
          key={f.uuid}
          file={f}
          onDelete={onDelete && (() => onDelete(f.uuid))}
        />
      ))}
    </ul>
  );
}

function Attachment({
  file,
  onDelete,
}: {
  file: InventoryAttachment;
  onDelete?: () => Promise<unknown>;
}) {
  const [downloadError, setDownloadError] = useState("");
  const { url, status } = useFileLink(
    { kind: "inventoryFile", id: file.uuid },
    { keepFresh: true },
  );
  async function download(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    setDownloadError("");
    try {
      await saveCopy(url, file.name);
    } catch {
      // Whatever the cause, the user can only reconnect and retry.
      setDownloadError("Download failed. Reconnect and try again.");
    }
  }
  return (
    <li className="panel">
      {url && file.type.startsWith("image/") && (
        <ImagePreview url={url} name={file.name} />
      )}
      <p>
        <strong>{file.name}</strong> · {sizeLabel(file.size)}
        <br />
        <small>Uploaded {new Date(file.uploadedAt).toLocaleString()}</small>
      </p>
      {url ? (
        <FileLinks url={url} file={file} onDownload={download} />
      ) : (
        <p>{status === "waiting" ? "Opening…" : UNAVAILABLE}</p>
      )}
      {onDelete && <DeleteFileButton name={file.name} onDelete={onDelete} />}
      {downloadError && <p role="alert">{downloadError}</p>}
    </li>
  );
}

function ImagePreview({ url, name }: { url: string; name: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" aria-label={`View ${name}`}>
      <img
        src={url}
        alt={name}
        loading="lazy"
        style={{ maxWidth: "100%", maxHeight: 200, objectFit: "contain" }}
      />
    </a>
  );
}

function FileLinks({
  url,
  file,
  onDownload,
}: {
  url: string;
  file: InventoryAttachment;
  onDownload: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <>
      <a className="button small" href={url} target="_blank" rel="noreferrer">
        Open {file.type === "application/pdf" ? "PDF" : "image"}
      </a>{" "}
      <a
        className="button small"
        href={url}
        download={file.name}
        onClick={onDownload}
      >
        Download {file.name}
      </a>
    </>
  );
}

// The download attribute is ignored on cross-origin links such as file
// links, so the file is fetched and saved from a blob URL.
async function saveCopy(url: string, name: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Download failed");
  const downloadUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), DOWNLOAD_URL_LIFETIME_MS);
}

function fileKey(file: File): string {
  let key = fileKeys.get(file);
  if (!key) {
    key = crypto.randomUUID();
    fileKeys.set(file, key);
  }
  return key;
}

function sizeLabel(bytes: number): string {
  return `${Math.ceil(bytes / BYTES_PER_KB)} KB`;
}
