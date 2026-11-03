import { fuelSchema, oilSchema } from "./flightFluids";
import { checklistFlightSchema } from "./flightChecklistSchema";
import { ownsActive, activeProgram, groupCoversAircraft } from "./programs";
import { z } from "zod";
export const permissionSchema = z.enum([
  "read",
  "flight",
  "discrepancy",
  "resolve",
  "maintenance",
]);
export type Permission = z.infer<typeof permissionSchema>;
export interface Group {
  programUuid?: string;
  programAdmin?: boolean;
  /** Aircraft owner: read-only portal limited to `aircraftIds` (none if empty). */
  owner?: boolean;
  id: string;
  name: string;
  aircraftIds: string[];
  permissions: Permission[];
}
export interface Member {
  certifications?: import("./certifications").Certification[];
  licenseNumber?: string;
  logbookPhrases?: string[];
  releaseStatements?: { label: string; text: string }[];
  certificateType?: string;
  availableAsPilot?: boolean;
  // Unset: program administrators receive alert digests, others do not.
  emailAlerts?: boolean;
  activeProgramUuid?: string;
  id: string;
  name: string;
  email: string;
  active: boolean;
  isAdmin: boolean;
  groupIds: string[];
}
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
const meterSchema = z
  .number()
  .int()
  .nonnegative()
  .refine((n) => n % 360 === 0, "Meter readings must use tenths of an hour");
export const engineStartSchema = z.object({
  engine: z.enum(["single", "left", "right"]),
  durationSeconds: z.number().finite().nonnegative().optional(),
  maxEgtC: z.number().finite().optional(),
});
export type EngineStart = z.infer<typeof engineStartSchema>;
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
  hobbsOn: meterSchema.optional(),
  tachOn: meterSchema.optional(),
  cyclicHobbsOn: meterSchema.optional(),
  flightTimeLogOn: meterSchema.optional(),
  landings: z.number().int().nonnegative().max(1000),
  cycles: z.number().int().nonnegative().max(1000),
  origin: z.string().max(100),
  destination: z.string().max(100),
  operation: z.enum([
    "Gov medical",
    "Mission medical",
    "Mission",
    "Commercial",
    "Private",
  ]),
  flightRules: z.enum(["VFR", "IFR"]),
  remarks: z.string().max(5000),
  discrepancy: z.string().max(5000),
});
export type FlightInput = z.infer<typeof flightInputSchema>;
export interface Flight extends FlightInput {
  uuid: string;
  authorId: string;
  submittedAt: number;
  status: "accepted" | "review" | "rejected";
  reviewReason?: string;
  hobbsOff?: number;
  tachOff?: number;
  cyclicHobbsOff?: number;
  flightTimeLogOff?: number;
  dispatchOverride?: import("./aircraftStatus").DispatchOverride;
}
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
export interface Snapshot {
  aircraftFiles?: import("./aircraftFiles").AircraftFile[];
  certificationFiles?: (import("./certifications").CertificationFile & {
    url: string;
  })[];
  faaCredential?: import("./faaCredential").FaaCredentialStatus;
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
}
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
    description: z.string().trim().min(1).max(5000),
    grounding: z.boolean().optional(),
  }),
]);
export type Operation = z.infer<typeof operationSchema>;
export interface QueuedOperation {
  operation: Operation;
  queuedAt: number;
  error?: string;
}
export const OFFLINE_WINDOW = 7 * 24 * 60 * 60 * 1000;
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
export function offlineValid(snapshot: Snapshot, now = Date.now()): boolean {
  return (
    snapshot.user.active &&
    now >= snapshot.authenticatedAt &&
    now < snapshot.authenticatedAt + OFFLINE_WINDOW
  );
}
export const aircraftMeterLabels = {
  hobbs: "Hobbs",
  tach: "Tach",
  cyclic: "Collective hourmeter",
  flightTimeLog: "Flight time log",
};
export function aircraftMeterReading(
  aircraft: Pick<
    Aircraft,
    | "meter"
    | "currentHobbs"
    | "currentTach"
    | "currentCyclicHobbs"
    | "currentFlightTimeLog"
  >,
) {
  if (aircraft.meter === "flightTimeLog") {
    if (aircraft.currentFlightTimeLog === undefined)
      throw new Error("Flight time log reading is required.");
    return aircraft.currentFlightTimeLog;
  }
  if (aircraft.meter === "cyclic") {
    if (aircraft.currentCyclicHobbs === undefined)
      throw new Error("Collective hourmeter reading is required.");
    return aircraft.currentCyclicHobbs;
  }
  return aircraft.meter === "hobbs"
    ? aircraft.currentHobbs
    : aircraft.currentTach;
}
/** Device-local calendar date (YYYY-MM-DD). The Convex server's zone is UTC. */
export function localDate(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const hourMs = 3600000;
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Latest local date in any zone (UTC+14); server-safe "not in the future" limit. */
export function latestLocalDate(now = Date.now()) {
  return utcDate(now + 14 * hourMs);
}
/** Whether a date is today's local date in some zone (UTC-12 to UTC+14). */
export function isLocalToday(d: string, now = Date.now()) {
  return d >= utcDate(now - 12 * hourMs) && d <= latestLocalDate(now);
}
export function totalSeconds(aircraft: Aircraft) {
  return aircraftMeterReading(aircraft) + aircraft.adjustmentSeconds;
}
export function hours(seconds: number) {
  return (seconds / 3600).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}
export function parseHours(value: string): number | undefined {
  if (!value.trim()) return undefined;
  if (!/^\d+(\.\d)?$/.test(value))
    throw new Error("Use positive hours with at most one decimal place.");
  const result = Math.round(Number(value) * 3600);
  if (!Number.isSafeInteger(result))
    throw new Error("Meter reading is too large.");
  return result;
}
