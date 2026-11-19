/**
 * Responsibility: Photos of the paper logbook on a flight or work order:
 *   taking or choosing one, the thumbnails, the full-size view with archive,
 *   the photos still waiting to upload, and the prompt after a flight saves.
 * Layer: UI. React components; writes through the workspace store.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts,
 *   src/data/logbookPhotos.ts, src/domain/aircraftFiles.ts,
 *   src/domain/model.ts, ./AircraftFiles.tsx, ./FileLink.tsx, ./design.tsx,
 *   ./ui.tsx, src/styles/screens/logbook-photos.css.
 *
 * For its first year the program keeps paper logbooks beside the app; a
 * photo of the paper line ties the two. Photos are never deleted (ADR-0004):
 * archiving hides one and keeps its stored file.
 */
import { useEffect, useState } from "react";
import { Camera, FileText } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import {
  pendingPhotosFor,
  type PendingLogbookPhoto,
} from "../data/logbookPhotos";
import {
  canWriteAircraftFile,
  linkedLogbookPhotos,
  type AircraftFile,
  type AircraftFileLink,
} from "../domain/aircraftFiles";
import type { Snapshot } from "../domain/model";
import { AircraftFileArchiveForm, OpenLink } from "./AircraftFiles";
import { LinkedImage, useFileLink, type ShownLink } from "./FileLink";
import { Dialog, NoticeBar } from "./design";
import { errorText } from "./ui";
import "../styles/screens/logbook-photos.css";

const BYTES_PER_KB = 1024;
const PDF_TYPE = "application/pdf";

/** The flight or work order a photo is attached to, on its aircraft. */
export interface LogbookPhotoTarget extends AircraftFileLink {
  aircraftUuid: string;
}

type PhotoDialogProps = {
  s: Snapshot;
  photo: AircraftFile;
  writer: boolean;
  onClose: () => void;
};

/**
 * A record's logbook page photos: the uploaded thumbnails, the ones still
 * waiting on this device, and, for a user who may write them, the control
 * that takes or chooses another.
 *
 * @param props.target - The flight or work order.
 * @param props.label - The control's text, such as "Add a photo of the
 *   logbook line".
 * @returns The strip, or null when there is nothing to show and nothing the
 *   user may add.
 */
export function LogbookPhotoStrip({
  target,
  label,
}: {
  target: LogbookPhotoTarget;
  label: string;
}) {
  const { snapshot: s, pendingPhotos } = useWorkspace();
  const photos = linkedLogbookPhotos(s!.aircraftFiles, target);
  const waiting = pendingPhotosFor(pendingPhotos, target);
  const writer = canWriteAircraftFile(
    s!,
    target.aircraftUuid,
    target.linkedKind,
  );
  if (!photos.length && !waiting.length && !writer) return null;
  return (
    <div className="lp-strip">
      <LogbookPhotoThumbnails s={s!} photos={photos} writer={writer} />
      {waiting.map((p) => (
        <PendingThumbnail key={p.key} photo={p} />
      ))}
      {writer && <LogbookPhotoControl target={target} label={label} />}
    </div>
  );
}

/**
 * The camera control: a file input that opens the rear camera on a phone and
 * the file picker elsewhere, then attaches the photo through the workspace,
 * which uploads it or keeps it on the device until the record has synced.
 *
 * @param props.target - The flight or work order.
 * @param props.label - The control's text.
 * @returns The control with its status or error beneath.
 */
export function LogbookPhotoControl({
  target,
  label,
}: {
  target: LogbookPhotoTarget;
  label: string;
}) {
  const { busy, error, message, attach } = usePhotoAttach(target);
  return (
    <div className="lp-control">
      <label className={"button small lp-button" + (busy ? " lp-busy" : "")}>
        <Camera size={18} aria-hidden="true" />
        {busy ? "Attaching…" : label}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="lp-input"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared so choosing the same file again still fires onChange.
            e.target.value = "";
            void attach(file);
          }}
        />
      </label>
      {message && (
        <small role="status" className="lp-status">
          {message}
        </small>
      )}
      {error && (
        <small role="alert" className="error">
          {error}
        </small>
      )}
    </div>
  );
}

/**
 * The notice shown once a flight is saved, offering to photograph its
 * logbook line now; the photos already attached appear beside the control.
 *
 * @param props.target - The flight just saved, which may still be in the
 *   outbox: a photo then waits on the device until it syncs.
 * @param props.onDismiss - Closes the notice.
 */
export function LogbookPhotoPrompt({
  target,
  onDismiss,
}: {
  target: LogbookPhotoTarget;
  onDismiss: () => void;
}) {
  return (
    <NoticeBar tone="good" icon={Camera} className="lp-prompt">
      <strong>Flight saved.</strong> Add a photo of the paper logbook line now,
      or later from the flight log.
      <LogbookPhotoStrip
        target={target}
        label="Add a photo of the logbook line"
      />
      <button type="button" className="button small" onClick={onDismiss}>
        Done
      </button>
    </NoticeBar>
  );
}

/**
 * A queued photo's thumbnail, marked as waiting or, after a refusal, as
 * needing attention in the Sync center.
 *
 * @param props.photo - The queued photo.
 */
export function PendingThumbnail({ photo }: { photo: PendingLogbookPhoto }) {
  const url = useBlobUrl(photo.blob);
  return (
    <span
      className={"lp-thumb lp-pending" + (photo.error ? " lp-failed" : "")}
      title={photo.error || "Waiting to upload"}
    >
      {photo.type === PDF_TYPE ? (
        <FileText size={28} aria-hidden="true" />
      ) : (
        <img src={url} alt={`${photo.name}, waiting to upload`} />
      )}
      <span className="lp-badge">{photo.error ? "Failed" : "Waiting"}</span>
    </span>
  );
}

function usePhotoAttach(target: LogbookPhotoTarget) {
  const { attachLogbookPhoto } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function attach(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await attachLogbookPhoto(target, file);
      setMessage(useWorkspace.getState().notice);
    } catch (e) {
      setError(errorText(e, "Unable to attach the photo."));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, message, attach };
}

function LogbookPhotoThumbnails({
  s,
  photos,
  writer,
}: {
  s: Snapshot;
  photos: AircraftFile[];
  writer: boolean;
}) {
  const [open, setOpen] = useState<AircraftFile | null>(null);
  const shown = open && photos.find((p) => p.uuid === open.uuid);
  return (
    <>
      {photos.map((p) => (
        <button
          key={p.uuid}
          type="button"
          className="lp-thumb"
          aria-label={`Open logbook photo ${p.name}`}
          onClick={() => setOpen(p)}
        >
          {p.type === PDF_TYPE ? (
            <FileText size={28} aria-hidden="true" />
          ) : (
            <LinkedImage
              file={{ kind: "aircraftFile", id: p.uuid }}
              alt=""
              fallback={<Camera size={28} aria-hidden="true" />}
            />
          )}
        </button>
      ))}
      {shown && (
        <PhotoDialog
          s={s}
          photo={shown}
          writer={writer}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

// Full size, with the archive form for a writer while connected.
function PhotoDialog({ s, photo, writer, onClose }: PhotoDialogProps) {
  const { backend, online, connected } = useWorkspace();
  const link = useFileLink(
    { kind: "aircraftFile", id: photo.uuid },
    { keepFresh: true },
  );
  const [archiving, setArchiving] = useState(false);
  const aircraft = s.aircraft.find((a) => a.uuid === photo.aircraftUuid);
  return (
    <Dialog
      title={`Logbook page — ${aircraft?.registration ?? ""}`}
      subtitle={`${photo.name} · uploaded ${new Date(photo.uploadedAt).toLocaleDateString()} · ${Math.ceil(photo.size / BYTES_PER_KB)} KB`}
      size="wide"
      className="lp-dialog"
      onClose={onClose}
    >
      <PhotoMedia photo={photo} link={link} />
      {writer && backend && online && connected && !archiving && (
        <button
          type="button"
          className="button small"
          onClick={() => setArchiving(true)}
        >
          Archive photo
        </button>
      )}
      {archiving && (
        <AircraftFileArchiveForm
          file={photo}
          onArchive={async (reason) => {
            await backend!.archiveAircraftFile(photo.uuid, reason);
            onClose();
          }}
          onCancel={() => setArchiving(false)}
        />
      )}
    </Dialog>
  );
}

// An image draws in the dialog; a PDF, or an image not yet linked, offers
// Open or says why it cannot.
function PhotoMedia({ photo, link }: { photo: AircraftFile; link: ShownLink }) {
  if (photo.type === PDF_TYPE || !link.url)
    return <OpenLink link={link} name={photo.name} />;
  return <img className="lp-full" src={link.url} alt={photo.name} />;
}

function useBlobUrl(blob: Blob): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const local = URL.createObjectURL(blob);
    setUrl(local);
    return () => URL.revokeObjectURL(local);
  }, [blob]);
  return url;
}
