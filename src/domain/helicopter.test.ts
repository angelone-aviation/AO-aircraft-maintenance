/**
 * Responsibility: Pins helicopters timed by the collective hourmeter: their
 *   readings, refusals, component hours and frozen closeout readings.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flights.ts, ./fleet, ./model, ./workOrders,
 *   ./components, src/data/demo.ts, tests/fixtures/workOrders.ts.
 */
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
const NOW = Date.parse("2026-10-02T12:00:00Z");
const HOUR_SECONDS = 3600;

/**
 * A demo helicopter timed by its collective hourmeter at 100 h (500 h total
 * with its 400 h adjustment), and a flight that brings it to 101 h.
 */
function setup() {
  const s = demoSnapshot();
  const input = {
    ...aircraftInputSchema.parse(s.aircraft[0]),
    uuid: "helicopter",
    registration: "N-HELI",
    version: 0,
    helicopter: true,
    meter: "cyclic" as const,
    currentCyclicHobbs: 100 * HOUR_SECONDS,
    adjustmentSeconds: 400 * HOUR_SECONDS,
  };
  const a = applyFleet(
    s,
    {
      action: "aircraft.save",
      aircraft: input,
      requestUuid: crypto.randomUUID(),
      reason: "Add helicopter",
    },
    NOW,
  ).aircraft!;
  const flight: FlightInput = {
    aircraftUuid: a.uuid,
    pilotId: s.user.id,
    startTime: "2026-10-02T13:00:00Z",
    cyclicHobbsOn: 101 * HOUR_SECONDS,
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
it("persists helicopter and independent cyclic readings; requires cyclic only when selected", () => {
  const { a, flight } = setup();
  expect(totalSeconds(a)).toBe(500 * HOUR_SECONDS);
  expect(a.baselineCyclicHobbs).toBe(100 * HOUR_SECONDS);
  expect(() => validateFlight(a, flight)).not.toThrow();
  expect(() =>
    validateFlight(a, {
      ...flight,
      cyclicHobbsOn: undefined,
      hobbsOn: a.currentHobbs,
    }),
  ).toThrow("Collective hourmeter");
  expect(
    conflictReason(
      a,
      { ...flight, cyclicHobbsOn: 99 * HOUR_SECONDS },
      a.version,
    ),
  ).toContain("lower");
  const flown = applyFlight(a, flight);
  expect(totalSeconds(flown)).toBe(501 * HOUR_SECONDS);
  expect(flown.currentHobbs).toBe(a.currentHobbs);
  expect(flown.currentTach).toBe(a.currentTach);
  const saved: Flight = {
    ...flight,
    uuid: crypto.randomUUID(),
    authorId: "user",
    status: "accepted",
    submittedAt: NOW,
  };
  const rebuilt = rebuildFlights(flown, [saved]);
  expect(rebuilt.aircraft.currentCyclicHobbs).toBe(flown.currentCyclicHobbs);
  expect(rebuilt.flights[0].cyclicHobbsOff).toBe(100 * HOUR_SECONDS);
});
it("rejects cyclic source without Helicopter or a reading", () => {
  for (const overrides of [
    { helicopter: false },
    { currentCyclicHobbs: undefined },
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
        NOW,
      ),
    ).toThrow("Collective hourmeter");
  }
});
it("uses cyclic hours for installed components and freezes cyclic work-order completion readings", () => {
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
  const open = saveWorkOrder(s, cmd, NOW);
  const flown = applyFlight(a, flight);
  s.aircraft = s.aircraft.map((old) => (old.uuid === a.uuid ? flown : old));
  expect(componentTotals(c, flown).timeSinceNew).toBe(
    c.timeSinceNew + HOUR_SECONDS,
  );
  const completion = {
    ...cmd,
    version: open.version,
    fields: {
      ...workOrderFieldsSchema.parse(open),
      status: "completed" as const,
      completionDate: "2026-10-02",
      releaseOutcome: "Reviewed",
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
  const closed = saveWorkOrder(s, completion, NOW);
  expect(closed.closeout!.aircraft.cyclicHobbs).toBe(101 * HOUR_SECONDS);
  expect(closed.closeout!.aircraft.totalSeconds).toBe(501 * HOUR_SECONDS);
  expect(closed.closeout!.components[0].timeSinceNew).toBe(
    c.timeSinceNew + HOUR_SECONDS,
  );
});
