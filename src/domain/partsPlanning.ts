/**
 * Responsibility: Parts demand for maintenance planning: which open work
 *   needs parts, and how many of each are still to get.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/partsRequests.ts, dueItems.ts; model.ts,
 *   airworthiness.ts and requiredParts.ts (types).
 *
 * Once any parts request names a record, the requests replace the parts
 * recorded on the record itself.
 */
import {
  requestMatchesSource,
  requestLineProgress,
  recurringRequestSource,
  type PartsRequest,
  type RequestLine,
  type RequestSource,
} from "./partsRequests";
import type { AD } from "./airworthiness";
import {
  dueItems,
  type AdDue,
  type InspectionDue,
  type MaintenanceDue,
  type RequirementDue,
} from "./dueItems";
import type { Snapshot } from "./model";
import type { RequiredPart } from "./requiredParts";

const PLANNED_AD_APPLICABILITY: readonly string[] = [
  "Applicable",
  "Previously Complied With (PCW)",
];
// Kinds planned from their own record, so a request for one adds nothing.
const RECORD_SOURCE_KINDS: readonly string[] = [
  "inspection",
  "discrepancy",
  "componentRequirement",
  "airworthiness",
];
const CLOSED_STATUSES: readonly string[] = ["completed", "cancelled"];

/** Open work that needs parts, for the parts planning lists. */
export interface PartsPlan {
  /** The inspection, discrepancy, requirement, AD task or request source. */
  uuid: string;
  aircraftUuid: string;
  label: string;
  /** Due soon or overdue, or needing attention now. */
  upcoming: boolean;
  parts: RequiredPart[];
}

/**
 * Lists the open work that needs parts.
 *
 * @param s - The snapshot.
 * @returns Unarchived inspections, open discrepancies, installed components'
 *   requirements, applicable AD tasks not complied with, then other parts
 *   requests (manual work items, job cards, movements) once per source. An
 *   inspection or requirement whose status cannot be computed is left out.
 */
export function maintenancePartsPlans(s: Snapshot): PartsPlan[] {
  const due = dueItems(s);
  return planOtherRequests(s, [
    ...planInspections(s, due),
    ...planDiscrepancies(s),
    ...planComponentRequirements(s, due),
    ...planAirworthiness(s, due),
  ]);
}

/**
 * Totals the parts one source still needs from its parts requests.
 *
 * @param s - The snapshot.
 * @param source - The record or work item.
 * @returns undefined when no request for parts (not repair) names the
 *   source. Otherwise each request line still short, from requests not
 *   cancelled or closed with their work: a recurring list counts in full only
 *   while no occurrence of it is on an open work order, never twice.
 */
export function requestedParts(
  s: Snapshot,
  source: RequestSource,
): RequiredPart[] | undefined {
  const linked = (s.partsRequests ?? []).filter(
    (r) => r.mode === "parts" && requestMatchesSource(s, r, source),
  );
  if (!linked.length) return;
  return linked
    .filter((r) => !r.cancelled && isOnOpenWork(s, r))
    .filter((r) => !r.recurring || isForecastTemplate(s, r, linked))
    .flatMap((r) => r.lines.map((line) => outstandingLine(s, r, line)))
    .filter((p) => p.quantity > 0);
}

// As in the alerts, an inspection or requirement whose status cannot be
// computed is skipped: the plans have no place to show it for review, and
// one such item must not hide the rest.
function planInspections(s: Snapshot, due: MaintenanceDue[]): PartsPlan[] {
  return due.flatMap((item) => {
    if (item.kind !== "inspection" || !item.due) return [];
    const i = item.inspection;
    const parts =
      requestedParts(s, recordSource("inspection", i.uuid)) ?? i.requiredParts;
    if (!parts?.length) return [];
    return [
      {
        uuid: i.uuid,
        aircraftUuid: item.aircraft.uuid,
        label: i.reference,
        upcoming: isUpcoming(item),
        parts,
      },
    ];
  });
}

function planDiscrepancies(s: Snapshot): PartsPlan[] {
  return s.discrepancies.flatMap((d) => {
    const parts =
      requestedParts(s, recordSource("discrepancy", d.uuid)) ?? d.requiredParts;
    if (d.status !== "open" || !parts?.length) return [];
    return [
      {
        uuid: d.uuid,
        aircraftUuid: d.aircraftUuid,
        label: d.description,
        upcoming: true,
        parts,
      },
    ];
  });
}

// Components held in inventory are not planned.
function planComponentRequirements(
  s: Snapshot,
  due: MaintenanceDue[],
): PartsPlan[] {
  return due.flatMap((item) => {
    if (item.kind !== "componentRequirement" || !item.aircraft || !item.due)
      return [];
    const { requirement: r, component: c } = item;
    const parts =
      requestedParts(s, recordSource("componentRequirement", r.uuid)) ??
      r.requiredParts;
    if (!parts?.length) return [];
    return [
      {
        uuid: r.uuid,
        aircraftUuid: item.aircraft.uuid,
        label: `${c.componentType}: ${r.description}`,
        upcoming: isUpcoming(item),
        parts,
      },
    ];
  });
}

// AD tasks have no parts of their own; only parts requests plan them.
function planAirworthiness(s: Snapshot, due: MaintenanceDue[]): PartsPlan[] {
  return due.flatMap((item) =>
    item.kind === "ad" && isPlanned(item.ad) ? planADTasks(s, item) : [],
  );
}

// An action with no due point or no readable counter needs attention now,
// as one coming due does.
function planADTasks(s: Snapshot, item: AdDue): PartsPlan[] {
  return item.tasks.flatMap(({ task, status, level }) => {
    const parts = requestedParts(s, recordSource("airworthiness", task.uuid));
    if (!parts?.length || status === "Complied") return [];
    return [
      {
        uuid: task.uuid,
        aircraftUuid: item.aircraftUuid,
        label: `AD ${item.ad.source.number}: ${task.description}`,
        upcoming: level !== "ok",
        parts,
      },
    ];
  });
}

function isPlanned(ad: AD) {
  return (
    !ad.reviewRequired && PLANNED_AD_APPLICABILITY.includes(ad.applicability)
  );
}

function isUpcoming(item: InspectionDue | RequirementDue) {
  return item.level === "overdue" || item.level === "due-soon";
}

// Other work (manual work items, job cards, component movements) adds demand
// through its parts requests alone, once per source.
function planOtherRequests(s: Snapshot, planned: PartsPlan[]) {
  const plans = [...planned];
  for (const r of s.partsRequests ?? []) {
    if (!isOtherWorkRequest(s, r)) continue;
    const parts = requestedParts(s, r.source);
    if (parts?.length && !plans.some((p) => p.uuid === r.source.uuid))
      plans.push({
        uuid: r.source.uuid,
        aircraftUuid: r.aircraftUuid,
        label: r.sourceLabel,
        upcoming: true,
        parts,
      });
  }
  return plans;
}

// A work item copied from a record is planned through that record.
function isOtherWorkRequest(
  s: Snapshot,
  r: PartsRequest,
): r is PartsRequest & { aircraftUuid: string } {
  if (r.cancelled || r.recurring || r.mode !== "parts" || !r.aircraftUuid)
    return false;
  if (RECORD_SOURCE_KINDS.includes(r.source.kind)) return false;
  if (r.source.kind !== "workTask") return true;
  const task = s.workOrders
    ?.find((w) => w.uuid === r.source.workOrderUuid)
    ?.tasks.find((t) => t.uuid === r.source.uuid);
  return !task || task.source.kind === "manual";
}

function recordSource(
  kind: RequestSource["kind"],
  uuid: string,
): RequestSource {
  return { kind, uuid, workOrderUuid: "" };
}

// A work item's request counts while its order and the item are both open.
function isOnOpenWork(s: Snapshot, r: PartsRequest) {
  return (
    r.source.kind !== "workTask" ||
    s.workOrders?.some(
      (w) =>
        w.uuid === r.source.workOrderUuid &&
        !CLOSED_STATUSES.includes(w.status) &&
        w.tasks.some(
          (t) =>
            t.uuid === r.source.uuid && !CLOSED_STATUSES.includes(t.status),
        ),
    )
  );
}

function isForecastTemplate(
  s: Snapshot,
  template: PartsRequest,
  linked: PartsRequest[],
) {
  return (
    recurringRequestSource(s, template.source) &&
    !linked.some(
      (occurrence) =>
        occurrence.templateUuid === template.uuid &&
        s.workOrders?.some(
          (w) =>
            w.uuid === occurrence.source.workOrderUuid &&
            !CLOSED_STATUSES.includes(w.status),
        ),
    )
  );
}

// A recurring list is a forecast, so nothing is on order or in transit for it.
function outstandingLine(
  s: Snapshot,
  r: PartsRequest,
  line: RequestLine,
): RequiredPart {
  const progress = requestLineProgress(s, r, line.uuid);
  return {
    stockUuid: "",
    locationUuid: "",
    partNumber: line.partNumber,
    quantity: r.recurring ? line.quantity : progress.remaining,
    onOrder: r.recurring ? 0 : progress.ordered,
    shipped: r.recurring
      ? 0
      : progress.purchases.reduce(
          (n, p) => n + Math.max(0, p.shipped - p.received),
          0,
        ),
  };
}
