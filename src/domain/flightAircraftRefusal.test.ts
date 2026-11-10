/**
 * Responsibility: Pins that an outbox flight for an aircraft the program no
 *   longer holds is refused as a FlightRejection, so the Sync center keeps
 *   the entry with its message instead of retrying it, and stores nothing.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/flightSubmission.ts, src/data/demo.ts (seed).
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { FlightRejection, submitOperation } from "./flightSubmission";

const NOW = Date.parse("2026-10-20T12:00:00Z");

it("refuses a flight for an aircraft not in the snapshot, storing nothing", () => {
  const s = demoSnapshot();
  const before = { flights: s.flights.length, audit: s.audit.length };
  const refusal = (() => {
    try {
      submitOperation(
        s,
        {
          kind: "flight",
          programUuid: "demo-program",
          uuid: "11111111-1111-4111-8111-111111111111",
          authorId: s.user.id,
          baseVersion: 1,
          input: {
            aircraftUuid: "transferred-away",
            pilotId: s.user.id,
            startTime: "2026-10-20T10:00:00Z",
            hobbsOn: 3600,
            tachOn: 3240,
            landings: 1,
            cycles: 1,
            origin: "AAA",
            destination: "BBB",
            operation: "Mission",
            flightRules: "VFR",
            remarks: "",
            discrepancy: "",
          },
        },
        { now: NOW, today: "2026-10-20" },
      );
    } catch (error) {
      return error;
    }
  })();
  expect(refusal).toBeInstanceOf(FlightRejection);
  expect((refusal as Error).message).toBe("Aircraft not found.");
  expect({ flights: s.flights.length, audit: s.audit.length }).toEqual(before);
});
