/**
 * Responsibility: The compliance a work-order close-out records: each
 *   completed inspection and routine component inspection, and the
 *   requirements its component work rebased.
 * Layer: Domain. Updates the working snapshot through ../management; no
 *   I/O, no React.
 * Dependencies: ../workOrders (types), ../management, ../components (types),
 *   ../rejection, ./closing.
 */
import type { Snapshot } from "../model";
import type { WorkOrder, WorkTask } from "../workOrders";
import { applyManagement, inspectionCounters } from "../management";
import type { ComponentRequirement } from "../components";
import { Rejection } from "../rejection";
import {
  findRequirement,
  type Closing,
  type Compliance,
  type ComponentSummary,
  type ServiceResult,
} from "./closing";

/**
 * Records compliance for each completed item, in order, through
 * {@link applyManagement}; manual items record none.
 *
 * @param components - The serviced components, for a requirement's usage.
 * @returns The compliance recorded.
 * @throws {Rejection} "The inspection is unavailable for this work order.";
 *   "The component service requirement is unavailable."; "Component
 *   compliance would precede existing compliance or lacks a verified time
 *   baseline."; as {@link applyManagement}.
 */
export function recordCompliance(
  ctx: Closing,
  completed: WorkTask[],
  components: ComponentSummary[],
) {
  const compliance: Compliance = [];
  for (const task of completed) {
    const common = {
      requestUuid: crypto.randomUUID(),
      reason: `Compliance from completed work order ${ctx.order.number}.`,
    };
    const entry =
      task.source.kind === "inspection"
        ? completeInspectionItem(ctx, task, common)
        : task.source.kind === "componentRequirement"
          ? completeRequirementItem(ctx, task, common, components)
          : undefined;
    if (entry) compliance.push(entry);
  }
  return compliance;
}

/**
 * Brings compliance up to date with the component work's rebased
 * requirements: an entry already recorded takes the rebased values, and an
 * overhaul adds each overhaul requirement of the component.
 *
 * @param compliance - Updated in place.
 */
export function addServiceCompliance(
  s: Snapshot,
  order: WorkOrder,
  serviceResults: ServiceResult[],
  compliance: Compliance,
) {
  for (const record of s.management ?? []) {
    if (record.kind !== "componentRequirement") continue;
    const result = serviceResults.find(
      (r) => r.componentUuid === record.componentUuid,
    );
    if (!result || result.action === "service") continue;
    const prior = compliance.find((item) => item.uuid === record.uuid);
    const renewedOverhaul =
      record.requirementType === "Overhaul Requirement" &&
      (result.action === "overhaul" || result.action === "both");
    if (!prior && !renewedOverhaul) continue;
    const next = {
      uuid: record.uuid,
      kind: "componentRequirement" as const,
      description: record.description,
      timeBasis: record.timeBasis,
      date: order.completionDate,
      seconds: record.lastSeconds,
      cycles: record.lastCycles,
      dueSeconds: record.dueSeconds,
      dueCycles: record.dueCycles,
      dueLandings: record.dueLandings,
      landings: record.lastLandings,
      dueDate: record.dueDate,
    };
    if (prior) Object.assign(prior, next);
    else compliance.push(next);
  }
}

function completeInspectionItem(
  { s, order, a, finalAircraft, now }: Closing,
  task: WorkTask,
  common: { requestUuid: string; reason: string },
): Compliance[number] | undefined {
  const i = s.inspections.find((i) => i.uuid === task.source.uuid);
  if (!i || i.aircraftUuid !== a.uuid)
    throw new Rejection("The inspection is unavailable for this work order.");
  const counters = inspectionCounters(i, finalAircraft, s.management);
  const { next } = applyManagement(
    s,
    {
      ...common,
      action: "inspection.complete",
      uuid: i.uuid,
      version: i.version ?? 0,
      date: order.completionDate,
      ...counters,
    },
    now,
  );
  if ("kind" in next) return undefined;
  return {
    uuid: next.uuid,
    kind: "inspection",
    timeBasis: i.componentUuid ? "TSN" : "aircraft total time",
    description: task.description,
    date: order.completionDate,
    ...counters,
    dueSeconds: next.dueSeconds,
    dueCycles: next.dueCycles,
    dueLandings: next.dueLandings,
    landings: next.lastLandings,
    dueDate: next.dueDate,
  };
}

// Routine inspection compliance is recorded here; the component work handles
// overhaul and repair.
function completeRequirementItem(
  ctx: Closing,
  task: WorkTask,
  common: { requestUuid: string; reason: string },
  components: ComponentSummary[],
): Compliance[number] | undefined {
  const { s, order, a, finalAircraft, now } = ctx;
  const r = findRequirement(s, task.source.uuid);
  if (!r || r.aircraftUuid !== a.uuid)
    throw new Rejection("The component service requirement is unavailable.");
  if (r.requirementType !== "Inspection Requirement") return undefined;
  const totals = components.find((c) => c.componentUuid === r.componentUuid)!;
  const seconds = secondsOnBasis(r.timeBasis, totals);
  assertCompliesAfter(ctx, r, totals, seconds);
  const record = {
    ...r,
    lastDate: order.completionDate,
    lastSeconds: seconds ?? undefined,
    lastCycles: totals.cyclesSinceNew ?? undefined,
    lastLandings: r.intervalLandings ? finalAircraft.landings : undefined,
  };
  const { next } = applyManagement(
    s,
    { ...common, action: "record.save", record },
    now,
  );
  if (!("kind" in next) || next.kind !== "componentRequirement")
    return undefined;
  return requirementCompliance(next, r.timeBasis, task.description, order);
}

function secondsOnBasis(
  basis: ComponentRequirement["timeBasis"],
  totals: ComponentSummary,
) {
  if (basis === "TSN") return totals.timeSinceNew;
  return basis === "TSO" ? totals.timeSinceOverhaul : totals.timeSinceRepair;
}

function assertCompliesAfter(
  { order, finalAircraft }: Closing,
  r: ComponentRequirement,
  totals: ComponentSummary,
  seconds: number | null,
) {
  if (
    (r.intervalSeconds && seconds === null) ||
    (r.intervalLandings && finalAircraft.landings < (r.lastLandings ?? 0)) ||
    order.completionDate < (r.lastDate ?? "") ||
    (seconds !== null && seconds < (r.lastSeconds ?? 0)) ||
    (totals.cyclesSinceNew !== null &&
      totals.cyclesSinceNew < (r.lastCycles ?? 0))
  )
    throw new Rejection(
      "Component compliance would precede existing compliance or lacks a verified time baseline.",
    );
}

function requirementCompliance(
  next: ComponentRequirement,
  timeBasis: ComponentRequirement["timeBasis"],
  description: string,
  order: WorkOrder,
): Compliance[number] {
  return {
    uuid: next.uuid,
    kind: "componentRequirement",
    timeBasis,
    description,
    date: order.completionDate,
    seconds: next.lastSeconds,
    cycles: next.lastCycles,
    dueSeconds: next.dueSeconds,
    dueCycles: next.dueCycles,
    dueLandings: next.dueLandings,
    landings: next.lastLandings,
    dueDate: next.dueDate,
  };
}
