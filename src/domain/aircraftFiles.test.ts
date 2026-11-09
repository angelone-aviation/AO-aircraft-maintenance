/**
 * Responsibility: Pins the aircraft document rules: upload limits, the HEIC
 *   refusal, what a photo links to, who may write, and archiving a copy
 *   instead of deleting it.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/aircraftFiles.ts, programs.ts, rejection.ts,
 *   model.ts and workOrders.ts (types), src/data/demo.ts (fixture).
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { scopedSnapshot } from "./programs";
import type { Flight, Snapshot } from "./model";
import type { WorkOrder } from "./workOrders";
import {
  aircraftFileArchive,
  assertAircraftFileLink,
  assertAircraftFileRoom,
  assertAircraftFileTarget,
  hasAircraftFileTarget,
  isCurrentAircraftFile,
  assertAircraftFileWriter,
  linkedLogbookPhotos,
  MAX_AIRCRAFT_FILES,
  validateAircraftFile,
  validateAircraftUpload,
  validateLogbookPhoto,
  type AircraftFile,
} from "./aircraftFiles";
import { Rejection } from "./rejection";

const HEIC_REFUSAL =
  "HEIC photos are not accepted. Choose JPEG, PNG or WebP; on an iPhone set Camera > Formats to Most Compatible.";

function flight(s: Snapshot, uuid: string): Flight {
  return {
    uuid,
    aircraftUuid: s.aircraft[0].uuid,
    authorId: "demo-pilot",
    pilotId: "demo-pilot",
    submittedAt: 1,
    status: "accepted",
    startTime: "2026-03-04T10:00:00-07:00",
    hobbsOn: 3600,
    landings: 1,
    cycles: 1,
    origin: "A",
    destination: "B",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  };
}

function photo(over: Partial<AircraftFile>): AircraftFile {
  return {
    uuid: "p",
    aircraftUuid: "a",
    category: "logbook-page",
    linkedKind: "flight",
    linkedUuid: "f1",
    name: "page.jpg",
    type: "image/jpeg",
    size: 10,
    uploadedAt: 1,
    url: "data:image/jpeg;base64,",
    ...over,
  };
}

it("accepts the shared attachment types up to 7 MB", () => {
  for (const [name, type] of [
    ["337.pdf", "application/pdf"],
    ["337.jpg", "image/jpeg"],
    ["337.png", "image/png"],
    ["337.webp", "image/webp"],
  ])
    expect(() =>
      validateAircraftFile(name, type, 7 * 1024 * 1024),
    ).not.toThrow();
  expect(() => validateAircraftFile("337.heic", "image/heic", 10)).toThrow(
    "PDF, JPEG, PNG or WebP",
  );
  expect(() =>
    validateAircraftFile("337.pdf", "application/pdf", 7 * 1024 * 1024 + 1),
  ).toThrow("7 MB");
  expect(() => assertAircraftFileRoom(MAX_AIRCRAFT_FILES - 1)).not.toThrow();
  expect(() => assertAircraftFileRoom(MAX_AIRCRAFT_FILES)).toThrow("maximum");
});

it("lets maintenance upload and delete while readers only see the files", () => {
  const s = demoSnapshot();
  const aircraftUuid = s.aircraft[0].uuid;
  expect(() => assertAircraftFileWriter(s, aircraftUuid)).not.toThrow();
  const pilot = { ...s, user: s.members.find((m) => m.id === "demo-pilot")! };
  expect(() => assertAircraftFileWriter(pilot, aircraftUuid)).toThrow(
    "maintenance permission",
  );
  pilot.aircraftFiles = [
    {
      uuid: "f",
      aircraftUuid,
      category: "form-337",
      name: "337.pdf",
      type: "application/pdf",
      size: 10,
      uploadedAt: 1,
      url: "data:application/pdf;base64,",
    },
    // A file on an aircraft outside the reader's access is never shown.
    {
      uuid: "g",
      aircraftUuid: "elsewhere",
      category: "form-337",
      name: "other.pdf",
      type: "application/pdf",
      size: 10,
      uploadedAt: 1,
      url: "data:application/pdf;base64,",
    },
  ];
  expect(scopedSnapshot(pilot).aircraftFiles?.map((f) => f.uuid)).toEqual([
    "f",
  ]);
});

it("archives a current copy only with a reason, recording who and when", () => {
  const user = { id: "u1", name: "Casey Tech" };
  expect(() => aircraftFileArchive({}, user, "  ", 5)).toThrow(
    "Enter a reason for archiving this copy.",
  );
  expect(() => aircraftFileArchive({}, user, "x".repeat(501), 5)).toThrow(
    "500 characters",
  );
  const archived = aircraftFileArchive({}, user, " Superseded ", 5);
  expect(archived).toEqual({
    archivedAt: 5,
    archivedBy: { userId: "u1", name: "Casey Tech" },
    archiveReason: "Superseded",
  });
  expect(isCurrentAircraftFile({})).toBe(true);
  expect(isCurrentAircraftFile(archived)).toBe(false);
  expect(() => aircraftFileArchive(archived, user, "Again", 6)).toThrow(
    "already archived",
  );
});

it("refuses with a Rejection and the exact message", () => {
  const user = { id: "u1", name: "Casey Tech" };
  const refusals: [() => unknown, string][] = [
    [
      () => assertAircraftFileRoom(MAX_AIRCRAFT_FILES),
      "This aircraft already has the maximum of 200 current documents.",
    ],
    [
      () =>
        assertAircraftFileWriter(
          { ...demoSnapshot(), user: demoSnapshot().members[1] },
          demoSnapshot().aircraft[0].uuid,
        ),
      "Aircraft maintenance permission required.",
    ],
    [
      () => aircraftFileArchive({ archivedAt: 1 }, user, "Again", 6),
      "This copy is already archived.",
    ],
    [
      () => aircraftFileArchive({}, user, "  ", 5),
      "Enter a reason for archiving this copy.",
    ],
    [
      () => aircraftFileArchive({}, user, "x".repeat(501), 5),
      "Keep the reason for archiving to 500 characters.",
    ],
  ];
  for (const [refuse, message] of refusals) {
    expect(refuse).toThrow(Rejection);
    expect(refuse).toThrow(Error(message));
  }
  expect(() =>
    aircraftFileArchive({}, user, ` ${"x".repeat(500)} `, 5),
  ).not.toThrow();
});

it("refuses HEIC photos by type or name and otherwise applies the Form 337 checks", () => {
  for (const [name, type] of [
    ["IMG_0001.HEIC", "image/heic"],
    ["IMG_0001.heif", "image/heif"],
    ["IMG_0001.heic", ""],
    ["page.jpg", "image/heic"],
  ])
    expect(() => validateLogbookPhoto(name, type, 10)).toThrow(
      Error(HEIC_REFUSAL),
    );
  expect(() =>
    validateLogbookPhoto("page.jpg", "image/jpeg", 10),
  ).not.toThrow();
  expect(() =>
    validateLogbookPhoto("page.pdf", "application/pdf", 10),
  ).not.toThrow();
  expect(() => validateLogbookPhoto("page.gif", "image/gif", 10)).toThrow(
    "PDF, JPEG, PNG or WebP",
  );
  expect(() =>
    validateLogbookPhoto("page.jpg", "image/jpeg", 7 * 1024 * 1024 + 1),
  ).toThrow("7 MB");
  expect(() =>
    validateAircraftUpload("logbook-page", "x.heic", "image/heic", 10),
  ).toThrow(Rejection);
  // A Form 337 copy keeps the generic message, HEIC included.
  expect(() =>
    validateAircraftUpload("form-337", "x.heic", "image/heic", 10),
  ).toThrow("Choose a PDF, JPEG, PNG or WebP file.");
});

it("requires a photo to link to a flight or work order and a Form 337 copy not to", () => {
  const link = { linkedKind: "flight" as const, linkedUuid: "f1" };
  expect(() => assertAircraftFileLink("logbook-page", link)).not.toThrow();
  expect(() => assertAircraftFileLink("form-337", undefined)).not.toThrow();
  for (const bad of [
    undefined,
    { linkedKind: "flight" as const },
    { linkedUuid: "f1" },
  ])
    expect(() => assertAircraftFileLink("logbook-page", bad)).toThrow(
      Error("Link the photo to a flight or work order."),
    );
  expect(() => assertAircraftFileLink("form-337", link)).toThrow(
    Error("A Form 337 copy is not linked to a record."),
  );
});

it("lets a pilot attach a flight's photo while a signed page and Form 337 need maintenance", () => {
  const s = demoSnapshot();
  const aircraftUuid = s.aircraft[0].uuid;
  const pilot = { ...s, user: s.members.find((m) => m.id === "demo-pilot")! };
  expect(() =>
    assertAircraftFileWriter(pilot, aircraftUuid, "flight"),
  ).not.toThrow();
  expect(() =>
    assertAircraftFileWriter(pilot, aircraftUuid, "work-order"),
  ).toThrow(Error("Aircraft maintenance permission required."));
  expect(() => assertAircraftFileWriter(pilot, aircraftUuid)).toThrow(
    Error("Aircraft maintenance permission required."),
  );
  // The administrator holds every permission, so each kind passes.
  for (const kind of ["flight", "work-order", undefined] as const)
    expect(() => assertAircraftFileWriter(s, aircraftUuid, kind)).not.toThrow();
  const observer = { ...s, user: { ...s.user, isAdmin: false, groupIds: [] } };
  expect(() =>
    assertAircraftFileWriter(observer, aircraftUuid, "flight"),
  ).toThrow(Rejection);
  expect(() =>
    assertAircraftFileWriter(observer, aircraftUuid, "flight"),
  ).toThrow(Error("Aircraft flight permission required."));
});

it("finds a photo's flight or work order only on the aircraft it is filed on", () => {
  const s = demoSnapshot();
  const aircraftUuid = s.aircraft[0].uuid;
  s.flights = [flight(s, "f1")];
  const onFlight = { linkedKind: "flight" as const, linkedUuid: "f1" };
  expect(hasAircraftFileTarget(s, aircraftUuid, onFlight)).toBe(true);
  expect(hasAircraftFileTarget(s, s.aircraft[1].uuid, onFlight)).toBe(false);
  expect(() =>
    assertAircraftFileTarget(s, aircraftUuid, onFlight),
  ).not.toThrow();
  expect(() =>
    assertAircraftFileTarget(s, aircraftUuid, {
      ...onFlight,
      linkedUuid: "f2",
    }),
  ).toThrow(Error("Flight not found."));
  expect(() =>
    assertAircraftFileTarget(s, aircraftUuid, {
      linkedKind: "work-order",
      linkedUuid: "w1",
    }),
  ).toThrow(Error("Work order not found."));
  s.workOrders = [{ uuid: "w1", aircraftUuid } as unknown as WorkOrder];
  expect(
    hasAircraftFileTarget(s, aircraftUuid, {
      linkedKind: "work-order",
      linkedUuid: "w1",
    }),
  ).toBe(true);
});

it("lists a record's current photos oldest first, skipping archived ones and other records", () => {
  const files = [
    photo({ uuid: "late", uploadedAt: 3 }),
    photo({ uuid: "early", uploadedAt: 1 }),
    photo({ uuid: "archived", uploadedAt: 2, archivedAt: 5 }),
    photo({ uuid: "other-flight", linkedUuid: "f2" }),
    photo({ uuid: "work", linkedKind: "work-order", linkedUuid: "f1" }),
    photo({
      uuid: "form",
      category: "form-337",
      linkedKind: undefined,
      linkedUuid: undefined,
    }),
  ];
  const link = { linkedKind: "flight" as const, linkedUuid: "f1" };
  expect(linkedLogbookPhotos(files, link).map((f) => f.uuid)).toEqual([
    "early",
    "late",
  ]);
  expect(linkedLogbookPhotos(undefined, link)).toEqual([]);
});
