/**
 * Responsibility: Parts demand for maintenance planning: which open work
 *   needs parts, and how many of each are still to get.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/partsRequests.ts, airworthiness.ts, management.ts,
 *   maintenance.ts, components.ts; model.ts and requiredParts.ts (types).
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
import { adTaskStatus, adAircraftUuid } from "./airworthiness";
import type { Snapshot } from "./model";
import type { RequiredPart } from "./requiredParts";
import { inspectionCounters } from "./management";
import { inspectionStatus } from "./maintenance";
import { requirementStatus } from "./components";

const DUE_REQUIREMENT_STATUSES: readonly string[] = [
  "Past due",
  "Due now",
  "Due soon",
];
const PLANNED_AD_APPLICABILITY: readonly string[] = [
  "Applicable",
  "Previously Complied With (PCW)",
];
const UPCOMING_AD_TASK_STATUSES: readonly string[] = [
  "Overdue",
  "Due soon",
  "Due not set",
  "Counter unavailable",
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
 *   requests (manual work items, job cards, movements) once per source.
 */
export function maintenancePartsPlans(s: Snapshot): PartsPlan[] {
  return planOtherRequests(s, [
    ...planInspections(s),
    ...planDiscrepancies(s),
    ...planComponentRequirements(s),
    ...planAirworthiness(s),
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

function planInspections(s: Snapshot): PartsPlan[] {
  return s.inspections.flatMap((i) => {
    const a = s.aircraft.find((a) => a.uuid === i.aircraftUuid);
    const parts =
      requestedParts(s, recordSource("inspection", i.uuid)) ?? i.requiredParts;
    if (!a || i.archived || !parts?.length) return [];
    const { status } = inspectionStatus(
      i,
      a,
      undefined,
      inspectionCounters(i, a, s.management),
    );
    const upcoming = status === "overdue" || status === "due-soon";
    return [
      {
        uuid: i.uuid,
        aircraftUuid: a.uuid,
        label: i.reference,
        upcoming,
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

function planComponentRequirements(s: Snapshot): PartsPlan[] {
  return (s.management ?? []).flatMap((r) => {
    if (r.kind !== "componentRequirement") return [];
    const parts =
      requestedParts(s, recordSource("componentRequirement", r.uuid)) ??
      r.requiredParts;
    if (!parts?.length) return [];
    const c = s.management?.find(
      (c) => c.kind === "component" && c.uuid === r.componentUuid,
    );
    if (!c || c.kind !== "component" || !c.installed) return [];
    const a = s.aircraft.find((a) => a.uuid === c.aircraftUuid);
    if (!a) return [];
    const { status } = requirementStatus(r, c, a);
    return [
      {
        uuid: r.uuid,
        aircraftUuid: a.uuid,
        label: `${c.componentType}: ${r.description}`,
        upcoming: DUE_REQUIREMENT_STATUSES.includes(status),
        parts,
      },
    ];
  });
}

// AD tasks have no parts of their own; only parts requests plan them.
function planAirworthiness(s: Snapshot): PartsPlan[] {
  return (s.airworthiness ?? []).flatMap((ad) => {
    if (
      ad.reviewRequired ||
      !PLANNED_AD_APPLICABILITY.includes(ad.applicability)
    )
      return [];
    return ad.tasks.flatMap((task) => {
      const parts = requestedParts(s, recordSource("airworthiness", task.uuid));
      const status = adTaskStatus(s, ad, task);
      if (!parts?.length || status === "Complied") return [];
      return [
        {
          uuid: task.uuid,
          aircraftUuid: adAircraftUuid(s, ad),
          label: `AD ${ad.source.number}: ${task.description}`,
          upcoming: UPCOMING_AD_TASK_STATUSES.includes(status),
          parts,
        },
      ];
    });
  });
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
