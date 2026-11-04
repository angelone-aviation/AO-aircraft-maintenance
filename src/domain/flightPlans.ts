/**
 * Responsibility: Imported ICAO flight plans: the stored plan, each aircraft's
 *   queue, saving a plan, the plan a flight is logged against, and what the
 *   queue would do to the aircraft's due items.
 * Layer: Domain. Zod schema, rules and an applier on a working snapshot; no
 *   I/O, no React.
 * Dependencies: zod, src/domain/model.ts, maintenance.ts, components.ts,
 *   rejection.ts.
 */
import { z } from "zod";
import {
  can,
  totalSeconds,
  type Aircraft,
  type Snapshot,
  type Flight,
} from "./model";
import { inspectionStatus } from "./maintenance";
import {
  requirementStatus,
  type Component,
  type ComponentRequirement,
} from "./components";
import { Rejection } from "./rejection";

const MINUTE_SECONDS = 60;
const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const ALREADY_LOGGED =
  "This plan already has a logged flight or a flight awaiting review.";

const text = z.string().trim().max(5000);

/**
 * A flight plan read from an ICAO flight-plan PDF and assigned to an
 * aircraft. `sourceHash` is the PDF's SHA-256; a copy keeps its source's.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
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

/** A parsed {@link flightPlanSchema} plan. */
export type FlightPlan = z.infer<typeof flightPlanSchema>;

/** A request to save a plan over the version the editor opened. */
export type PlanCommand = { plan: FlightPlan; baseVersion: number };

/**
 * Finds the flight logged against a plan.
 *
 * @param s - The snapshot's flights.
 * @param uuid - The plan.
 * @returns The first such flight that was not rejected, if any.
 */
export function linkedPlanFlight(s: Pick<Snapshot, "flights">, uuid: string) {
  return s.flights.find(
    (f) => f.flightPlanUuid === uuid && f.status !== "rejected",
  );
}

/**
 * An aircraft's queue: its proposed plans not yet flown by an accepted
 * flight. A flight awaiting review keeps its plan queued.
 *
 * @param s - The snapshot.
 * @param aircraftUuid - The aircraft.
 * @returns The plans by departure, then creation time, then uuid.
 */
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

/**
 * Saves a plan as the next version, with the aircraft's current registration.
 *
 * @param s - The working snapshot; its `flightPlans` are replaced.
 * @param command - The plan and the version it was opened at (0 for new).
 * @returns The saved plan, which replaces any earlier one with its uuid.
 * @throws {z.ZodError} When the plan does not parse.
 * @throws {Rejection} In check order: "Flight Program access denied." without
 *   `flight` on the aircraft; "An existing plan cannot change aircraft.";
 *   "Plan changed. Reopen it before saving."; "A plan's copy source cannot
 *   change."; for a new copy, "The original flight plan is unavailable." or
 *   "The copied plan must retain its source document."; "This plan already has
 *   a logged flight or a flight awaiting review."; "This PDF has already been
 *   imported for this aircraft."
 */
export function saveFlightPlan(s: Snapshot, command: PlanCommand) {
  const p = flightPlanSchema.parse(command.plan);
  if (!can(s, p.aircraftUuid, "flight"))
    throw new Rejection("Flight Program access denied.");
  const previous = s.flightPlans?.find((x) => x.uuid === p.uuid);
  if (previous && previous.aircraftUuid !== p.aircraftUuid)
    throw new Rejection("An existing plan cannot change aircraft.");
  if ((previous?.version ?? 0) !== command.baseVersion)
    throw new Rejection("Plan changed. Reopen it before saving.");
  if (previous && previous.copiedFromUuid !== p.copiedFromUuid)
    throw new Rejection("A plan's copy source cannot change.");
  if (!previous && p.copiedFromUuid) assertCopySource(s, p);
  if (linkedPlanFlight(s, p.uuid)) throw new Rejection(ALREADY_LOGGED);
  if (isDuplicateImport(s, p))
    throw new Rejection(
      "This PDF has already been imported for this aircraft.",
    );
  const next = {
    ...p,
    // can() passed, so the aircraft is in the snapshot.
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

/**
 * Checks that a flight may be logged against the plan it names.
 *
 * @param s - The snapshot.
 * @param input - The flight; without a plan there is nothing to check.
 * @throws {Rejection} "Flight plan is unavailable for this aircraft." unless
 *   the plan is a proposed plan for the flight's aircraft; "This plan already
 *   has a logged flight or a flight awaiting review."
 */
export function validatePlanFlight(
  s: Snapshot,
  input: Pick<Flight, "flightPlanUuid" | "aircraftUuid">,
) {
  if (!input.flightPlanUuid) return;
  const p = s.flightPlans?.find((p) => p.uuid === input.flightPlanUuid);
  if (!p || p.aircraftUuid !== input.aircraftUuid || p.status !== "proposed")
    throw new Rejection("Flight plan is unavailable for this aircraft.");
  if (linkedPlanFlight(s, p.uuid)) throw new Rejection(ALREADY_LOGGED);
}

/**
 * Projects an aircraft's queue, flight by flight: the time, cycles and total
 * time after each plan, and what would stand in the way of flying it. The
 * snapshot is not changed.
 *
 * @param s - The snapshot.
 * @param aircraftUuid - The aircraft; it must be in the snapshot when it has
 *   queued plans.
 * @returns One entry per plan in {@link queuedPlans} order: the plan, the
 *   cumulative minutes and cycles, its end time, the projected total seconds,
 *   and flags for a flight awaiting review, a status other than airworthy,
 *   open discrepancies, inspections and component requirements due by the
 *   flight's end (UTC date).
 */
export function projectQueue(s: Snapshot, aircraftUuid: string) {
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid)!;
  let minutes = 0,
    cycles = 0,
    landings = 0;
  return queuedPlans(s, aircraftUuid).map((p) => {
    minutes += p.durationMinutes;
    cycles += p.cycles;
    landings += p.landings;
    const end = new Date(
      Date.parse(p.departureAt) + p.durationMinutes * MINUTE_MS,
    ).toISOString();
    const projected = projectAircraft(a, minutes, cycles, landings);
    return {
      plan: p,
      minutes,
      cycles,
      end,
      totalSeconds: totalSeconds(projected),
      flags: listFlags(s, p, projected, end.slice(0, 10)),
    };
  });
}

/**
 * Formats minutes as hours and minutes.
 *
 * @param minutes - Whole minutes.
 * @returns Such as "4h 53m"; minutes are always two digits.
 */
export function durationLabel(minutes: number) {
  const hours = Math.floor(minutes / HOUR_MINUTES);
  return `${hours}h ${String(minutes % HOUR_MINUTES).padStart(2, "0")}m`;
}

function assertCopySource(s: Snapshot, p: FlightPlan) {
  const source = s.flightPlans?.find((x) => x.uuid === p.copiedFromUuid);
  if (!source || !can(s, source.aircraftUuid, "flight"))
    throw new Rejection("The original flight plan is unavailable.");
  if (source.sourceHash !== p.sourceHash)
    throw new Rejection("The copied plan must retain its source document.");
}

// Copies share their source's PDF on purpose; only original imports are
// unique per aircraft, and a cancelled one may be imported again.
function isDuplicateImport(s: Snapshot, p: FlightPlan) {
  if (p.copiedFromUuid) return false;
  return (s.flightPlans ?? []).some(
    (x) =>
      !x.copiedFromUuid &&
      x.uuid !== p.uuid &&
      x.aircraftUuid === p.aircraftUuid &&
      x.sourceHash === p.sourceHash &&
      x.status !== "cancelled",
  );
}

// An estimate: every meter the aircraft keeps advances by the planned time.
function projectAircraft(
  a: Aircraft,
  minutes: number,
  cycles: number,
  landings: number,
) {
  const seconds = minutes * MINUTE_SECONDS;
  const advance = (reading?: number) =>
    reading === undefined ? undefined : reading + seconds;
  return {
    ...a,
    currentHobbs: a.currentHobbs + seconds,
    currentTach: a.currentTach + seconds,
    currentCyclicHobbs: advance(a.currentCyclicHobbs),
    currentFlightTimeLog: advance(a.currentFlightTimeLog),
    cycles: a.cycles + cycles,
    landings: a.landings + landings,
  };
}

function listFlags(
  s: Snapshot,
  p: FlightPlan,
  projected: Aircraft,
  endDate: string,
): string[] {
  const flags: string[] = [];
  if (linkedPlanFlight(s, p.uuid)?.status === "review")
    flags.push(
      "Logged flight awaiting review; estimate remains in projection until accepted.",
    );
  if (projected.operationalStatus !== "airworthy")
    flags.push(`Aircraft status: ${projected.operationalStatus}`);
  for (const d of s.discrepancies)
    if (d.aircraftUuid === projected.uuid && d.status === "open")
      flags.push(`Open discrepancy: ${d.description}`);
  return [
    ...flags,
    ...listInspectionFlags(s, projected, endDate),
    ...listComponentFlags(s, projected, endDate),
  ];
}

function listInspectionFlags(
  s: Snapshot,
  projected: Aircraft,
  endDate: string,
): string[] {
  return s.inspections
    .filter((i) => i.aircraftUuid === projected.uuid && !i.archived)
    .flatMap((i) => {
      const due = inspectionStatus(i, projected, endDate);
      if (due.status === "scheduled") return [];
      const passed =
        (due.daysRemaining !== undefined && due.daysRemaining < 0) ||
        (due.hoursRemaining !== undefined && due.hoursRemaining <= 0);
      if (passed) return [`${i.reference}: Due before further Flight`];
      const message =
        due.status === "overdue" ? "due by flight end" : due.status;
      return [`${i.reference}: ${message}`];
    });
}

function listComponentFlags(
  s: Snapshot,
  projected: Aircraft,
  endDate: string,
): string[] {
  const records = s.management ?? [];
  return records.flatMap((c) => {
    if (c.kind !== "component" || !c.installed) return [];
    if (c.aircraftUuid !== projected.uuid) return [];
    return records.flatMap((r) =>
      r.kind === "componentRequirement" && r.componentUuid === c.uuid
        ? flagRequirement(r, c, projected, endDate)
        : [],
    );
  });
}

function flagRequirement(
  r: ComponentRequirement,
  c: Component,
  projected: Aircraft,
  endDate: string,
): string[] {
  // A projection that cannot be computed (for example, readings before the
  // install baseline) is a flag, not a failure of the whole queue.
  try {
    const { status } = requirementStatus(r, c, projected, endDate);
    return status === "Tracked"
      ? []
      : [`${c.componentType} / ${r.description}: ${status}`];
  } catch {
    return [
      `${c.componentType}: verify installation baseline for planned date`,
    ];
  }
}
