import { it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { applyFleet, aircraftInputSchema } from "./fleet";
import { totalSeconds, type FlightInput, type Flight } from "./model";
import {
  validateFlight,
  applyFlight,
  conflictReason,
  rebuildFlights,
} from "./flights";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
import { saveWorkOrder, workOrderFieldsSchema } from "./workOrders";
import { componentTotals } from "./components";
const now = Date.parse("2026-10-02T12:00:00Z");
function setup() {
  const s = demoSnapshot();
  const input = {
    ...aircraftInputSchema.parse(s.aircraft[0]),
    uuid: "flightTimeLog",
    registration: "N-HELI",
    version: 0,
    flightTimeLog: true,
    meter: "flightTimeLog" as const,
    currentFlightTimeLog: 100 * 3600,
    adjustmentSeconds: 400 * 3600,
  };
  const a = applyFleet(
    s,
    {
      action: "aircraft.save",
      aircraft: input,
      requestUuid: crypto.randomUUID(),
      reason: "Add flightTimeLog",
    },
    now,
  ).aircraft!;
  const flight: FlightInput = {
    aircraftUuid: a.uuid,
    pilotId: s.user.id,
    startTime: "2026-10-02T13:00:00Z",
    flightTimeLogOn: 101 * 3600,
    landings: 1,
    cycles: 1,
    origin: "AAA",
    destination: "BBB",
    operation: "Mission",
    flightRules: "VFR",
    remarks: "",
    discrepancy: "",
  };
  return { s, a, input, flight };
}
it("persists flightTimeLog and independent flight time log readings; requires flight time log only when selected", () => {
  const { a, flight } = setup();
  expect(totalSeconds(a)).toBe(500 * 3600);
  expect(a.baselineFlightTimeLog).toBe(100 * 3600);
  expect(() => validateFlight(a, flight)).not.toThrow();
  expect(() =>
    validateFlight(a, {
      ...flight,
      flightTimeLogOn: undefined,
      hobbsOn: a.currentHobbs,
    }),
  ).toThrow("Flight time log");
  expect(
    conflictReason(a, { ...flight, flightTimeLogOn: 99 * 3600 }, a.version),
  ).toContain("lower");
  const flown = applyFlight(a, flight);
  expect(totalSeconds(flown)).toBe(501 * 3600);
  expect(flown.currentHobbs).toBe(a.currentHobbs);
  expect(flown.currentTach).toBe(a.currentTach);
  const saved: Flight = {
    ...flight,
    uuid: crypto.randomUUID(),
    authorId: "user",
    status: "accepted",
    submittedAt: now,
  };
  const rebuilt = rebuildFlights(flown, [saved]);
  expect(rebuilt.aircraft.currentFlightTimeLog).toBe(
    flown.currentFlightTimeLog,
  );
  expect(rebuilt.flights[0].flightTimeLogOff).toBe(100 * 3600);
});
it("rejects flight time log source without Flight time log or a reading", () => {
  for (const overrides of [
    { flightTimeLog: false },
    { currentFlightTimeLog: undefined },
  ]) {
    const { s, input } = setup();
    expect(() =>
      applyFleet(
        s,
        {
          action: "aircraft.save",
          requestUuid: crypto.randomUUID(),
          reason: "Invalid source",
          aircraft: {
            ...input,
            uuid: "invalid",
            registration: "INVALID",
            ...overrides,
          },
        },
        now,
      ),
    ).toThrow("Flight time log");
  }
});
it("uses flight time log hours for installed components and freezes flight time log work-order completion readings", () => {
  const { s, a, flight } = setup();
  const c = {
    ...workOrderComponent(),
    aircraftUuid: a.uuid,
    installedSeconds: totalSeconds(a),
    installedCycles: a.cycles,
  };
  s.management = [c];
  const cmd = workOrderCommand();
  cmd.fields.aircraftUuid = a.uuid;
  cmd.componentUuids = [c.uuid];
  const open = saveWorkOrder(s, cmd, now);
  const flown = applyFlight(a, flight);
  s.aircraft = s.aircraft.map((old) => (old.uuid === a.uuid ? flown : old));
  expect(componentTotals(c, flown).timeSinceNew).toBe(c.timeSinceNew + 3600);
  const completion = {
    ...cmd,
    version: open.version,
    fields: {
      ...workOrderFieldsSchema.parse(open),
      status: "completed" as const,
      completionDate: "2026-10-02",
      releaseOutcome: "Reviewed",
      finalReview: "Reviewed",
    },
    componentWork: [
      {
        componentUuid: c.uuid,
        version: c.version,
        action: "service" as const,
        description: "Inspected",
        reference: "",
      },
    ],
  };
  const closed = saveWorkOrder(s, completion, now);
  expect(closed.closeout!.aircraft.flightTimeLog).toBe(101 * 3600);
  expect(closed.closeout!.aircraft.totalSeconds).toBe(501 * 3600);
  expect(closed.closeout!.components[0].timeSinceNew).toBe(
    c.timeSinceNew + 3600,
  );
});
