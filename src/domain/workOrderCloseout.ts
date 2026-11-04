/**
 * Responsibility: Completing a work order: the readings, serviced components
 *   and compliance its close-out records, and the work-performed text and
 *   performers its logbook entry shows.
 * Layer: Domain. Updates the working snapshot; no I/O, no React.
 * Dependencies: ./certifications, ./workOrderComponentWork, ./logbookWording,
 *   ./workOrderCloseoutSchema, ./workOrders (types), ./model, ./management,
 *   ./components, ./workOrderCards, ./rejection.
 */
import { memberLicense } from "./certifications";
import {
  applyWorkOrderComponentWork,
  workOrderComponentIds,
  componentWorkLabels,
  type ComponentWork,
} from "./workOrderComponentWork";
import { logbookWorkLine } from "./logbookWording";
import {
  closeoutSchema,
  completionReadingsSchema,
  type CompletionReadings,
  type WorkOrderCloseout,
} from "./workOrderCloseoutSchema";
import type { WorkOrder, WorkTask } from "./workOrders";
import {
  aircraftMeterReading,
  isLocalToday,
  totalSeconds,
  type Aircraft,
  type Snapshot,
} from "./model";
import { applyManagement, inspectionCounters } from "./management";
import {
  componentTotals,
  type Component,
  type ComponentRequirement,
} from "./components";
import { taskCardMatchesWorkItem } from "./workOrderCards";
import { Rejection } from "./rejection";

const HOUR_SECONDS = 3600;
const OPENING_READINGS = ["totalSeconds", "hobbs", "tach", "cycles"] as const;

/**
 * Each distinct technician who signed a job card included in the entry, in
 * signing order: the persons who performed the work (14 CFR 43.9(a)(3)).
 *
 * @param preview - Also counts job cards not yet completed, except cancelled.
 * @returns The user id and name of each, first signature first.
 */
export function logbookPerformers(
  s: Snapshot,
  order: WorkOrder,
  preview = false,
) {
  const performers = new Map<string, { userId: string; name: string }>();
  for (const { technicianSignoff: signed } of entryCards(s, order, preview)
    .filter((card) => card.includeInLogbook !== false)
    .sort(
      (a, b) => (a.technicianSignoff?.at ?? 0) - (b.technicianSignoff?.at ?? 0),
    ))
    if (signed && !performers.has(signed.userId))
      performers.set(signed.userId, {
        userId: signed.userId,
        name: signed.name,
      });
  return [...performers.values()];
}

/**
 * The work-performed text of a work order's logbook entry: each work item in
 * order with its job cards, then job cards linked to no item.
 *
 * @param preview - Also includes items and job cards not yet completed,
 *   except cancelled ones.
 * @returns One paragraph per item or card, separated by blank lines. An item
 *   or card left out of the logbook, or with nothing to say, adds none.
 */
export function workPerformedText(
  s: Snapshot,
  order: WorkOrder,
  preview = false,
) {
  const cards = entryCards(s, order, preview);
  const seen = new Set<string>();
  const describe = (card: Card) => {
    seen.add(card.uuid);
    return cardText(s, order, card);
  };
  const items = order.tasks.map((task, index) => {
    const linked = cards.filter(
      (card) => taskCardMatchesWorkItem(card, task) && !seen.has(card.uuid),
    );
    return itemText(task, index, linked, linked.map(describe), preview);
  });
  return [
    ...items,
    ...cards.filter((card) => !seen.has(card.uuid)).map(describe),
  ]
    .filter(Boolean)
    .join("\n\n");
}

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

type Card = NonNullable<Snapshot["taskCards"]>[number];
type Compliance = WorkOrderCloseout["compliance"];
type ComponentSummary = WorkOrderCloseout["components"][number];
type ServiceResult = ReturnType<typeof applyWorkOrderComponentWork>[number];
/** The order being closed, its aircraft as it was at completion, and when. */
interface Closing {
  s: Snapshot;
  order: WorkOrder;
  a: Aircraft;
  finalAircraft: Aircraft;
  now: number;
}

const signoffs = (card: Card) => [
  card.technicianSignoff && `Work signed by: ${card.technicianSignoff.name}`,
  card.inspectionSignoff &&
    `Inspection signed by: ${card.inspectionSignoff.name}`,
];
const executionDetails = (card: Card) => [
  card.findings && `Findings: ${card.findings}`,
  card.notesRemarks && `Notes: ${card.notesRemarks}`,
  card.measurements && `Measurements: ${card.measurements}`,
  ...card.partsUsed.map(
    (p) =>
      `Part: ${p.description || p.partNumber}; P/N ${p.partNumber}; quantity ${p.quantity}${p.serialLot ? `; S/N or lot ${p.serialLot}` : ""}${p.removedComponent ? `; removed: ${p.removedComponent}` : ""}${p.installedComponent ? `; installed: ${p.installedComponent}` : ""}`,
  ),
];
const stepResults = (card: Card) =>
  card.steps.flatMap((step, index) =>
    step.result || step.measurement !== null
      ? [
          `Step ${index + 1} — ${step.instruction}: ${[step.result, step.measurement !== null && `${step.measurement}${step.units ? ` ${step.units}` : ""}`].filter(Boolean).join("; ")}`,
        ]
      : [],
  );
const revisionText = (card: Card) =>
  card.referenceRevision ? `, revision ${card.referenceRevision}` : "";

// Job cards whose work the logbook entry describes.
const entryCards = (s: Snapshot, order: WorkOrder, preview: boolean) =>
  (s.taskCards ?? []).filter(
    (t) =>
      t.workOrderUuid === order.uuid &&
      (t.status === "completed" || (preview && t.status !== "canceled")),
  );

// A work item's selection controls its own line; each job card controls its
// procedure line.
function itemText(
  task: WorkTask,
  index: number,
  linked: Card[],
  details: string[],
  preview: boolean,
) {
  if (task.status !== "completed" && (!preview || task.status === "cancelled"))
    return details.filter(Boolean).join("\n");
  return [itemSummary(task, index, linked), ...details]
    .filter(Boolean)
    .join("\n");
}

function itemSummary(task: WorkTask, index: number, linked: Card[]) {
  if (task.includeInLogbook === true)
    return logbookWorkLine(
      index + 1,
      task.logbookPhrase,
      task.description,
      task.maintenanceReference?.trim() || "",
    );
  if (
    task.includeInLogbook === false ||
    linked.some((card) => card.includeInLogbook !== undefined)
  )
    return "";
  return [task.description, task.notes].filter(Boolean).join("\n");
}

function cardText(s: Snapshot, order: WorkOrder, card: Card) {
  if (card.includeInLogbook === false) return "";
  const libraryReference = manualReferenceText(s, card);
  if (card.includeInLogbook === true)
    return selectedCardText(order, card, libraryReference);
  return [
    `${card.cardNumber} — ${card.title}: ${card.actualWork}`,
    card.maintenanceReference &&
      `Reference: ${card.maintenanceReference}${revisionText(card)}`,
    libraryReference && libraryReference,
    ...executionDetails(card),
    ...signoffs(card),
  ]
    .filter(Boolean)
    .join("\n");
}

function manualReferenceText(s: Snapshot, card: Card) {
  const reference = card.manualReference;
  if (!reference) return "";
  const manual = s.manuals?.find((m) => m.uuid === reference.manualUuid);
  return [
    manual?.title || "Linked maintenance manual",
    manual?.documentNumber,
    manual?.revision && `revision ${manual.revision}`,
    reference.section && `section ${reference.section}`,
    reference.printedPage && `page ${reference.printedPage}`,
    `PDF page ${reference.pdfPage}`,
  ]
    .filter(Boolean)
    .join(", ");
}

function selectedCardText(
  order: WorkOrder,
  card: Card,
  libraryReference: string,
) {
  const taskIndex = order.tasks.findIndex((task) =>
    taskCardMatchesWorkItem(card, task),
  );
  const maintenance = card.maintenanceReference.trim();
  const reference =
    libraryReference ||
    (maintenance ? `${maintenance}${revisionText(card)}` : "");
  return [
    logbookWorkLine(
      taskIndex < 0 ? card.cardNumber : taskIndex + 1,
      card.logbookPhrase,
      card.title || card.description,
      reference,
    ),
    // The entry records the work actually performed, not only the procedure.
    card.actualWork && `Work performed: ${card.actualWork}`,
    ...stepResults(card),
    ...executionDetails(card),
    ...signoffs(card),
  ]
    .filter(Boolean)
    .join("\n");
}

function completionReadings(
  s: Snapshot,
  a: Aircraft,
  order: WorkOrder,
  supplied: CompletionReadings | undefined,
  now: number,
) {
  if (!isLocalToday(order.completionDate, now) && !supplied)
    throw new Rejection(
      "Enter aircraft readings at completion for a backdated work order.",
    );
  const readings = completionReadingsSchema.parse(
    supplied ?? {
      totalSeconds: totalSeconds(a),
      hobbs: a.currentHobbs,
      tach: a.currentTach,
      cyclicHobbs: a.currentCyclicHobbs,
      flightTimeLog: a.currentFlightTimeLog,
      cycles: a.cycles,
      landings: a.landings,
    },
  );
  assertMeterReadings(a, order, readings);
  assertLandingReadings(s, a, order, readings);
  return readings;
}

function assertMeterReadings(
  a: Aircraft,
  order: WorkOrder,
  readings: CompletionReadings,
) {
  const current = {
    totalSeconds: totalSeconds(a),
    hobbs: a.currentHobbs,
    tach: a.currentTach,
    cycles: a.cycles,
  };
  for (const key of OPENING_READINGS)
    if (outside(readings[key], order.aircraft[key], current[key]))
      throw new Rejection(
        "Completion readings must be between the work-order opening readings and current aircraft readings.",
      );
  assertOptionalMeters(a, order.aircraft, readings);
}

// The Collective hourmeter and Flight time log are required only when the
// aircraft's time comes from them, but are range-checked whenever entered.
function assertOptionalMeters(
  a: Aircraft,
  opening: WorkOrder["aircraft"],
  readings: CompletionReadings,
) {
  if (a.meter === "cyclic" && readings.cyclicHobbs === undefined)
    throw new Rejection(
      "Enter the Collective hourmeter reading at completion.",
    );
  if (
    readings.cyclicHobbs !== undefined &&
    outside(
      readings.cyclicHobbs,
      opening.cyclicHobbs ?? 0,
      a.currentCyclicHobbs,
    )
  )
    throw new Rejection(
      "Completion Collective hourmeter must be between opening and current readings.",
    );
  if (a.meter === "flightTimeLog" && readings.flightTimeLog === undefined)
    throw new Rejection("Enter the Flight time log reading at completion.");
  if (
    readings.flightTimeLog !== undefined &&
    outside(
      readings.flightTimeLog,
      opening.flightTimeLog ?? 0,
      a.currentFlightTimeLog,
    )
  )
    throw new Rejection(
      "Completion Flight time log must be between opening and current readings.",
    );
}

// A reading is refused below the order's opening reading, above the
// aircraft's current one, or when the aircraft has no current reading.
const outside = (value: number, opening: number, current?: number) =>
  value < opening || current === undefined || value > current;

function assertLandingReadings(
  s: Snapshot,
  a: Aircraft,
  order: WorkOrder,
  readings: CompletionReadings,
) {
  if (
    order.tasks.some((task) => hasLandingLimit(s, task)) &&
    readings.landings === undefined
  )
    throw new Rejection("Enter aircraft total landings at completion.");
  if (
    readings.landings !== undefined &&
    outside(readings.landings, order.aircraft.landings ?? 0, a.landings)
  )
    throw new Rejection(
      "Completion landings must be between opening and current aircraft totals.",
    );
}

function hasLandingLimit(s: Snapshot, task: WorkTask) {
  const r =
    task.source.kind === "inspection"
      ? s.inspections.find((i) => i.uuid === task.source.uuid)
      : s.management?.find(
          (i) =>
            i.kind === "componentRequirement" && i.uuid === task.source.uuid,
        );
  return r && "dueLandings" in r && r.dueLandings !== undefined;
}

function atCompletion(a: Aircraft, readings: CompletionReadings): Aircraft {
  const meters = {
    currentHobbs: readings.hobbs,
    currentTach: readings.tach,
    currentCyclicHobbs: readings.cyclicHobbs,
    currentFlightTimeLog: readings.flightTimeLog,
  };
  return {
    ...a,
    ...meters,
    cycles: readings.cycles,
    landings: readings.landings ?? a.landings,
    adjustmentSeconds:
      readings.totalSeconds - aircraftMeterReading({ ...a, ...meters }),
  };
}

// The components the close-out reports: those on the order, its completed
// job cards, and its completed inspections and component requirements.
function servicedComponentIds(
  s: Snapshot,
  order: WorkOrder,
  completed: WorkTask[],
) {
  const ids = new Set(workOrderComponentIds(s, order));
  const cards = (s.taskCards ?? []).filter(
    (t) => t.workOrderUuid === order.uuid && t.status === "completed",
  );
  if (cards.some((card) => card.completionDate > order.completionDate))
    throw new Rejection(
      "The work-order completion date cannot precede its completed job cards.",
    );
  for (const card of cards) if (card.componentUuid) ids.add(card.componentUuid);
  for (const task of completed) {
    const uuid = taskComponentUuid(s, task);
    if (uuid !== undefined) ids.add(uuid);
  }
  return ids;
}

function taskComponentUuid(s: Snapshot, task: WorkTask) {
  if (task.source.kind === "inspection")
    return (
      s.inspections.find((i) => i.uuid === task.source.uuid)?.componentUuid ||
      undefined
    );
  if (task.source.kind !== "componentRequirement") return undefined;
  return findRequirement(s, task.source.uuid)?.componentUuid;
}

function findRequirement(s: Snapshot, uuid: string) {
  return s.management?.find(
    (r): r is ComponentRequirement =>
      r.uuid === uuid && r.kind === "componentRequirement",
  );
}

function componentSummary(
  { s, order, a, finalAircraft }: Closing,
  uuid: string,
  componentWork: ComponentWork[],
): ComponentSummary {
  const c = s.management?.find(
    (r): r is Component => r.kind === "component" && r.uuid === uuid,
  );
  const installing = componentWork.some(
    (w) => w.componentUuid === uuid && w.action === "install",
  );
  if (
    !c ||
    (c.aircraftUuid !== a.uuid && !installing) ||
    movedAfter(s, c, order)
  )
    throw new Rejection(
      "A serviced component has moved or has tracking changes after the completion date. Review its tracking before closing this order.",
    );
  const totals = componentTotals(c, finalAircraft, order.completionDate);
  return {
    componentUuid: c.uuid,
    label: `${c.componentType}${c.installPosition ? ` · ${c.installPosition}` : ""}`,
    manufacturer: c.manufacturer,
    model: c.model ?? "",
    partNumber: c.partNumber,
    serial: c.serial,
    timeSinceNew: c.trackTime ? totals.timeSinceNew : null,
    timeSinceOverhaul: c.trackTime ? totals.timeSinceOverhaul : null,
    timeSinceRepair: c.trackTime ? totals.timeSinceRepair : null,
    cyclesSinceNew: c.trackCycles ? totals.cyclesSinceNew : null,
    serviceDays:
      c.trackCalendar && !c.calendarSinceNewUnknown ? totals.serviceDays : null,
  };
}

function movedAfter(s: Snapshot, c: Component, order: WorkOrder) {
  return (
    (!!c.removedDate && c.removedDate > order.completionDate) ||
    !!s.management?.some(
      (r) =>
        r.kind === "componentMovement" &&
        r.componentUuid === c.uuid &&
        r.date > order.completionDate,
    )
  );
}

function recordCompliance(
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

// Component work rebases requirements: an entry already recorded takes the
// requirement as rebased, and an overhaul adds its overhaul requirements.
function addServiceCompliance(
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

// An overhaul or repair, or a counter already tracked, reports the
// component's time since it as the work left it.
function updateServicedTotals(
  components: ComponentSummary[],
  serviceResults: ServiceResult[],
) {
  for (const result of serviceResults) {
    const component = components.find(
      (c) => c.componentUuid === result.componentUuid,
    )!;
    const { action, after } = result;
    if (
      component.timeSinceOverhaul !== null ||
      action === "overhaul" ||
      action === "both"
    )
      component.timeSinceOverhaul = after.timeSinceOverhaul;
    if (
      component.timeSinceRepair !== null ||
      action === "repair" ||
      action === "both"
    )
      component.timeSinceRepair = after.timeSinceRepair;
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
