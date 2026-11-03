import { z } from "zod";
import {
  componentSchema,
  componentDescendants,
  POSITIONS,
  componentTotals,
  componentAircraftSeconds,
  movementSchema,
  moveRequirement,
  rebaseServicedRequirements,
  type Component,
} from "./components";
import { validateComponentLocation } from "./componentInventory";
import { recordProgram } from "./programs";
import { can, totalSeconds, type Aircraft, type Snapshot } from "./model";
import type { WorkOrder } from "./workOrders";

export const componentWorkDraftSchema = z.object({
  taskUuid: z.string().uuid().optional(),
  installPosition: z.enum(POSITIONS).optional(),
  locationUuid: z.string().optional(),
  partsLocation: z.string().max(150).optional(),
  componentUuid: z.string().min(1),
  version: z.number().int().nonnegative(),
  action: z.enum([
    "service",
    "repair",
    "overhaul",
    "both",
    "install",
    "remove",
  ]),
  description: z.string().trim().max(10000),
  reference: z.string().trim().max(2000),
});
export const componentWorkSchema = componentWorkDraftSchema.superRefine(
  (item, ctx) => {
    if (item.action !== "service" && !item.description)
      ctx.addIssue({
        code: "custom",
        path: ["description"],
        message:
          item.action === "install" || item.action === "remove"
            ? "Describe the component work performed."
            : "Describe the component repair or overhaul.",
      });
  },
);
export type ComponentWork = z.infer<typeof componentWorkSchema>;
export const componentWorkLabels = {
  install: "Installed on aircraft",
  remove: "Removed from aircraft",
  service: "Inspected / serviced only",
  repair: "Repaired",
  overhaul: "Overhauled",
  both: "Repaired and overhauled",
};
export function workOrderComponentIds(
  s: Snapshot,
  order: Pick<WorkOrder, "uuid" | "tasks"> & {
    componentReadings: { componentUuid: string }[];
    componentWork?: ComponentWork[];
  },
  includePlanned = false,
) {
  const ids = new Set(order.componentReadings.map((c) => c.componentUuid));
  for (const work of order.componentWork ?? []) {
    if (
      (work.action === "install" || work.action === "remove") &&
      order.tasks.some(
        (t) =>
          t.uuid === work.taskUuid &&
          (t.status === "completed" ||
            (includePlanned && t.status !== "cancelled")),
      )
    )
      ids.add(work.componentUuid);
  }
  for (const card of s.taskCards ?? [])
    if (
      card.workOrderUuid === order.uuid &&
      (card.status === "completed" ||
        (includePlanned && card.status !== "canceled")) &&
      card.componentUuid
    )
      ids.add(card.componentUuid);
  for (const task of order.tasks.filter(
    (t) =>
      t.status === "completed" || (includePlanned && t.status !== "cancelled"),
  )) {
    if (task.source.kind === "inspection") {
      const i = s.inspections.find((i) => i.uuid === task.source.uuid);
      if (i?.componentUuid) ids.add(i.componentUuid);
    } else if (task.source.kind === "componentRequirement") {
      const r = s.management?.find(
        (r) => r.kind === "componentRequirement" && r.uuid === task.source.uuid,
      );
      if (r?.kind === "componentRequirement") ids.add(r.componentUuid);
    }
  }
  return [...ids];
}
export function applyWorkOrderComponentWork(
  s: Snapshot,
  order: WorkOrder,
  aircraft: Aircraft,
  choices: ComponentWork[],
  now: number,
) {
  choices = z.array(componentWorkSchema).parse(choices);
  const ids = workOrderComponentIds(s, order);
  if (
    choices.length !== ids.length ||
    new Set(choices.map((c) => c.componentUuid)).size !== ids.length ||
    choices.some((c) => !ids.includes(c.componentUuid))
  )
    throw new Error("Select the work performed for every included component.");
  // Finish explicitly selected part service before freezing the assembly's movement readings.
  choices = [...choices].sort(
    (a, b) =>
      Number(a.action === "install" || a.action === "remove") -
      Number(b.action === "install" || b.action === "remove"),
  );
  return choices.map((choice) => {
    const c = s.management?.find(
      (r): r is Component =>
        r.kind === "component" && r.uuid === choice.componentUuid,
    );
    if (
      !c ||
      (choice.action !== "install" && c.aircraftUuid !== order.aircraftUuid) ||
      c.version !== choice.version
    )
      throw new Error(
        "Component tracking changed. Reopen the work order and review its components.",
      );
    if (
      c.parentComponentUuid &&
      (choice.action === "install" || choice.action === "remove")
    )
      throw new Error(
        "Move the parent component; its attached parts move with it.",
      );
    const descendants = componentDescendants(s, c.uuid);
    const trackedRecords = () =>
      (s.management ?? []).filter(
        (r) =>
          (r.kind === "component" &&
            (r.uuid === c.uuid ||
              ((choice.action === "install" || choice.action === "remove") &&
                descendants.some((child) => child.uuid === r.uuid)))) ||
          (r.kind === "componentRequirement" &&
            (r.componentUuid === c.uuid ||
              ((choice.action === "install" || choice.action === "remove") &&
                descendants.some((child) => child.uuid === r.componentUuid)))),
      );
    const baselineBefore = JSON.stringify(trackedRecords());
    const priorMovements = new Set(
      (s.management ?? [])
        .filter((r) => r.kind === "componentMovement")
        .map((r) => r.uuid),
    );
    if (c.outForRepair)
      throw Error(
        "Receive the component from repair before performing component work.",
      );
    const before = componentTotals(c, aircraft, order.completionDate);
    const repair = choice.action === "repair" || choice.action === "both";
    const overhaul = choice.action === "overhaul" || choice.action === "both";
    if (choice.action === "install" || choice.action === "remove") {
      const install = choice.action === "install";
      if (
        !order.tasks.some(
          (t) => t.uuid === choice.taskUuid && t.status === "completed",
        )
      )
        throw new Error(
          "Complete the component movement task before closing the order.",
        );
      if (
        c.installed === install ||
        recordProgram(s, c) !== aircraft.programUuid ||
        (c.aircraftUuid && !can(s, c.aircraftUuid, "maintenance"))
      )
        throw new Error("Component is unavailable for this aircraft movement.");
      if (install && !choice.installPosition)
        throw new Error("Select an installation position.");
      if (!install && !choice.locationUuid && !choice.partsLocation?.trim())
        throw new Error("Select the removal inventory location.");
      const next = componentSchema.parse({
        ...c,
        version: c.version + 1,
        installed: install,
        aircraftUuid: aircraft.uuid,
        installedDate: install ? order.completionDate : c.installedDate,
        removedDate: install ? undefined : order.completionDate,
        installPosition: install ? choice.installPosition : undefined,
        locationUuid: install ? undefined : choice.locationUuid,
        partsLocation: install ? undefined : choice.partsLocation,
        installedSeconds: install
          ? componentAircraftSeconds(c, aircraft)
          : c.installedSeconds,
        installedCycles: install ? aircraft.cycles : c.installedCycles,
        timeSinceNew: before.timeSinceNew,
        timeSinceOverhaul: before.timeSinceOverhaul,
        timeSinceRepair: before.timeSinceRepair,
        cyclesSinceNew: before.cyclesSinceNew,
        serviceDaysBase: before.serviceDays,
        calendarOverhaulDaysBase: before.calendarOverhaulDays,
        calendarOverhaulDate: order.completionDate,
      });
      validateComponentLocation(s, next);
      s.management = s.management!.map((r) =>
        r.uuid === c.uuid
          ? next
          : r.kind === "componentRequirement" &&
              r.componentUuid === c.uuid &&
              r.aircraftUuid !== aircraft.uuid
            ? moveRequirement(r, aircraft.uuid)
            : r,
      );
      s.inspections = s.inspections.map((i) =>
        i.componentUuid === c.uuid && i.aircraftUuid !== aircraft.uuid
          ? { ...i, aircraftUuid: aircraft.uuid, version: (i.version ?? 0) + 1 }
          : i,
      );
      s.management.push(
        movementSchema.parse({
          programUuid: c.programUuid,
          uuid: crypto.randomUUID(),
          version: 1,
          kind: "componentMovement",
          componentUuid: c.uuid,
          aircraftUuid: aircraft.uuid,
          workOrderUuid: order.uuid,
          action: install ? "INSTALL" : "REMOVE",
          date: order.completionDate,
          installPosition: install ? choice.installPosition : c.installPosition,
          locationUuid: next.locationUuid,
          partsLocation: next.partsLocation,
          timeSinceNew: before.timeSinceNew,
          timeSinceOverhaul: before.timeSinceOverhaul,
          timeSinceRepair: before.timeSinceRepair,
          cycles: before.cyclesSinceNew,
          serviceDays: before.serviceDays,
          calendarSinceNewUnknown: c.calendarSinceNewUnknown,
          calendarOverhaulDays: before.calendarOverhaulDays,
          aircraftSnapshot: {
            registration: aircraft.registration,
            make: aircraft.make,
            model: aircraft.model,
            serial: aircraft.serial,
            totalSeconds: totalSeconds(aircraft),
            cycles: aircraft.cycles,
            removedBy: s.user.name,
            mechanic: s.user.licenseNumber ?? "",
          },
          note: `Work order ${order.number}: ${choice.description}${choice.reference ? `; ${choice.reference}` : ""}`,
          actorId: s.user.id,
          at: now,
        }),
      );
    }
    if (choice.action === "install" || choice.action === "remove") {
      const install = choice.action === "install";
      for (const child of descendants) {
        if (
          child.installed !== c.installed ||
          child.aircraftUuid !== c.aircraftUuid
        )
          throw new Error(
            "Attached part location is inconsistent with its parent.",
          );
        // Same completion readings as the parent, not the live aircraft totals.
        const usage = componentTotals(child, aircraft, order.completionDate);
        const next = componentSchema.parse({
          ...child,
          version: child.version + 1,
          installed: install,
          aircraftUuid: aircraft.uuid,
          installedDate: install ? order.completionDate : child.installedDate,
          removedDate: install ? undefined : order.completionDate,
          installPosition: install ? choice.installPosition : undefined,
          locationUuid: install ? undefined : choice.locationUuid,
          partsLocation: install ? undefined : choice.partsLocation,
          installedSeconds: install
            ? componentAircraftSeconds(child, aircraft)
            : child.installedSeconds,
          installedCycles: install ? aircraft.cycles : child.installedCycles,
          timeSinceNew: usage.timeSinceNew,
          timeSinceOverhaul: usage.timeSinceOverhaul,
          timeSinceRepair: usage.timeSinceRepair,
          cyclesSinceNew: usage.cyclesSinceNew,
          serviceDaysBase: usage.serviceDays,
          calendarOverhaulDaysBase: usage.calendarOverhaulDays,
          calendarOverhaulDate: order.completionDate,
        });
        validateComponentLocation(s, next);
        s.management = s.management!.map((r) =>
          r.uuid === child.uuid
            ? next
            : r.kind === "componentRequirement" &&
                r.componentUuid === child.uuid &&
                r.aircraftUuid !== aircraft.uuid
              ? moveRequirement(r, aircraft.uuid)
              : r,
        );
        s.inspections = s.inspections.map((r) =>
          r.componentUuid === child.uuid && r.aircraftUuid !== aircraft.uuid
            ? {
                ...r,
                aircraftUuid: aircraft.uuid,
                version: (r.version ?? 0) + 1,
              }
            : r,
        );
        const parentMovement = s.management.find(
          (r) =>
            r.kind === "componentMovement" &&
            r.componentUuid === c.uuid &&
            r.workOrderUuid === order.uuid &&
            !priorMovements.has(r.uuid),
        );
        if (!parentMovement || parentMovement.kind !== "componentMovement")
          throw new Error("Parent movement is missing.");
        s.management.push(
          movementSchema.parse({
            ...parentMovement,
            uuid: crypto.randomUUID(),
            componentUuid: child.uuid,
            timeSinceNew: usage.timeSinceNew,
            timeSinceOverhaul: usage.timeSinceOverhaul,
            timeSinceRepair: usage.timeSinceRepair,
            cycles: usage.cyclesSinceNew,
            serviceDays: usage.serviceDays,
            calendarSinceNewUnknown: child.calendarSinceNewUnknown,
            calendarOverhaulDays: usage.calendarOverhaulDays,
            note: `Attached to ${c.model || c.partNumber || c.componentType}: ${parentMovement.note}`,
          }),
        );
      }
    }
    if (repair || overhaul) {
      const next = componentSchema.parse({
        ...c,
        version: c.version + 1,
        timeSinceNew: before.timeSinceNew,
        timeSinceOverhaul: overhaul ? 0 : before.timeSinceOverhaul,
        calendarOverhaulDaysBase: overhaul ? 0 : before.calendarOverhaulDays,
        calendarOverhaulDate: order.completionDate,
        timeSinceRepair: repair ? 0 : before.timeSinceRepair,
        cyclesSinceNew: before.cyclesSinceNew,
        installedSeconds: c.installed
          ? componentAircraftSeconds(c, aircraft)
          : c.installedSeconds,
        installedCycles: c.installed ? aircraft.cycles : c.installedCycles,
      });
      s.management = s.management!.map((r) => (r.uuid === c.uuid ? next : r));
      for (const action of [
        overhaul ? "OVERHAUL" : null,
        repair ? "REPAIR" : null,
      ] as const) {
        if (!action) continue;
        s.management.push(
          movementSchema.parse({
            programUuid: c.programUuid,
            uuid: crypto.randomUUID(),
            version: 1,
            kind: "componentMovement",
            componentUuid: c.uuid,
            aircraftUuid: c.aircraftUuid,
            action,
            workOrderUuid: order.uuid,
            date: order.completionDate,
            installPosition: c.installPosition,
            partsLocation: c.partsLocation,
            timeSinceNew: before.timeSinceNew,
            timeSinceOverhaul: next.timeSinceOverhaul,
            timeSinceRepair: next.timeSinceRepair,
            cycles: before.cyclesSinceNew,
            serviceDays: before.serviceDays,
            calendarSinceNewUnknown: c.calendarSinceNewUnknown,
            calendarOverhaulDays: next.calendarOverhaulDaysBase,
            note: `Work order ${order.number}: ${choice.description}${choice.reference ? `; ${choice.reference}` : ""}`,
            actorId: s.user.id,
            at: now,
          }),
        );
      }
      const updated = rebaseServicedRequirements(
        s,
        next,
        before,
        {
          overhaul,
          repair,
          date: order.completionDate,
          landings: aircraft.landings,
        },
        now,
      );
      s.management = s.management.map(
        (item) => updated.find((r) => r.uuid === item.uuid) ?? item,
      );
    }
    const after = {
      ...before,
      calendarOverhaulDays: overhaul ? 0 : before.calendarOverhaulDays,
      timeSinceRepair: repair ? 0 : before.timeSinceRepair,
      timeSinceOverhaul: overhaul ? 0 : before.timeSinceOverhaul,
    };
    return {
      ...choice,
      installPosition:
        choice.action === "remove" ? c.installPosition : choice.installPosition,
      date: order.completionDate,
      before,
      after,
      trackingBaseline: {
        before: baselineBefore,
        after: JSON.stringify(trackedRecords()),
        movementUuids: (s.management ?? [])
          .filter(
            (r) =>
              r.kind === "componentMovement" && !priorMovements.has(r.uuid),
          )
          .map((r) => r.uuid),
      },
    };
  });
}
