/**
 * Responsibility: Pins the photo queue rules: the storage key, whose photos
 *   are shown, which belong to a record, when one may upload, and how one
 *   follows a replaced flight.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/logbookPhotos.ts, src/data/demo.ts,
 *   src/domain/model.ts (types).
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "./demo";
import type { Flight } from "../domain/model";
import {
  ownPendingPhotos,
  pendingPhotoFile,
  pendingPhotoKey,
  pendingPhotoReady,
  pendingPhotosFor,
  relinkPendingPhoto,
  type PendingLogbookPhoto,
} from "./logbookPhotos";

const LINK = { linkedKind: "flight" as const, linkedUuid: "f1" };

function photo(over: Partial<PendingLogbookPhoto>): PendingLogbookPhoto {
  return {
    key: "f1:line.jpg",
    aircraftUuid: "a",
    ...LINK,
    authorId: "demo-admin",
    programUuid: "demo-program",
    name: "line.jpg",
    type: "image/jpeg",
    size: 2,
    queuedAt: 1,
    blob: new Blob([new Uint8Array([1, 2])]),
    ...over,
  };
}

it("keys a photo by its record and its own id", () => {
  expect(pendingPhotoKey(LINK, "p1")).toBe("f1:p1");
});

it("moves a photo to a replacing flight under that flight's key, clearing its refusal", () => {
  const moved = relinkPendingPhoto(
    photo({ key: "f1:p1", error: "Flight not found." }),
    { uuid: "f2", aircraftUuid: "b" },
  );
  expect(moved).toMatchObject({
    key: "f2:p1",
    linkedKind: "flight",
    linkedUuid: "f2",
    aircraftUuid: "b",
    name: "line.jpg",
  });
  expect(moved.error).toBeUndefined();
  // A photo queued under the earlier name key keeps its name as its id.
  expect(
    relinkPendingPhoto(photo({}), { uuid: "f2", aircraftUuid: "b" }).key,
  ).toBe("f2:line.jpg");
});

it("filters the queue by author and by record", () => {
  const mine = photo({});
  const theirs = photo({ authorId: "demo-pilot", key: "f1:other.jpg" });
  const onWork = photo({ linkedKind: "work-order", key: "f1:w.jpg" });
  const queue = [mine, theirs, onWork];
  expect(ownPendingPhotos(queue, "demo-admin")).toEqual([mine, onWork]);
  expect(pendingPhotosFor(queue, LINK)).toEqual([mine, theirs]);
  expect(pendingPhotosFor(queue, { ...LINK, linkedUuid: "f2" })).toEqual([]);
});

it("is ready only for the signed-in author, the active program and a synced record", () => {
  const s = demoSnapshot();
  const aircraftUuid = s.aircraft[0].uuid;
  const flight = { uuid: "f1", aircraftUuid } as Flight;
  const ready = photo({ aircraftUuid, programUuid: s.activeProgramUuid });
  expect(pendingPhotoReady(ready, s)).toBe(false);
  s.flights = [flight];
  expect(pendingPhotoReady(ready, s)).toBe(true);
  expect(pendingPhotoReady({ ...ready, authorId: "demo-pilot" }, s)).toBe(
    false,
  );
  expect(pendingPhotoReady({ ...ready, programUuid: "other" }, s)).toBe(false);
  expect(
    pendingPhotoReady({ ...ready, aircraftUuid: s.aircraft[1].uuid }, s),
  ).toBe(false);
});

it("rebuilds the upload file from the queued bytes, name and type", async () => {
  const file = pendingPhotoFile(photo({}));
  expect([file.name, file.type, file.size]).toEqual([
    "line.jpg",
    "image/jpeg",
    2,
  ]);
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(
    new Uint8Array([1, 2]),
  );
});
