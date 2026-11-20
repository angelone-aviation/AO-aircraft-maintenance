/**
 * Responsibility: Pins the demo's file links: the copy it keeps for each file
 *   the demo user's own view lists, none for others, and the board refusal.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/data/demoFileLinks.ts, src/data/demo.ts,
 *   src/domain (programs, fileLinks, rejection).
 */
import { expect, it } from "vitest";
import { demoFileLinks } from "./demoFileLinks";
import { demoSnapshot, withDemoRole } from "./demo";
import { scopedSnapshot } from "../domain/programs";
import { FILE_LINK_TTL_MS } from "../domain/fileLinks";
import { Rejection } from "../domain/rejection";
import type { Snapshot } from "../domain/model";

const NOW = 1_000_000;

function withFiles(): Snapshot {
  const s = demoSnapshot();
  const a = s.aircraft[0].uuid;
  const file = (uuid: string, category: "form-337" | "logbook-page") => ({
    uuid,
    aircraftUuid: a,
    category,
    name: `${uuid}.pdf`,
    type: "application/pdf",
    size: 3,
    uploadedAt: 1,
    url: `data:application/pdf;base64,${btoa(uuid)}`,
  });
  return {
    ...s,
    aircraft: s.aircraft.map((x, i) =>
      i === 0 ? { ...x, photoUrl: "data:image/png;base64,cGhvdG8=" } : x,
    ),
    aircraftFiles: [
      file("copy", "form-337"),
      {
        ...file("line", "logbook-page"),
        linkedKind: "flight",
        linkedUuid: "f",
      },
    ],
  };
}

it("hands the demo user the stored copy of each file their view lists", () => {
  const s = scopedSnapshot(withFiles());
  const a = s.aircraft[0].uuid;
  expect(
    demoFileLinks(
      s,
      [
        { kind: "aircraftFile", id: "copy" },
        { kind: "aircraftPhoto", id: a },
        { kind: "aircraftPhoto", id: s.aircraft[1].uuid },
        { kind: "workOrderFile", id: "missing" },
      ],
      NOW,
    ),
  ).toEqual([
    {
      url: `data:application/pdf;base64,${btoa("copy")}`,
      expiresAt: NOW + FILE_LINK_TTL_MS,
    },
    {
      url: "data:image/png;base64,cGhvdG8=",
      expiresAt: NOW + FILE_LINK_TTL_MS,
    },
    null,
    null,
  ]);
});

it("keeps the owner preview to its portal's files and refuses the board preview", () => {
  const owner = scopedSnapshot(withDemoRole(withFiles(), "owner"));
  const opened = demoFileLinks(
    owner,
    [
      { kind: "aircraftFile", id: "copy" },
      { kind: "aircraftFile", id: "line" },
    ],
    NOW,
  ).map((link) => link !== null);
  // The demo owner owns demo-206: its current Form 337 copy only.
  expect(owner.aircraft.map((a) => a.uuid)).toEqual(["demo-206"]);
  expect(opened).toEqual([true, false]);
  const board = scopedSnapshot(withDemoRole(withFiles(), "board"));
  expect(() =>
    demoFileLinks(board, [{ kind: "aircraftFile", id: "copy" }], NOW),
  ).toThrow(new Rejection("Files are not available in the board view."));
});

it("hands over the demo's purchase-order files and license copies, but not manuals", () => {
  const s: Snapshot = {
    ...scopedSnapshot(withFiles()),
    purchaseOrderFiles: [
      {
        uuid: "invoice",
        poUuid: "po",
        name: "invoice.pdf",
        type: "application/pdf",
        size: 3,
        uploadedAt: 1,
        url: "data:application/pdf;base64,aW52",
      },
    ],
    certificationFiles: [
      {
        id: "license",
        userId: "demo-admin",
        kind: "mechanic",
        name: "license.pdf",
        type: "application/pdf",
        size: 3,
        uploadedAt: 1,
        url: "data:application/pdf;base64,bGlj",
      },
    ],
  };
  expect(
    demoFileLinks(
      s,
      [
        { kind: "poFile", id: "invoice" },
        { kind: "certificationFile", id: "license" },
        { kind: "manual", id: "any" },
      ],
      NOW,
    ).map((link) => link?.url ?? null),
  ).toEqual([
    "data:application/pdf;base64,aW52",
    "data:application/pdf;base64,bGlj",
    null,
  ]);
});
