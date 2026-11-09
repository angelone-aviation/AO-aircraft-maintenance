/**
 * Responsibility: Pins the demo aircraft files: the stored data URL, the
 *   change-log entries, a photo's link to its flight, and that archiving
 *   keeps the copy.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/demoAircraftFiles.ts, src/data/demo.ts,
 *   src/domain/model.ts (types).
 */
import { expect, it, vi } from "vitest";
import { demoAircraftFiles } from "./demoAircraftFiles";
import { demoSnapshot } from "./demo";
import type { Flight, Snapshot } from "../domain/model";

function setup() {
  const s = demoSnapshot();
  const modify = async (fn: (s: Snapshot) => void) => fn(s);
  const audit = vi.fn();
  return { s, modify, audit, aircraft: s.aircraft[0].uuid };
}

const pdf = () =>
  new File([new Uint8Array([0, 255, 65])], "337.pdf", {
    type: "application/pdf",
  });
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

it("keeps an upload as a data URL and logs it", async () => {
  const { s, modify, audit, aircraft } = setup();
  await demoAircraftFiles.upload(modify, audit, form337(aircraft), pdf());
  expect(s.aircraftFiles).toMatchObject([
    { aircraftUuid: aircraft, url: "data:application/pdf;base64,AP9B" },
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
      size: 3,
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
