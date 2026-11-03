import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Flight, Snapshot } from "./model";
import type { ManagedRecord, Stock } from "./management";
import {
  FlightRejection,
  submitOperation,
  type FlightOperation,
  type DiscrepancyOperation,
} from "./flightSubmission";
import { applyFlight } from "./flights";

const now = Date.parse("2026-10-20T12:00:00Z");
const options = { now, today: "2026-10-20" };
const location: ManagedRecord = {
  kind: "location",
  uuid: "oil-store",
  version: 0,
  programUuid: "demo-program",
  name: "Oil store",
  address: "",
  contact: "",
};
const oilStock = (over: Partial<Stock> = {}): Stock => ({
  kind: "stock",
  uuid: "oil-part",
  version: 0,
  programUuid: "demo-program",
  locationUuid: "oil-store",
  partNumber: "OIL-1",
  description: "Engine oil quart",
  category: "supply",
  condition: "new",
  alternates: "",
  quantity: 5,
  minimum: 0,
  vendor: "",
  invoiceNumber: "",
  poRef: "",
  cost: 0,
  oil: true,
  ...over,
});
// The demo program with nothing grounding its first aircraft.
function world(): Snapshot {
  const s = demoSnapshot();
  s.discrepancies = [];
  s.inspections = [];
  s.management = [location, oilStock()];
  s.airworthiness = [];
  return s;
}
function flight(
  s: Snapshot,
  over: Partial<FlightOperation["input"]> = {},
  op: Partial<FlightOperation> = {},
): FlightOperation {
  const a = s.aircraft[0];
  return {
    kind: "flight",
    programUuid: "demo-program",
    uuid: "11111111-1111-4111-8111-111111111111",
    authorId: s.user.id,
    baseVersion: a.version,
    input: {
      aircraftUuid: a.uuid,
      pilotId: s.user.id,
      startTime: "2026-10-20T10:00:00Z",
      hobbsOn: a.currentHobbs + 3600,
      tachOn: a.currentTach + 3240,
      landings: 2,
      cycles: 1,
      origin: "AAA",
      destination: "BBB",
      operation: "Mission",
      flightRules: "VFR",
      remarks: "",
      discrepancy: "",
      ...over,
    },
    ...op,
  };
}
const oilAdded = (stockUuid = "oil-part") => ({
  oil: [
    {
      engine: "single" as const,
      unit: "US qt" as const,
      start: 6,
      added: 1,
      inventory: { locationUuid: "oil-store", stockUuid, quantity: 1 },
    },
  ],
});
const rejection = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a rejection.");
};

describe("submitting a flight", () => {
  it("accepts an in-sequence flight, applies its counters and audits it", () => {
    const s = world();
    const op = flight(s);
    const { status, changes } = submitOperation(s, op, options);
    expect(status).toBe("accepted");
    expect(changes!.flight).toMatchObject({
      uuid: op.uuid,
      authorId: op.authorId,
      submittedAt: now,
      status: "accepted",
      hobbsOff: s.aircraft[0].currentHobbs,
      tachOff: s.aircraft[0].currentTach,
    });
    expect(changes!.aircraft).toEqual(applyFlight(s.aircraft[0], op.input));
    expect(changes!.stock).toEqual([]);
    expect(changes!.discrepancy).toBeUndefined();
    expect(changes!.audit).toEqual([
      {
        action: "flight.created",
        entityUuid: op.uuid,
        aircraftUuid: s.aircraft[0].uuid,
        after: changes!.flight,
      },
    ]);
  });
  it("holds a stale or out-of-sequence flight for review without changing totals", () => {
    const s = world();
    const stale = submitOperation(
      s,
      flight(s, {}, { baseVersion: s.aircraft[0].version + 1 }),
      options,
    );
    expect(stale.status).toBe("review");
    expect(stale.changes!.aircraft).toBeUndefined();
    expect(stale.changes!.flight!.reviewReason).toBe(
      "Aircraft totals changed after this entry was started.",
    );
    expect(stale.changes!.audit.map((e) => e.action)).toEqual(["flight.held"]);
    s.aircraft[0].counterEvents = [
      {
        at: "2026-10-20T11:00:00Z",
        meter: "hobbs",
        adjustmentSeconds: 0,
        currentHobbs: s.aircraft[0].currentHobbs,
        currentTach: s.aircraft[0].currentTach,
        cycles: s.aircraft[0].cycles,
        landings: s.aircraft[0].landings,
      },
    ];
    const predates = submitOperation(s, flight(s), options);
    expect(predates.status).toBe("review");
    expect(predates.changes!.flight!.reviewReason).toBe(
      "Flight predates an aircraft counter change and requires chronology review.",
    );
  });
  it("files the flight's problem report, trimmed", () => {
    const s = world();
    const op = flight(s, { discrepancy: "  Landing light out  " });
    const { changes } = submitOperation(s, op, options);
    expect(changes!.discrepancy).toEqual({
      uuid: op.uuid + "-discrepancy",
      aircraftUuid: s.aircraft[0].uuid,
      flightUuid: op.uuid,
      description: "Landing light out",
      status: "open",
      authorId: op.authorId,
      createdAt: now,
    });
  });
  it("draws down oil stock and audits only the stock id and quantities", () => {
    const s = world();
    const op = flight(s, oilAdded());
    const { changes } = submitOperation(s, op, options);
    expect(changes!.stock).toHaveLength(1);
    expect(changes!.stock[0].after).toMatchObject({ quantity: 4, version: 1 });
    expect(changes!.audit[0]).toEqual({
      action: "stock.oil_used",
      entityUuid: "oil-part",
      programUuid: "demo-program",
      aircraftUuid: s.aircraft[0].uuid,
      reason: `Oil added for flight ${op.uuid}`,
      before: { stockUuid: "oil-part", quantity: 5 },
      after: { stockUuid: "oil-part", quantity: 4 },
    });
    expect(changes!.audit[1].action).toBe("flight.created");
  });
  it("refuses stock that is not oil, or an expired lot, with a message the Sync center shows", () => {
    const tire = world();
    tire.management = [
      location,
      oilStock({ uuid: "tire", partNumber: "TIRE-1", oil: undefined }),
    ];
    const notOil = rejection(() =>
      submitOperation(tire, flight(tire, oilAdded("tire")), options),
    );
    expect(notOil).toBeInstanceOf(FlightRejection);
    expect((notOil as Error).message).toMatch(/TIRE-1 is not marked as oil/);
    const expired = world();
    expired.management = [location, oilStock({ expirationDate: "2026-09-20" })];
    const lot = rejection(() =>
      submitOperation(expired, flight(expired, oilAdded()), options),
    );
    expect(lot).toBeInstanceOf(FlightRejection);
    expect((lot as Error).message).toBe(
      "OIL-1 expired on 2026-09-20. Expired stock cannot be issued or reserved.",
    );
  });
  it("re-checks the dispatch gate and records an administrator's override", () => {
    const s = world();
    s.discrepancies = [
      {
        uuid: "grounding",
        aircraftUuid: s.aircraft[0].uuid,
        description: "Cracked windshield",
        grounding: true,
        status: "open",
        authorId: s.user.id,
        createdAt: now,
      },
    ];
    const grounded = rejection(() => submitOperation(s, flight(s), options));
    expect(grounded).toBeInstanceOf(FlightRejection);
    expect((grounded as Error).message).toMatch(
      /is grounded: Open discrepancy/,
    );
    const reason = "Ferry flight to the repair station";
    const op = flight(s, {}, { dispatchOverrideReason: reason });
    const { changes } = submitOperation(s, op, options);
    const override = { by: s.user.id, name: s.user.name, reason, at: now };
    expect(changes!.flight!.dispatchOverride).toEqual(override);
    expect(changes!.audit.at(-1)).toEqual({
      action: "flight.dispatch_override",
      entityUuid: op.uuid,
      programUuid: "demo-program",
      aircraftUuid: s.aircraft[0].uuid,
      reason,
      after: override,
    });
  });
  it("requires an active pilot and copilot from the aircraft's Flight Program", () => {
    const s = world();
    const pilot = s.members.find((m) => m.id === "demo-pilot")!;
    expect(
      submitOperation(s, flight(s, { pilotId: pilot.id }), options),
    ).toMatchObject({ status: "accepted" });
    expect(() =>
      submitOperation(s, flight(s, { copilotId: "nobody" }), options),
    ).toThrow("Pilot must belong to this Flight Program.");
    pilot.groupIds = [];
    expect(() =>
      submitOperation(s, flight(s, { pilotId: pilot.id }), options),
    ).toThrow("Pilot must belong to this Flight Program.");
    s.members = s.members.map((m) =>
      m.id === s.user.id ? { ...m, active: false } : m,
    );
    expect(() => submitOperation(s, flight(s), options)).toThrow(
      "Select an active pilot.",
    );
  });
  it("validates in the server's order: checklist, plan, crew, readings, dispatch", () => {
    const s = world();
    s.discrepancies = [
      {
        uuid: "grounding",
        aircraftUuid: s.aircraft[0].uuid,
        description: "Cracked windshield",
        grounding: true,
        status: "open",
        authorId: s.user.id,
        createdAt: now,
      },
    ];
    const everything = flight(s, {
      checklistRun: {
        sessionUuid: "44444444-4444-4444-8444-444444444444",
        checklistUuid: "55555555-5555-4555-8555-555555555555",
        checklistVersion: 1,
        checklistName: "Preflight",
        startedAt: "2026-10-20T09:00:00Z",
        metersVerifiedAt: "2026-10-20T09:10:00Z",
        preflight: { hobbs: 0, tach: 0 },
        checked: [],
        skipped: [],
        totalChecks: 0,
      },
      flightPlanUuid: "33333333-3333-4333-8333-333333333333",
      copilotId: "nobody",
      hobbsOn: undefined,
    });
    const steps = [
      "Checklist is unavailable for this aircraft or Flight Program.",
      "Flight plan is unavailable for this aircraft.",
      "Pilot must belong to this Flight Program.",
      "The hobbs reading is required for this aircraft.",
      /is grounded/,
    ];
    let op = everything;
    for (const [i, message] of steps.entries()) {
      expect(() => submitOperation(s, op, options)).toThrow(message);
      op = flight(s, {
        ...op.input,
        ...[
          { checklistRun: undefined },
          { flightPlanUuid: undefined },
          { copilotId: undefined },
          { hobbsOn: s.aircraft[0].currentHobbs + 3600 },
          {},
        ][i],
      });
    }
  });
  it("reports a resubmitted entry's status and never lets another author reuse its id", () => {
    const s = world();
    const op = flight(s);
    const held = {
      ...submitOperation(s, op, options).changes!.flight!,
      status: "review",
    } as Flight;
    s.flights.push(held);
    expect(submitOperation(s, op, options)).toEqual({ status: "review" });
    expect(() =>
      submitOperation(s, { ...op, authorId: "demo-pilot" }, options),
    ).toThrow("Entry ID already used.");
  });
});

describe("submitting a problem report", () => {
  const report = (
    s: Snapshot,
    over: Partial<DiscrepancyOperation> = {},
  ): DiscrepancyOperation => ({
    kind: "discrepancy",
    programUuid: "demo-program",
    uuid: "22222222-2222-4222-8222-222222222222",
    authorId: s.user.id,
    aircraftUuid: s.aircraft[0].uuid,
    description: "Oil leak at the left cowl",
    grounding: true,
    ...over,
  });
  it("files and audits the report", () => {
    const s = world();
    const op = report(s);
    const { status, changes } = submitOperation(s, op, options);
    expect(status).toBe("accepted");
    const filed = {
      uuid: op.uuid,
      aircraftUuid: op.aircraftUuid,
      flightUuid: undefined,
      description: op.description,
      grounding: true,
      status: "open",
      authorId: op.authorId,
      createdAt: now,
    };
    expect(changes).toEqual({
      stock: [],
      discrepancy: filed,
      audit: [
        {
          action: "discrepancy.created",
          entityUuid: op.uuid,
          aircraftUuid: op.aircraftUuid,
          after: filed,
        },
      ],
    });
    s.discrepancies.push(changes!.discrepancy!);
    expect(submitOperation(s, op, options)).toEqual({ status: "accepted" });
    expect(() =>
      submitOperation(s, { ...op, authorId: "demo-pilot" }, options),
    ).toThrow("Entry ID already used.");
  });
  it("links only a flight of the same aircraft", () => {
    const s = world();
    const logged = submitOperation(s, flight(s), options).changes!.flight!;
    s.flights.push(logged);
    expect(
      submitOperation(s, report(s, { flightUuid: logged.uuid }), options)
        .changes!.discrepancy!.flightUuid,
    ).toBe(logged.uuid);
    expect(() =>
      submitOperation(
        s,
        report(s, {
          flightUuid: logged.uuid,
          aircraftUuid: s.aircraft[1].uuid,
        }),
        options,
      ),
    ).toThrow("Linked flight does not belong to this aircraft.");
  });
});
