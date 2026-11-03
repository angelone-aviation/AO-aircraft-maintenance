import {
  requestMatchesSource,
  requestLineProgress,
  recurringRequestSource,
  type RequestSource,
} from "./partsRequests";
import { adTaskStatus, adAircraftUuid } from "./airworthiness";
import type { Snapshot } from "./model";
import type { RequiredPart } from "./requiredParts";
import { inspectionCounters } from "./management";
import { inspectionStatus } from "./maintenance";
import { requirementStatus } from "./components";

export interface PartsPlan {
  uuid: string;
  aircraftUuid: string;
  label: string;
  upcoming: boolean;
  parts: RequiredPart[];
}
export function maintenancePartsPlans(s: Snapshot): PartsPlan[] {
  const plans: PartsPlan[] = [];
  for (const i of s.inspections) {
    const a = s.aircraft.find((a) => a.uuid === i.aircraftUuid);
    const parts =
      requestedParts(s, {
        kind: "inspection",
        uuid: i.uuid,
        workOrderUuid: "",
      }) ?? i.requiredParts;
    if (!a || i.archived || !parts?.length) continue;
    const status = inspectionStatus(
      i,
      a,
      undefined,
      inspectionCounters(i, a, s.management),
    ).status;
    plans.push({
      uuid: i.uuid,
      aircraftUuid: a.uuid,
      label: i.reference,
      upcoming: status === "overdue" || status === "due-soon",
      parts,
    });
  }
  for (const d of s.discrepancies) {
    const parts =
      requestedParts(s, {
        kind: "discrepancy",
        uuid: d.uuid,
        workOrderUuid: "",
      }) ?? d.requiredParts;
    if (d.status === "open" && parts?.length)
      plans.push({
        uuid: d.uuid,
        aircraftUuid: d.aircraftUuid,
        label: d.description,
        upcoming: true,
        parts,
      });
  }
  for (const r of s.management ?? []) {
    if (r.kind !== "componentRequirement") continue;
    const parts =
      requestedParts(s, {
        kind: "componentRequirement",
        uuid: r.uuid,
        workOrderUuid: "",
      }) ?? r.requiredParts;
    if (!parts?.length) continue;
    const c = s.management?.find(
      (c) => c.kind === "component" && c.uuid === r.componentUuid,
    );
    if (!c || c.kind !== "component" || !c.installed) continue;
    const a = s.aircraft.find((a) => a.uuid === c.aircraftUuid);
    if (!a) continue;
    const status = requirementStatus(r, c, a).status;
    plans.push({
      uuid: r.uuid,
      aircraftUuid: a.uuid,
      label: `${c.componentType}: ${r.description}`,
      upcoming: ["Past due", "Due now", "Due soon"].includes(status),
      parts,
    });
  }
  for (const ad of s.airworthiness ?? []) {
    if (
      ad.reviewRequired ||
      !["Applicable", "Previously Complied With (PCW)"].includes(
        ad.applicability,
      )
    )
      continue;
    for (const task of ad.tasks) {
      const parts = requestedParts(s, {
        kind: "airworthiness",
        uuid: task.uuid,
        workOrderUuid: "",
      });
      const status = adTaskStatus(s, ad, task);
      if (!parts?.length || status === "Complied") continue;
      plans.push({
        uuid: task.uuid,
        aircraftUuid: adAircraftUuid(s, ad),
        label: `AD ${ad.source.number}: ${task.description}`,
        upcoming: [
          "Overdue",
          "Due soon",
          "Due not set",
          "Counter unavailable",
        ].includes(status),
        parts,
      });
    }
  }
  // Other work (manual tasks, job cards, component movements) also contributes demand.
  for (const r of s.partsRequests ?? []) {
    if (r.cancelled || r.recurring || r.mode !== "parts" || !r.aircraftUuid)
      continue;
    if (
      [
        "inspection",
        "discrepancy",
        "componentRequirement",
        "airworthiness",
      ].includes(r.source.kind)
    )
      continue;
    if (r.source.kind === "workTask") {
      const task = s.workOrders
        ?.find((w) => w.uuid === r.source.workOrderUuid)
        ?.tasks.find((t) => t.uuid === r.source.uuid);
      if (task && task.source.kind !== "manual") continue;
    }
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

/** Replaces legacy requirements once requests exist; never counts a template and its active occurrence twice. */
export function requestedParts(
  s: Snapshot,
  source: RequestSource,
): RequiredPart[] | undefined {
  const linked = (s.partsRequests ?? []).filter(
    (r) => r.mode === "parts" && requestMatchesSource(s, r, source),
  );
  if (!linked.length) return;
  const active = linked.filter(
    (r) =>
      !r.cancelled &&
      (r.source.kind !== "workTask" ||
        s.workOrders?.some(
          (w) =>
            w.uuid === r.source.workOrderUuid &&
            !["completed", "cancelled"].includes(w.status) &&
            w.tasks.some(
              (t) =>
                t.uuid === r.source.uuid &&
                !["completed", "cancelled"].includes(t.status),
            ),
        )),
  );
  return active
    .filter(
      (r) =>
        !r.recurring ||
        (recurringRequestSource(s, r.source) &&
          !linked.some(
            (instance) =>
              instance.templateUuid === r.uuid &&
              s.workOrders?.some(
                (w) =>
                  w.uuid === instance.source.workOrderUuid &&
                  !["completed", "cancelled"].includes(w.status),
              ),
          )),
    )
    .flatMap((r) =>
      r.lines.map((line) => {
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
      }),
    )
    .filter((p) => p.quantity > 0);
}
