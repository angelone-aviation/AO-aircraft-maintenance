/**
 * Responsibility: What is next due on one aircraft, for its owner:
 *   inspections, component limits and ADs, each with a status and what remains.
 * Layer: Domain. Pure functions; no I/O, no React (a `today` left to its
 *   default reads the clock).
 * Dependencies: ./model, ./adOwnership, ./airworthiness, ./adRemaining,
 *   ./maintenance, ./management, ./components, ./rejection.
 */
import type { Aircraft, Inspection, Snapshot } from "./model";
import { localDate } from "./model";
import { adAircraftUuid } from "./adOwnership";
import { adStatus, type AD } from "./airworthiness";
import { adRemaining } from "./adRemaining";
import { inspectionStatus } from "./maintenance";
import { inspectionCounters, type ManagedRecord } from "./management";
import { requirementStatus } from "./components";
import { Rejection } from "./rejection";

/** How pressing a due item is; `unknown` when it cannot be worked out. */
export type DueStatus = "overdue" | "due-soon" | "ok" | "unknown";

/** One line of an owner's due list. */
export interface DueItem {
  uuid: string;
  kind: "Inspection" | "Component" | "AD";
  label: string;
  status: DueStatus;
  remaining: string;
}

const DUE_STATUS_RANK: Record<DueStatus, number> = {
  overdue: 0,
  "due-soon": 1,
  unknown: 2,
  ok: 3,
};
const HOUR_SECONDS = 3600;
const NEEDS_REVIEW = { status: "unknown", remaining: "Review" } as const;
const MISSING_COMPONENT = "Inspection component not found.";
const HIDDEN_AD_APPLICABILITY = ["Not applicable", "Superseded"];
const AD_OK_STATUSES = [
  "Scheduled",
  "Complied",
  "Previously Complied With (PCW)",
];

/**
 * The next-due items for one aircraft, worst first, from the same status
 * rules the maintenance screens use.
 *
 * @param s - The snapshot.
 * @param a - The aircraft.
 * @param today - A local date; today by default.
 * @returns Live inspections, installed components' limits and ADs neither
 *   not applicable nor superseded, ordered overdue, due soon, unknown, ok.
 *   `remaining` lists what is left, "Not set" when nothing limits it, or
 *   "Review" for a component limit it cannot compute or an inspection whose
 *   component is missing.
 * @throws As {@link inspectionCounters} and {@link inspectionStatus}, except
 *   "Inspection component not found.".
 */
export function ownerDueItems(
  s: Snapshot,
  a: Aircraft,
  today = localDate(),
): DueItem[] {
  const records = s.management ?? [];
  const inspections = s.inspections
    .filter((i) => !i.archived && i.aircraftUuid === a.uuid)
    .map((i) => inspectionItem(s, a, i, today));
  const limits = records.flatMap((r) =>
    componentLimitItems(records, r, a, today),
  );
  const ads = (s.airworthiness ?? [])
    .filter(
      (r) =>
        adAircraftUuid(s, r) === a.uuid &&
        !HIDDEN_AD_APPLICABILITY.includes(r.applicability),
    )
    .map((r) => adItem(s, r, today));
  return [...inspections, ...limits, ...ads].sort(
    (x, y) => DUE_STATUS_RANK[x.status] - DUE_STATUS_RANK[y.status],
  );
}

/**
 * How many due items are overdue and due soon, for the owner's status slot.
 *
 * @param items - From {@link ownerDueItems}.
 * @returns The two counts.
 */
export function ownerDueCounts(items: DueItem[]) {
  return {
    overdue: items.filter((i) => i.status === "overdue").length,
    dueSoon: items.filter((i) => i.status === "due-soon").length,
  };
}

const joinRemaining = (parts: (string | false | undefined)[]) =>
  parts.filter(Boolean).join(" · ") || "Not set";

function inspectionItem(
  s: Snapshot,
  a: Aircraft,
  i: Inspection,
  today: string,
): DueItem {
  const item = {
    uuid: i.uuid,
    kind: "Inspection" as const,
    label: i.reference || i.description,
  };
  const counters = countersUnlessMissing(i, a, s.management, today);
  if (!counters) return { ...item, ...NEEDS_REVIEW };
  const r = inspectionStatus(i, a, today, counters);
  return {
    ...item,
    status:
      r.status === "scheduled" ? "ok" : (r.status as Exclude<DueStatus, "ok">),
    remaining: joinRemaining([
      r.hoursRemaining !== undefined && `${r.hoursRemaining.toFixed(1)} h`,
      r.cyclesRemaining !== undefined && `${r.cyclesRemaining} cycles`,
      r.landingsRemaining !== undefined && `${r.landingsRemaining} landings`,
      r.daysRemaining !== undefined && `${r.daysRemaining} days`,
    ]),
  };
}

function countersUnlessMissing(
  i: Inspection,
  a: Aircraft,
  records: ManagedRecord[] | undefined,
  today: string,
) {
  try {
    return inspectionCounters(i, a, records, today);
  } catch (error) {
    // An inspection whose component is no longer on this aircraft is listed
    // for review, as a component limit is, rather than failing the whole list.
    if (error instanceof Rejection && error.message === MISSING_COMPONENT)
      return undefined;
    throw error;
  }
}

function componentLimitItems(
  records: ManagedRecord[],
  r: ManagedRecord,
  a: Aircraft,
  today: string,
): DueItem[] {
  if (r.kind !== "componentRequirement") return [];
  const c = records.find(
    (x) =>
      x.kind === "component" &&
      x.uuid === r.componentUuid &&
      x.aircraftUuid === a.uuid &&
      x.installed,
  );
  if (c?.kind !== "component") return [];
  const item = {
    uuid: r.uuid,
    kind: "Component" as const,
    label: `${c.componentType} S/N ${c.serial} · ${r.description}`,
  };
  try {
    const q = requirementStatus(r, c, a, today);
    const remaining = joinRemaining([
      q.seconds !== undefined && `${(q.seconds / HOUR_SECONDS).toFixed(1)} h`,
      q.cycles !== undefined && `${q.cycles} cycles`,
      q.landings !== undefined && `${q.landings} landings`,
      q.days !== undefined && `${q.days} days`,
    ]);
    return [{ ...item, status: componentDueStatus(q.status), remaining }];
  } catch {
    // Usage it cannot compute is listed for review, not hidden from the owner.
    return [{ ...item, ...NEEDS_REVIEW }];
  }
}

function componentDueStatus(status: string): DueStatus {
  if (status === "Past due" || status === "Due now") return "overdue";
  if (status === "Due soon") return "due-soon";
  return status === "Tracked" ? "ok" : "unknown";
}

function adItem(s: Snapshot, r: AD, today: string): DueItem {
  const remaining = r.tasks.flatMap((t) =>
    adRemaining(s, r, t, today).map((x) => `${x.label}: ${x.value}`),
  );
  return {
    uuid: r.uuid,
    kind: "AD",
    label: `AD ${r.source.number} · ${r.source.subject}`,
    status: adDueStatus(adStatus(s, r)),
    remaining: joinRemaining(remaining),
  };
}

function adDueStatus(status: string): DueStatus {
  if (status === "Overdue") return "overdue";
  if (status === "Due soon") return "due-soon";
  return AD_OK_STATUSES.includes(status) ? "ok" : "unknown";
}
