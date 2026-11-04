/**
 * Responsibility: Completing a work order: the close-out its readings,
 *   serviced components, compliance and component work make up.
 * Layer: Domain. Updates the working snapshot; no I/O, no React.
 * Dependencies: ../model, ../workOrders (types), ../certifications,
 *   ../workOrderComponentWork, ../workOrderCloseoutSchema, ./closing,
 *   ./readings, ./servicedComponents, ./compliance, ./logbookText.
 */
import type { Aircraft, Snapshot } from "../model";
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
  const serviceResults = applyWorkOrderComponentWork(
    s,
    order,
    ctx.finalAircraft,
    componentWork,
    now,
  );
  addServiceCompliance(s, order, serviceResults, compliance);
  updateServicedTotals(components, serviceResults);
  return closeoutRecord(ctx, readings, components, compliance, serviceResults);
}

function closeoutRecord(
  { s, order, a, finalAircraft, now }: Closing,
  readings: CompletionReadings,
  components: ComponentSummary[],
  compliance: Compliance,
  serviceResults: ServiceResult[],
) {
  const license = memberLicense(s.user, order.completionDate || undefined);
  const work = serviceResults
    .filter((r) => r.action !== "service")
    .map((r) => componentWorkText(r, components, finalAircraft));
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
