import { useState } from "react";
import { useWorkspace } from "../data/store";
import { validateAircraftPhoto } from "../domain/aircraftPhotos";
export function AircraftPhoto({ aircraftUuid }: { aircraftUuid: string }) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const aircraft = snapshot?.aircraft.find((a) => a.uuid === aircraftUuid);
  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      validateAircraftPhoto(file.type, file.size);
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw Error("Unable to prepare photo.");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(Error("Unable to prepare photo."))),
          "image/jpeg",
          0.85,
        ),
      );
      await backend!.uploadAircraftPhoto(
        aircraftUuid,
        new File([blob], "aircraft.jpg", { type: "image/jpeg" }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to upload photo.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Aircraft photo">
      <h3>Dashboard photo</h3>
      {aircraft?.photoUrl && (
        <img
          className="aircraft-photo-preview"
          src={aircraft.photoUrl}
          alt={`${aircraft.registration} photo preview`}
        />
      )}
      <p className="muted">
        JPEG, PNG or WebP, up to 5 MB. Photos save immediately and are resized
        for the dashboard.
      </p>
      <label>
        Aircraft photo
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy || !online || !connected}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      </label>
      {aircraft?.photoUrl && (
        <button
          type="button"
          className="text-button"
          disabled={busy || !online || !connected}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await backend!.removeAircraftPhoto(aircraftUuid);
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Unable to remove photo.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Remove photo
        </button>
      )}
      {busy && <p role="status">Saving photo…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
