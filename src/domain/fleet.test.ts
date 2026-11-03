import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  applyFleet,
  aircraftInputSchema,
  parseAdjustment,
  type Program,
} from "./fleet";
import {
  applyFlight,
  rebuildFlights,
  conflictReason,
  validateFlight,
} from "./flights";
import { componentTotals, type Component } from "./components";
import { totalSeconds, type Flight } from "./model";
const common = () => ({
  requestUuid: crypto.randomUUID(),
  reason: "Verified aircraft records",
});
const program: Program = {
  uuid: "program",
  version: 0,
  name: "Medical outreach",
  address: "Hangar 2",
  email: "ops@example.test",
  contactName: "Casey",
  website: "https://example.test",
};
describe("aircraft and programs", () => {
  it("creates a program, assigns its ID, and resolves renamed programs without changing aircraft counters", () => {
    const s = demoSnapshot();
    applyFleet(s, { ...common(), action: "program.save", program });
    s.user.activeProgramUuid = program.uuid;
    applyFleet(s, {
      ...common(),
      action: "aircraft.save",
      aircraft: {
        ...aircraftInputSchema.parse(s.aircraft[0]),
        uuid: "new-aircraft",
        registration: " n123xy ",
        programUuid: program.uuid,
        meter: "tach",
        adjustmentSeconds: 360000,
      },
    });
    const a = s.aircraft.find((a) => a.uuid === "new-aircraft")!;
    expect(a.registration).toBe("N123XY");
    expect(a.program).toBe("Medical outreach");
    expect(totalSeconds(a)).toBe(a.currentTach + 360000);
    applyFleet(s, {
      ...common(),
      action: "program.save",
      program: { ...program, version: 1, name: "Regional outreach" },
    });
    expect(s.aircraft.find((a) => a.uuid === "new-aircraft")?.version).toBe(0);
    expect(s.aircraft.find((a) => a.uuid === "new-aircraft")?.program).toBe(
      "Regional outreach",
    );
    expect(() =>
      applyFleet(s, { ...common(), action: "program.save", program }),
    ).toThrow("changed");
  });
  it("preserves installed component usage when total-time/cycle baselines are corrected", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0];
    const c: Component = {
      uuid: "c",
      version: 1,
      kind: "component",
      aircraftUuid: a.uuid,
      componentType: "Pump",
      partNumber: "P1",
      serial: "S1",
      manufacturer: "",
      notes: "",
      trackTime: true,
      trackCycles: true,
      trackCalendar: true,
      installed: true,
      installPosition: "MAIN",
      installedDate: "2026-01-01",
      installedSeconds: totalSeconds(a) - 36000,
      installedCycles: a.cycles - 10,
      timeSinceNew: 360000,
      timeSinceOverhaul: null,
      timeSinceRepair: null,
      cyclesSinceNew: 50,
      serviceDaysBase: 0,
    };
    s.management = [c];
    const before = componentTotals(c, a);
    const change = applyFleet(s, {
      ...common(),
      action: "aircraft.save",
      aircraft: {
        ...aircraftInputSchema.parse(a),
        adjustmentSeconds: 360000,
        cycles: a.cycles + 20,
      },
    });
    expect(componentTotals(change.components[0], change.aircraft)).toEqual(
      before,
    );
    expect(totalSeconds(change.aircraft!)).toBe(totalSeconds(a) + 360000);
    expect(JSON.parse(s.audit[0].before!).installedSeconds).toBe(
      c.installedSeconds,
    );
    expect(change.components[0].version).toBe(2);
  });
  it("replays meter/counter changes without overwriting historic flight readings", () => {
    const s = demoSnapshot(),
      a = s.aircraft[0];
    const first: Flight = {
      uuid: "f1",
      aircraftUuid: a.uuid,
      authorId: s.user.id,
      pilotId: s.user.id,
      submittedAt: 0,
      status: "accepted",
      startTime: "2026-01-01T10:00:00Z",
      hobbsOn: a.currentHobbs + 3600,
      cycles: 1,
      landings: 1,
      origin: "",
      destination: "",
      operation: "Mission",
      flightRules: "VFR",
      remarks: "",
      discrepancy: "",
    };
    s.aircraft[0] = applyFlight(a, first);
    const current = s.aircraft[0];
    const result = applyFleet(
      s,
      {
        ...common(),
        action: "aircraft.save",
        aircraft: {
          ...aircraftInputSchema.parse(current),
          meter: "tach",
          currentTach: 0,
          adjustmentSeconds: totalSeconds(current),
        },
      },
      Date.parse("2026-01-02T12:00:00Z"),
    );
    const next = result.aircraft!;
    expect(totalSeconds(next)).toBe(totalSeconds(current));
    expect(() => validateFlight(next, first)).not.toThrow();
    const second: Flight = {
      ...first,
      uuid: "f2",
      startTime: "2026-01-03T10:00:00Z",
      hobbsOn: undefined,
      tachOn: 3600,
    };
    const rebuilt = rebuildFlights(next, [first, second]);
    expect(rebuilt.flights[0]).toMatchObject({
      hobbsOff: a.currentHobbs,
      hobbsOn: first.hobbsOn,
    });
    expect(rebuilt.flights[1].tachOff).toBe(0);
    expect(rebuilt.aircraft.currentTach).toBe(3600);
    expect(totalSeconds(rebuilt.aircraft)).toBe(totalSeconds(current) + 3600);
    expect(conflictReason(next, first, next.version)).toContain(
      "counter change",
    );
  });
  it("validates adjustments, stale versions, program references, and scoped writes", () => {
    expect(parseAdjustment("-10.2")).toBe(-36720);
    expect(() => parseAdjustment("1.23")).toThrow("decimal");
    const s = demoSnapshot(),
      a = s.aircraft[0];
    const input = aircraftInputSchema.parse(a);
    expect(() =>
      applyFleet(s, {
        ...common(),
        action: "aircraft.save",
        aircraft: { ...input, adjustmentSeconds: -a.currentHobbs - 360 },
      }),
    ).toThrow("nonnegative");
    expect(() =>
      applyFleet(s, {
        ...common(),
        action: "aircraft.save",
        aircraft: { ...input, version: 99 },
      }),
    ).toThrow("changed");
    expect(() =>
      applyFleet(s, {
        ...common(),
        action: "aircraft.save",
        aircraft: { ...input, programUuid: "missing" },
      }),
    ).toThrow("Program not found");
    s.user = { ...s.user, isAdmin: false, groupIds: ["tech"] };
    s.groups = [
      {
        id: "tech",
        name: "Maintenance",
        programUuid: "demo-program",
        aircraftIds: [a.uuid],
        permissions: ["read", "maintenance"],
      },
    ];
    expect(() =>
      applyFleet(s, { ...common(), action: "program.save", program }),
    ).toThrow("Administrator");
    expect(() =>
      applyFleet(s, {
        ...common(),
        action: "aircraft.save",
        aircraft: { ...input, uuid: "new" },
      }),
    ).toThrow("permission");
    expect(
      applyFleet(s, {
        ...common(),
        action: "aircraft.save",
        aircraft: { ...input, model: "Updated model" },
      }).aircraft?.model,
    ).toBe("Updated model");
  });
});
