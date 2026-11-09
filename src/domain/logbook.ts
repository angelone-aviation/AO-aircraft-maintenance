/**
 * Responsibility: The logbook entry text generated from a work order, and the
 *   signer and template choices it is built from.
 * Layer: Domain. Pure zod schema and functions; no I/O, no React.
 * Dependencies: zod, src/domain/model.ts and workOrders.ts (types),
 *   workOrderCloseout.ts, rejection.ts.
 *
 * The text is unsigned (ADR-0004): a mechanic copies it into the aircraft
 * logbook and signs it there. A closed order reads its frozen close-out, so
 * the entry stays the same when the aircraft or job cards change later.
 */
import { z } from "zod";
import type { Snapshot } from "./model";
import type { WorkOrder } from "./workOrders";
import {
  logbookPerformers,
  workPerformedText,
  type ComponentCloseoutPreview,
} from "./workOrderCloseout";
import { Rejection } from "./rejection";

const SECONDS_PER_HOUR = 3600;
const NOT_RECORDED = "Not recorded";
const SIGNER_FIELD_MAX_LENGTH = 100;

/**
 * The certificate type and license number a signer enters, trimmed.
 *
 * @throws {z.ZodError} From `parse()`: "Enter a license / certificate number
 *   of up to 100 characters." or "Enter a certificate type of up to 100
 *   characters."
 */
export const licenseSchema = z.object({
  licenseNumber: signerField("license / certificate number"),
  certificateType: signerField("certificate type"),
});

/** The entry templates, with the label each shows and titles the entry. */
export const logbookTemplates = {
  maintenance: "Maintenance / inspection",
  inspection: "Annual / 100-Hour inspection",
  component: "Component service / replacement",
  ad: "AD compliance",
} as const;

/** A key of {@link logbookTemplates}. */
export type LogbookTemplate = keyof typeof logbookTemplates;

/** The signer's choice for the component template's certification. */
export type ComponentEntry = { approvedForReturnToService: boolean };

/** A component entry with return to service not yet chosen. */
export const emptyComponentEntry: ComponentEntry = {
  approvedForReturnToService: false,
};

/** What the signer records for the inspection template (14 CFR 43.11). */
export type InspectionEntry = {
  type: "annual" | "100-hour";
  checklist: string;
  reviewedThrough: string;
  airworthy: boolean;
};

/** An annual inspection entry with nothing recorded yet. */
export const emptyInspectionEntry: InspectionEntry = {
  type: "annual",
  checklist: "",
  reviewedThrough: "",
  airworthy: false,
};

/**
 * Tells whether an inspection entry can be used.
 *
 * @param entry - The inspection entry.
 * @returns True once the checklist and review date are filled in (not just
 *   spaces) and the aircraft is found airworthy.
 */
export const inspectionEntryReady = (entry: InspectionEntry) =>
  Boolean(
    entry.checklist.trim() && entry.reviewedThrough.trim() && entry.airworthy,
  );

type Signer = {
  userId?: string;
  name: string;
  licenseNumber: string;
  certificateType: string;
};

/**
 * Generates the logbook entry text for a work order.
 *
 * @param s - The snapshot.
 * @param order - The work order.
 * @param template - Which entry to write.
 * @param signer - Who certifies it; left out of "Performed by" by user id,
 *   else by name (ignoring case and outer spaces).
 * @param inspection - The inspection template's choices.
 * @param component - The component template's choice.
 * @param preview - True to draft from an open order's current job cards.
 * @returns The entry's lines, each ending in "\n".
 * @throws {Rejection} "Complete the work order before generating a logbook
 *   entry." for an open order unless `preview`.
 */
export function logbookText(
  s: Snapshot,
  order: WorkOrder,
  template: LogbookTemplate,
  signer: Signer,
  inspection: InspectionEntry = emptyInspectionEntry,
  component: ComponentEntry = emptyComponentEntry,
  preview = false,
) {
  if (!preview && order.status !== "completed")
    throw new Rejection(
      "Complete the work order before generating a logbook entry.",
    );
  return entryText(s, order, {
    template,
    signer,
    inspection,
    component,
    preview,
    closing: null,
  });
}

/**
 * The maintenance entry the work order form previews: drafted from the
 * order's current job cards, as {@link logbookText} in preview mode.
 *
 * @param order - The order as the form would save it.
 * @param signer - Who would certify it.
 * @param closing - What completing the order would write about its
 *   components: these replace the opening readings, and the work lines follow
 *   the wording (or precede its prompt). Null keeps the opening readings.
 * @returns The entry's lines, joined by "\n".
 */
export function logbookSampleText(
  s: Snapshot,
  order: WorkOrder,
  signer: Signer,
  closing: ComponentCloseoutPreview | null,
) {
  return entryText(s, order, {
    template: "maintenance",
    signer,
    inspection: emptyInspectionEntry,
    component: emptyComponentEntry,
    preview: true,
    closing,
  });
}

/**
 * The frozen entry of a completed work order for a records copy: the
 * maintenance entry as {@link logbookText} writes it, naming everyone who
 * performed the work, without the certification and signature lines. The
 * signed page in the aircraft logbook is the record (ADR-0004); this is the
 * text generated for it.
 *
 * @param s - The snapshot.
 * @param order - The work order.
 * @returns The entry's lines, joined by "\n".
 * @throws {Rejection} "Complete the work order before generating a logbook
 *   entry." for an order that is not completed.
 */
export function logbookRecordText(s: Snapshot, order: WorkOrder) {
  if (order.status !== "completed")
    throw new Rejection(
      "Complete the work order before generating a logbook entry.",
    );
  return entryText(s, order, {
    template: "maintenance",
    signer: null,
    inspection: emptyInspectionEntry,
    component: emptyComponentEntry,
    preview: false,
    closing: null,
  });
}

type Entry = {
  template: LogbookTemplate;
  /** Who certifies the entry; null for an unsigned records copy. */
  signer: Signer | null;
  inspection: InspectionEntry;
  component: ComponentEntry;
  preview: boolean;
  closing: ComponentCloseoutPreview | null;
};

function entryText(s: Snapshot, order: WorkOrder, entry: Entry) {
  const { template, signer, inspection, component, preview, closing } = entry;
  const closingLines = signer
    ? [
        ...certify(template, inspection, component),
        ...sign(s, order, template, signer, preview),
      ]
    : performedBy(performerNames(s, order, preview));
  return [
    ...describeHeading(order, template, preview),
    ...(template === "inspection" ? [describeInspection(inspection), ""] : []),
    template === "ad" ? "Work and compliance references:" : "Work performed:",
    order.revisedWorkPerformed ??
      order.closeout?.workPerformed ??
      draftWork(s, order, preview, closing?.workLines ?? []),
    ...describeComponents(order, preview, closing?.components),
    ...describeCompliance(order.closeout?.compliance ?? []),
    "",
    ...describeCorrections(order),
    order.releaseOutcome,
    "",
    ...closingLines,
  ].join("\n");
}

function describeHeading(
  order: WorkOrder,
  template: LogbookTemplate,
  preview: boolean,
) {
  const a = order.closeout?.aircraft ?? order.aircraft;
  const dated = template === "inspection" || template === "component";
  const revision = order.revisions?.at(-1);
  return [
    `${logbookTemplates[template]} logbook entry`,
    dated
      ? `Date: ${toUsDate(order.completionDate)}`
      : `Date completed: ${order.completionDate}`,
    ...(dated
      ? [`Aircraft Total Time: ${formatHours(a.totalSeconds)} Hours`]
      : []),
    `Aircraft: ${a.registration} — ${a.make} ${a.model}; S/N ${a.serial || NOT_RECORDED}`,
    `Aircraft total time: ${hours(a.totalSeconds)}; Hobbs: ${hours(a.hobbs)}; Tach: ${hours(a.tach)}; Cycles: ${a.cycles}${a.landings === undefined ? "" : `; Landings: ${a.landings}`}`,
    ...(a.flightTimeLog === undefined
      ? []
      : [`Flight time log: ${hours(a.flightTimeLog)}`]),
    ...(a.cyclicHobbs === undefined
      ? []
      : [`Collective hourmeter: ${hours(a.cyclicHobbs)}`]),
    `Work order: ${order.number}`,
    ...(revision
      ? [
          `Revision ${order.revisions!.length} — ${new Date(revision.recordedAt).toISOString()} — ${revision.authorName}`,
          `Correction reason: ${revision.reason}`,
        ]
      : []),
    ...(!preview && !order.closeout
      ? [
          "Historical work order: the readings above were recorded when the order opened. Confirm completion readings before signing.",
        ]
      : []),
    "",
  ];
}

// 14 CFR 43.11(a)(1): the inspection's type and scope, Part 43 Appendix D.
function describeInspection(inspection: InspectionEntry) {
  const annual = inspection.type === "annual";
  return `Completed ${annual ? "an" : "a"} ${annual ? "Annual" : "100-Hour"} inspection of this aircraft in accordance with the scope and detail of 14 CFR Part 43, Appendix D, and ${inspection.checklist.trim() || "[manufacturer's inspection checklist]"}. Service Bulletins and Airworthiness Directives checked through ${inspection.reviewedThrough.trim() || "[review date / bi-weekly issue]"}.`;
}

// The close-out writes its component work lines after the wording; without
// wording, the prompt stays below them.
function draftWork(
  s: Snapshot,
  order: WorkOrder,
  preview: boolean,
  workLines: string[],
) {
  const wording = workPerformedText(s, order, preview);
  const parts = wording
    ? [wording, ...workLines]
    : [
        ...workLines,
        "[Select Include in log book entry on a task or job card to see its wording here.]",
      ];
  return parts.join("\n\n");
}

// Without a close-out, the components' readings are those taken when the order
// opened, and a finished entry says so.
function describeComponents(
  order: WorkOrder,
  preview: boolean,
  closing?: ComponentCloseoutPreview["components"],
) {
  const components =
    order.closeout?.components ??
    closing ??
    order.componentReadings.map((c) => ({
      ...c,
      label: preview ? c.label : `${c.label} (opening readings)`,
      manufacturer: "",
      model: "",
      serviceDays: null,
    }));
  return components.flatMap((c) => [
    "",
    `Component: ${[c.label, [c.manufacturer, c.model].filter(Boolean).join(" ")].filter(Boolean).join(" — ")}`,
    `P/N ${c.partNumber || NOT_RECORDED}; S/N ${c.serial || NOT_RECORDED}`,
    `TSN: ${hours(c.timeSinceNew)}; TSO: ${hours(c.timeSinceOverhaul)}; TSR: ${hours(c.timeSinceRepair)}; Cycles: ${c.cyclesSinceNew ?? "Not tracked"}${c.serviceDays === null ? "" : `; Service days: ${c.serviceDays}`}`,
  ]);
}

type Compliance = NonNullable<WorkOrder["closeout"]>["compliance"][number];

function describeCompliance(compliance: Compliance[]) {
  if (!compliance.length) return [];
  return [
    "",
    "Inspection compliance recorded:",
    ...compliance.map(
      (c) =>
        `${c.description}: ${c.date}${c.seconds === undefined ? "" : ` at ${hoursOn(c.seconds, c.timeBasis)}`}${c.cycles === undefined ? "" : `, ${c.cycles} cycles`}${c.landings === undefined ? "" : `, ${c.landings} aircraft landings`}. Next due: ${describeNextDue(c)}.`,
    ),
  ];
}

function describeNextDue(c: Compliance) {
  const limits = [
    c.dueDate,
    c.dueSeconds === undefined ? "" : hoursOn(c.dueSeconds, c.timeBasis),
    c.dueCycles === undefined ? "" : `${c.dueCycles} cycles`,
    c.dueLandings === undefined ? "" : `${c.dueLandings} aircraft landings`,
  ];
  return limits.filter(Boolean).join(" / ") || "No recurring interval";
}

// Corrections are appended as addenda, never edited into the entry.
function describeCorrections(order: WorkOrder) {
  if (!order.componentCorrections?.length) return [];
  return [
    "COMPONENT TRACKING CORRECTIONS — review original entry and addenda:",
    ...order.componentCorrections.map((c) => c.addendum),
    "",
  ];
}

function certify(
  template: LogbookTemplate,
  inspection: InspectionEntry,
  component: ComponentEntry,
) {
  if (template === "inspection")
    return [
      inspection.airworthy
        ? `I certify that this aircraft has been inspected in accordance with ${inspection.type === "annual" ? "an" : "a"} ${inspection.type} inspection and was determined to be in airworthy condition.`
        : "[Select the airworthy finding before using this certification template.]",
      "",
    ];
  if (template === "component")
    return [
      component.approvedForReturnToService
        ? "The work performed on the aircraft component part identified above has been performed satisfactorily. The aircraft is approved for return to service only for the work performed."
        : "[Select the return-to-service outcome before using this certification template.]",
      "",
    ];
  return [];
}

// 43.9(a)(3): name who performed the work when it is not the approver.
// Closed orders use the performers frozen at close-out; orders closed
// before they were recorded keep their entry without the line.
function sign(
  s: Snapshot,
  order: WorkOrder,
  template: LogbookTemplate,
  signer: Signer,
  preview: boolean,
) {
  const approver = signer.name.trim().toLowerCase();
  const performers = performerNames(s, order, preview, (p) =>
    signer.userId
      ? p.userId !== signer.userId
      : p.name.trim().toLowerCase() !== approver,
  );
  return [
    ...performedBy(performers),
    `${template === "component" ? "Name" : "Certifying person"}: ${signer.name}`,
    `Certificate / license: ${signer.certificateType || "[enter certificate type]"} ${signer.licenseNumber || "[enter license number]"}`,
    "Signature: ______________________________",
    "",
  ];
}

type Performer = { userId?: string; name: string };

function performerNames(
  s: Snapshot,
  order: WorkOrder,
  preview: boolean,
  keep: (p: Performer) => boolean = () => true,
): string[] {
  const performers: Performer[] = preview
    ? logbookPerformers(s, order, true)
    : (order.closeout?.performers ?? []);
  return performers.filter(keep).map((p) => p.name);
}

function performedBy(performers: string[]): string[] {
  return performers.length ? [`Performed by: ${performers.join(", ")}`] : [];
}

function toUsDate(isoDate: string) {
  return isoDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1");
}

function formatHours(seconds: number) {
  return (seconds / SECONDS_PER_HOUR).toFixed(1);
}

function hours(seconds: number | null) {
  return seconds === null ? NOT_RECORDED : `${formatHours(seconds)} h`;
}

function hoursOn(seconds: number, timeBasis: string | undefined) {
  return `${hours(seconds)}${timeBasis ? ` ${timeBasis}` : ""}`;
}

function signerField(name: string) {
  const message = `Enter a ${name} of up to ${SIGNER_FIELD_MAX_LENGTH} characters.`;
  return z
    .string()
    .trim()
    .min(1, message)
    .max(SIGNER_FIELD_MAX_LENGTH, message);
}
