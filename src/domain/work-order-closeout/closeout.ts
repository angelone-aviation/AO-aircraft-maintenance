/**
 * Responsibility: Completing a work order: the close-out its readings,
 *   serviced components, compliance and component work make up, and what it
 *   would write about its components.
 * Layer: Domain. Updates the working snapshot; no I/O, no React.
 * Dependencies: zod, ../model, ../changeLog, ../workOrders (types),
 *   ../certifications, ../workOrderComponentWork, ../workOrderCloseoutSchema,
 *   ../rejection, ./closing, ./readings, ./servicedComponents, ./compliance,
 *   ./logbookText.
 */
import { z } from "zod";
import type { Aircraft, Inspection, Snapshot } from "../model";
import { auditEntry } from "../changeLog";
import type { WorkOrder } from "../workOrders";
import { memberLicense } from "../certifications";
import {
  applyWorkOrderComponentWork,
  componentWorkLabels,
  type ComponentWork,
} from "../workOrderComponentWork";
import {
  closeoutSchema,
  type CompletionReadings,
  type WorkOrderCloseout,
} from "../workOrderCloseoutSchema";
import type {
  Closing,
  Compliance,
  ComponentSummary,
  ServiceResult,
} from "./closing";
import { atCompletion, completionReadings } from "./readings";
import {
  componentSummary,
  servicedComponentIds,
  updateServicedTotals,
} from "./servicedComponents";
import { addServiceCompliance, recordCompliance } from "./compliance";
import { Rejection } from "../rejection";
import { logbookPerformers, workPerformedText } from "./logbookText";

const HOUR_SECONDS = 3600;

/**
 * Completes a work order inside its transaction: checks the readings at
 * completion, records compliance for each completed inspection and routine
 * component inspection, applies the chosen component work, and returns the
 * close-out. Aircraft and component lifetime counters are never reset.
 *
 * @param s - The working snapshot; inspections, records and the change log
 *   are updated through {@link applyManagement}.
 * @param supplied - Readings at completion; required for a backdated order,
 *   the aircraft's current readings by default.
 * @param now - The time to record, in epoch milliseconds.
 * @param componentWork - The work chosen for each included component.
 * @throws {Rejection} In order: "Enter aircraft readings at completion for a
 *   backdated work order."; readings, Collective hourmeter, Flight time log
 *   or landings missing or outside the opening and current readings; "The
 *   work-order completion date cannot precede its completed job cards."; a
 *   serviced component moved after completion; an unavailable inspection or
 *   requirement; component compliance before existing compliance; then as
 *   {@link applyManagement} and {@link applyWorkOrderComponentWork}.
 * @throws {Error} As {@link completionReadings} for a missing meter reading.
 * @throws {z.ZodError} On invalid readings.
 */
export function completeWorkOrder(
  s: Snapshot,
  order: WorkOrder,
  supplied: CompletionReadings | undefined,
  now: number,
  componentWork: ComponentWork[] = [],
): WorkOrderCloseout {
  const a = s.aircraft.find((a) => a.uuid === order.aircraftUuid)!;
  const readings = completionReadings(s, a, order, supplied, now);
  const ctx = { s, order, a, finalAircraft: atCompletion(a, readings), now };
  const completed = order.tasks.filter((t) => t.status === "completed");
  const components = [...servicedComponentIds(s, order, completed)].map(
    (uuid) => componentSummary(ctx, uuid, componentWork),
  );
  const compliance = recordCompliance(ctx, completed, components);
  const tracked = { management: s.management, inspections: s.inspections };
  const serviceResults = applyWorkOrderComponentWork(
    s,
    order,
    ctx.finalAircraft,
    componentWork,
    now,
  );
  auditComponentWork(s, order, tracked, now);
  addServiceCompliance(s, order, serviceResults, compliance);
  updateServicedTotals(components, serviceResults);
  return closeoutRecord(ctx, readings, components, compliance, serviceResults);
}

// Component work changes components, the requirements it rebases or moves
// and the inspections that follow a moved component, outside applyManagement.
// Each changed record gets its own change-log row, as a direct service does,
// so its Change history shows the close-out.
function auditComponentWork(
  s: Snapshot,
  order: WorkOrder,
  before: Pick<Snapshot, "management" | "inspections">,
  now: number,
) {
  const reason = `Component work recorded at close-out of work order ${order.number}.`;
  const changed = [
    ...listChanged(before.management ?? [], s.management ?? []),
    ...listChanged(before.inspections, s.inspections),
  ];
  for (const { old, next } of changed)
    s.audit.unshift(
      auditEntry(
        s,
        {
          action: CLOSEOUT_ACTIONS[recordKind(next)],
          entityUuid: next.uuid,
          aircraftUuid: order.aircraftUuid,
          reason,
          before: old,
          after: next,
        },
        now,
      ),
    );
}

type Tracked = NonNullable<Snapshot["management"]>[number] | Inspection;

const CLOSEOUT_ACTIONS = {
  component: "component.closeout",
  componentRequirement: "component.requirement.closeout",
  inspection: "inspection.closeout",
} as const;

function recordKind(r: Tracked): keyof typeof CLOSEOUT_ACTIONS {
  if (!("kind" in r)) return "inspection";
  return r.kind === "component" ? "component" : "componentRequirement";
}

// Records whose version the close-out raised; movements are new history
// entries, not changes, and other kinds are not touched by component work.
function listChanged<T extends Tracked>(before: T[], after: T[]) {
  return after.flatMap((next) => {
    if ("kind" in next && !(next.kind in CLOSEOUT_ACTIONS)) return [];
    const old = before.find((r) => r.uuid === next.uuid);
    return old && old.version !== next.version ? [{ old, next }] : [];
  });
}

/** What completing an order would write about its components. */
export interface ComponentCloseoutPreview {
  /** The serviced components at completion, after the chosen work. */
  components: ComponentSummary[];
  /** One line per repair, overhaul or move, as the close-out writes it. */
  workLines: string[];
}

/**
 * What completing the order would write about its components, worked out on
 * a copy of the records, for the logbook preview.
 *
 * @param s - The snapshot; left unchanged.
 * @param order - The order as it would be saved, with its component work.
 * @param readings - The aircraft's readings at completion.
 * @param now - The time, in epoch milliseconds.
 * @returns The close-out's components and work lines; null without a
 *   completion date, or while the close-out would refuse them as chosen.
 */
export function previewComponentCloseout(
  s: Snapshot,
  order: WorkOrder,
  readings: CompletionReadings,
  now: number,
): ComponentCloseoutPreview | null {
  // Usage is read on the completion date; until one is entered there is
  // nothing to read it on.
  if (!z.iso.date().safeParse(order.completionDate).success) return null;
  const records = {
    ...s,
    management: structuredClone(s.management),
    inspections: structuredClone(s.inspections),
  };
  try {
    return closeComponents(records, order, readings, now);
  } catch (error) {
    // Saving refuses the same choices with this message; until the user
    // fixes them, the preview keeps the opening readings.
    if (error instanceof Rejection || error instanceof z.ZodError) return null;
    throw error;
  }
}

function closeoutRecord(
  { s, order, a, finalAircraft, now }: Closing,
  readings: CompletionReadings,
  components: ComponentSummary[],
  compliance: Compliance,
  serviceResults: ServiceResult[],
) {
  const license = memberLicense(s.user, order.completionDate || undefined);
  const work = componentWorkLines(serviceResults, components, finalAircraft);
  return closeoutSchema.parse({
    componentWork: serviceResults,
    recordedAt: now,
    aircraft: {
      ...readings,
      registration: a.registration,
      make: a.make,
      model: a.model,
      serial: a.serial,
    },
    completedBy: {
      userId: s.user.id,
      name: s.user.name,
      licenseNumber: license.licenseNumber,
      certificateType: license.certificateType,
    },
    workPerformed: [workPerformedText(s, order), ...work]
      .filter(Boolean)
      .join("\n\n"),
    performers: logbookPerformers(s, order),
    components,
    compliance,
  });
}

// The close-out's component steps, without compliance: `s` is changed.
function closeComponents(
  s: Snapshot,
  order: WorkOrder,
  readings: CompletionReadings,
  now: number,
): ComponentCloseoutPreview {
  const a = s.aircraft.find((a) => a.uuid === order.aircraftUuid)!;
  const ctx = { s, order, a, finalAircraft: atCompletion(a, readings), now };
  const completed = order.tasks.filter((t) => t.status === "completed");
  const work = order.componentWork ?? [];
  const components = [...servicedComponentIds(s, order, completed)].map(
    (uuid) => componentSummary(ctx, uuid, work),
  );
  const results = applyWorkOrderComponentWork(
    s,
    order,
    ctx.finalAircraft,
    work,
    now,
  );
  updateServicedTotals(components, results);
  return {
    components,
    workLines: componentWorkLines(results, components, ctx.finalAircraft),
  };
}

function componentWorkLines(
  results: ServiceResult[],
  components: ComponentSummary[],
  aircraft: Aircraft,
) {
  return results
    .filter((r) => r.action !== "service")
    .map((r) => componentWorkText(r, components, aircraft));
}

function componentWorkText(
  r: ServiceResult,
  components: ComponentSummary[],
  aircraft: Aircraft,
) {
  const c = components.find((c) => c.componentUuid === r.componentUuid)!;
  const moved =
    r.action === "install" || r.action === "remove"
      ? ` ${aircraft.registration} (${aircraft.make} ${aircraft.model}; aircraft S/N ${aircraft.serial})${r.installPosition ? `; position ${r.installPosition}` : ""}`
      : "";
  const reference = r.reference ? ` IAW ${r.reference}` : "";
  const { timeSinceNew, timeSinceOverhaul, timeSinceRepair } = r.after;
  return `${c.label} (P/N ${c.partNumber}; S/N ${c.serial}): ${componentWorkLabels[r.action]}${moved} on ${r.date}. ${r.description}${reference}. TSN ${hoursText(timeSinceNew)}; TSO ${recordedHours(timeSinceOverhaul)}; TSR ${recordedHours(timeSinceRepair)}.`;
}

const hoursText = (seconds: number) =>
  `${(seconds / HOUR_SECONDS).toFixed(1)} h`;
const recordedHours = (seconds: number | null) =>
  seconds === null ? "Not recorded" : hoursText(seconds);
