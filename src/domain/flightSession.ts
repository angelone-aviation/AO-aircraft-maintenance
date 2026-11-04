/**
 * Responsibility: The saved preflight of a flight in progress, and the flight
 *   fields a filed flight plan fills in.
 * Layer: Domain. Pure schema and functions; no I/O, no React.
 * Dependencies: zod; src/domain/model.ts, rejection.ts; flightPlans.ts
 *   (types).
 */
import { z } from "zod";
import type { FlightPlan } from "./flightPlans";
import {
  flightInputSchema,
  type Aircraft,
  type FlightInput,
  type Member,
} from "./model";
import { Rejection } from "./rejection";

// ICAO flight plan item 8: Y is IFR then VFR, Z is VFR then IFR, so the
// flight departs under the first rules named.
const IFR_DEPARTURE_RULES: readonly string[] = ["I", "Y"];

/**
 * A preflight saved on the device: the verified opening meter readings and
 * the flight entry without its ending readings.
 *
 * @throws {z.ZodError} From `parse()` on a malformed or tampered session.
 */
export const flightSessionSchema = z.object({
  uuid: z.string().uuid(),
  savedAt: z.iso.datetime(),
  verifiedAt: z.iso.datetime(),
  opening: z.object({
    version: z.number().int(),
    hobbs: z.number().nonnegative(),
    tach: z.number().nonnegative(),
    cyclic: z.number().nonnegative().optional(),
    flightTimeLog: z.number().nonnegative().optional(),
  }),
  input: flightInputSchema,
});

/** A parsed {@link flightSessionSchema} session. */
export type FlightSession = z.infer<typeof flightSessionSchema>;

/**
 * Saves a verified preflight. The aircraft's current readings and version
 * become the opening, so a later change to the aircraft shows as a conflict;
 * ending readings, engine starts and ending fuel are cleared.
 *
 * @param aircraft - The aircraft whose meters the crew verified.
 * @param input - The flight entry so far.
 * @param verifiedAt - When the meters were verified (ISO date-time).
 * @param uuid - The session id.
 * @returns The session; the aircraft is not changed.
 * @throws {Rejection} When the aircraft differs, or preflight fuel, or oil for
 *   any engine, lacks its starting level or quantity added.
 */
export function startFlightSession(
  aircraft: Aircraft,
  input: FlightInput,
  verifiedAt: string,
  uuid = crypto.randomUUID(),
) {
  const preflight = flightInputSchema.parse(input);
  if (preflight.aircraftUuid !== aircraft.uuid)
    throw new Rejection("The verified aircraft does not match this flight.");
  assertPreflightFluids(aircraft, preflight);
  return flightSessionSchema.parse({
    uuid,
    savedAt: new Date().toISOString(),
    verifiedAt,
    opening: {
      version: aircraft.version,
      hobbs: aircraft.currentHobbs,
      tach: aircraft.currentTach,
      cyclic: aircraft.currentCyclicHobbs,
      flightTimeLog: aircraft.currentFlightTimeLog,
    },
    input: {
      ...preflight,
      hobbsOn: undefined,
      tachOn: undefined,
      cyclicHobbsOn: undefined,
      flightTimeLogOn: undefined,
      engineStarts: undefined,
      fuel: { ...preflight.fuel, end: undefined },
    },
  });
}

/**
 * The flight entry fields a filed flight plan supplies; its times are
 * estimates, so it fills in no meter readings.
 *
 * @param plan - The flight plan.
 * @param members - The members to find the plan's pilot among.
 * @param currentUserId - The pilot unless exactly one active pilot has the
 *   plan's pilot name (trimmed, ignoring case).
 * @returns The plan's aircraft, pilot, departure, airports, landings, cycles,
 *   flight rules and route (as a remark).
 */
export function plannedFlightPrefill(
  plan: FlightPlan,
  members: Member[],
  currentUserId: string,
): Partial<FlightInput> {
  const matching = members.filter(
    (m) =>
      m.active &&
      m.availableAsPilot !== false &&
      m.name.trim().toLowerCase() === plan.pilotText.trim().toLowerCase(),
  );
  return {
    aircraftUuid: plan.aircraftUuid,
    flightPlanUuid: plan.uuid,
    pilotId: matching.length === 1 ? matching[0].id : currentUserId,
    startTime: plan.departureAt,
    origin: plan.origin,
    destination: plan.destination,
    landings: plan.landings,
    cycles: plan.cycles,
    flightRules: IFR_DEPARTURE_RULES.includes(plan.flightRules) ? "IFR" : "VFR",
    remarks: plan.route ? `Planned route: ${plan.route}` : "",
  };
}

function assertPreflightFluids(aircraft: Aircraft, preflight: FlightInput) {
  if (preflight.fuel?.start === undefined || preflight.fuel.added === undefined)
    throw new Rejection("Enter preflight fuel and quantity added (0 if none).");
  const engines = aircraft.twin ? ["left", "right"] : ["single"];
  for (const engine of engines) {
    const oil = preflight.oil?.find((o) => o.engine === engine);
    if (oil?.start === undefined || oil.added === undefined)
      throw new Rejection(
        "Enter preflight oil and quantity added for each engine (0 if none).",
      );
  }
}
