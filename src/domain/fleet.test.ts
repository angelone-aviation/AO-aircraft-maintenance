/**
 * Responsibility: Pins saving Flight Programs and aircraft: the refusals and
 *   their order, counter changes, and installed-component baselines.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/fleet.ts, flights.ts, components.ts, model.ts,
 *   rejection.ts, src/data/demo.ts (fixture).
 */
import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  applyFleet,
  aircraftInputSchema,
  normalizeWebsite,
  parseAdjustment,
  programSchema,
  type AircraftInput,
  type FleetCommand,
  type Program,
} from "./fleet";
import { Rejection } from "./rejection";
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
  it("links a typed website, keeping anything that reads as a scheme", () => {
    expect(normalizeWebsite(" example.org ")).toBe("https://example.org");
    expect(normalizeWebsite("//example.org")).toBe("https://example.org");
    expect(normalizeWebsite("HTTP://example.org")).toBe("HTTP://example.org");
    expect(normalizeWebsite("mailto:ops@example.org")).toBe(
      "mailto:ops@example.org",
    );
    expect(normalizeWebsite(" ")).toBe("");
    const website = (value: string) =>
      programSchema.safeParse({ ...program, website: value });
    expect(website("example.org").data?.website).toBe("https://example.org");
    expect(website("mailto:ops@example.org").error?.issues[0].message).toBe(
      "Enter a valid website address.",
    );
    // Characterizes current behaviour: a host with a port reads as a scheme,
    // so it is kept as typed and then refused.
    expect(normalizeWebsite("example.org:8080")).toBe("example.org:8080");
    expect(website("example.org:8080").success).toBe(false);
  });
  it("refuses adjustments with a Rejection", () => {
    expect(() => parseAdjustment("1.23")).toThrow(Rejection);
    expect(() => parseAdjustment("9".repeat(20))).toThrow(
      Error("Total time adjustment is too large."),
    );
    expect(() => parseAdjustment("9".repeat(20))).toThrow(Rejection);
  });
  it("writes a structured program address into the text fields", () => {
    const s = demoSnapshot();
    const { program: saved } = applyFleet(s, {
      ...common(),
      action: "program.save",
      program: {
        ...program,
        addressDetails: {
          organization: "",
          street: "1 Ramp Road",
          street2: "",
          city: "Salina",
          region: "KS",
          postalCode: "67401",
          country: "US",
          contactName: "Robin",
          email: "robin@example.test",
          phone: "",
          confirmed: false,
        },
      },
    });
    expect(saved).toMatchObject({
      address:
        "1 Ramp Road\nSalina, KS, 67401\nUS\nContact: Robin\nEmail: robin@example.test",
      email: "robin@example.test",
      contactName: "Robin",
      version: 1,
    });
  });
  it("times a counter change after the latest flight when the clock is behind", () => {
    const s = demoSnapshot();
    s.aircraft[0].latestFlightAt = "2030-01-01T00:00:00.000Z";
    const saved = applyFleet(
      s,
      {
        ...common(),
        action: "aircraft.save",
        aircraft: { ...aircraftInputSchema.parse(s.aircraft[0]), cycles: 1 },
      },
      Date.parse("2026-01-01T00:00:00Z"),
    ).aircraft!;
    expect(saved.counterEvents!.at(-1)!.at).toBe("2030-01-01T00:00:00.001Z");
  });
});

function refusal(s: Parameters<typeof applyFleet>[0], command: FleetCommand) {
  try {
    applyFleet(s, command);
  } catch (error) {
    return [error instanceof Rejection, (error as Error).message];
  }
  return [false, "saved"];
}

describe("fleet refusals", () => {
  it("refuses a program save in check order, each as a Rejection", () => {
    const s = demoSnapshot();
    s.programs!.push({ ...program, uuid: "other", name: "Other" });
    const save = (p: Program) =>
      refusal(s, { ...common(), action: "program.save", program: p });
    const current = { ...s.programs![0], name: "OTHER", version: 9 };
    s.user = { ...s.user, active: false, isAdmin: false };
    expect(save(current)).toEqual([true, "An active account is required."]);
    s.user.active = true;
    expect(save(current)).toEqual([true, "Administrator permission required."]);
    s.user.isAdmin = true;
    expect(save(current)).toEqual([
      true,
      "Program changed. Refresh and try again.",
    ]);
    expect(save({ ...current, version: 1 })).toEqual([
      true,
      "Program name already exists.",
    ]);
    expect(save({ ...current, version: 1, name: "Renamed" })).toEqual([
      false,
      "saved",
    ]);
  });
  it("refuses an aircraft save in check order, each as a Rejection", () => {
    const s = demoSnapshot();
    const [a, b] = s.aircraft;
    s.programs!.push({ ...program, uuid: "other", name: "Other" });
    s.user = { ...s.user, isAdmin: false, groupIds: ["crew"] };
    s.groups = [
      {
        id: "crew",
        name: "Crew",
        programUuid: "demo-program",
        aircraftIds: [],
        permissions: ["read"],
      },
    ];
    s.management = [
      {
        uuid: "pump",
        version: 1,
        kind: "component",
        aircraftUuid: a.uuid,
        componentType: "Pump",
        partNumber: "P1",
        serial: "S1",
        manufacturer: "",
        notes: "",
        trackTime: true,
        trackCycles: false,
        trackCalendar: false,
        installed: true,
        installPosition: "MAIN",
        installedDate: "2026-01-01",
        installedSeconds: 0,
        installedCycles: 0,
        timeSinceNew: 0,
        timeSinceOverhaul: null,
        timeSinceRepair: null,
        cyclesSinceNew: 0,
        serviceDaysBase: 0,
      },
    ];
    a.programUuid = "other";
    const input = {
      ...aircraftInputSchema.parse(a),
      programUuid: "missing",
      version: a.version + 1,
      meter: "cyclic" as AircraftInput["meter"],
      helicopter: false,
      registration: b.registration.toLowerCase(),
      adjustmentSeconds: -totalSeconds(a) - 3600,
    };
    const save = () =>
      refusal(s, { ...common(), action: "aircraft.save", aircraft: input });
    expect(save()).toEqual([
      true,
      "Aircraft belongs to another Flight Program.",
    ]);
    a.programUuid = "demo-program";
    expect(save()).toEqual([true, "Program not found."]);
    input.programUuid = "other";
    expect(save()).toEqual([true, "Use an explicit Flight Program transfer."]);
    input.programUuid = "demo-program";
    expect(save()).toEqual([true, "Aircraft management permission required."]);
    s.groups[0].permissions.push("maintenance");
    expect(save()).toEqual([true, "Aircraft changed. Refresh before saving."]);
    input.version = a.version;
    expect(save()).toEqual([
      true,
      "Select Helicopter and enter a Collective hourmeter reading to use it as the time source.",
    ]);
    input.meter = "flightTimeLog";
    expect(save()).toEqual([
      true,
      "Select Flight time log and enter its reading to use it as the time source.",
    ]);
    input.meter = a.meter;
    expect(save()).toEqual([true, "Registration already exists."]);
    input.registration = a.registration;
    expect(save()).toEqual([true, "Aircraft total time must be nonnegative."]);
    input.adjustmentSeconds = a.adjustmentSeconds - 360;
    expect(save()).toEqual([
      true,
      "Aircraft readings would invalidate an installed component baseline. Review the verified readings.",
    ]);
    input.adjustmentSeconds = a.adjustmentSeconds;
    expect(save()).toEqual([false, "saved"]);
  });
});
