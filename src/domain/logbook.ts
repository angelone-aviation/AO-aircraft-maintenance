import { z } from "zod";
import type { Snapshot } from "./model";
import type { WorkOrder } from "./workOrders";
import { logbookPerformers, workPerformedText } from "./workOrderCloseout";
export const licenseSchema = z.object({
  licenseNumber: z.string().trim().min(1).max(100),
  certificateType: z.string().trim().min(1).max(100),
});
export const logbookTemplates = {
  maintenance: "Maintenance / inspection",
  inspection: "Annual / 100-Hour inspection",
  component: "Component service / replacement",
  ad: "AD compliance",
} as const;
export type LogbookTemplate = keyof typeof logbookTemplates;
export type ComponentEntry = { approvedForReturnToService: boolean };
export const emptyComponentEntry: ComponentEntry = {
  approvedForReturnToService: false,
};
export type InspectionEntry = {
  type: "annual" | "100-hour";
  checklist: string;
  reviewedThrough: string;
  airworthy: boolean;
};
export const emptyInspectionEntry: InspectionEntry = {
  type: "annual",
  checklist: "",
  reviewedThrough: "",
  airworthy: false,
};
export const inspectionEntryReady = (entry: InspectionEntry) =>
  Boolean(
    entry.checklist.trim() && entry.reviewedThrough.trim() && entry.airworthy,
  );
const hours = (seconds: number | null) =>
  seconds === null ? "Not recorded" : `${(seconds / 3600).toFixed(1)} h`;
export function logbookText(
  s: Snapshot,
  order: WorkOrder,
  template: LogbookTemplate,
  signer: {
    userId?: string;
    name: string;
    licenseNumber: string;
    certificateType: string;
  },
  inspection: InspectionEntry = emptyInspectionEntry,
  component: ComponentEntry = emptyComponentEntry,
  preview = false,
) {
  if (!preview && order.status !== "completed")
    throw new Error(
      "Complete the work order before generating a logbook entry.",
    );
  const final = order.closeout;
  // 43.9(a)(3): name who performed the work when it is not the approver.
  // Closed orders use the performers frozen at close-out; orders closed
  // before they were recorded keep their entry without the line.
  const approver = signer.name.trim().toLowerCase();
  const performers = (
    preview ? logbookPerformers(s, order, true) : (final?.performers ?? [])
  )
    .filter((p) =>
      signer.userId
        ? p.userId !== signer.userId
        : p.name.trim().toLowerCase() !== approver,
    )
    .map((p) => p.name);
  const a = final?.aircraft ?? order.aircraft;
  const components =
    final?.components ??
    order.componentReadings.map((c) => ({
      ...c,
      label: preview ? c.label : `${c.label} (opening readings)`,
      manufacturer: "",
      model: "",
      serviceDays: null,
    }));
  const lines = [
    `${logbookTemplates[template]} logbook entry`,
    template === "inspection" || template === "component"
      ? `Date: ${order.completionDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1")}`
      : `Date completed: ${order.completionDate}`,
    ...(template === "inspection" || template === "component"
      ? [`Aircraft Total Time: ${(a.totalSeconds / 3600).toFixed(1)} Hours`]
      : []),
    `Aircraft: ${a.registration} — ${a.make} ${a.model}; S/N ${a.serial || "Not recorded"}`,
    `Aircraft total time: ${hours(a.totalSeconds)}; Hobbs: ${hours(a.hobbs)}; Tach: ${hours(a.tach)}; Cycles: ${a.cycles}${a.landings === undefined ? "" : `; Landings: ${a.landings}`}`,
    ...(a.flightTimeLog !== undefined
      ? [`Flight time log: ${hours(a.flightTimeLog)}`]
      : []),
    ...(a.cyclicHobbs !== undefined
      ? [`Collective hourmeter: ${hours(a.cyclicHobbs)}`]
      : []),
    `Work order: ${order.number}`,
    ...(order.revisions?.length
      ? [
          `Revision ${order.revisions.length} — ${new Date(order.revisions.at(-1)!.recordedAt).toISOString()} — ${order.revisions.at(-1)!.authorName}`,
          `Correction reason: ${order.revisions.at(-1)!.reason}`,
        ]
      : []),
    !preview &&
      !final &&
      "Historical work order: the readings above were recorded when the order opened. Confirm completion readings before signing.",
    "",
    ...(template === "inspection"
      ? [
          `Completed ${inspection.type === "annual" ? "an" : "a"} ${inspection.type === "annual" ? "Annual" : "100-Hour"} inspection of this aircraft in accordance with the scope and detail of 14 CFR Part 43, Appendix D, and ${inspection.checklist.trim() || "[manufacturer's inspection checklist]"}. Service Bulletins and Airworthiness Directives checked through ${inspection.reviewedThrough.trim() || "[review date / bi-weekly issue]"}.`,
          "",
        ]
      : []),
    template === "ad" ? "Work and compliance references:" : "Work performed:",
    order.revisedWorkPerformed ??
      final?.workPerformed ??
      (workPerformedText(s, order, preview) ||
        "[Select Include in log book entry on a task or job card to see its wording here.]"),
    ...components.flatMap((c) => [
      "",
      `Component: ${[c.label, [c.manufacturer, c.model].filter(Boolean).join(" ")].filter(Boolean).join(" — ")}`,
      `P/N ${c.partNumber || "Not recorded"}; S/N ${c.serial || "Not recorded"}`,
      `TSN: ${hours(c.timeSinceNew)}; TSO: ${hours(c.timeSinceOverhaul)}; TSR: ${hours(c.timeSinceRepair)}; Cycles: ${c.cyclesSinceNew ?? "Not tracked"}${c.serviceDays === null ? "" : `; Service days: ${c.serviceDays}`}`,
    ]),
    ...(final?.compliance.length
      ? [
          "",
          "Inspection compliance recorded:",
          ...final.compliance.map(
            (c) =>
              `${c.description}: ${c.date}${c.seconds === undefined ? "" : ` at ${hours(c.seconds)}${c.timeBasis ? ` ${c.timeBasis}` : ""}`}${c.cycles === undefined ? "" : `, ${c.cycles} cycles`}${c.landings === undefined ? "" : `, ${c.landings} aircraft landings`}. Next due: ${[c.dueDate, c.dueSeconds === undefined ? "" : `${hours(c.dueSeconds)}${c.timeBasis ? ` ${c.timeBasis}` : ""}`, c.dueCycles === undefined ? "" : `${c.dueCycles} cycles`, c.dueLandings === undefined ? "" : `${c.dueLandings} aircraft landings`].filter(Boolean).join(" / ") || "No recurring interval"}.`,
          ),
        ]
      : []),
    "",
    ...(order.componentCorrections?.length
      ? [
          "COMPONENT TRACKING CORRECTIONS — review original entry and addenda:",
          ...order.componentCorrections.map((c) => c.addendum),
          "",
        ]
      : []),
    order.releaseOutcome,
    "",
    ...(template === "inspection"
      ? [
          inspection.airworthy
            ? `I certify that this aircraft has been inspected in accordance with ${inspection.type === "annual" ? "an" : "a"} ${inspection.type} inspection and was determined to be in airworthy condition.`
            : "[Select the airworthy finding before using this certification template.]",
          "",
        ]
      : []),
    ...(template === "component"
      ? [
          component.approvedForReturnToService
            ? "The work performed on the aircraft component part identified above has been performed satisfactorily. The aircraft is approved for return to service only for the work performed."
            : "[Select the return-to-service outcome before using this certification template.]",
          "",
        ]
      : []),
    ...(performers.length ? [`Performed by: ${performers.join(", ")}`] : []),
    `${template === "component" ? "Name" : "Certifying person"}: ${signer.name}`,
    `Certificate / license: ${signer.certificateType || "[enter certificate type]"} ${signer.licenseNumber || "[enter license number]"}`,
    "Signature: ______________________________",
    "",
  ];
  return lines
    .filter((line) => line !== false && line !== undefined)
    .join("\n");
}
