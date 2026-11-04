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

it("starts owners with no aircraft and only program managers as admins", () => {
  expect(
    defaultPermissionGroups.map((g) => [g.name, !!g.programAdmin, !!g.owner]),
  ).toEqual([
    ["Observers", false, false],
    ["Pilots", false, false],
    ["Maintenance technicians", false, false],
    ["Program managers", true, false],
    ["Aircraft owners", false, true],
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
  ]);
});
