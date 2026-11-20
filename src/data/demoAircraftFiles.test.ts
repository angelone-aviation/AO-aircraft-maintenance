/**
 * Responsibility: Pins the demo aircraft files: the stored data URL, the
 *   change-log entries, a photo's link to its flight, the separate caps, and
 *   that archiving keeps the copy.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/demoAircraftFiles.ts, src/data/demo.ts,
 *   src/domain/model.ts and aircraftFiles.ts (types).
 */
import { expect, it, vi } from "vitest";
import { demoAircraftFiles } from "./demoAircraftFiles";
import { demoSnapshot } from "./demo";
import type { Flight, Snapshot } from "../domain/model";
import type { AircraftFileCategory } from "../domain/aircraftFiles";

function setup() {
  const s = demoSnapshot();
  const modify = async (fn: (s: Snapshot) => void) => fn(s);
  const audit = vi.fn();
  return { s, modify, audit, aircraft: s.aircraft[0].uuid };
}

const pdf = () =>
  new File(
    [new TextEncoder().encode("%PDF-"), new Uint8Array([0, 255, 65])],
    "337.pdf",
    {
      type: "application/pdf",
    },
  );
const jpeg = () =>
  new File([new Uint8Array([255, 216, 255])], "line.jpg", {
    type: "image/jpeg",
  });
const form337 = (aircraftUuid: string) => ({
  aircraftUuid,
  category: "form-337" as const,
});

function flight(aircraftUuid: string, uuid: string): Flight {
  return {
    uuid,
    aircraftUuid,
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

it("refuses a file whose first bytes are not its declared type, as the server does", async () => {
  const { s, modify, audit, aircraft } = setup();
  const svg = new File(["<svg/>"], "page.png", { type: "image/png" });
  await expect(
    demoAircraftFiles.upload(modify, audit, form337(aircraft), svg),
  ).rejects.toThrow("This file's contents do not match its type.");
  expect(s.aircraftFiles ?? []).toEqual([]);
  expect(audit).not.toHaveBeenCalled();
});

it("caps Form 337 copies and logbook page photos apart, as the server does", async () => {
  const { s, modify, audit, aircraft } = setup();
  const copy = (category: AircraftFileCategory, i: number) => ({
    uuid: `${category}-${i}`,
    aircraftUuid: aircraft,
    category,
    name: `${i}.pdf`,
    type: "application/pdf",
    size: 1,
    uploadedAt: i,
    url: "",
  });
  s.aircraftFiles = Array.from({ length: 499 }, (_, i) =>
    copy("logbook-page", i),
  );
  await demoAircraftFiles.upload(modify, audit, form337(aircraft), pdf());
  s.aircraftFiles.push(copy("logbook-page", 499));
  s.flights = [flight(aircraft, "f1")];
  await expect(
    demoAircraftFiles.upload(
      modify,
      audit,
      {
        ...form337(aircraft),
        category: "logbook-page",
        linkedKind: "flight",
        linkedUuid: "f1",
      },
      jpeg(),
    ),
  ).rejects.toThrow(
    "This aircraft already has the maximum of 500 current logbook page photos.",
  );
  expect(s.aircraftFiles).toHaveLength(501);
});

it("keeps an upload as a data URL and logs it", async () => {
  const { s, modify, audit, aircraft } = setup();
  await demoAircraftFiles.upload(modify, audit, form337(aircraft), pdf());
  expect(s.aircraftFiles).toMatchObject([
    { aircraftUuid: aircraft, url: "data:application/pdf;base64,JVBERi0A/0E=" },
  ]);
  expect(audit).toHaveBeenCalledWith(
    s,
    "aircraft.file_uploaded",
    aircraft,
    aircraft,
    undefined,
    undefined,
    {
      category: "form-337",
      linkedKind: undefined,
      linkedUuid: undefined,
      name: "337.pdf",
      type: "application/pdf",
      size: 8,
    },
  );
});

it("files a logbook page photo against a flight on the aircraft and lets the pilot archive it", async () => {
  const { s, modify, audit, aircraft } = setup();
  s.flights = [flight(aircraft, "f1")];
  s.user = s.members.find((m) => m.id === "demo-pilot")!;
  const photo = {
    aircraftUuid: aircraft,
    category: "logbook-page" as const,
    linkedKind: "flight" as const,
    linkedUuid: "f1",
  };
  await expect(
    demoAircraftFiles.upload(
      modify,
      audit,
      { ...photo, linkedUuid: "f2" },
      jpeg(),
    ),
  ).rejects.toThrow("Flight not found.");
  await expect(
    demoAircraftFiles.upload(
      modify,
      audit,
      { ...photo, linkedKind: undefined, linkedUuid: undefined },
      jpeg(),
    ),
  ).rejects.toThrow("Link the photo to a flight or work order.");
  await expect(
    demoAircraftFiles.upload(modify, audit, form337(aircraft), pdf()),
  ).rejects.toThrow("Aircraft maintenance permission required.");
  await demoAircraftFiles.upload(modify, audit, photo, jpeg());
  expect(s.aircraftFiles).toMatchObject([
    {
      linkedKind: "flight",
      linkedUuid: "f1",
      url: "data:image/jpeg;base64,/9j/",
    },
  ]);
  expect(audit).toHaveBeenLastCalledWith(
    s,
    "aircraft.file_uploaded",
    aircraft,
    aircraft,
    undefined,
    undefined,
    expect.objectContaining({ category: "logbook-page", linkedUuid: "f1" }),
  );
  await demoAircraftFiles.archive(
    modify,
    audit,
    s.aircraftFiles![0].uuid,
    "Blurry",
  );
  expect(s.aircraftFiles![0]).toMatchObject({ archiveReason: "Blurry" });
});

it("archives a copy without deleting it, logging the reason", async () => {
  const { s, modify, audit, aircraft } = setup();
  await demoAircraftFiles.upload(modify, audit, form337(aircraft), pdf());
  const file = s.aircraftFiles![0];
  await demoAircraftFiles.archive(modify, audit, file.uuid, " Superseded ");
  expect(s.aircraftFiles).toEqual([
    expect.objectContaining({ url: file.url, archiveReason: "Superseded" }),
  ]);
  expect(audit).toHaveBeenLastCalledWith(
    s,
    "aircraft.file_archived",
    aircraft,
    aircraft,
    "Superseded",
    expect.objectContaining({ name: "337.pdf" }),
    expect.objectContaining({ archiveReason: "Superseded" }),
  );
  await expect(
    demoAircraftFiles.archive(modify, audit, "missing", "x"),
  ).rejects.toThrow("Document not found.");
});
