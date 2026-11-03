import { it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { isPilotView } from "./pilotView";
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
