/**
 * Responsibility: The device's queue of logbook page photos waiting to
 *   upload: what one entry holds, whose it is, and when it may be sent.
 * Layer: Data. Pure functions over the queue; no I/O, no React.
 * Dependencies: src/domain/aircraftFiles.ts, src/domain/model.ts (types).
 *
 * A photo taken while offline, or while its flight is still in the outbox,
 * cannot be uploaded yet: the server learns of the flight only when the
 * outbox entry syncs. The outbox stays JSON; photo blobs queue beside it and
 * follow the same rules of ownership (the author's only) and program.
 */
import {
  hasAircraftFileTarget,
  type AircraftFileLink,
} from "../domain/aircraftFiles";
import type { Snapshot } from "../domain/model";

/** A photo kept on the device until its flight or work order has synced. */
export interface PendingLogbookPhoto extends AircraftFileLink {
  /** {@link pendingPhotoKey}: the record and the photo's own id. */
  key: string;
  aircraftUuid: string;
  authorId: string;
  /** The active Flight Program when queued; absent for unassigned records. */
  programUuid?: string;
  name: string;
  type: string;
  size: number;
  queuedAt: number;
  /** The server's refusal, kept for the Sync center; retried on request. */
  error?: string;
  blob: Blob;
}

/**
 * The key a queued photo is stored under. The id is generated for each photo
 * queued, never taken from the file name: a phone names every camera capture
 * "image.jpg", and a name key let the second page photo replace the first.
 *
 * @param link - The flight or work order.
 * @param photoId - The photo's id, unique on the device.
 * @returns `<linkedUuid>:<photoId>`. Photos queued before ids were generated
 *   keep their `<linkedUuid>:<name>` key.
 */
export function pendingPhotoKey(link: AircraftFileLink, photoId: string) {
  return `${link.linkedUuid}:${photoId}`;
}

/**
 * A queued photo moved to the flight that replaces its own: Edit and retry
 * saves a failed flight under a new id, and its photos follow it.
 *
 * @param photo - The queued photo.
 * @param flight - The replacing flight's uuid and aircraft.
 * @returns The photo under the new flight's key with the same photo id,
 *   without its old refusal.
 */
export function relinkPendingPhoto(
  photo: PendingLogbookPhoto,
  flight: { uuid: string; aircraftUuid: string },
): PendingLogbookPhoto {
  const link = { linkedKind: photo.linkedKind, linkedUuid: flight.uuid };
  return {
    ...photo,
    ...link,
    key: pendingPhotoKey(link, photo.key.slice(photo.key.indexOf(":") + 1)),
    aircraftUuid: flight.aircraftUuid,
    error: undefined,
  };
}

/**
 * The queued photos `userId` took on this device, in queue order.
 *
 * @param photos - The device's queue, oldest first.
 * @param userId - The signed-in user.
 */
export function ownPendingPhotos(
  photos: PendingLogbookPhoto[],
  userId: string,
): PendingLogbookPhoto[] {
  return photos.filter((p) => p.authorId === userId);
}

/**
 * The queued photos of one flight or work order, in queue order.
 *
 * @param photos - The device's queue, oldest first.
 * @param link - The flight or work order.
 */
export function pendingPhotosFor(
  photos: PendingLogbookPhoto[],
  link: AircraftFileLink,
): PendingLogbookPhoto[] {
  return photos.filter(
    (p) => p.linkedKind === link.linkedKind && p.linkedUuid === link.linkedUuid,
  );
}

/**
 * Whether a queued photo may be uploaded now: its author is signed in, its
 * program is active, and its flight or work order is in the snapshot, so the
 * server knows the record.
 *
 * @param photo - The queued photo.
 * @param s - The current snapshot.
 */
export function pendingPhotoReady(
  photo: PendingLogbookPhoto,
  s: Snapshot,
): boolean {
  return (
    photo.authorId === s.user.id &&
    photo.programUuid === s.activeProgramUuid &&
    hasAircraftFileTarget(s, photo.aircraftUuid, photo)
  );
}

/**
 * The photo as a File for upload.
 *
 * @param photo - The queued photo.
 * @returns A File with the queued name and type over the stored bytes.
 */
export function pendingPhotoFile(photo: PendingLogbookPhoto): File {
  return new File([photo.blob], photo.name, { type: photo.type });
}
