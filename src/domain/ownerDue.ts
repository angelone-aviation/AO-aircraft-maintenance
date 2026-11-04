/**
 * Responsibility: What is next due on one aircraft, for its owner:
 *   inspections, component limits and ADs, each with a status and what remains.
 * Layer: Domain. Pure functions; no I/O, no React (a `today` left to its
 *   default reads the clock).
 * Dependencies: ./model, ./dueItems, ./adRemaining, ./rejection.
 */
import type { Aircraft, Snapshot } from "./model";
import { localDate } from "./model";
import { adRemaining } from "./adRemaining";
import {
  dueItems,
  type AdDue,
  type DueLevel,
  type InspectionDue,
  type MaintenanceDue,
  type RequirementDue,
} from "./dueItems";
import { Rejection } from "./rejection";

/** How pressing a due item is; `unknown` when it cannot be worked out. */
export type DueStatus = DueLevel;

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

/**
 * The next-due items for one aircraft, worst first, from the same status
 * rules the maintenance screens use.
 *
 * @param s - The snapshot.
 * @param a - The aircraft, as the snapshot holds it.
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
  return dueItems(s, a.uuid, today)
    .filter(isShownToOwner)
    .map((item) => ownerRow(s, item, today))
    .sort((x, y) => DUE_STATUS_RANK[x.status] - DUE_STATUS_RANK[y.status]);
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

function isShownToOwner(item: MaintenanceDue) {
  return (
    item.kind !== "ad" ||
    !HIDDEN_AD_APPLICABILITY.includes(item.ad.applicability)
  );
}

function ownerRow(s: Snapshot, item: MaintenanceDue, today: string) {
  if (item.kind === "inspection") return inspectionRow(item);
  if (item.kind === "componentRequirement") return limitRow(item);
  return adRow(s, item, today);
}

function inspectionRow(item: InspectionDue): DueItem {
  const { inspection: i } = item;
  const row = {
    uuid: i.uuid,
    kind: "Inspection" as const,
    label: i.reference || i.description,
  };
  if (!item.due) return { ...row, ...reviewIfMissing(item.error) };
  const r = item.due;
  return {
    ...row,
    status: item.level,
    remaining: joinRemaining([
      r.hoursRemaining !== undefined && `${r.hoursRemaining.toFixed(1)} h`,
      r.cyclesRemaining !== undefined && `${r.cyclesRemaining} cycles`,
      r.landingsRemaining !== undefined && `${r.landingsRemaining} landings`,
      r.daysRemaining !== undefined && `${r.daysRemaining} days`,
    ]),
  };
}

// An inspection whose component is no longer on this aircraft is listed for
// review, as a component limit is, rather than failing the whole list.
function reviewIfMissing(error: unknown) {
  if (error instanceof Rejection && error.message === MISSING_COMPONENT)
    return NEEDS_REVIEW;
  throw error;
}

function limitRow(item: RequirementDue): DueItem {
  const { requirement: r, component: c } = item;
  const row = {
    uuid: r.uuid,
    kind: "Component" as const,
    label: `${c.componentType} S/N ${c.serial} · ${r.description}`,
  };
  // Usage it cannot compute is listed for review, not hidden from the owner.
  if (!item.due) return { ...row, ...NEEDS_REVIEW };
  const q = item.due;
  return {
    ...row,
    status: item.level,
    remaining: joinRemaining([
      q.seconds !== undefined && `${(q.seconds / HOUR_SECONDS).toFixed(1)} h`,
      q.cycles !== undefined && `${q.cycles} cycles`,
      q.landings !== undefined && `${q.landings} landings`,
      q.days !== undefined && `${q.days} days`,
    ]),
  };
}

function adRow(s: Snapshot, item: AdDue, today: string): DueItem {
  const r = item.ad;
  const remaining = r.tasks.flatMap((t) =>
    adRemaining(s, r, t, today).map((x) => `${x.label}: ${x.value}`),
  );
  return {
    uuid: r.uuid,
    kind: "AD",
    label: `AD ${r.source.number} · ${r.source.subject}`,
    status: item.level,
    remaining: joinRemaining(remaining),
  };
}
