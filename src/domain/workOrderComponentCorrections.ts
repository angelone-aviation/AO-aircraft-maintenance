/**
 * Responsibility: Correcting the component work recorded at a work order's
 *   close-out: the preview, its refusals, and the records it would change.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: zod, ./components, ./workOrderComponentWork, ./model,
 *   ./workOrderCloseoutSchema, ./management, ./workOrders, ./rejection.
 *
 * The work is replayed at the completion readings on the records saved before
 * it (the tracking baseline), keeping later usage; later changes need review.
 */
import { z } from "zod";
import {
  componentSchema,
  requirementSchema,
  movementSchema,
  componentTotals,
} from "./components";
import {
  applyWorkOrderComponentWork,
  componentWorkSchema,
  componentWorkLabels,
} from "./workOrderComponentWork";
import { trackingBaselineSchema } from "./workOrderCloseoutSchema";
import { aircraftMeterReading, type Aircraft, type Snapshot } from "./model";
import type { ManagedRecord } from "./management";
import type { WorkOrder } from "./workOrders";
import { Rejection, StaleRecordRejection } from "./rejection";

const HOUR_SECONDS = 3600;
const totalsSchema = z.object({
  timeSinceNew: z.number(),
  timeSinceOverhaul: z.number().nullable(),
  timeSinceRepair: z.number().nullable(),
  cyclesSinceNew: z.number(),
  serviceDays: z.number(),
  calendarOverhaulDays: z.number().nullable().optional(),
});

/**
 * A request to correct the work recorded for one component at close-out.
 *
 * @throws {z.ZodError} From `parse()` on a blank reason or one over 1,500
 *   characters, or invalid work.
 */
export const componentCorrectionCommandSchema = z.object({
  action: z.literal("correctComponent"),
  uuid: z.string().uuid(),
  version: z.number().int().nonnegative(),
  aircraftVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1500),
  choice: componentWorkSchema,
});

/** A request to correct one component's close-out work. */
export type ComponentCorrectionCommand = z.infer<
  typeof componentCorrectionCommandSchema
>;

/**
 * A correction as stored on the work order: who made it and why, the work
 * before and after, the totals at completion and now on both sides, the
 * requirements as JSON, and the logbook addendum.
 */
export const componentCorrectionSchema = z.object({
  uuid: z.string().uuid(),
  componentUuid: z.string(),
  recordedAt: z.number(),
  authorId: z.string(),
  authorName: z.string(),
  reason: z.string(),
  originalAction: z.enum(["service", "repair", "overhaul", "both"]),
  choice: componentWorkSchema,
  trackingBaseline: trackingBaselineSchema,
  completionBefore: totalsSchema,
  completionAfter: totalsSchema,
  currentBefore: totalsSchema,
  currentAfter: totalsSchema,
  requirementsBefore: z.string(),
  requirementsAfter: z.string(),
  addendum: z.string(),
});

/**
 * Works out a correction without changing the snapshot; the caller stores the
 * result in one transaction.
 *
 * @param s - The aircraft, the component's records and later work orders.
 * @param order - The completed work order.
 * @param raw - The correction request.
 * @param now - When the correction is recorded.
 * @returns The correction, and the management records to store in its place.
 * @throws {Rejection} When the order or component is not correctable, or
 *   later records need manual review; a StaleRecordRejection when the order,
 *   component or aircraft is stale.
 */
export function previewComponentCorrection(
  s: Snapshot,
  order: WorkOrder,
  raw: ComponentCorrectionCommand,
  now = Date.now(),
) {
  const command = componentCorrectionCommandSchema.parse(raw);
  const target = findCorrectableWork(order, command);
  const { current, aircraft } = findCurrentRecords(s, order, command, target);
  const { before, relevant } = readTrackingBaseline(s, current, target);
  assertNoLaterWork(s, order, current, target);
  const c: Correcting = { s, order, command, target, current, aircraft, now };
  const replay = replayAtCompletion(c, before, relevant);
  const uuid = crypto.randomUUID();
  const newMovements = replay.movements.map((r) => ({
    ...r,
    workOrderUuid: order.uuid,
    correctionUuid: uuid,
  }));
  const correction = buildCorrection(c, replay, relevant, uuid, [
    ...target.baseline.movementUuids,
    ...newMovements.map((r) => r.uuid),
    uuid,
  ]);
  const correctionMovement = buildCorrectionMovement(c, replay, uuid);
  const management = supersedeRecords(s, replay.updated, target, uuid);
  return {
    correction,
    management: [...management, ...newMovements, correctionMovement],
  };
}

type CloseoutWork = NonNullable<
  NonNullable<WorkOrder["closeout"]>["componentWork"]
>[number];
type TrackedRecord = z.infer<typeof recordsSchema>[number];
type CurrentComponent = Extract<ManagedRecord, { kind: "component" }>;
type Totals = ReturnType<typeof componentTotals>;
type Replay = ReturnType<typeof replayAtCompletion>;

interface CorrectableWork {
  closeout: NonNullable<WorkOrder["closeout"]>;
  original: CloseoutWork;
  prior?: z.infer<typeof componentCorrectionSchema>;
  baseline: z.infer<typeof trackingBaselineSchema>;
  // The work as last recorded: the latest correction's, or the close-out's.
  effective: { action: CloseoutWork["action"]; description: string };
}

interface Correcting {
  s: Snapshot;
  order: WorkOrder;
  command: ComponentCorrectionCommand;
  target: CorrectableWork;
  current: CurrentComponent;
  aircraft: Aircraft;
  now: number;
}

const recordsSchema = z.array(z.union([componentSchema, requirementSchema]));

// Compares records whatever their key order: the baseline is stored JSON.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

function findCorrectableWork(
  order: WorkOrder,
  command: ComponentCorrectionCommand,
): CorrectableWork {
  const closeout = order.closeout;
  if (order.status !== "completed" || !closeout)
    throw new Rejection(
      "A completed work order with saved closeout readings is required.",
    );
  if (command.uuid !== order.uuid || command.version !== order.version)
    throw new StaleRecordRejection("workOrder", order.version);
  const original = closeout.componentWork?.find(
    (c) => c.componentUuid === command.choice.componentUuid,
  );
  if (!original)
    throw new Rejection("This component was not recorded at closeout.");
  if (
    ["install", "remove"].includes(original.action) ||
    ["install", "remove"].includes(command.choice.action)
  )
    throw new Rejection(
      "Record component movement changes through a new work order.",
    );
  const prior = order.componentCorrections
    ?.filter((c) => c.componentUuid === original.componentUuid)
    .at(-1);
  const baseline = prior?.trackingBaseline ?? original.trackingBaseline;
  if (!baseline)
    throw new Rejection(
      "Manual review required: this older closeout does not contain the pre-service component and requirement records needed for a safe tracking correction.",
    );
  const effective = prior?.choice ?? original;
  assertWorkChanged(effective, command.choice);
  return { closeout, original, prior, baseline, effective };
}

function assertWorkChanged(
  effective: { action: string; description: string; reference: string },
  choice: ComponentCorrectionCommand["choice"],
) {
  if (
    effective.action === choice.action &&
    effective.description === choice.description &&
    effective.reference === choice.reference
  )
    throw new Rejection(
      "Change the component work performed before previewing a correction.",
    );
}

function findCurrentRecords(
  s: Snapshot,
  order: WorkOrder,
  command: ComponentCorrectionCommand,
  { original }: CorrectableWork,
) {
  const current = s.management?.find(
    (r) => r.kind === "component" && r.uuid === original.componentUuid,
  );
  const aircraft = s.aircraft.find((a) => a.uuid === order.aircraftUuid);
  if (
    !current ||
    current.kind !== "component" ||
    !aircraft ||
    aircraft.version !== command.aircraftVersion ||
    current.version !== command.choice.version
  )
    throw new StaleRecordRejection(
      "component",
      current?.kind === "component" ? current.version : 0,
    );
  return { current, aircraft };
}

// The component and its requirements must still be exactly as the close-out
// (or the latest correction) left them; later records are never overwritten.
function readTrackingBaseline(
  s: Snapshot,
  current: CurrentComponent,
  { baseline }: CorrectableWork,
) {
  const expected = recordsSchema.parse(JSON.parse(baseline.after));
  const before = recordsSchema.parse(JSON.parse(baseline.before));
  const relevant = (s.management ?? []).filter(
    (r) =>
      (r.kind === "component" && r.uuid === current.uuid) ||
      (r.kind === "componentRequirement" && r.componentUuid === current.uuid),
  );
  if (canonical(sortByUuid(relevant)) !== canonical(sortByUuid(expected)))
    throw new Rejection(
      "Manual review required: component tracking or service requirements changed after this closeout. Later records will not be overwritten.",
    );
  return { before, relevant };
}

function assertNoLaterWork(
  s: Snapshot,
  order: WorkOrder,
  current: CurrentComponent,
  { closeout, baseline }: CorrectableWork,
) {
  if (
    (s.management ?? []).some(
      (r) =>
        r.kind === "componentMovement" &&
        r.componentUuid === current.uuid &&
        !baseline.movementUuids.includes(r.uuid) &&
        (r.at >= closeout.recordedAt || r.date > order.completionDate),
    ) ||
    (s.workOrders ?? []).some(
      (w) =>
        w.uuid !== order.uuid &&
        w.closeout &&
        w.closeout.recordedAt >= closeout.recordedAt &&
        w.closeout.componentWork?.some((c) => c.componentUuid === current.uuid),
    )
  )
    throw new Rejection(
      "Manual review required: later component maintenance or movement exists. Review those events before correcting this closeout.",
    );
}

// Replays the corrected work on a copy holding the baseline records, then
// carries the result's records forward with their live versions bumped.
function replayAtCompletion(
  c: Correcting,
  before: TrackedRecord[],
  relevant: ManagedRecord[],
) {
  const { current, aircraft } = c;
  const ids = new Set(before.map((r) => r.uuid));
  const { clone, result } = replayOnBaseline(c, before, ids);
  const updated = (clone.management ?? [])
    .filter((r) => ids.has(r.uuid))
    .map((r) => ({
      ...r,
      version:
        (relevant.find((old) => old.uuid === r.uuid)?.version ?? r.version) + 1,
    }));
  const nextComponent = updated.find((r) => r.kind === "component")!;
  if (nextComponent.kind !== "component")
    throw new Error("Component baseline unavailable.");
  const currentBefore = componentTotals(current, aircraft);
  const currentAfter = componentTotals(nextComponent, aircraft);
  assertLifetimeUnchanged(currentBefore, currentAfter);
  const movements = (clone.management ?? []).filter(
    (r) =>
      r.kind === "componentMovement" &&
      result.trackingBaseline.movementUuids.includes(r.uuid),
  );
  return {
    result,
    updated,
    nextComponent,
    currentBefore,
    currentAfter,
    movements,
  };
}

function replayOnBaseline(
  c: Correcting,
  before: TrackedRecord[],
  ids: Set<string>,
) {
  const { s, order, command, target, current, aircraft, now } = c;
  const clone = structuredClone(s);
  clone.management = [
    ...(clone.management ?? []).filter((r) => !ids.has(r.uuid)),
    ...before,
  ];
  const atCompletion = aircraftAtCompletion(aircraft, target.closeout.aircraft);
  const component = before.find((r) => r.kind === "component")!;
  const single = singleComponentOrder(order, current, target.original, now);
  clone.taskCards = [];
  const result = applyWorkOrderComponentWork(
    clone,
    single,
    atCompletion,
    [{ ...command.choice, version: component.version }],
    now,
  )[0];
  return { clone, result };
}

// The aircraft's meters and counters as frozen at close-out.
function aircraftAtCompletion(
  aircraft: Aircraft,
  completion: CorrectableWork["closeout"]["aircraft"],
) {
  const meters = {
    ...aircraft,
    currentHobbs: completion.hobbs,
    currentTach: completion.tach,
    currentCyclicHobbs: completion.cyclicHobbs ?? aircraft.currentCyclicHobbs,
    currentFlightTimeLog:
      completion.flightTimeLog ?? aircraft.currentFlightTimeLog,
  };
  return {
    ...meters,
    cycles: completion.cycles,
    landings: completion.landings ?? aircraft.landings,
    adjustmentSeconds: completion.totalSeconds - aircraftMeterReading(meters),
  };
}

// The order cut to this one component, so the replay touches nothing else.
function singleComponentOrder(
  order: WorkOrder,
  current: CurrentComponent,
  original: CloseoutWork,
  now: number,
): WorkOrder {
  const single = {
    ...order,
    tasks: [],
    componentReadings: order.componentReadings.filter(
      (c) => c.componentUuid === current.uuid,
    ),
  };
  // Components can have originated from job cards rather than the header.
  if (!single.componentReadings.length)
    single.componentReadings = [
      {
        componentUuid: current.uuid,
        recordedAt: now,
        label: current.componentType,
        partNumber: current.partNumber,
        serial: current.serial,
        ...original.before,
      },
    ];
  return single;
}

// Changing the kind of work may reset time since overhaul or repair, never
// time or cycles since new, or service days.
function assertLifetimeUnchanged(before: Totals, after: Totals) {
  if (
    before.timeSinceNew !== after.timeSinceNew ||
    before.cyclesSinceNew !== after.cyclesSinceNew ||
    before.serviceDays !== after.serviceDays
  )
    throw new Rejection(
      "Manual review required: correction would change lifetime tracking.",
    );
}

function buildCorrection(
  c: Correcting,
  { result, updated, currentBefore, currentAfter }: Replay,
  relevant: ManagedRecord[],
  uuid: string,
  movementUuids: string[],
) {
  const { s, command, target, current, now } = c;
  return componentCorrectionSchema.parse({
    uuid,
    componentUuid: current.uuid,
    recordedAt: now,
    authorId: s.user.id,
    authorName: s.user.name,
    reason: command.reason,
    originalAction: target.effective.action,
    choice: command.choice,
    completionBefore: target.prior?.completionAfter ?? target.original.after,
    completionAfter: result.after,
    currentBefore,
    currentAfter,
    requirementsBefore: JSON.stringify(
      relevant.filter((r) => r.kind === "componentRequirement"),
    ),
    requirementsAfter: JSON.stringify(
      updated.filter((r) => r.kind === "componentRequirement"),
    ),
    trackingBaseline: {
      before: target.baseline.before,
      after: JSON.stringify(updated),
      movementUuids,
    },
    addendum: writeAddendum(c, result.after),
  });
}

function writeAddendum(c: Correcting, after: Replay["result"]["after"]) {
  const { s, order, command, target, current, now } = c;
  const { choice } = command;
  const work = choice.reference
    ? `${choice.description} IAW ${choice.reference}`
    : choice.description;
  const displayHours = (value: number | null) =>
    value === null ? "Not recorded" : `${(value / HOUR_SECONDS).toFixed(1)} h`;
  return (
    `Correction to work order ${order.number}, component ${current.componentType} P/N ${current.partNumber}; S/N ${current.serial}, maintenance dated ${order.completionDate}: ` +
    `${componentWorkLabels[target.effective.action]} corrected to ${componentWorkLabels[choice.action]}. ${endSentence(work)} ` +
    `Corrected completion TSN ${displayHours(after.timeSinceNew)}; TSO ${displayHours(after.timeSinceOverhaul)}; TSR ${displayHours(after.timeSinceRepair)}; cycles ${after.cyclesSinceNew}. ` +
    `Reason: ${command.reason}. Recorded by ${s.user.name} on ${new Date(now).toISOString()}. Review alongside the original logbook entry.`
  );
}

// The work text runs straight into "Corrected completion…", so a description
// typed without a full stop would merge the two sentences in signed text.
function endSentence(text: string) {
  return !text || /[.!?]$/.test(text) ? text : `${text}.`;
}

function buildCorrectionMovement(
  c: Correcting,
  { result, nextComponent }: Replay,
  uuid: string,
) {
  const { s, order, command, current, now } = c;
  return movementSchema.parse({
    uuid,
    version: 1,
    kind: "componentMovement",
    programUuid: current.programUuid,
    componentUuid: current.uuid,
    aircraftUuid: current.aircraftUuid,
    action: "CORRECTION",
    date: order.completionDate,
    timeSinceNew: result.after.timeSinceNew,
    timeSinceOverhaul: result.after.timeSinceOverhaul,
    timeSinceRepair: result.after.timeSinceRepair,
    cycles: result.after.cyclesSinceNew,
    serviceDays: result.after.serviceDays,
    calendarSinceNewUnknown: nextComponent.calendarSinceNewUnknown,
    calendarOverhaulDays: result.after.calendarOverhaulDays,
    note: `Correction of work order ${order.number}: ${command.reason}`,
    actorId: s.user.id,
    at: now,
    workOrderUuid: order.uuid,
    correctionUuid: uuid,
  });
}

// Movements of the replaced work stay in the history, marked as superseded.
function supersedeRecords(
  s: Snapshot,
  updated: Replay["updated"],
  { baseline }: CorrectableWork,
  uuid: string,
) {
  return (s.management ?? []).map((r) => {
    const replacement = updated.find((next) => next.uuid === r.uuid);
    if (replacement) return replacement;
    if (
      r.kind === "componentMovement" &&
      baseline.movementUuids.includes(r.uuid) &&
      !r.supersededByCorrection
    )
      return { ...r, version: r.version + 1, supersededByCorrection: uuid };
    return r;
  });
}

function sortByUuid<T extends { uuid: string }>(records: T[]) {
  return [...records].sort((a, b) => a.uuid.localeCompare(b.uuid));
}
