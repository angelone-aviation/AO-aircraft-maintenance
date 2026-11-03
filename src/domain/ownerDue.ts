import type { Aircraft, Snapshot } from "./model";
import { localDate } from "./model";
import { adAircraftUuid } from "./adOwnership";
import { adStatus } from "./airworthiness";
import { adRemaining } from "./adRemaining";
import { inspectionStatus } from "./maintenance";
import { inspectionCounters } from "./management";
import { requirementStatus } from "./components";

export type DueStatus = "overdue" | "due-soon" | "ok" | "unknown";
export interface DueItem {
  uuid: string;
  kind: "Inspection" | "Component" | "AD";
  label: string;
  status: DueStatus;
  remaining: string;
}
const rank: Record<DueStatus, number> = {
  overdue: 0,
  "due-soon": 1,
  unknown: 2,
  ok: 3,
};
const join = (parts: (string | false | undefined)[]) =>
  parts.filter(Boolean).join(" · ") || "Not set";

/** Next-due inspections, component limits and ADs for one aircraft, worst
 * first, using the existing status functions. */
export function ownerDueItems(
  s: Snapshot,
  a: Aircraft,
  today = localDate(),
): DueItem[] {
  const inspections = s.inspections
    .filter((i) => !i.archived && i.aircraftUuid === a.uuid)
    .map((i): DueItem => {
      const r = inspectionStatus(
        i,
        a,
        today,
        inspectionCounters(i, a, s.management),
      );
      return {
        uuid: i.uuid,
        kind: "Inspection",
        label: i.reference || i.description,
        status:
          r.status === "scheduled"
            ? "ok"
            : (r.status as Exclude<DueStatus, "ok">),
        remaining: join([
          r.hoursRemaining !== undefined && `${r.hoursRemaining.toFixed(1)} h`,
          r.cyclesRemaining !== undefined && `${r.cyclesRemaining} cycles`,
          r.landingsRemaining !== undefined &&
            `${r.landingsRemaining} landings`,
          r.daysRemaining !== undefined && `${r.daysRemaining} days`,
        ]),
      };
    });
  const limits = (s.management ?? []).flatMap((r): DueItem[] => {
    if (r.kind !== "componentRequirement") return [];
    const c = s.management!.find(
      (x) =>
        x.kind === "component" &&
        x.uuid === r.componentUuid &&
        x.aircraftUuid === a.uuid &&
        x.installed,
    );
    if (c?.kind !== "component") return [];
    const label = `${c.componentType} S/N ${c.serial} · ${r.description}`;
    try {
      const q = requirementStatus(r, c, a, today);
      return [
        {
          uuid: r.uuid,
          kind: "Component",
          label,
          status:
            q.status === "Past due" || q.status === "Due now"
              ? "overdue"
              : q.status === "Due soon"
                ? "due-soon"
                : q.status === "Tracked"
                  ? "ok"
                  : "unknown",
          remaining: join([
            q.seconds !== undefined && `${(q.seconds / 3600).toFixed(1)} h`,
            q.cycles !== undefined && `${q.cycles} cycles`,
            q.landings !== undefined && `${q.landings} landings`,
            q.days !== undefined && `${q.days} days`,
          ]),
        },
      ];
    } catch {
      return [
        {
          uuid: r.uuid,
          kind: "Component",
          label,
          status: "unknown",
          remaining: "Review",
        },
      ];
    }
  });
  const ads = (s.airworthiness ?? [])
    .filter(
      (r) =>
        adAircraftUuid(s, r) === a.uuid &&
        !["Not applicable", "Superseded"].includes(r.applicability),
    )
    .map((r): DueItem => {
      const status = adStatus(s, r);
      return {
        uuid: r.uuid,
        kind: "AD",
        label: `AD ${r.source.number} · ${r.source.subject}`,
        status:
          status === "Overdue"
            ? "overdue"
            : status === "Due soon"
              ? "due-soon"
              : [
                    "Scheduled",
                    "Complied",
                    "Previously Complied With (PCW)",
                  ].includes(status)
                ? "ok"
                : "unknown",
        remaining: join(
          r.tasks.flatMap((t) =>
            adRemaining(s, r, t, today).map((x) => `${x.label}: ${x.value}`),
          ),
        ),
      };
    });
  return [...inspections, ...limits, ...ads].sort(
    (x, y) => rank[x.status] - rank[y.status],
  );
}

/** Overdue / due-soon counts for the owner status slot. */
export function ownerDueCounts(items: DueItem[]) {
  return {
    overdue: items.filter((i) => i.status === "overdue").length,
    dueSoon: items.filter((i) => i.status === "due-soon").length,
  };
}
