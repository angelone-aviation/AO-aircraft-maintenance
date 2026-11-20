/**
 * Responsibility: Uploads, previews and removes the photo an aircraft shows on
 *   the dashboard, resizing it in the browser first.
 * Layer: UI. React component; writes through the workspace backend.
 * Dependencies: react, src/data/store.ts, src/data/backend.ts (types),
 *   src/domain/aircraftPhotos.ts, ./FileLink.tsx, ./ui.tsx.
 */
import { useState } from "react";
import type { Backend } from "../data/backend";
import { useWorkspace } from "../data/store";
import { validateAircraftPhoto } from "../domain/aircraftPhotos";
import { LinkedImage } from "./FileLink";
import { errorText } from "./ui";

// Longest edge, in pixels, of the stored JPEG.
const PHOTO_MAX_EDGE = 1024;
const JPEG_QUALITY = 0.85;

/**
 * The aircraft's dashboard photo: a preview, a file input that saves a new
 * photo at once and a Remove photo button, both disabled offline.
 *
 * @returns The "Aircraft photo" section; a failure shows as an alert.
 */
export function AircraftPhoto({ aircraftUuid }: { aircraftUuid: string }) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const photo = usePhotoActions(aircraftUuid, backend);
  const aircraft = snapshot?.aircraft.find((a) => a.uuid === aircraftUuid);
  const disabled = photo.busy || !online || !connected;
  return (
    <section aria-label="Aircraft photo">
      <h3>Dashboard photo</h3>
      {aircraft?.hasPhoto && (
        <LinkedImage
          file={{ kind: "aircraftPhoto", id: aircraft.uuid }}
          className="aircraft-photo-preview"
          alt={`${aircraft.registration} photo preview`}
        />
      )}
      <p className="muted">
        JPEG, PNG or WebP, up to 5 MiB. Photos save immediately and are resized
        for the dashboard.
      </p>
      <PhotoInput disabled={disabled} onFile={photo.upload} />
      {aircraft?.hasPhoto && (
        <button
          type="button"
          className="text-button"
          disabled={disabled}
          onClick={() => void photo.remove()}
        >
          Remove photo
        </button>
      )}
      {photo.busy && <p role="status">Saving photo…</p>}
      {photo.error && (
        <p role="alert" className="error">
          {photo.error}
        </p>
      )}
    </section>
  );
}

function usePhotoActions(aircraftUuid: string, backend: Backend | null) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorText(e, fallback));
    } finally {
      setBusy(false);
    }
  }
  const upload = (file: File) =>
    run(async () => {
      validateAircraftPhoto(file.type, file.size);
      const photo = await resizePhoto(file);
      await backend!.uploadAircraftPhoto(aircraftUuid, photo);
    }, "Unable to upload photo.");
  const remove = () =>
    run(
      () => backend!.removeAircraftPhoto(aircraftUuid),
      "Unable to remove photo.",
    );
  return { busy, error, upload, remove };
}

function PhotoInput({
  disabled,
  onFile,
}: {
  disabled: boolean;
  onFile: (file: File) => Promise<void>;
}) {
  return (
    <label>
      Aircraft photo
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so choosing the same file again still fires onChange.
          e.target.value = "";
          if (file) void onFile(file);
        }}
      />
    </label>
  );
}

async function resizePhoto(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, PHOTO_MAX_EDGE / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("Unable to prepare photo.");
  // JPEG has no transparency: paint white first, or clear pixels turn black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(Error("Unable to prepare photo."))),
      "image/jpeg",
      JPEG_QUALITY,
    ),
  );
  return new File([blob], "aircraft.jpg", { type: "image/jpeg" });
}
