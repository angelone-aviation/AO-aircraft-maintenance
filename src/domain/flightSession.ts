import { z } from "zod";
import type { FlightPlan } from "./flightPlans";
import {
  flightInputSchema,
  type Aircraft,
  type FlightInput,
  type Member,
} from "./model";

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
export type FlightSession = z.infer<typeof flightSessionSchema>;

export function startFlightSession(
  aircraft: Aircraft,
  input: FlightInput,
  verifiedAt: string,
  uuid = crypto.randomUUID(),
) {
  const preflight = flightInputSchema.parse(input);
  if (preflight.aircraftUuid !== aircraft.uuid)
    throw new Error("The verified aircraft does not match this flight.");
  if (preflight.fuel?.start === undefined || preflight.fuel.added === undefined)
    throw new Error("Enter preflight fuel and quantity added (0 if none).");
  const engines = aircraft.twin ? ["left", "right"] : ["single"];
  for (const engine of engines) {
    const oil = preflight.oil?.find((o) => o.engine === engine);
    if (oil?.start === undefined || oil.added === undefined)
      throw new Error(
        "Enter preflight oil and quantity added for each engine (0 if none).",
      );
  }
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
    flightRules: ["I", "Y"].includes(plan.flightRules) ? "IFR" : "VFR",
    remarks: plan.route ? `Planned route: ${plan.route}` : "",
  };
}
