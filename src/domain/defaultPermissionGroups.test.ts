/**
 * Responsibility: Pins the starter permission groups and how missing ones are
 *   found.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/defaultPermissionGroups.ts.
 */
import { expect, it } from "vitest";
import {
  defaultPermissionGroups,
  missingDefaultGroups,
} from "./defaultPermissionGroups";

it("starts owners with no aircraft, only program managers as admins and the board read-only", () => {
  expect(
    defaultPermissionGroups.map((g) => [
      g.name,
      !!g.programAdmin,
      !!g.owner,
      !!g.board,
    ]),
  ).toEqual([
    ["Observers", false, false, false],
    ["Pilots", false, false, false],
    ["Maintenance technicians", false, false, false],
    ["Program managers", true, false, false],
    ["Aircraft owners", false, true, false],
    ["Board (read-only)", false, false, true],
  ]);
  expect(defaultPermissionGroups.every((g) => !g.aircraftIds.length)).toBe(
    true,
  );
});

it("matches existing groups by name, ignoring case and surrounding spaces", () => {
  const missing = missingDefaultGroups([
    { name: "  pilots " },
    { name: "PROGRAM MANAGERS" },
    { name: "Flyers" },
  ]);
  expect(missing.map((g) => g.name)).toEqual([
    "Observers",
    "Maintenance technicians",
    "Aircraft owners",
    "Board (read-only)",
  ]);
});
