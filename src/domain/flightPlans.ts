import { z } from "zod";
import { can, totalSeconds, type Snapshot, type Flight } from "./model";
import { inspectionStatus } from "./maintenance";
import { requirementStatus } from "./components";
const text = z.string().trim().max(5000);
export const flightPlanSchema = z.object({
  uuid: z.string().uuid(),
  version: z.number().int().nonnegative(),
  aircraftUuid: z.string().min(1),
  registration: text,
  departureAt: z.iso.datetime({ offset: true }),
  origin: z.string().trim().min(1).max(100),
  destination: z.string().trim().min(1).max(100),
  alternate: text,
  durationMinutes: z.number().int().positive().max(5999),
  cycles: z.number().int().nonnegative().max(1000),
  landings: z.number().int().nonnegative().max(1000),
  flightRules: z.enum(["I", "V", "Y", "Z"]),
  aircraftType: text,
  flightType: text,
  speed: text,
  level: text,
  route: text,
  enduranceMinutes: z.number().int().nonnegative().max(5999).optional(),
  personsOnBoard: z.number().int().nonnegative().max(999).optional(),
  pilotText: text,
  equipment: text,
  otherInformation: text,
  sourceName: z.string().max(255),
  copiedFromUuid: z.string().uuid().optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["proposed", "cancelled"]),
  createdAt: z.number(),
});
export type FlightPlan = z.infer<typeof flightPlanSchema>;
export type PlanCommand = { plan: FlightPlan; baseVersion: number };
export function linkedPlanFlight(s: Pick<Snapshot, "flights">, uuid: string) {
  return s.flights.find(
    (f) => f.flightPlanUuid === uuid && f.status !== "rejected",
  );
}
export function queuedPlans(s: Snapshot, aircraftUuid: string) {
  return (s.flightPlans ?? [])
    .filter(
      (p) =>
        p.aircraftUuid === aircraftUuid &&
        p.status === "proposed" &&
        linkedPlanFlight(s, p.uuid)?.status !== "accepted",
    )
    .sort(
      (a, b) =>
        Date.parse(a.departureAt) - Date.parse(b.departureAt) ||
        a.createdAt - b.createdAt ||
        a.uuid.localeCompare(b.uuid),
    );
}
export function saveFlightPlan(s: Snapshot, command: PlanCommand) {
  const p = flightPlanSchema.parse(command.plan);
  if (!can(s, p.aircraftUuid, "flight"))
    throw new Error("Flight Program access denied.");
  const previous = s.flightPlans?.find((x) => x.uuid === p.uuid);
  if (previous && previous.aircraftUuid !== p.aircraftUuid)
    throw new Error("An existing plan cannot change aircraft.");
  if ((previous?.version ?? 0) !== command.baseVersion)
    throw new Error("Plan changed. Reopen it before saving.");
  if (previous && previous.copiedFromUuid !== p.copiedFromUuid)
    throw new Error("A plan's copy source cannot change.");
  if (!previous && p.copiedFromUuid) {
    const source = s.flightPlans?.find((x) => x.uuid === p.copiedFromUuid);
    if (!source || !can(s, source.aircraftUuid, "flight"))
      throw new Error("The original flight plan is unavailable.");
    if (source.sourceHash !== p.sourceHash)
      throw new Error("The copied plan must retain its source document.");
  }
  if (linkedPlanFlight(s, p.uuid))
    throw new Error(
      "This plan already has a logged flight or a flight awaiting review.",
    );
  if (
    !p.copiedFromUuid &&
    (s.flightPlans ?? []).some(
      (x) =>
        !x.copiedFromUuid &&
        x.uuid !== p.uuid &&
        x.aircraftUuid === p.aircraftUuid &&
        x.sourceHash === p.sourceHash &&
        x.status !== "cancelled",
    )
  )
    throw new Error("This PDF has already been imported for this aircraft.");
  const next = {
    ...p,
    registration: s.aircraft.find((a) => a.uuid === p.aircraftUuid)!
      .registration,
    version: (previous?.version ?? 0) + 1,
    createdAt: previous?.createdAt ?? Date.now(),
  };
  s.flightPlans = [
    ...(s.flightPlans ?? []).filter((x) => x.uuid !== p.uuid),
    next,
  ];
  return next;
}
export function validatePlanFlight(
  s: Snapshot,
  input: Pick<Flight, "flightPlanUuid" | "aircraftUuid">,
) {
  if (!input.flightPlanUuid) return;
  const p = s.flightPlans?.find((p) => p.uuid === input.flightPlanUuid);
  if (!p || p.aircraftUuid !== input.aircraftUuid || p.status !== "proposed")
    throw new Error("Flight plan is unavailable for this aircraft.");
  if (linkedPlanFlight(s, p.uuid))
    throw new Error(
      "This plan already has a logged flight or a flight awaiting review.",
    );
}
export function projectQueue(s: Snapshot, aircraftUuid: string) {
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid)!;
  const plans = queuedPlans(s, aircraftUuid);
  let minutes = 0,
    cycles = 0,
    landings = 0;
  return plans.map((p) => {
    minutes += p.durationMinutes;
    cycles += p.cycles;
    landings += p.landings;
    const end = new Date(
      Date.parse(p.departureAt) + p.durationMinutes * 60000,
    ).toISOString();
    const today = end.slice(0, 10);
    const projected = {
      ...a,
      currentHobbs: a.currentHobbs + minutes * 60,
      currentTach: a.currentTach + minutes * 60,
      currentCyclicHobbs:
        a.currentCyclicHobbs === undefined
          ? undefined
          : a.currentCyclicHobbs + minutes * 60,
      currentFlightTimeLog:
        a.currentFlightTimeLog === undefined
          ? undefined
          : a.currentFlightTimeLog + minutes * 60,
      cycles: a.cycles + cycles,
      landings: a.landings + landings,
    };
    const flags: string[] = [];
    if (linkedPlanFlight(s, p.uuid)?.status === "review")
      flags.push(
        "Logged flight awaiting review; estimate remains in projection until accepted.",
      );
    if (a.operationalStatus !== "airworthy")
      flags.push(`Aircraft status: ${a.operationalStatus}`);
    for (const d of s.discrepancies.filter(
      (d) => d.aircraftUuid === a.uuid && d.status === "open",
    ))
      flags.push(`Open discrepancy: ${d.description}`);
    for (const i of s.inspections.filter(
      (i) => i.aircraftUuid === a.uuid && !i.archived,
    )) {
      const { status, daysRemaining, hoursRemaining } = inspectionStatus(
        i,
        projected,
        today,
      );
      if (status !== "scheduled") {
        const message =
          daysRemaining !== undefined && daysRemaining < 0
            ? "Due before further Flight"
            : hoursRemaining !== undefined && hoursRemaining <= 0
              ? "Due before further Flight"
              : status === "overdue"
                ? "due by flight end"
                : status;
        flags.push(`${i.reference}: ${message}`);
      }
    }
    for (const c of s.management ?? []) {
      if (c.kind !== "component" || !c.installed || c.aircraftUuid !== a.uuid)
        continue;
      for (const r of s.management ?? []) {
        if (r.kind !== "componentRequirement" || r.componentUuid !== c.uuid)
          continue;
        try {
          const status = requirementStatus(r, c, projected, today).status;
          if (status !== "Tracked")
            flags.push(`${c.componentType} / ${r.description}: ${status}`);
        } catch {
          flags.push(
            `${c.componentType}: verify installation baseline for planned date`,
          );
        }
      }
    }
    return {
      plan: p,
      minutes,
      cycles,
      end,
      totalSeconds: totalSeconds(projected),
      flags,
    };
  });
}
export function durationLabel(minutes: number) {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
