import { addressSchema, formatAddress } from "./addresses";
import { activeProgram, ownsActive, programPermission } from "./programs";
import { z } from "zod";
import { can, totalSeconds, type Aircraft, type Snapshot } from "./model";
import { validateMaintenanceTotals } from "./management";
import { componentAircraftSeconds, type Component } from "./components";
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const seconds = count.refine((n) => n % 360 === 0, "Use tenths of an hour.");
const text = z.string().trim().min(1).max(150);
export function normalizeWebsite(value: string) {
  const website = value.trim();
  if (!website || /^[a-z][a-z0-9+.-]*:/i.test(website)) return website;
  return website.startsWith("//") ? `https:${website}` : `https://${website}`;
}
export const programSchema = z.object({
  uuid: text,
  version: count,
  name: text,
  addressDetails: addressSchema.optional(),
  address: z.string().trim().max(4000),
  email: z.union([z.literal(""), z.email()]),
  contactName: z.string().trim().max(150),
  website: z
    .string()
    .transform(normalizeWebsite)
    .pipe(z.string().max(2000))
    .refine(
      (s) => !s || (/^https?:\/\//i.test(s) && z.url().safeParse(s).success),
      "Enter a valid website address.",
    ),
});
export type Program = z.infer<typeof programSchema>;
export const aircraftInputSchema = z.object({
  twin: z.boolean().optional(),
  turbine: z.boolean().optional(),
  amphibious: z.boolean().optional(),
  helicopter: z.boolean().optional(),
  flightTimeLog: z.boolean().optional(),
  uuid: text,
  version: count,
  registration: text,
  make: text,
  model: text,
  faaSearchModel: z.string().trim().max(150).optional(),
  serial: z.string().trim().max(150),
  programUuid: z.string().optional(),
  meter: z.enum(["hobbs", "tach", "cyclic", "flightTimeLog"]),
  adjustmentSeconds: z
    .number()
    .int()
    .min(-Number.MAX_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER)
    .refine((n) => n % 360 === 0, "Use tenths of an hour."),
  currentHobbs: seconds,
  currentTach: seconds,
  currentCyclicHobbs: seconds.optional(),
  currentFlightTimeLog: seconds.optional(),
  cycles: count,
  landings: count,
  operationalStatus: z.enum([
    "unknown",
    "airworthy",
    "maintenance",
    "grounded",
  ]),
});
export type AircraftInput = z.infer<typeof aircraftInputSchema>;
export const counterFields = [
  "meter",
  "adjustmentSeconds",
  "currentHobbs",
  "currentTach",
  "currentCyclicHobbs",
  "currentFlightTimeLog",
  "cycles",
  "landings",
] as const;
export type CounterField = (typeof counterFields)[number];
export type CounterReadings = Pick<Aircraft, CounterField>;
/** An administrator's change to aircraft counters; holds every counter after it. */
export interface AircraftCounterEvent {
  at: string;
  meter: "hobbs" | "tach" | "cyclic" | "flightTimeLog";
  adjustmentSeconds: number;
  currentHobbs: number;
  currentTach: number;
  currentCyclicHobbs?: number;
  currentFlightTimeLog?: number;
  cycles: number;
  landings: number;
  /**
   * The counters the administrator changed. A flight rebuild overrides only
   * these, so earlier flights keep counting in the others. Missing on events
   * recorded before 2026-11-03; `rebuildFlights` derives it for them.
   */
  changed?: CounterField[];
  /** What the changed counters read just before; a missing key was unset. */
  previous?: Partial<CounterReadings>;
}
const common = {
  requestUuid: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
};
export const fleetCommandSchema = z.discriminatedUnion("action", [
  z.object({
    ...common,
    action: z.literal("aircraft.save"),
    aircraft: aircraftInputSchema,
  }),
  z.object({
    ...common,
    action: z.literal("program.save"),
    program: programSchema,
  }),
]);
export type FleetCommand = z.infer<typeof fleetCommandSchema>;
export function parseAdjustment(value: string) {
  if (!/^-?\d+(\.\d)?$/.test(value.trim()))
    throw new Error(
      "Enter total time adjustment with at most one decimal place.",
    );
  const seconds = Math.round(Number(value) * 3600);
  if (!Number.isSafeInteger(seconds))
    throw new Error("Total time adjustment is too large.");
  return seconds;
}
export function applyFleet(
  s: Snapshot,
  raw: FleetCommand,
  now = Date.now(),
): { aircraft?: Aircraft; program?: Program; components: Component[] } {
  const c = fleetCommandSchema.parse(raw);
  if (!s.user.active) throw new Error("An active account is required.");
  if (c.action === "program.save") {
    if (c.program.addressDetails) {
      c.program.address = formatAddress(c.program.addressDetails);
      c.program.email = c.program.addressDetails.email;
      c.program.contactName = c.program.addressDetails.contactName;
    }
    if (
      !s.user.isAdmin &&
      !(c.program.uuid === activeProgram(s) && programPermission(s, "admin"))
    )
      throw new Error("Administrator permission required.");
    const before = (s.programs ?? []).find((p) => p.uuid === c.program.uuid);
    if (c.program.version !== (before?.version ?? 0))
      throw new Error("Program changed. Refresh and try again.");
    if (
      (s.programs ?? []).some(
        (p) =>
          p.uuid !== c.program.uuid &&
          p.name.toLowerCase() === c.program.name.toLowerCase(),
      )
    )
      throw new Error("Program name already exists.");
    const program = { ...c.program, version: c.program.version + 1 };
    s.programs = [
      ...(s.programs ?? []).filter((p) => p.uuid !== program.uuid),
      program,
    ];
    s.aircraft = s.aircraft.map((a) =>
      a.programUuid === program.uuid ? { ...a, program: program.name } : a,
    );
    s.audit.unshift({
      uuid: c.requestUuid,
      actorId: s.user.id,
      at: now,
      action: before ? "program.updated" : "program.created",
      entityUuid: program.uuid,
      reason: c.reason,
      before: before ? JSON.stringify(before) : undefined,
      after: JSON.stringify(program),
    });
    return { program, components: [] };
  }
  const input = c.aircraft,
    before = s.aircraft.find((a) => a.uuid === input.uuid);
  if (before && !ownsActive(s, before.programUuid))
    throw new Error("Aircraft belongs to another Flight Program.");
  if (
    input.programUuid &&
    !s.programs?.some((p) => p.uuid === input.programUuid)
  )
    throw new Error("Program not found.");
  if (input.programUuid && input.programUuid !== activeProgram(s))
    throw new Error("Use an explicit Flight Program transfer.");
  input.programUuid = before?.programUuid ?? activeProgram(s);
  if (
    before
      ? !can(s, before.uuid, "maintenance")
      : !programPermission(s, "admin")
  )
    throw new Error("Aircraft management permission required.");
  if (input.version !== (before?.version ?? 0))
    throw new Error("Aircraft changed. Refresh before saving.");
  if (
    input.meter === "cyclic" &&
    (!input.helicopter || input.currentCyclicHobbs === undefined)
  )
    throw new Error(
      "Select Helicopter and enter a Collective hourmeter reading to use it as the time source.",
    );
  if (
    input.meter === "flightTimeLog" &&
    (!input.flightTimeLog || input.currentFlightTimeLog === undefined)
  )
    throw new Error(
      "Select Flight time log and enter its reading to use it as the time source.",
    );
  const registration = input.registration.toUpperCase();
  if (
    s.aircraft.some(
      (a) =>
        a.uuid !== input.uuid && a.registration.toUpperCase() === registration,
    )
  )
    throw new Error("Registration already exists.");
  const program = input.programUuid
    ? (s.programs ?? []).find((p) => p.uuid === input.programUuid)
    : undefined;
  if (input.programUuid && !program) throw new Error("Program not found.");
  const next: Aircraft = {
    ...before,
    ...input,
    registration,
    program: program?.name ?? "",
    version: (before?.version ?? -1) + 1,
    baselineHobbs: before?.baselineHobbs ?? input.currentHobbs,
    baselineTach: before?.baselineTach ?? input.currentTach,
    baselineCyclicHobbs: before
      ? before.baselineCyclicHobbs
      : input.currentCyclicHobbs,
    baselineFlightTimeLog: before
      ? before.baselineFlightTimeLog
      : input.currentFlightTimeLog,
    baselineCycles: before?.baselineCycles ?? input.cycles,
    baselineLandings: before?.baselineLandings ?? input.landings,
    baselineMeter: before?.baselineMeter ?? before?.meter ?? input.meter,
    baselineAdjustmentSeconds:
      before?.baselineAdjustmentSeconds ??
      before?.adjustmentSeconds ??
      input.adjustmentSeconds,
  };
  if (!Number.isSafeInteger(totalSeconds(next)) || totalSeconds(next) < 0)
    throw new Error("Aircraft total time must be nonnegative.");
  const components: Component[] = [];
  if (before) {
    const changed = counterFields.filter((k) => next[k] !== before[k]);
    if (changed.length) {
      const lastEvent = before.counterEvents?.at(-1)?.at;
      const at = new Date(
        Math.max(
          now,
          Date.parse(before.latestFlightAt ?? "") + 1 || 0,
          Date.parse(lastEvent ?? "") + 1 || 0,
        ),
      ).toISOString();
      next.counterEvents = [
        ...(before.counterEvents ?? []),
        {
          at,
          meter: next.meter,
          adjustmentSeconds: next.adjustmentSeconds,
          currentHobbs: next.currentHobbs,
          currentTach: next.currentTach,
          currentCyclicHobbs: next.currentCyclicHobbs,
          currentFlightTimeLog: next.currentFlightTimeLog,
          cycles: next.cycles,
          landings: next.landings,
          changed,
          previous: Object.fromEntries(
            changed
              .filter((k) => before[k] !== undefined)
              .map((k) => [k, before[k]]),
          ),
        },
      ];
    }
    const cycles = next.cycles - before.cycles;
    for (const r of s.management ?? [])
      if (
        r.kind === "component" &&
        r.installed &&
        r.aircraftUuid === next.uuid
      ) {
        const delta = r.trackTime
          ? componentAircraftSeconds(r, next) -
            componentAircraftSeconds(r, before)
          : 0;
        const installedSeconds = r.installedSeconds + delta,
          installedCycles = r.installedCycles + (r.trackCycles ? cycles : 0);
        if (installedSeconds < 0 || installedCycles < 0)
          throw new Error(
            "Aircraft readings would invalidate an installed component baseline. Review the verified readings.",
          );
        if (
          installedSeconds !== r.installedSeconds ||
          installedCycles !== r.installedCycles
        )
          components.push({
            ...r,
            installedSeconds,
            installedCycles,
            version: r.version + 1,
          });
      }
  }
  const beforeRecords = s.management ?? [];
  const records = beforeRecords.map(
    (r) => components.find((c) => c.uuid === r.uuid) ?? r,
  );
  validateMaintenanceTotals(next, records, s.inspections);
  s.aircraft = [...s.aircraft.filter((a) => a.uuid !== next.uuid), next];
  s.management = records;
  s.audit.unshift({
    uuid: c.requestUuid,
    actorId: s.user.id,
    at: now,
    action: before ? "aircraft.updated" : "aircraft.created",
    entityUuid: next.uuid,
    aircraftUuid: next.uuid,
    reason: c.reason,
    before: before ? JSON.stringify(before) : undefined,
    after: JSON.stringify(next),
  });
  for (const component of components)
    s.audit.unshift({
      uuid: c.requestUuid + "-" + component.uuid,
      actorId: s.user.id,
      at: now,
      action: "component.aircraft_baseline_adjusted",
      entityUuid: component.uuid,
      aircraftUuid: next.uuid,
      reason: c.reason,
      before: JSON.stringify(
        beforeRecords.find((r) => r.uuid === component.uuid),
      ),
      after: JSON.stringify(component),
    });
  return { aircraft: next, components };
}
