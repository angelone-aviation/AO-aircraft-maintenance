/**
 * Responsibility: Pins the aircraft document rules: upload limits, who may
 *   write, and archiving a copy instead of deleting it.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/aircraftFiles.ts, programs.ts, rejection.ts,
 *   src/data/demo.ts (fixture).
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { scopedSnapshot } from "./programs";
import {
  aircraftFileArchive,
  assertAircraftFileRoom,
  isCurrentAircraftFile,
  assertAircraftFileWriter,
  MAX_AIRCRAFT_FILES,
  validateAircraftFile,
} from "./aircraftFiles";
import { Rejection } from "./rejection";

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
