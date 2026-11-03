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
import { aircraftMeterReading, type Snapshot } from "./model";
import type { WorkOrder } from "./workOrders";

const totalsSchema = z.object({
  timeSinceNew: z.number(),
  timeSinceOverhaul: z.number().nullable(),
  timeSinceRepair: z.number().nullable(),
  cyclesSinceNew: z.number(),
  serviceDays: z.number(),
  calendarOverhaulDays: z.number().nullable().optional(),
});
export const componentCorrectionCommandSchema = z.object({
  action: z.literal("correctComponent"),
  uuid: z.string().uuid(),
  version: z.number().int().nonnegative(),
  aircraftVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1500),
  choice: componentWorkSchema,
});
export type ComponentCorrectionCommand = z.infer<
  typeof componentCorrectionCommandSchema
>;
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
const recordsSchema = z.array(z.union([componentSchema, requirementSchema]));
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

// Pure preview and validation. The caller commits this result atomically.
export function previewComponentCorrection(
  s: Snapshot,
  order: WorkOrder,
  raw: ComponentCorrectionCommand,
  now = Date.now(),
) {
  const command = componentCorrectionCommandSchema.parse(raw);
  if (order.status !== "completed" || !order.closeout)
    throw new Error(
      "A completed work order with saved closeout readings is required.",
    );
  if (command.uuid !== order.uuid || command.version !== order.version)
    throw new Error("Work order changed. Reopen the correction preview.");
  const original = order.closeout.componentWork?.find(
    (c) => c.componentUuid === command.choice.componentUuid,
  );
  if (!original)
    throw new Error("This component was not recorded at closeout.");
  if (
    ["install", "remove"].includes(original.action) ||
    ["install", "remove"].includes(command.choice.action)
  )
    throw new Error(
      "Record component movement changes through a new work order.",
    );
  const prior = order.componentCorrections
    ?.filter((c) => c.componentUuid === original.componentUuid)
    .at(-1);
  const baseline = prior?.trackingBaseline ?? original.trackingBaseline;
  if (!baseline)
    throw new Error(
      "Manual review required: this older closeout does not contain the pre-service component and requirement records needed for a safe tracking correction.",
    );
  const effective = prior?.choice ?? original;
  if (
    effective.action === command.choice.action &&
    effective.description === command.choice.description &&
    effective.reference === command.choice.reference
  )
    throw new Error(
      "Change the component work performed before previewing a correction.",
    );
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
    throw new Error(
      "Aircraft or component readings changed. Reopen the correction preview.",
    );
  const expected = recordsSchema.parse(JSON.parse(baseline.after));
  const before = recordsSchema.parse(JSON.parse(baseline.before));
  const relevant = (s.management ?? []).filter(
    (r) =>
      (r.kind === "component" && r.uuid === current.uuid) ||
      (r.kind === "componentRequirement" && r.componentUuid === current.uuid),
  );
  if (
    canonical([...relevant].sort((a, b) => a.uuid.localeCompare(b.uuid))) !==
    canonical([...expected].sort((a, b) => a.uuid.localeCompare(b.uuid)))
  )
    throw new Error(
      "Manual review required: component tracking or service requirements changed after this closeout. Later records will not be overwritten.",
    );
  if (
    (s.management ?? []).some(
      (r) =>
        r.kind === "componentMovement" &&
        r.componentUuid === current.uuid &&
        !baseline.movementUuids.includes(r.uuid) &&
        (r.at >= order.closeout!.recordedAt || r.date > order.completionDate),
    ) ||
    (s.workOrders ?? []).some(
      (w) =>
        w.uuid !== order.uuid &&
        w.closeout &&
        w.closeout.recordedAt >= order.closeout!.recordedAt &&
        w.closeout.componentWork?.some((c) => c.componentUuid === current.uuid),
    )
  )
    throw new Error(
      "Manual review required: later component maintenance or movement exists. Review those events before correcting this closeout.",
    );
  const clone = structuredClone(s);
  const ids = new Set(before.map((r) => r.uuid));
  clone.management = [
    ...(clone.management ?? []).filter((r) => !ids.has(r.uuid)),
    ...before,
  ];
  const completion = order.closeout.aircraft;
  const atCompletion = {
    ...aircraft,
    currentHobbs: completion.hobbs,
    currentTach: completion.tach,
    currentCyclicHobbs: completion.cyclicHobbs ?? aircraft.currentCyclicHobbs,
    currentFlightTimeLog:
      completion.flightTimeLog ?? aircraft.currentFlightTimeLog,
    cycles: completion.cycles,
    landings: completion.landings ?? aircraft.landings,
    adjustmentSeconds:
      completion.totalSeconds -
      aircraftMeterReading({
        ...aircraft,
        currentHobbs: completion.hobbs,
        currentTach: completion.tach,
        currentCyclicHobbs:
          completion.cyclicHobbs ?? aircraft.currentCyclicHobbs,
        currentFlightTimeLog:
          completion.flightTimeLog ?? aircraft.currentFlightTimeLog,
      }),
  };
  const component = before.find((r) => r.kind === "component")!;
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
  clone.taskCards = [];
  const result = applyWorkOrderComponentWork(
    clone,
    single,
    atCompletion,
    [{ ...command.choice, version: component.version }],
    now,
  )[0];
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
  if (
    currentBefore.timeSinceNew !== currentAfter.timeSinceNew ||
    currentBefore.cyclesSinceNew !== currentAfter.cyclesSinceNew ||
    currentBefore.serviceDays !== currentAfter.serviceDays
  )
    throw new Error(
      "Manual review required: correction would change lifetime tracking.",
    );
  const uuid = crypto.randomUUID();
  const newMovements = (clone.management ?? [])
    .filter(
      (r) =>
        r.kind === "componentMovement" &&
        result.trackingBaseline.movementUuids.includes(r.uuid),
    )
    .map((r) => ({ ...r, workOrderUuid: order.uuid, correctionUuid: uuid }));
  const completionBefore = prior?.completionAfter ?? original.after;
  const displayHours = (value: number | null) =>
    value === null ? "Not recorded" : `${(value / 3600).toFixed(1)} h`;
  const addendum = `Correction to work order ${order.number}, component ${current.componentType} P/N ${current.partNumber}; S/N ${current.serial}, maintenance dated ${order.completionDate}: ${componentWorkLabels[effective.action]} corrected to ${componentWorkLabels[command.choice.action]}. ${command.choice.description}${command.choice.reference ? ` IAW ${command.choice.reference}.` : ""} Corrected completion TSN ${displayHours(result.after.timeSinceNew)}; TSO ${displayHours(result.after.timeSinceOverhaul)}; TSR ${displayHours(result.after.timeSinceRepair)}; cycles ${result.after.cyclesSinceNew}. Reason: ${command.reason}. Recorded by ${s.user.name} on ${new Date(now).toISOString()}. Review alongside the original logbook entry.`;
  const correction = componentCorrectionSchema.parse({
    uuid,
    componentUuid: current.uuid,
    recordedAt: now,
    authorId: s.user.id,
    authorName: s.user.name,
    reason: command.reason,
    originalAction: effective.action,
    choice: command.choice,
    completionBefore,
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
      before: baseline.before,
      after: JSON.stringify(updated),
      movementUuids: [
        ...baseline.movementUuids,
        ...newMovements.map((r) => r.uuid),
        uuid,
      ],
    },
    addendum,
  });
  const correctionMovement = movementSchema.parse({
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
  const management = (s.management ?? []).map((r) => {
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
  return {
    correction,
    management: [...management, ...newMovements, correctionMovement],
  };
}
