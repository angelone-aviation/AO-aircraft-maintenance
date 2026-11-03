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
import type { WorkOrder } from "./workOrders";
import {
  aircraftMeterReading,
  isLocalToday,
  totalSeconds,
  type Snapshot,
} from "./model";
import { applyManagement, inspectionCounters } from "./management";
import { componentTotals, type Component } from "./components";
import { taskCardMatchesWorkItem } from "./workOrderCards";

type Card = NonNullable<Snapshot["taskCards"]>[number];
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
// Job cards whose work the logbook entry describes.
const entryCards = (s: Snapshot, order: WorkOrder, preview: boolean) =>
  (s.taskCards ?? []).filter(
    (t) =>
      t.workOrderUuid === order.uuid &&
      (t.status === "completed" || (preview && t.status !== "canceled")),
  );
/** Each distinct technician signer on the job cards included in the entry, in
 * signing order: the persons who performed the work (14 CFR 43.9(a)(3)). */
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
export function workPerformedText(
  s: Snapshot,
  order: WorkOrder,
  preview = false,
) {
  const cards = entryCards(s, order, preview);
  const seen = new Set<string>();
  const cardText = (card: (typeof cards)[number]) => {
    seen.add(card.uuid);
    if (card.includeInLogbook === false) return "";
    const reference = card.manualReference;
    const manual = reference
      ? s.manuals?.find((m) => m.uuid === reference.manualUuid)
      : undefined;
    const libraryReference = reference
      ? [
          manual?.title || "Linked maintenance manual",
          manual?.documentNumber,
          manual?.revision && `revision ${manual.revision}`,
          reference.section && `section ${reference.section}`,
          reference.printedPage && `page ${reference.printedPage}`,
          `PDF page ${reference.pdfPage}`,
        ]
          .filter(Boolean)
          .join(", ")
      : "";
    if (card.includeInLogbook === true) {
      const taskIndex = order.tasks.findIndex((task) =>
        taskCardMatchesWorkItem(card, task),
      );
      return [
        logbookWorkLine(
          taskIndex < 0 ? card.cardNumber : taskIndex + 1,
          card.logbookPhrase,
          card.title || card.description,
          libraryReference
            ? libraryReference
            : card.maintenanceReference.trim()
              ? `${card.maintenanceReference.trim()}${card.referenceRevision ? `, revision ${card.referenceRevision}` : ""}`
              : "",
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
    return [
      `${card.cardNumber} — ${card.title}: ${card.actualWork}`,
      card.maintenanceReference &&
        `Reference: ${card.maintenanceReference}${card.referenceRevision ? `, revision ${card.referenceRevision}` : ""}`,
      libraryReference && libraryReference,
      ...executionDetails(card),
      ...signoffs(card),
    ]
      .filter(Boolean)
      .join("\n");
  };
  const items = order.tasks.map((task, index) => {
    const linked = cards.filter(
      (card) => taskCardMatchesWorkItem(card, task) && !seen.has(card.uuid),
    );
    // A work item's selection controls its own line; each job card controls its procedure line.
    const details = linked.map(cardText);
    if (
      task.status !== "completed" &&
      (!preview || task.status === "cancelled")
    )
      return details.filter(Boolean).join("\n");
    const reference = task.maintenanceReference?.trim() || "";
    const summary =
      task.includeInLogbook === true
        ? logbookWorkLine(
            index + 1,
            task.logbookPhrase,
            task.description,
            reference,
          )
        : task.includeInLogbook === false ||
            linked.some((card) => card.includeInLogbook !== undefined)
          ? ""
          : [task.description, task.notes].filter(Boolean).join("\n");
    return [summary, ...details].filter(Boolean).join("\n");
  });
  return [
    ...items,
    ...cards.filter((card) => !seen.has(card.uuid)).map(cardText),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Runs inside the isolated work-order transaction. It does not reset aircraft or component lifetime counters.
export function completeWorkOrder(
  s: Snapshot,
  order: WorkOrder,
  supplied: CompletionReadings | undefined,
  now: number,
  componentWork: ComponentWork[] = [],
): WorkOrderCloseout {
  const a = s.aircraft.find((a) => a.uuid === order.aircraftUuid)!;
  if (!isLocalToday(order.completionDate, now) && !supplied)
    throw new Error(
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
  const current = {
    totalSeconds: totalSeconds(a),
    hobbs: a.currentHobbs,
    tach: a.currentTach,
    cycles: a.cycles,
  };
  for (const key of ["totalSeconds", "hobbs", "tach", "cycles"] as const)
    if (readings[key] < order.aircraft[key] || readings[key] > current[key])
      throw new Error(
        "Completion readings must be between the work-order opening readings and current aircraft readings.",
      );
  if (a.meter === "cyclic" && readings.cyclicHobbs === undefined)
    throw new Error("Enter the Collective hourmeter reading at completion.");
  if (
    readings.cyclicHobbs !== undefined &&
    (readings.cyclicHobbs < (order.aircraft.cyclicHobbs ?? 0) ||
      a.currentCyclicHobbs === undefined ||
      readings.cyclicHobbs > a.currentCyclicHobbs)
  )
    throw new Error(
      "Completion Collective hourmeter must be between opening and current readings.",
    );
  if (a.meter === "flightTimeLog" && readings.flightTimeLog === undefined)
    throw new Error("Enter the Flight time log reading at completion.");
  if (
    readings.flightTimeLog !== undefined &&
    (readings.flightTimeLog < (order.aircraft.flightTimeLog ?? 0) ||
      a.currentFlightTimeLog === undefined ||
      readings.flightTimeLog > a.currentFlightTimeLog)
  )
    throw new Error(
      "Completion Flight time log must be between opening and current readings.",
    );
  const hasLandingWork = order.tasks.some((task) => {
    const r =
      task.source.kind === "inspection"
        ? s.inspections.find((i) => i.uuid === task.source.uuid)
        : s.management?.find(
            (i) =>
              i.kind === "componentRequirement" && i.uuid === task.source.uuid,
          );
    return r && "dueLandings" in r && r.dueLandings !== undefined;
  });
  if (hasLandingWork && readings.landings === undefined)
    throw new Error("Enter aircraft total landings at completion.");
  if (
    readings.landings !== undefined &&
    (readings.landings < (order.aircraft.landings ?? 0) ||
      readings.landings > a.landings)
  )
    throw new Error(
      "Completion landings must be between opening and current aircraft totals.",
    );
  const finalAircraft = {
    ...a,
    currentHobbs: readings.hobbs,
    currentTach: readings.tach,
    currentCyclicHobbs: readings.cyclicHobbs,
    currentFlightTimeLog: readings.flightTimeLog,
    cycles: readings.cycles,
    landings: readings.landings ?? a.landings,
    adjustmentSeconds:
      readings.totalSeconds -
      aircraftMeterReading({
        ...a,
        currentHobbs: readings.hobbs,
        currentTach: readings.tach,
        currentCyclicHobbs: readings.cyclicHobbs,
        currentFlightTimeLog: readings.flightTimeLog,
      }),
  };
  const completed = order.tasks.filter((t) => t.status === "completed");
  const componentIds = new Set(workOrderComponentIds(s, order));
  const cards = (s.taskCards ?? []).filter(
    (t) => t.workOrderUuid === order.uuid && t.status === "completed",
  );
  if (cards.some((card) => card.completionDate > order.completionDate))
    throw new Error(
      "The work-order completion date cannot precede its completed job cards.",
    );
  cards.forEach((card) => {
    if (card.componentUuid) componentIds.add(card.componentUuid);
  });
  for (const task of completed) {
    if (task.source.kind === "inspection") {
      const inspection = s.inspections.find((i) => i.uuid === task.source.uuid);
      if (inspection?.componentUuid) componentIds.add(inspection.componentUuid);
    } else if (task.source.kind === "componentRequirement") {
      const r = s.management?.find(
        (r) => r.uuid === task.source.uuid && r.kind === "componentRequirement",
      );
      if (r?.kind === "componentRequirement") componentIds.add(r.componentUuid);
    }
  }
  const components = [...componentIds].map((uuid) => {
    const c = s.management?.find(
      (r): r is Component => r.kind === "component" && r.uuid === uuid,
    );
    if (
      !c ||
      (c.aircraftUuid !== a.uuid &&
        !componentWork.some(
          (w) => w.componentUuid === uuid && w.action === "install",
        )) ||
      (c.removedDate && c.removedDate > order.completionDate) ||
      s.management?.some(
        (r) =>
          r.kind === "componentMovement" &&
          r.componentUuid === uuid &&
          r.date > order.completionDate,
      )
    )
      throw new Error(
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
        c.trackCalendar && !c.calendarSinceNewUnknown
          ? totals.serviceDays
          : null,
    };
  });
  const compliance: WorkOrderCloseout["compliance"] = [];
  for (const task of completed) {
    const common = {
      requestUuid: crypto.randomUUID(),
      reason: `Compliance from completed work order ${order.number}.`,
    };
    if (task.source.kind === "inspection") {
      const i = s.inspections.find((i) => i.uuid === task.source.uuid);
      if (!i || i.aircraftUuid !== a.uuid)
        throw new Error("The inspection is unavailable for this work order.");
      const counters = inspectionCounters(i, finalAircraft, s.management);
      const result = applyManagement(
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
      const next = result.next;
      if (!("kind" in next))
        compliance.push({
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
        });
    } else if (task.source.kind === "componentRequirement") {
      const r = s.management?.find(
        (r) => r.uuid === task.source.uuid && r.kind === "componentRequirement",
      );
      if (!r || r.kind !== "componentRequirement" || r.aircraftUuid !== a.uuid)
        throw new Error("The component service requirement is unavailable.");
      // Routine inspection compliance is recorded here; component actions below handle overhaul and repair.
      if (r.requirementType !== "Inspection Requirement") continue;
      const totals = components.find(
        (c) => c.componentUuid === r.componentUuid,
      )!;
      const seconds =
        r.timeBasis === "TSN"
          ? totals.timeSinceNew
          : r.timeBasis === "TSO"
            ? totals.timeSinceOverhaul
            : totals.timeSinceRepair;
      if (
        (r.intervalSeconds && seconds === null) ||
        (r.intervalLandings &&
          finalAircraft.landings < (r.lastLandings ?? 0)) ||
        order.completionDate < (r.lastDate ?? "") ||
        (seconds !== null && seconds < (r.lastSeconds ?? 0)) ||
        (totals.cyclesSinceNew !== null &&
          totals.cyclesSinceNew < (r.lastCycles ?? 0))
      )
        throw new Error(
          "Component compliance would precede existing compliance or lacks a verified time baseline.",
        );
      const result = applyManagement(
        s,
        {
          ...common,
          action: "record.save",
          record: {
            ...r,
            lastDate: order.completionDate,
            lastSeconds: seconds ?? undefined,
            lastCycles: totals.cyclesSinceNew ?? undefined,
            lastLandings: r.intervalLandings
              ? finalAircraft.landings
              : undefined,
          },
        },
        now,
      );
      if (
        "kind" in result.next &&
        result.next.kind === "componentRequirement"
      ) {
        const next = result.next;
        compliance.push({
          uuid: next.uuid,
          kind: "componentRequirement",
          timeBasis: r.timeBasis,
          description: task.description,
          date: order.completionDate,
          seconds: next.lastSeconds,
          cycles: next.lastCycles,
          dueSeconds: next.dueSeconds,
          dueCycles: next.dueCycles,
          dueLandings: next.dueLandings,
          landings: next.lastLandings,
          dueDate: next.dueDate,
        });
      }
    }
  }
  const serviceResults = applyWorkOrderComponentWork(
    s,
    order,
    finalAircraft,
    componentWork,
    now,
  );
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
    if (prior || renewedOverhaul) {
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
  for (const result of serviceResults) {
    const component = components.find(
      (c) => c.componentUuid === result.componentUuid,
    )!;
    if (
      component.timeSinceOverhaul !== null ||
      result.action === "overhaul" ||
      result.action === "both"
    )
      component.timeSinceOverhaul = result.after.timeSinceOverhaul;
    if (
      component.timeSinceRepair !== null ||
      result.action === "repair" ||
      result.action === "both"
    )
      component.timeSinceRepair = result.after.timeSinceRepair;
  }
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
      licenseNumber: memberLicense(s.user, order.completionDate || undefined)
        .licenseNumber,
      certificateType: memberLicense(s.user, order.completionDate || undefined)
        .certificateType,
    },
    workPerformed: [
      workPerformedText(s, order),
      ...serviceResults
        .filter((r) => r.action !== "service")
        .map((r) => {
          const c = components.find(
            (c) => c.componentUuid === r.componentUuid,
          )!;
          return `${c.label} (P/N ${c.partNumber}; S/N ${c.serial}): ${componentWorkLabels[r.action]}${r.action === "install" || r.action === "remove" ? ` ${finalAircraft.registration} (${finalAircraft.make} ${finalAircraft.model}; aircraft S/N ${finalAircraft.serial})${r.installPosition ? `; position ${r.installPosition}` : ""}` : ""} on ${r.date}. ${r.description}${r.reference ? ` IAW ${r.reference}` : ""}. TSN ${(r.after.timeSinceNew / 3600).toFixed(1)} h; TSO ${r.after.timeSinceOverhaul === null ? "Not recorded" : (r.after.timeSinceOverhaul / 3600).toFixed(1) + " h"}; TSR ${r.after.timeSinceRepair === null ? "Not recorded" : (r.after.timeSinceRepair / 3600).toFixed(1) + " h"}.`;
        }),
    ]
      .filter(Boolean)
      .join("\n\n"),
    performers: logbookPerformers(s, order),
    components,
    compliance,
  });
}
