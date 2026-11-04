/**
 * Responsibility: Work orders: the stored record and its commands, the work
 *   items an aircraft offers, progress, attachment rules, and the applier
 *   every work-order command runs through (saveWorkOrder).
 * Layer: Domain. Zod schemas, rules and one applier; no I/O, no React.
 * Dependencies: zod, ./model, ./programs, ./components, ./adOwnership,
 *   ./componentInventory, ./inventoryAttachments, ./logbookWording,
 *   ./rejection, and the ./workOrder* modules.
 */
import { removedTaskCards } from "./workOrderTaskRemoval";
import { adAircraftUuid } from "./adOwnership";
import {
  componentCorrectionCommandSchema,
  componentCorrectionSchema,
  previewComponentCorrection,
} from "./workOrderComponentCorrections";
import {
  componentWorkDraftSchema,
  workOrderComponentIds,
} from "./workOrderComponentWork";
import { logbookSelectionFields } from "./logbookWording";
import {
  closeoutSchema,
  completionReadingsSchema,
} from "./workOrderCloseoutSchema";
import { workPerformedText } from "./workOrderCloseout";
import { completeWorkOrder } from "./workOrderCloseout";
import {
  copyWorkOrderTemplates,
  taskCardMatchesWorkItem,
  workItemCompletionIssue,
} from "./workOrderCards";
import { z } from "zod";
import { recordProgram } from "./programs";
import { validateComponentLocation } from "./componentInventory";
import { MAX_ACTION_FILE_BYTES } from "./inventoryAttachments";
import {
  can,
  latestLocalDate,
  localDate,
  totalSeconds,
  type Inspection,
  type Snapshot,
} from "./model";
import { componentTotals, type Component } from "./components";
import { Rejection } from "./rejection";
const text = z.string().trim().max(10000);
const id = z.string().min(1).max(200);
export const workOrderStatuses = [
  "open",
  "in-progress",
  "awaiting-approval",
  "parts-delay",
  "completed",
  "cancelled",
] as const;
export const taskStatuses = [
  "requested",
  "in-progress",
  "parts-delay",
  "completed",
  "cancelled",
] as const;
export const sourceSchema = z.object({
  kind: z.enum([
    "discrepancy",
    "inspection",
    "componentRequirement",
    "airworthiness",
    "manual",
  ]),
  uuid: id,
});
export type WorkSource = z.infer<typeof sourceSchema>;
const taskSchema = z.object({
  ...logbookSelectionFields,
  maintenanceReference: text.optional(),
  uuid: z.string().uuid(),
  source: sourceSchema,
  description: text.min(1),
  status: z.enum(taskStatuses),
  notes: text,
  partsDelay: text,
});
export const workOrderFieldsSchema = z.object({
  number: z.string().trim().max(100),
  aircraftUuid: id,
  dateOpened: z.iso.date(),
  supervisor: text,
  scope: text,
  priority: z.enum(["routine", "high", "urgent"]),
  status: z.enum(workOrderStatuses),
  completionDate: z.union([z.iso.date(), z.literal("")]),
  releaseOutcome: text,
  finalReview: text,
});
const componentReadingSchema = z.object({
  recordedAt: z.number(),
  componentUuid: id,
  label: text,
  partNumber: text,
  serial: text,
  timeSinceNew: z.number().nullable(),
  timeSinceOverhaul: z.number().nullable(),
  timeSinceRepair: z.number().nullable(),
  cyclesSinceNew: z.number(),
});
export const workOrderRevisionFieldsSchema = z.object({
  supervisor: text,
  scope: text,
  releaseOutcome: text,
  finalReview: text,
  workPerformed: z.string().trim().max(100000),
});
export const workOrderSchema = workOrderFieldsSchema.extend({
  archivedTasks: z
    .array(
      z.object({
        task: taskSchema,
        cardUuids: z.array(z.string().uuid()),
        removedAt: z.number(),
        removedBy: id,
        removedByName: text,
        componentWork: z.array(componentWorkDraftSchema).optional(),
      }),
    )
    .optional(),
  templateCopy: z
    .object({
      jobId: z.string(),
      status: z.enum(["running", "failed", "completed"]),
      completed: z.number(),
      total: z.number(),
      error: z.string().optional(),
    })
    .optional(),
  componentCorrections: z.array(componentCorrectionSchema).max(100).optional(),
  revisedWorkPerformed: z.string().max(100000).optional(),
  revisions: z
    .array(
      z.object({
        number: z.number().int().positive(),
        recordedAt: z.number(),
        authorId: id,
        authorName: text,
        reason: text.min(1),
        // Preserve the previous record without recursively copying its history.
        previousRecord: z.string(),
      }),
    )
    .max(100)
    .optional(),
  closeout: closeoutSchema.optional(),
  componentWork: z.array(componentWorkDraftSchema).max(100).optional(),
  uuid: z.string().uuid(),
  version: z.number().int().nonnegative(),
  recordedAt: z.number(),
  createdBy: id,
  aircraft: z.object({
    registration: text,
    make: text,
    model: text,
    serial: text,
    totalSeconds: z.number(),
    hobbs: z.number(),
    tach: z.number(),
    cyclicHobbs: z.number().optional(),
    flightTimeLog: z.number().optional(),
    meter: z.enum(["hobbs", "tach", "cyclic", "flightTimeLog"]),
    cycles: z.number(),
    landings: z.number().int().nonnegative().optional(),
  }),
  componentReadings: z.array(componentReadingSchema).max(100),
  tasks: z.array(taskSchema).max(500),
});
export type WorkOrder = z.infer<typeof workOrderSchema>;
export type WorkOrderFields = z.infer<typeof workOrderFieldsSchema>;
export type WorkTask = WorkOrder["tasks"][number];
export const workOrderCommandSchema = z.discriminatedUnion("action", [
  componentCorrectionCommandSchema,
  z.object({
    action: z.literal("revise"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    reason: text.min(1),
    fields: workOrderRevisionFieldsSchema,
  }),
  z.object({
    action: z.literal("copyTemplates"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal("save"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    fields: workOrderFieldsSchema,
    completionReadings: completionReadingsSchema.optional(),
    componentWork: z.array(componentWorkDraftSchema).max(100).optional(),
    componentUuids: z.array(id).max(100),
    tasks: z.array(taskSchema).max(500),
  }),
  z.object({
    action: z.literal("add"),
    uuid: z.string().uuid(),
    version: z.number().int().nonnegative(),
    source: sourceSchema,
  }),
]);
export type WorkOrderCommand = z.infer<typeof workOrderCommandSchema>;
export const isOpenWorkOrder = (w: WorkOrder) =>
  !["completed", "cancelled"].includes(w.status);
export function installedComponents(s: Snapshot, aircraftUuid: string) {
  return (s.management ?? []).filter(
    (r): r is Component =>
      r.kind === "component" && r.installed && r.aircraftUuid === aircraftUuid,
  );
}
export function workSources(
  s: Snapshot,
  aircraftUuid: string,
): { source: WorkSource; description: string }[] {
  const components = installedComponents(s, aircraftUuid);
  return [
    ...(s.airworthiness ?? [])
      .filter(
        (r) =>
          adAircraftUuid(s, r) === aircraftUuid &&
          ["Applicable", "Previously Complied With (PCW)"].includes(
            r.applicability,
          ) &&
          !r.reviewRequired,
      )
      .flatMap((r) =>
        r.tasks.map((t) => ({
          source: { kind: "airworthiness" as const, uuid: t.uuid },
          description: `AD ${r.source.number}: ${t.description}`,
        })),
      ),
    ...s.discrepancies
      .filter((d) => d.aircraftUuid === aircraftUuid && d.status === "open")
      .map((d) => ({
        source: { kind: "discrepancy" as const, uuid: d.uuid },
        description: d.description,
      })),
    ...s.inspections
      .filter((i) => i.aircraftUuid === aircraftUuid && !i.archived)
      .map((i) => ({
        source: { kind: "inspection" as const, uuid: i.uuid },
        description: `${i.reference}: ${i.description}`,
      })),
    ...(s.management ?? []).flatMap((r) => {
      if (r.kind !== "componentRequirement") return [];
      const c = components.find((c) => c.uuid === r.componentUuid);
      return c
        ? [
            {
              source: { kind: "componentRequirement" as const, uuid: r.uuid },
              description: `${c.componentType} (${c.serial}) / ${r.description}`,
            },
          ]
        : [];
    }),
  ];
}
export function newWorkTask(source: WorkSource, description: string): WorkTask {
  return {
    uuid: crypto.randomUUID(),
    source,
    description,
    includeInLogbook: false,
    logbookPhrase: "Performed",
    status: "requested",
    notes: "",
    partsDelay: "",
  };
}
/**
 * Adds an inspection to a work order as a new requested task, described by
 * the inspection's reference and description.
 *
 * Whether the order is open, and whether the inspection is already on it, are
 * left to saveWorkOrder, which checks the second after its component checks.
 *
 * @param order - The work order, which is not changed.
 * @param inspection - The inspection the command names, or undefined when the
 *   snapshot holds none.
 * @returns A copy of the order with the task appended.
 * @throws {Rejection} "Work item is unavailable for this aircraft." for a
 *   missing or archived inspection, or one on another aircraft.
 */
export function addInspectionTask(
  order: WorkOrder,
  inspection: Inspection | undefined,
): WorkOrder {
  if (
    !inspection ||
    inspection.archived ||
    inspection.aircraftUuid !== order.aircraftUuid
  )
    throw new Rejection("Work item is unavailable for this aircraft.");
  const task = newWorkTask(
    { kind: "inspection", uuid: inspection.uuid },
    `${inspection.reference}: ${inspection.description}`,
  );
  return { ...order, tasks: [...order.tasks, task] };
}
export function workOrderProgress(s: Snapshot, w: WorkOrder) {
  const cards = (s.taskCards ?? []).filter((t) => t.workOrderUuid === w.uuid);
  const discrepancyIds = new Set([
    ...w.tasks
      .filter((t) => t.source.kind === "discrepancy")
      .map((t) => t.source.uuid),
    ...cards.map((t) => t.discrepancyUuid).filter(Boolean),
  ]);
  return {
    total: w.tasks.length,
    completed: w.tasks.filter((t) => t.status === "completed").length,
    taskCardsTotal: cards.length,
    taskCardsCompleted: cards.filter((t) => t.status === "completed").length,
    outstandingDiscrepancies: s.discrepancies.filter(
      (d) => discrepancyIds.has(d.uuid) && d.status === "open",
    ).length,
    partsDelays:
      w.tasks.filter((t) => t.status === "parts-delay").length +
      cards.filter((t) => t.status === "awaiting-parts").length,
  };
}
export function saveWorkOrder(
  s: Snapshot,
  raw: WorkOrderCommand,
  now = Date.now(),
  options: { deferTemplateCopies?: boolean } = {},
): WorkOrder {
  const command = workOrderCommandSchema.parse(raw);
  const existing = s.workOrders?.find((w) => w.uuid === command.uuid);
  if (existing?.templateCopy && existing.templateCopy.status !== "completed")
    throw new Error(
      "Job cards are still being prepared. Finish or resume preparation before editing or closing this work order.",
    );
  const aircraftUuid =
    command.action === "save"
      ? command.fields.aircraftUuid
      : existing?.aircraftUuid;
  if (!aircraftUuid || !can(s, aircraftUuid, "maintenance"))
    throw new Error("Work order maintenance access denied.");
  if (existing && existing.aircraftUuid !== aircraftUuid)
    throw new Error("A work order cannot change aircraft.");
  if ((existing?.version ?? 0) !== command.version)
    throw new Error("Work order changed. Reopen it before saving.");
  if (command.action === "correctComponent") {
    if (!existing) throw new Error("Work order not found.");
    const result = previewComponentCorrection(s, existing, command, now);
    const next = workOrderSchema.parse({
      ...existing,
      version: existing.version + 1,
      componentCorrections: [
        ...(existing.componentCorrections ?? []),
        result.correction,
      ],
    });
    s.management = result.management;
    s.workOrders = s.workOrders!.map((w) => (w.uuid === next.uuid ? next : w));
    return next;
  }
  if (command.action === "revise") {
    if (!existing || isOpenWorkOrder(existing))
      throw new Error(
        "Only closed work orders can be revised. Edit open orders normally.",
      );
    if (existing.status === "completed" && !command.fields.releaseOutcome)
      throw new Error("A completed work order requires a release statement.");
    const priorFields = {
      supervisor: existing.supervisor,
      scope: existing.scope,
      releaseOutcome: existing.releaseOutcome,
      finalReview: existing.finalReview,
      workPerformed:
        existing.revisedWorkPerformed ??
        existing.closeout?.workPerformed ??
        workPerformedText(s, existing),
    };
    if (JSON.stringify(priorFields) === JSON.stringify(command.fields))
      throw new Error("Change at least one field before saving a revision.");
    const { revisions = [], ...previousRecord } = existing;
    const { workPerformed, ...fields } = command.fields;
    const next = workOrderSchema.parse({
      ...existing,
      ...fields,
      revisedWorkPerformed: workPerformed,
      version: existing.version + 1,
      revisions: [
        ...revisions,
        {
          number: revisions.length + 1,
          recordedAt: now,
          authorId: s.user.id,
          authorName: s.user.name,
          reason: command.reason,
          previousRecord: JSON.stringify(previousRecord),
        },
      ],
    });
    // A documentary correction must never replay closeout tracking updates.
    s.workOrders = s.workOrders!.map((w) => (w.uuid === next.uuid ? next : w));
    return next;
  }
  if (existing && !isOpenWorkOrder(existing))
    throw new Error("This work order is closed.");
  if (command.action === "add" && !existing)
    throw new Error("Work order not found.");
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid)!;
  const sources = workSources(s, aircraftUuid);
  let next: WorkOrder;
  let removedTasks: WorkTask[] = [];
  if (command.action === "copyTemplates") {
    if (!existing) throw new Error("Work order not found.");
    next = { ...existing };
  } else if (command.action === "add" && command.source.kind === "inspection") {
    const { uuid } = command.source;
    next = addInspectionTask(
      existing!,
      s.inspections.find((i) => i.uuid === uuid),
    );
  } else if (command.action === "add") {
    const item = sources.find(
      (x) =>
        x.source.kind === command.source.kind &&
        x.source.uuid === command.source.uuid,
    );
    if (!item) throw new Error("Work item is unavailable for this aircraft.");
    next = {
      ...existing!,
      tasks: [...existing!.tasks, newWorkTask(item.source, item.description)],
    };
  } else {
    const fields = command.fields;
    const today = localDate(now),
      latest = latestLocalDate(now);
    if (fields.dateOpened > latest)
      throw new Error("Date opened cannot be in the future.");
    if (
      fields.completionDate &&
      (fields.completionDate < fields.dateOpened ||
        fields.completionDate > latest)
    )
      throw new Error("Completion date must be between opening and today.");
    if (!existing && fields.status !== "open")
      throw new Error("New work orders must start open.");
    if (
      fields.status === "completed" &&
      (!fields.completionDate ||
        !fields.releaseOutcome ||
        command.tasks.some(
          (t) => !["completed", "cancelled"].includes(t.status),
        ))
    )
      throw new Error(
        "Complete or cancel every task and enter a completion date and release outcome before closing.",
      );
    if (
      ["completed", "cancelled"].includes(fields.status) &&
      (s.taskCards ?? []).some(
        (t) =>
          t.workOrderUuid === command.uuid &&
          !["completed", "canceled"].includes(t.status),
      )
    )
      throw new Error(
        "Complete or cancel linked job cards before closing the work order.",
      );
    const scopedOrders = (s.workOrders ?? []).filter(
      (w) =>
        s.aircraft.find((a) => a.uuid === w.aircraftUuid)?.programUuid ===
        a.programUuid,
    );
    let number = fields.number || existing?.number;
    if (!number) {
      let sequence = 1;
      do {
        number = `WO-${today.slice(0, 4)}-${String(sequence++).padStart(4, "0")}`;
      } while (
        scopedOrders.some(
          (w) => w.number.toLowerCase() === number!.toLowerCase(),
        )
      );
    }
    if (
      scopedOrders.some(
        (w) =>
          w.uuid !== command.uuid &&
          w.number.toLowerCase() === number.toLowerCase(),
      )
    )
      throw new Error("Work order number already exists in this program.");
    const componentReadings = [...new Set(command.componentUuids)].map(
      (uuid) => {
        const prior = existing?.componentReadings.find(
          (c) => c.componentUuid === uuid,
        );
        if (prior) return prior;
        const c = installedComponents(s, aircraftUuid).find(
          (c) => c.uuid === uuid,
        );
        if (!c)
          throw new Error(
            "Header components must be installed on this aircraft.",
          );
        const totals = componentTotals(c, a, today);
        return {
          recordedAt: now,
          componentUuid: uuid,
          label: `${c.componentType}${c.installPosition ? ` · ${c.installPosition}` : ""}`,
          partNumber: c.partNumber,
          serial: c.serial,
          timeSinceNew: totals.timeSinceNew,
          timeSinceOverhaul: totals.timeSinceOverhaul,
          timeSinceRepair: totals.timeSinceRepair,
          cyclesSinceNew: totals.cyclesSinceNew,
        };
      },
    );
    const tasks = command.tasks.map((t) => {
      const prior = existing?.tasks.find((x) => x.uuid === t.uuid);
      if (prior) {
        if (
          prior.source.kind !== t.source.kind ||
          prior.source.uuid !== t.source.uuid
        )
          throw new Error("A task cannot change its source.");
        return { ...t, description: prior.description };
      }
      if (t.source.kind === "manual") return t;
      const source = sources.find(
        (x) =>
          x.source.kind === t.source.kind && x.source.uuid === t.source.uuid,
      );
      if (!source)
        throw new Error("Work item is unavailable for this aircraft.");
      return { ...t, description: source.description };
    });
    removedTasks =
      existing?.tasks.filter(
        (task) => !tasks.some((next) => next.uuid === task.uuid),
      ) ?? [];
    next = {
      ...fields,
      number,
      uuid: command.uuid,
      version: command.version,
      recordedAt: existing?.recordedAt ?? now,
      createdBy: existing?.createdBy ?? s.user.id,
      aircraft: existing?.aircraft ?? {
        registration: a.registration,
        make: a.make,
        model: a.model,
        serial: a.serial,
        totalSeconds: totalSeconds(a),
        hobbs: a.currentHobbs,
        tach: a.currentTach,
        cyclicHobbs: a.currentCyclicHobbs,
        flightTimeLog: a.currentFlightTimeLog,
        meter: a.meter,
        cycles: a.cycles,
        landings: a.landings,
      },
      componentReadings,
      componentWork: (command.componentWork ?? existing?.componentWork)?.filter(
        (work) =>
          !work.taskUuid ||
          !removedTasks.some((task) => task.uuid === work.taskUuid),
      ),
      templateCopy: existing?.templateCopy,
      archivedTasks: existing?.archivedTasks,
      tasks,
    };
  }
  const movements = (next.componentWork ?? []).filter(
    (w) => w.action === "install" || w.action === "remove",
  );
  if (
    new Set((next.componentWork ?? []).map((w) => w.componentUuid)).size !==
    (next.componentWork ?? []).length
  )
    throw new Error("A component can only have one action per work order.");
  for (const movement of movements) {
    const task = next.tasks.find((t) => t.uuid === movement.taskUuid);
    if (!task || task.source.kind !== "manual")
      throw new Error("A component movement requires its own work order task.");
    if (task.status === "cancelled" || next.status === "cancelled") continue;
    const c = s.management?.find(
      (r): r is Component =>
        r.kind === "component" && r.uuid === movement.componentUuid,
    );
    if (
      !c ||
      recordProgram(s, c) !== a.programUuid ||
      (c.aircraftUuid && !can(s, c.aircraftUuid, "maintenance"))
    )
      throw new Error("Component maintenance access denied.");
    if (c.parentComponentUuid)
      throw new Error(
        "Move the parent component; its attached parts move with it.",
      );
    if (c.version !== movement.version)
      throw new Error(
        "Component tracking changed. Review the component readings before saving.",
      );
    if (
      movement.action === "install"
        ? c.installed
        : !c.installed || c.aircraftUuid !== aircraftUuid
    )
      throw new Error("Component is unavailable for this aircraft movement.");
    if (movement.action === "install" && !movement.installPosition)
      throw new Error("Select an installation position.");
    if (movement.action === "remove") {
      if (!movement.locationUuid && !movement.partsLocation?.trim())
        throw new Error("Select the removal inventory location.");
      validateComponentLocation(s, {
        ...c,
        installed: false,
        locationUuid: movement.locationUuid,
        partsLocation: movement.partsLocation,
      });
    }
  }
  const componentIds = workOrderComponentIds(
    s,
    next,
    next.status !== "completed",
  );
  if (next.componentWork)
    next.componentWork = next.componentWork.filter((item) =>
      componentIds.includes(item.componentUuid),
    );
  const keys = next.tasks.map((t) => `${t.source.kind}:${t.source.uuid}`);
  if (
    new Set(keys).size !== keys.length ||
    new Set(next.tasks.map((t) => t.uuid)).size !== next.tasks.length
  )
    throw new Error("This item is already on the work order.");
  next = workOrderSchema.parse({ ...next, version: command.version + 1 });
  const isolated = structuredClone(s);
  if (removedTasks.length) {
    const removedCards = removedTaskCards(
      isolated,
      next.uuid,
      removedTasks,
      next.tasks,
    );
    isolated.archivedTaskCards = [
      ...(isolated.archivedTaskCards ?? []),
      ...structuredClone(removedCards),
    ];
    next.archivedTasks = [
      ...(next.archivedTasks ?? []),
      ...removedTasks.map((task) => ({
        task: structuredClone(task),
        cardUuids: removedCards
          .filter((card) => taskCardMatchesWorkItem(card, task))
          .map((card) => card.uuid),
        removedAt: now,
        removedBy: s.user.id,
        removedByName: s.user.name,
        componentWork: existing?.componentWork?.filter(
          (work) => work.taskUuid === task.uuid,
        ),
      })),
    ];
    const removedIds = new Set(removedCards.map((card) => card.uuid));
    isolated.taskCards = isolated.taskCards?.filter(
      (card) => !removedIds.has(card.uuid),
    );
    for (const card of removedCards)
      isolated.audit.unshift({
        uuid: crypto.randomUUID(),
        programUuid: a.programUuid,
        actorId: s.user.id,
        at: now,
        action: "taskCard.archived_with_task",
        entityUuid: card.uuid,
        aircraftUuid,
        reason:
          "Job card archived with its removed work-order task; signatures and evidence retained.",
        before: JSON.stringify(card),
      });
  }
  isolated.workOrders = [
    ...(s.workOrders ?? []).filter((w) => w.uuid !== next.uuid),
    next,
  ];
  if (!options.deferTemplateCopies)
    copyWorkOrderTemplates(
      isolated,
      next,
      command.action === "copyTemplates" ? undefined : existing,
      now,
    );
  for (const task of next.tasks)
    if (task.status === "completed") {
      const issue = workItemCompletionIssue(isolated, next.uuid, task);
      if (issue) throw new Error(issue);
    }
  if (next.status === "completed") {
    next = {
      ...next,
      closeout: completeWorkOrder(
        isolated,
        next,
        command.action === "save" ? command.completionReadings : undefined,
        now,
        next.componentWork,
      ),
    };
    isolated.workOrders = isolated.workOrders!.map((w) =>
      w.uuid === next.uuid ? next : w,
    );
  }
  if (next.status === "completed") {
    s.inspections = isolated.inspections;
    s.management = isolated.management;
  }
  s.workOrders = isolated.workOrders;
  s.taskCards = isolated.taskCards;
  s.archivedTaskCards = isolated.archivedTaskCards;
  s.audit = isolated.audit;
  return next;
}
export interface WorkOrderAttachment {
  uuid: string;
  workOrderUuid: string;
  name: string;
  size: number;
  uploadedAt: number;
  url: string;
}
/**
 * Refuses a work-order attachment or job-card evidence file unless it is a
 * PDF, JPEG or PNG of 1 byte to {@link MAX_ACTION_FILE_BYTES}, with a
 * non-blank name of at most 255 characters.
 *
 * @throws {Rejection} "Choose a PDF, JPEG or PNG file up to 7 MB."
 */
export function validateWorkOrderFile(
  name: string,
  type: string,
  size: number,
) {
  if (
    !name.trim() ||
    name.length > 255 ||
    !["application/pdf", "image/jpeg", "image/png"].includes(type) ||
    size <= 0 ||
    size > MAX_ACTION_FILE_BYTES
  )
    throw new Rejection("Choose a PDF, JPEG or PNG file up to 7 MB.");
}
