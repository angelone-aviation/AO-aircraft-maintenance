/**
 * Responsibility: Pins when the pilot view applies and the routes it keeps.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/pilotView.ts, src/data/demo.ts (seed).
 */
import { it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { isPilotView, pilotNavigation } from "./pilotView";
it("uses permissions in the active program and keeps full tools for mixed roles", () => {
  const s = demoSnapshot();
  s.user = {
    ...s.user,
    isAdmin: false,
    groupIds: ["pilot"],
    activeProgramUuid: "demo-program",
  };
  s.groups = [
    {
      id: "pilot",
      name: "Renamed pilot group",
      programUuid: "demo-program",
      aircraftIds: [],
      permissions: ["read", "flight", "discrepancy"],
    },
  ];
  expect(isPilotView(s)).toBe(true);
  s.groups.push({
    id: "maintenance",
    name: "Technicians",
    programUuid: "other",
    aircraftIds: [],
    permissions: ["read", "maintenance"],
  });
  s.user.groupIds.push("maintenance");
  expect(isPilotView(s)).toBe(true);
  s.groups[1].programUuid = "demo-program";
  expect(isPilotView(s)).toBe(false);
  s.user.groupIds = ["pilot"];
  s.groups[0].programAdmin = true;
  expect(isPilotView(s)).toBe(false);
  s.groups[0].programAdmin = false;
  s.groups[0].permissions = ["read"];
  expect(isPilotView(s)).toBe(false);
});

it("leaves the pilot view for resolve or system administrator access", () => {
  const s = demoSnapshot();
  s.user = {
    ...s.user,
    isAdmin: false,
    groupIds: ["pilot"],
    activeProgramUuid: "demo-program",
  };
  s.groups = [
    {
      id: "pilot",
      name: "Pilots",
      programUuid: "demo-program",
      aircraftIds: [],
      permissions: ["read", "flight", "resolve"],
    },
  ];
  expect(isPilotView(s)).toBe(false);
  s.groups[0].permissions = ["read", "flight"];
  expect(isPilotView(s)).toBe(true);
  s.user.isAdmin = true;
  expect(isPilotView(s)).toBe(false);
});

it("keeps the flight, discrepancy, manual and sync routes in the pilot view", () => {
  expect([...pilotNavigation]).toEqual([
    "/",
    "/flight-plans",
    "/checklists",
    "/flights",
    "/discrepancies",
    "/manuals",
    "/sync",
  ]);
});
