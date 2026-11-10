/**
 * Responsibility: The core records (aircraft, flights, discrepancies,
 *   inspections, audit entries), the Snapshot read model, the offline outbox
 *   entry, and the shared permission, pilot, counter, hours and local-date
 *   rules.
 * Layer: Domain. Pure types, zod schemas and functions; no I/O, no React.
 * Dependencies: zod; src/domain/flightFluids.ts, flightChecklistSchema.ts,
 *   programs.ts, readings.ts and rejection.ts; types from the feature modules.
 */
import { fuelSchema, oilSchema } from "./flightFluids";
import { checklistFlightSchema } from "./flightChecklistSchema";
import { ownsActive, activeProgram, groupCoversAircraft } from "./programs";
import { meterReadingSchema } from "./readings";
import { Rejection } from "./rejection";
import { z } from "zod";

/** Typed hours as stored seconds; see ./readings, kept here for importers. */
export { parseHours } from "./readings";

const HOUR_SECONDS = 3600;
const HOUR_MS = HOUR_SECONDS * 1000;

// The world's time zones run from UTC-12 to UTC+14.
const FURTHEST_BEHIND_UTC_MS = 12 * HOUR_MS;
const FURTHEST_AHEAD_OF_UTC_MS = 14 * HOUR_MS;

/** The longest flight remark, flight discrepancy or problem report. */
export const NOTE_MAX_LENGTH = 5000;
/** The most landings, or cycles, that one flight may log. */
export const FLIGHT_COUNT_MAX = 1000;
/** The longest origin or destination a flight may name. */
export const FLIGHT_PLACE_MAX_LENGTH = 100;
const ENGINE_START_CYCLES_MODEL = "R66";

/**
 * The permissions a group grants over its aircraft (GLOSSARY "Permission
 * group").
 */
export const permissionSchema = z.enum([
  "read",
  "flight",
  "discrepancy",
  "resolve",
  "maintenance",
]);

/** One permission a group can grant. */
export type Permission = z.infer<typeof permissionSchema>;

/**
 * A permission group of one Flight Program. It covers the aircraft in
 * `aircraftIds`, or all of them when the list is empty, except that an owner
 * group then covers none; a program-administrator group covers all.
 */
export interface Group {
  programUuid?: string;
  programAdmin?: boolean;
  /** Aircraft owner: a read-only portal for the covered aircraft. */
  owner?: boolean;
  /** Board member: the read-only fleet summary (GLOSSARY "Board view"). */
  board?: boolean;
  id: string;
  name: string;
  aircraftIds: string[];
  permissions: Permission[];
}

/** A user as the Flight Program sees them, with their own preferences. */
export interface Member {
  certifications?: import("./certifications").Certification[];
  licenseNumber?: string;
  logbookPhrases?: string[];
  releaseStatements?: { label: string; text: string }[];
  certificateType?: string;
  availableAsPilot?: boolean;
  /** Unset: program administrators receive alert digests, others do not. */
  emailAlerts?: boolean;
  /** Unset: program administrators and maintenance members get urgent alerts
   * by email at once, others do not. */
  urgentAlertEmails?: boolean;
  activeProgramUuid?: string;
  id: string;
  name: string;
  email: string;
  active: boolean;
  isAdmin: boolean;
  groupIds: string[];
}

/**
 * An aircraft and its counters. Times are seconds; `meter` is the meter its
 * hours are read from, and `adjustmentSeconds` turns that reading into total
 * time (GLOSSARY "Total time").
 */
export interface Aircraft {
  photoUrl?: string;
  twin?: boolean;
  turbine?: boolean;
  amphibious?: boolean;
  helicopter?: boolean;
  flightTimeLog?: boolean;
  uuid: string;
  registration: string;
  make: string;
  model: string;
  faaSearchModel?: string;
  serial: string;
  program: string;
  programUuid?: string;
  baselineMeter?: "hobbs" | "tach" | "cyclic" | "flightTimeLog";
  baselineAdjustmentSeconds?: number;
  counterEvents?: import("./fleet").AircraftCounterEvent[];
  meter: "hobbs" | "tach" | "cyclic" | "flightTimeLog";
  adjustmentSeconds: number;
  baselineHobbs: number;
  baselineTach: number;
  baselineCyclicHobbs?: number;
  baselineFlightTimeLog?: number;
  baselineCycles: number;
  baselineLandings: number;
  currentHobbs: number;
  currentTach: number;
  currentCyclicHobbs?: number;
  currentFlightTimeLog?: number;
  cycles: number;
  landings: number;
  version: number;
  latestFlightAt?: string;
  operationalStatus: "unknown" | "airworthy" | "maintenance" | "grounded";
}
/** One engine start logged with a flight: the engine, duration and peak EGT. */
export const engineStartSchema = z.object({
  engine: z.enum(["single", "left", "right"]),
  durationSeconds: z.number().finite().nonnegative().optional(),
  maxEgtC: z.number().finite().optional(),
});

/** A parsed engine start. */
export type EngineStart = z.infer<typeof engineStartSchema>;

/**
 * A flight as the pilot logs it. Meter readings are seconds in whole tenths of
 * an hour; engine starts name one single engine, or distinct left and right.
 *
 * @throws {z.ZodError} From `parse()` on a missing or malformed field,
 *   including "Meter readings must use tenths of an hour".
 */
export const flightInputSchema = z.object({
  fuel: fuelSchema.optional(),
  oil: oilSchema.optional(),
  checklistRun: checklistFlightSchema.optional(),
  engineStarts: z
    .array(engineStartSchema)
    .max(2)
    .refine(
      (starts) =>
        new Set(starts.map((s) => s.engine)).size === starts.length &&
        !(starts.length > 1 && starts.some((s) => s.engine === "single")),
      "Use either a single engine or distinct left and right engines.",
    )
    .optional(),
  landingSurface: z.enum(["sea", "land"]).nullable().optional(),
  flightPlanUuid: z.string().uuid().optional(),
  aircraftUuid: z.string().min(1),
  pilotId: z.string().min(1),
  copilotId: z.string().optional(),
  startTime: z.iso.datetime({ offset: true }),
  hobbsOn: meterReadingSchema.optional(),
  tachOn: meterReadingSchema.optional(),
  cyclicHobbsOn: meterReadingSchema.optional(),
  flightTimeLogOn: meterReadingSchema.optional(),
  landings: z.number().int().nonnegative().max(FLIGHT_COUNT_MAX),
  cycles: z.number().int().nonnegative().max(FLIGHT_COUNT_MAX),
  origin: z.string().max(FLIGHT_PLACE_MAX_LENGTH),
  destination: z.string().max(FLIGHT_PLACE_MAX_LENGTH),
  operation: z.enum([
    "Gov medical",
    "Mission medical",
    "Mission",
    "Commercial",
    "Private",
  ]),
  flightRules: z.enum(["VFR", "IFR"]),
  remarks: z.string().max(NOTE_MAX_LENGTH),
  discrepancy: z.string().max(NOTE_MAX_LENGTH),
});

/** A parsed flight log entry. */
export type FlightInput = z.infer<typeof flightInputSchema>;

/**
 * A submitted flight and its outcome: accepted, held for review with the
 * reason (a held flight), or rejected.
 */
export interface Flight extends FlightInput {
  uuid: string;
  authorId: string;
  submittedAt: number;
  status: "accepted" | "review" | "rejected";
  reviewReason?: string;
  /** The aircraft's readings when the flight was submitted: where it started.
   * The pilot's `hobbsOn` and the other `*On` readings are where it ended. */
  hobbsOff?: number;
  tachOff?: number;
  cyclicHobbsOff?: number;
  flightTimeLogOff?: number;
  dispatchOverride?: import("./aircraftStatus").DispatchOverride;
}

/** A reported defect, open until resolved; it may ground or be deferred. */
export interface Discrepancy {
  grounding?: boolean;
  deferral?: import("./deferrals").Deferral;
  requiredParts?: import("./requiredParts").RequiredPart[];
  partsVersion?: number;
  uuid: string;
  aircraftUuid: string;
  flightUuid?: string;
  description: string;
  status: "open" | "resolved";
  authorId: string;
  createdAt: number;
  resolution?: string;
  resolvedBy?: string;
  resolvedAt?: number;
}

/**
 * A recurring or one-time requirement on an aircraft or component, due by
 * hours (seconds), cycles, landings or calendar (GLOSSARY "Inspection").
 */
export interface Inspection {
  calendarExempt?: boolean;
  calendarExemptReason?: string;
  calendarExemptChangedAt?: number;
  calendarExemptChangedBy?: string;
  usageMeter?: "aircraft" | "collective";
  requiredParts?: import("./requiredParts").RequiredPart[];
  sourceKey?: string;
  manualReference?: import("./manuals").ManualReference | null;
  programUuid?: string;
  ataChapter?: import("./ata").AtaChapter;
  componentUuid?: string;
  version?: number;
  intervalSeconds?: number;
  intervalCycles?: number;
  intervalLandings?: number;
  intervalMonths?: number;
  lastSeconds?: number;
  lastCycles?: number;
  lastLandings?: number;
  lastDate?: string;
  materials?: string;
  archived?: boolean;
  uuid: string;
  aircraftUuid: string;
  reference: string;
  description: string;
  dueSeconds?: number;
  dueCycles?: number;
  dueLandings?: number;
  dueDate?: string;
}

/** One change-log row: who changed what and when, with before and after. */
export interface AuditEntry {
  programUuid?: string;
  uuid: string;
  aircraftUuid?: string;
  actorId: string;
  at: number;
  action: string;
  entityUuid: string;
  reason?: string;
  before?: string;
  after?: string;
}

/**
 * The scoped read model the server sends and the device caches: the active
 * Flight Program's records the user may see. Optional collections are absent
 * where the program or the user's permissions leave them out.
 */
export interface Snapshot {
  aircraftFiles?: import("./aircraftFiles").AircraftFile[];
  certificationFiles?: (import("./certifications").CertificationFile & {
    url: string;
  })[];
  faaCredential?: import("./faaCredential").FaaCredentialStatus;
  expiringItems?: import("./expiringItems").ExpiringItem[];
  faaMonitors?: import("./faa").FaaMonitor[];
  airworthiness?: import("./airworthiness").AD[];
  purchaseOrderFiles?: {
    uuid: string;
    poUuid: string;
    receiptUuid?: string;
    name: string;
    url: string;
    type: string;
    size: number;
    uploadedAt: number;
  }[];
  partsOnOrder?: { stockUuid: string; quantity: number; shipped: number }[];
  savedAddresses?: import("./savedAddresses").SavedAddress[];
  partsRequests?: import("./partsRequests").PartsRequest[];
  partsRequestPurchases?: import("./partsRequests").RequestPurchase[];
  purchaseOrders?: import("./purchaseOrders").PurchaseOrder[];
  checklists?: import("./checklists").ChecklistRecord[];
  inventoryAttachments?: import("./inventoryAttachments").InventoryAttachment[];
  partsInventory?: import("./requiredParts").PartsInventory;
  componentTemplates?: import("./componentTemplates").ComponentTemplate[];
  componentSetups?: import("./componentTemplates").ComponentSetup[];
  inspectionTemplates?: import("./inspectionTemplates").InspectionTemplate[];
  manuals?: import("./manuals").Manual[];
  taskCards?: import("./taskCards").TaskCard[];
  archivedTaskCards?: import("./taskCards").TaskCard[];
  taskEvidence?: import("./taskCards").TaskEvidence[];
  workOrders?: import("./workOrders").WorkOrder[];
  workOrderAttachments?: import("./workOrders").WorkOrderAttachment[];
  flightPlans?: import("./flightPlans").FlightPlan[];
  // Demo mode only: the live app loads engine trends per aircraft on demand.
  engineTrends?: import("./engineTrends").EngineTrend[];
  engineTrendLimits?: (import("./engineTrends").EngineLimits & {
    aircraftUuid: string;
  })[];
  programScopeVersion?: 1;
  activeProgramUuid?: string;
  programs?: import("./fleet").Program[];
  user: Member;
  authenticatedAt: number;
  syncedAt: number;
  groups: Group[];
  members: Member[];
  aircraft: Aircraft[];
  flights: Flight[];
  discrepancies: Discrepancy[];
  inspections: Inspection[];
  audit: AuditEntry[];
  management?: import("./management").ManagedRecord[];
  costs?: import("./costs").CostRecord[];
  /** Board view only: cost totals in place of the cost records. */
  boardCosts?: import("./boardView").BoardAircraftCosts[];
  /** When the newest off-site backup finished; set for the board view. */
  offsiteBackupAt?: number;
}

/**
 * An offline outbox entry: a flight or a problem report recorded on the
 * device. The server applies each `uuid` once.
 *
 * @throws {z.ZodError} From `parse()` on an unknown kind or a malformed field.
 */
export const operationSchema = z.discriminatedUnion("kind", [
  z.object({
    programUuid: z.string().optional(),
    kind: z.literal("flight"),
    uuid: z.string().uuid(),
    authorId: z.string(),
    baseVersion: z.number().int().nonnegative(),
    input: flightInputSchema,
    dispatchOverrideReason: z.string().max(1000).optional(),
  }),
  z.object({
    programUuid: z.string().optional(),
    kind: z.literal("discrepancy"),
    uuid: z.string().uuid(),
    authorId: z.string(),
    aircraftUuid: z.string(),
    flightUuid: z.string().optional(),
    description: z.string().trim().min(1).max(NOTE_MAX_LENGTH),
    grounding: z.boolean().optional(),
  }),
]);

/** A parsed outbox entry. */
export type Operation = z.infer<typeof operationSchema>;

/** An outbox entry with when it was queued and its sync error, if any. */
export interface QueuedOperation {
  operation: Operation;
  queuedAt: number;
  error?: string;
}

/** How long after sign-in a device may open its cached snapshot offline. */
export const OFFLINE_WINDOW = 7 * 24 * HOUR_MS;

/**
 * Whether the user may act on an aircraft: an active user, the aircraft in the
 * active Flight Program, and a system administrator or a group of that program
 * covering the aircraft with `read` plus the permission (program-administrator
 * groups hold every one). A convenience: the server checks again.
 *
 * @param snapshot - The user's snapshot.
 * @param aircraftUuid - The aircraft acted on.
 * @param permission - The permission the action needs.
 * @returns True when allowed.
 */
export function can(
  snapshot: Snapshot,
  aircraftUuid: string,
  permission: Permission,
): boolean {
  return (
    snapshot.user.active &&
    snapshot.aircraft.some(
      (a) => a.uuid === aircraftUuid && ownsActive(snapshot, a.programUuid),
    ) &&
    (snapshot.user.isAdmin ||
      snapshot.groups.some(
        (g) =>
          snapshot.user.groupIds.includes(g.id) &&
          g.programUuid === activeProgram(snapshot) &&
          groupCoversAircraft(g, aircraftUuid) &&
          g.permissions.includes("read") &&
          (g.programAdmin || g.permissions.includes(permission)),
      ))
  );
}

/**
 * Whether a member may be chosen as a flight's pilot or copilot: active, and
 * not marked unavailable for the active Flight Program.
 *
 * @param m - The member.
 * @returns True when available.
 */
export function isAvailablePilot(
  m: Pick<Member, "active" | "availableAsPilot">,
): boolean {
  return m.active && m.availableAsPilot !== false;
}

/**
 * How far a device clock may run behind the server's sign-in time: the
 * server stamps `authenticatedAt`, the device compares it with its own clock.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

/**
 * Whether a cached snapshot may open: an active user, signed in less than
 * {@link OFFLINE_WINDOW} before `now`, and not after it by more than
 * {@link CLOCK_SKEW_TOLERANCE_MS}. A clock further behind stays locked out,
 * or setting it back would keep offline access open for good.
 *
 * @param snapshot - The cached snapshot.
 * @param now - The current time (epoch ms).
 * @returns True while the offline window is open.
 */
export function offlineValid(snapshot: Snapshot, now = Date.now()): boolean {
  return (
    snapshot.user.active &&
    !deviceClockBehind(snapshot, now) &&
    now < snapshot.authenticatedAt + OFFLINE_WINDOW
  );
}

/**
 * Whether the device clock reads earlier than the sign-in the server
 * recorded, by more than {@link CLOCK_SKEW_TOLERANCE_MS}: the reason a fresh
 * sign-in would not open, which is not an expired window.
 *
 * @param snapshot - The cached snapshot.
 * @param now - The current time (epoch ms).
 */
export function deviceClockBehind(
  snapshot: Pick<Snapshot, "authenticatedAt">,
  now = Date.now(),
): boolean {
  return now < snapshot.authenticatedAt - CLOCK_SKEW_TOLERANCE_MS;
}

/** The display name of each meter an aircraft's hours can be read from. */
export const aircraftMeterLabels = {
  hobbs: "Hobbs",
  tach: "Tach",
  cyclic: "Collective hourmeter",
  flightTimeLog: "Flight time log",
};

/**
 * Whether an aircraft model's cycles are its engine starts, as on the R66.
 *
 * @param model - The aircraft model, matched trimmed and ignoring case.
 * @returns True for the R66.
 */
export function logsEngineStartsAsCycles(model: string): boolean {
  return model.trim().toUpperCase() === ENGINE_START_CYCLES_MODEL;
}

/**
 * The aircraft's current reading on its own meter.
 *
 * @param aircraft - The aircraft's meter and current readings.
 * @returns The reading in seconds.
 * @throws {Rejection} "Flight time log reading is required." or "Collective
 *   hourmeter reading is required." when that meter has no reading.
 */
export function aircraftMeterReading(
  aircraft: Pick<
    Aircraft,
    | "meter"
    | "currentHobbs"
    | "currentTach"
    | "currentCyclicHobbs"
    | "currentFlightTimeLog"
  >,
): number {
  if (aircraft.meter === "flightTimeLog") {
    if (aircraft.currentFlightTimeLog === undefined)
      throw new Rejection("Flight time log reading is required.");
    return aircraft.currentFlightTimeLog;
  }
  if (aircraft.meter === "cyclic") {
    if (aircraft.currentCyclicHobbs === undefined)
      throw new Rejection("Collective hourmeter reading is required.");
    return aircraft.currentCyclicHobbs;
  }
  return aircraft.meter === "hobbs"
    ? aircraft.currentHobbs
    : aircraft.currentTach;
}

/**
 * The calendar date in the runtime's time zone: the device's in the browser,
 * UTC on the Convex server.
 *
 * @param now - The time (epoch ms).
 * @returns The date as YYYY-MM-DD.
 */
export function localDate(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The latest date that is today anywhere: the server's limit for "not in the
 * future", whatever the user's time zone.
 *
 * @param now - The time (epoch ms).
 * @returns The date as YYYY-MM-DD.
 */
export function latestLocalDate(now = Date.now()): string {
  return formatUtcDate(now + FURTHEST_AHEAD_OF_UTC_MS);
}

/**
 * Whether a date is today in some time zone.
 *
 * @param d - The date as YYYY-MM-DD.
 * @param now - The time (epoch ms).
 * @returns True for the dates from the furthest-behind zone's to the
 *   furthest-ahead zone's.
 */
export function isLocalToday(d: string, now = Date.now()): boolean {
  return (
    d >= formatUtcDate(now - FURTHEST_BEHIND_UTC_MS) &&
    d <= latestLocalDate(now)
  );
}

/**
 * The aircraft's total time in service (GLOSSARY "Total time").
 *
 * @param aircraft - The aircraft.
 * @returns Its meter reading plus its adjustment, in seconds.
 * @throws {Rejection} As {@link aircraftMeterReading}.
 */
export function totalSeconds(aircraft: Aircraft): number {
  return aircraftMeterReading(aircraft) + aircraft.adjustmentSeconds;
}

/**
 * The aircraft's total time, for a screen that shows it rather than records
 * against it. The aircraft form requires a meter reading, so only damaged or
 * hand-edited data lacks one.
 *
 * @param aircraft - The aircraft.
 * @returns As {@link totalSeconds}, or undefined when its meter has no
 *   reading.
 */
export function recordedTotalSeconds(aircraft: Aircraft): number | undefined {
  try {
    return totalSeconds(aircraft);
  } catch (error) {
    if (error instanceof Rejection) return undefined;
    throw error;
  }
}

/**
 * Formats seconds as hours for display.
 *
 * @param seconds - The time in seconds.
 * @returns Hours rounded to one decimal, with US thousands separators, such
 *   as "1,234.5".
 */
export function hours(seconds: number): string {
  return (seconds / HOUR_SECONDS).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function formatUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
