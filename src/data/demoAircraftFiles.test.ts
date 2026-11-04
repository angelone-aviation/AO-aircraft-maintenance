/**
 * Responsibility: Pins the demo aircraft files: the stored data URL, the
 *   change-log entries, and that archiving keeps the copy.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/demoAircraftFiles.ts, src/data/demo.ts.
 */
import { expect, it, vi } from "vitest";
import { demoAircraftFiles } from "./demoAircraftFiles";
import { demoSnapshot } from "./demo";
import type { Snapshot } from "../domain/model";

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

it("keeps an upload as a data URL and logs it", async () => {
  const { s, modify, audit, aircraft } = setup();
  await demoAircraftFiles.upload(modify, audit, aircraft, "form-337", pdf());
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
    { category: "form-337", name: "337.pdf", type: "application/pdf", size: 3 },
  );
});

it("archives a copy without deleting it, logging the reason", async () => {
  const { s, modify, audit, aircraft } = setup();
  await demoAircraftFiles.upload(modify, audit, aircraft, "form-337", pdf());
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
