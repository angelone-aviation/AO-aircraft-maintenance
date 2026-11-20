/**
 * Responsibility: What "Keep mine" may and may not combine on each record a
 *   stale-save review covers: the parts only the server writes, and the
 *   facts only one person may have changed.
 * Layer: Domain. Declarative rules for recordMerge; no I/O, no React.
 * Dependencies: ./recordMerge (rule types), ./model, ./airworthiness,
 *   ./management, ./workOrders, ./workOrderComponentWork, ./purchaseOrders
 *   (record types).
 *
 * The rules sit together, apart from each record's own module, so the whole
 * policy can be read and reviewed in one place.
 */
import type { MergeRules } from "./recordMerge";
import type { Inspection } from "./model";
import type { AD } from "./airworthiness";
import type { Component } from "./management";
import type { WorkOrder, WorkOrderFields } from "./workOrders";
import type { ComponentWork } from "./workOrderComponentWork";
import type { PODraft } from "./purchaseOrders";

/**
 * Inspections. A due value under a recurring interval is derived by the
 * server on every save, so it is neither the user's nor the other person's
 * to keep; a completion recorded underneath an edit of the same baseline
 * cannot be combined with it.
 */
export const INSPECTION_KEEP_MINE: MergeRules<Inspection> = {
  prepare: withoutDerivedDue,
  serverOwned: ["calendarExemptChangedAt", "calendarExemptChangedBy"],
  together: [
    {
      what: "the last compliance or the due limits",
      fields: [
        "lastSeconds",
        "lastCycles",
        "lastLandings",
        "lastDate",
        "dueSeconds",
        "dueCycles",
        "dueLandings",
        "dueDate",
      ],
    },
    {
      what: "the calendar exemption",
      fields: ["calendarExempt", "calendarExemptReason"],
    },
  ],
};

/**
 * ADs. The compliance history and the replaced FAA sources are append-only
 * (ADR-0005), and compliance moves an action's next due: limits edited while
 * someone recorded compliance on the same action cannot be combined.
 */
export const AD_KEEP_MINE: MergeRules<AD> = {
  serverOwned: ["history", "sourceHistory"],
  together: [
    {
      what: "the due limits or intervals of this action",
      fields: [
        "tasks.dueDate",
        "tasks.dueHours",
        "tasks.dueCycles",
        "tasks.dueLandings",
        "tasks.intervalDays",
        "tasks.intervalHours",
        "tasks.intervalCycles",
        "tasks.intervalLandings",
        "tasks.recurrence",
      ],
    },
    {
      what: "the applicability decision",
      fields: [
        "applicability",
        "reason",
        "priorCompliance",
        "source.supersededBy",
      ],
    },
  ],
};

/**
 * Components. Installing, removing, shipping or servicing a component (a
 * work order close-out, a repair order) rewrites its placement and its life
 * baselines together; half of one person's and half of the other's would
 * describe a component that never existed.
 */
export const COMPONENT_KEEP_MINE: MergeRules<Component> = {
  serverOwned: ["outForRepair"],
  together: [
    {
      what: "where the component is installed or stored",
      fields: [
        "installed",
        "installedDate",
        "removedDate",
        "installPosition",
        "aircraftUuid",
        "parentComponentUuid",
        "locationUuid",
        "partsLocation",
        "installedSeconds",
        "installedCycles",
      ],
    },
    {
      what: "the component's time, cycle or calendar baselines",
      fields: [
        "usageMeter",
        "trackTime",
        "trackCycles",
        "trackCalendar",
        "timeSinceNew",
        "timeSinceOverhaul",
        "timeSinceRepair",
        "cyclesSinceNew",
        "serviceDaysBase",
        "calendarSinceNewUnknown",
        "calendarOverhaulDaysBase",
        "calendarOverhaulDate",
      ],
    },
  ],
};

/**
 * What a work order's form saves: the fields, work items and component
 * work of the save command. Close-out, revisions, corrections and archived
 * items are written by their own commands and are not part of it.
 */
export type WorkOrderEdit = WorkOrderFields &
  Pick<WorkOrder, "uuid" | "version" | "tasks"> & {
    componentWork: ComponentWork[];
    componentUuids: string[];
  };

/**
 * The part of a stored work order its form edits, to compare with a draft.
 *
 * @param w - The stored order.
 * @returns Its fields, items, component work and the components whose
 *   readings it holds, in stored order.
 */
export function workOrderEdit(w: WorkOrder): WorkOrderEdit {
  return {
    uuid: w.uuid,
    version: w.version,
    number: w.number,
    aircraftUuid: w.aircraftUuid,
    dateOpened: w.dateOpened,
    supervisor: w.supervisor,
    scope: w.scope,
    priority: w.priority,
    status: w.status,
    completionDate: w.completionDate,
    releaseOutcome: w.releaseOutcome,
    tasks: w.tasks,
    componentWork: w.componentWork ?? [],
    componentUuids: w.componentReadings.map((c) => c.componentUuid),
  };
}

/**
 * Work orders. A work item's status and its parts-delay note are one report
 * of progress by whoever did the work, and the order's status and
 * completion date are one decision.
 */
export const WORK_ORDER_KEEP_MINE: MergeRules<WorkOrderEdit> = {
  together: [
    {
      what: "the status or parts delay of this work item",
      fields: ["tasks.status", "tasks.partsDelay"],
    },
    {
      what: "the status or completion date of the order",
      fields: ["status", "completionDate"],
    },
  ],
};

/**
 * Draft purchase orders. The vendor's name, account, address and contact
 * name one vendor.
 */
export const PO_KEEP_MINE: MergeRules<PODraft> = {
  together: [
    {
      what: "the vendor",
      fields: ["vendor", "vendorUuid", "vendorAddressDetails", "vendorContact"],
    },
  ],
};

function withoutDerivedDue(i: Inspection): Inspection {
  return {
    ...i,
    dueSeconds: i.intervalSeconds ? undefined : i.dueSeconds,
    dueCycles: i.intervalCycles ? undefined : i.dueCycles,
    dueLandings: i.intervalLandings ? undefined : i.dueLandings,
    dueDate: i.intervalMonths ? undefined : i.dueDate,
  };
}
