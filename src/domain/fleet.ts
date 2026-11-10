/**
 * Responsibility: Saving Flight Programs and aircraft: their stored schemas,
 *   the checks on a save, counter-change events, and the installed-component
 *   baselines a counter correction moves.
 * Layer: Domain. Zod schemas, rules and an applier on a working snapshot; no
 *   I/O, no React.
 * Dependencies: zod, src/domain/addresses.ts, programs.ts, model.ts,
 *   management.ts, components.ts, changeLog.ts, rejection.ts.
 */
import { addressSchema, formatAddress } from "./addresses";
import { activeProgram, ownsActive, programPermission } from "./programs";
import { z } from "zod";
import { can, totalSeconds, type Aircraft, type Snapshot } from "./model";
import { validateMaintenanceTotals } from "./management";
import { componentAircraftSeconds, type Component } from "./components";
import { auditEntry, type AuditChange } from "./changeLog";
import { Rejection, StaleRecordRejection } from "./rejection";

const HOUR_SECONDS = 3600;
const TENTH_HOUR_SECONDS = 360;
const TENTHS_MESSAGE = "Use tenths of an hour.";

/**
 * The longest name, registration, make, model or serial number a Flight
 * Program or aircraft records.
 */
export const FLEET_NAME_MAX_LENGTH = 150;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const seconds = count.refine(isWholeTenths, TENTHS_MESSAGE);
const text = z.string().trim().min(1).max(FLEET_NAME_MAX_LENGTH);

/**
 * Turns what a person typed as a website into a link: trimmed, with
 * "https://" added to a bare host or to a protocol-relative "//host".
 *
 * @param value - The website as typed.
 * @returns The link; "" for blank input. A value that already starts with a
 *   scheme ("mailto:", "http:") is kept as typed, and so, because it reads as
 *   a scheme, is a host with a port such as "example.org:8080".
 */
export function normalizeWebsite(value: string) {
  const website = value.trim();
  if (!website || /^[a-z][a-z0-9+.-]*:/i.test(website)) return website;
  return website.startsWith("//") ? `https:${website}` : `https://${website}`;
}

/**
 * A Flight Program's stored details. The website is normalized on parse and
 * must then be blank or an http(s) URL.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field, or "Enter a valid
 *   website address." for any other website.
 */
export const programSchema = z.object({
  uuid: text,
  version: count,
  name: text,
  addressDetails: addressSchema.optional(),
  address: z.string().trim().max(4000),
  email: z.union([z.literal(""), z.email()]),
  contactName: z.string().trim().max(FLEET_NAME_MAX_LENGTH),
  website: z
    .string()
    .transform(normalizeWebsite)
    .pipe(z.string().max(2000))
    .refine(
      (s) => !s || (/^https?:\/\//i.test(s) && z.url().safeParse(s).success),
      "Enter a valid website address.",
    ),
});

/** A parsed {@link programSchema} program. */
export type Program = z.infer<typeof programSchema>;

/**
 * An aircraft as the fleet form saves it. Readings are seconds in whole
 * tenths of an hour; the adjustment may be negative.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field, or "Use tenths of
 *   an hour." for a reading or adjustment that is not.
 */
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
  faaSearchModel: z.string().trim().max(FLEET_NAME_MAX_LENGTH).optional(),
  serial: z.string().trim().max(FLEET_NAME_MAX_LENGTH),
  programUuid: z.string().optional(),
  meter: z.enum(["hobbs", "tach", "cyclic", "flightTimeLog"]),
  adjustmentSeconds: z
    .number()
    .int()
    .min(-Number.MAX_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER)
    .refine(isWholeTenths, TENTHS_MESSAGE),
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

/**
 * The manual status assessment recorded on an aircraft, as the aircraft
 * form's Status select words it; not the computed aircraft status.
 */
export const operationalStatusLabels: Record<
  Aircraft["operationalStatus"],
  string
> = {
  unknown: "Unverified",
  airworthy: "Airworthy",
  maintenance: "Maintenance",
  grounded: "Grounded",
};

/** A parsed {@link aircraftInputSchema} aircraft. */
export type AircraftInput = z.infer<typeof aircraftInputSchema>;

/** The aircraft fields a counter change records. */
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

/** One of {@link counterFields}. */
export type CounterField = (typeof counterFields)[number];

/** An aircraft's counters, as a counter change records them. */
export type CounterReadings = Pick<Aircraft, CounterField>;

/**
 * An administrator's change to aircraft counters; holds every counter after
 * it.
 */
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

/**
 * Saves an aircraft or a Flight Program, with the reason for the change log.
 *
 * @throws {z.ZodError} From `parse()` on an unknown action or invalid field.
 */
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

/** A parsed {@link fleetCommandSchema} command. */
export type FleetCommand = z.infer<typeof fleetCommandSchema>;

type ProgramSave = Extract<FleetCommand, { action: "program.save" }>;
type AircraftSave = Extract<FleetCommand, { action: "aircraft.save" }>;
type FleetChange = {
  aircraft?: Aircraft;
  program?: Program;
  components: Component[];
};

/**
 * Reads a total time adjustment typed in hours.
 *
 * @param value - Hours with at most one decimal place, such as "-10.2".
 * @returns The adjustment in seconds.
 * @throws {Rejection} "Enter total time adjustment with at most one decimal
 *   place." or "Total time adjustment is too large."
 */
export function parseAdjustment(value: string) {
  if (!/^-?\d+(\.\d)?$/.test(value.trim()))
    throw new Rejection(
      "Enter total time adjustment with at most one decimal place.",
    );
  const seconds = Math.round(Number(value) * HOUR_SECONDS);
  if (!Number.isSafeInteger(seconds))
    throw new Rejection("Total time adjustment is too large.");
  return seconds;
}

/**
 * Saves a Flight Program or an aircraft, writing a change-log entry for it
 * and for each installed component whose baseline moves.
 *
 * @param s - The working snapshot; its programs, aircraft, `management` and
 *   audit are updated.
 * @param raw - The command, untrusted.
 * @param now - The save time in epoch milliseconds.
 * @returns The saved program, or the saved aircraft and the components whose
 *   install baselines moved.
 * @throws {z.ZodError} When the command does not parse.
 * @throws {Rejection} In check order. Any save: "An active account is
 *   required." A program: "Administrator permission required." (system
 *   administrator, or program administrator saving the active program);
 *   the stale-save message; "Program name already exists."
 *   (any case). An aircraft: "Aircraft belongs to another Flight Program.";
 *   "Program not found."; "Use an explicit Flight Program transfer."; "Aircraft
 *   management permission required."; the stale-save message (a
 *   StaleRecordRejection); "Select Helicopter and enter a Collective
 *   hourmeter reading to use it as the time source."; "Select Flight time log
 *   and enter its reading to use it as the time source."; "Registration
 *   already exists." (any case);
 *   "Aircraft total time must be nonnegative."; "Aircraft readings would
 *   invalidate an installed component baseline. Review the verified readings."
 * @throws {Error} "Correction would move …" from validateMaintenanceTotals,
 *   before a component installation or recorded compliance.
 */
export function applyFleet(
  s: Snapshot,
  raw: FleetCommand,
  now = Date.now(),
): { aircraft?: Aircraft; program?: Program; components: Component[] } {
  const c = fleetCommandSchema.parse(raw);
  if (!s.user.active) throw new Rejection("An active account is required.");
  return c.action === "program.save"
    ? saveProgram(s, c, now)
    : saveAircraft(s, c, now);
}

function saveProgram(s: Snapshot, c: ProgramSave, now: number): FleetChange {
  const input = withAddressText(c.program);
  if (
    !s.user.isAdmin &&
    !(input.uuid === activeProgram(s) && programPermission(s, "admin"))
  )
    throw new Rejection("Administrator permission required.");
  const before = (s.programs ?? []).find((p) => p.uuid === input.uuid);
  if (input.version !== (before?.version ?? 0))
    throw new StaleRecordRejection("program", before?.version ?? 0);
  const name = input.name.toLowerCase();
  if (
    (s.programs ?? []).some(
      (p) => p.uuid !== input.uuid && p.name.toLowerCase() === name,
    )
  )
    throw new Rejection("Program name already exists.");
  const program = { ...input, version: input.version + 1 };
  s.programs = [
    ...(s.programs ?? []).filter((p) => p.uuid !== program.uuid),
    program,
  ];
  s.aircraft = s.aircraft.map((a) =>
    a.programUuid === program.uuid ? { ...a, program: program.name } : a,
  );
  recordFleetChange(
    s,
    {
      uuid: c.requestUuid,
      programUuid: program.uuid,
      action: before ? "program.updated" : "program.created",
      entityUuid: program.uuid,
      reason: c.reason,
      before,
      after: program,
    },
    now,
  );
  return { program, components: [] };
}

function saveAircraft(s: Snapshot, c: AircraftSave, now: number): FleetChange {
  const input = c.aircraft;
  const before = s.aircraft.find((a) => a.uuid === input.uuid);
  assertSameProgram(s, input, before);
  input.programUuid = before?.programUuid ?? activeProgram(s);
  assertMayManageAircraft(s, before);
  if (input.version !== (before?.version ?? 0))
    throw new StaleRecordRejection("aircraft", before?.version ?? 0);
  assertTimeSourceRecorded(input);
  const registration = input.registration.toUpperCase();
  assertRegistrationFree(s, input.uuid, registration);
  const next = buildAircraft(s, input, registration, before);
  if (!Number.isSafeInteger(totalSeconds(next)) || totalSeconds(next) < 0)
    throw new Rejection("Aircraft total time must be nonnegative.");
  if (before) recordCounterChange(before, next, now);
  const components = before ? moveComponentBaselines(s, before, next) : [];
  const beforeRecords = s.management ?? [];
  const records = beforeRecords.map(
    (r) => components.find((c) => c.uuid === r.uuid) ?? r,
  );
  validateMaintenanceTotals(
    next,
    records,
    s.inspections,
    s.airworthiness ?? [],
  );
  s.aircraft = [...s.aircraft.filter((a) => a.uuid !== next.uuid), next];
  s.management = records;
  auditAircraftSave(s, c, before, next, components, beforeRecords, now);
  return { aircraft: next, components };
}

// Editing needs maintenance on the aircraft; adding one needs the program's
// administrator.
function assertMayManageAircraft(s: Snapshot, before: Aircraft | undefined) {
  const allowed = before
    ? can(s, before.uuid, "maintenance")
    : programPermission(s, "admin");
  if (!allowed) throw new Rejection("Aircraft management permission required.");
}

function assertRegistrationFree(
  s: Snapshot,
  uuid: string,
  registration: string,
) {
  const taken = s.aircraft.some(
    (a) => a.uuid !== uuid && a.registration.toUpperCase() === registration,
  );
  if (taken) throw new Rejection("Registration already exists.");
}

// The free-text address and contact fields stay for older screens and
// reports; a structured address rewrites them.
function withAddressText(program: Program): Program {
  const details = program.addressDetails;
  if (!details) return program;
  return {
    ...program,
    address: formatAddress(details),
    email: details.email,
    contactName: details.contactName,
  };
}

// An aircraft changes Flight Program only through a transfer, which moves its
// records with it.
function assertSameProgram(
  s: Snapshot,
  input: AircraftInput,
  before: Aircraft | undefined,
) {
  if (before && !ownsActive(s, before.programUuid))
    throw new Rejection("Aircraft belongs to another Flight Program.");
  if (!input.programUuid) return;
  if (!s.programs?.some((p) => p.uuid === input.programUuid))
    throw new Rejection("Program not found.");
  if (input.programUuid !== activeProgram(s))
    throw new Rejection("Use an explicit Flight Program transfer.");
}

function assertTimeSourceRecorded(input: AircraftInput) {
  if (
    input.meter === "cyclic" &&
    (!input.helicopter || input.currentCyclicHobbs === undefined)
  )
    throw new Rejection(
      "Select Helicopter and enter a Collective hourmeter reading to use it as the time source.",
    );
  if (
    input.meter === "flightTimeLog" &&
    (!input.flightTimeLog || input.currentFlightTimeLog === undefined)
  )
    throw new Rejection(
      "Select Flight time log and enter its reading to use it as the time source.",
    );
}

// Baselines are the counters when the aircraft was created; rebuildFlights
// replays every flight from them, so a save never changes them. Aircraft saved
// before a baseline field existed take today's value for it.
function buildAircraft(
  s: Snapshot,
  input: AircraftInput,
  registration: string,
  before: Aircraft | undefined,
): Aircraft {
  const program = input.programUuid
    ? (s.programs ?? []).find((p) => p.uuid === input.programUuid)
    : undefined;
  // Reached only when the active program is missing from the snapshot.
  if (input.programUuid && !program) throw new Error("Program not found.");
  return {
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
}

// The event is timed after the latest flight and the previous change, even
// when the device clock is behind, so a flight rebuild applies it after them.
function recordCounterChange(before: Aircraft, next: Aircraft, now: number) {
  const changed = counterFields.filter((k) => next[k] !== before[k]);
  if (!changed.length) return;
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

// A counter correction must not change an installed component's own usage, so
// its install baseline moves by the same time and cycles.
function moveComponentBaselines(
  s: Snapshot,
  before: Aircraft,
  next: Aircraft,
): Component[] {
  const cycles = next.cycles - before.cycles;
  return (s.management ?? []).flatMap((r) => {
    if (r.kind !== "component" || !r.installed || r.aircraftUuid !== next.uuid)
      return [];
    const delta = r.trackTime
      ? componentAircraftSeconds(r, next) - componentAircraftSeconds(r, before)
      : 0;
    const installedSeconds = r.installedSeconds + delta;
    const installedCycles = r.installedCycles + (r.trackCycles ? cycles : 0);
    if (installedSeconds < 0 || installedCycles < 0)
      throw new Rejection(
        "Aircraft readings would invalidate an installed component baseline. Review the verified readings.",
      );
    if (
      installedSeconds === r.installedSeconds &&
      installedCycles === r.installedCycles
    )
      return [];
    return [
      { ...r, installedSeconds, installedCycles, version: r.version + 1 },
    ];
  });
}

function auditAircraftSave(
  s: Snapshot,
  c: AircraftSave,
  before: Aircraft | undefined,
  next: Aircraft,
  components: Component[],
  beforeRecords: NonNullable<Snapshot["management"]>,
  now: number,
) {
  recordFleetChange(
    s,
    {
      uuid: c.requestUuid,
      action: before ? "aircraft.updated" : "aircraft.created",
      entityUuid: next.uuid,
      aircraftUuid: next.uuid,
      reason: c.reason,
      before,
      after: next,
    },
    now,
  );
  for (const component of components)
    recordFleetChange(
      s,
      {
        uuid: `${c.requestUuid}-${component.uuid}`,
        action: "component.aircraft_baseline_adjusted",
        entityUuid: component.uuid,
        aircraftUuid: next.uuid,
        reason: c.reason,
        before: beforeRecords.find((r) => r.uuid === component.uuid),
        after: component,
      },
      now,
    );
}

function recordFleetChange(s: Snapshot, change: AuditChange, now: number) {
  s.audit.unshift(auditEntry(s, change, now));
}

function isWholeTenths(n: number) {
  return n % TENTH_HOUR_SECONDS === 0;
}
