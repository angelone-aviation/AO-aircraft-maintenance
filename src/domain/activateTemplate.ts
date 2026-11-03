import { taskSourceText, taskApplicabilityText } from "./inspectionTemplates";
import { z } from "zod";
import { can, type Snapshot } from "./model";
import { ownsActive } from "./programs";
import { matchesAircraft, matchesComponent } from "./manualDiscovery";
import { applyManagement } from "./management";
import { saveTaskCard, taskCardDefaults } from "./taskCards";
import type { InspectionTemplate } from "./inspectionTemplates";
const count = z.number().int().nonnegative();
export const activateTemplateSchema = z.strictObject({
  usageMeter: z.enum(["aircraft", "collective"]).optional(),
  templateUuid: z.string().uuid(),
  templateVersion: count,
  targetUuid: z.string().min(1),
  mode: z.enum(["initial", "recurring"]),
  description: z.string().trim().min(1).max(2000),
  lastSeconds: count.optional(),
  lastCycles: count.optional(),
  lastLandings: count.optional(),
  lastDate: z.iso.date().optional(),
  reviewed: z.literal(true),
});
export type ActivateTemplateInput = z.infer<typeof activateTemplateSchema>;
export function templateActivationIssue(t: InspectionTemplate) {
  if (
    t.applicability.kind === "aircraft" &&
    t.calendarValue &&
    t.calendarUnit === "DAYS"
  )
    return "Aircraft inspection schedules currently support months or years, not recurring days. Keep this template until a day-based schedule is available.";
  if (t.applicability.kind === "aircraft" && t.hours && t.timeBasis !== "TSN")
    return "Aircraft inspections use aircraft total time. Use a component-model template for TSO or TSR limits.";
  return "";
}
export function activateTemplate(s: Snapshot, raw: ActivateTemplateInput) {
  const input = activateTemplateSchema.parse(raw);
  const t = s.inspectionTemplates?.find((t) => t.uuid === input.templateUuid);
  if (!t || !ownsActive(s, t.programUuid))
    throw new Error("Template is unavailable in this Flight Program.");
  if (t.archived || t.version !== input.templateVersion)
    throw new Error(
      "Template changed or was archived. Reopen it before creating a schedule.",
    );
  const issue = templateActivationIssue(t);
  if (issue) throw new Error(issue);
  const component =
    t.applicability.kind === "component"
      ? s.management?.find(
          (c) => c.kind === "component" && c.uuid === input.targetUuid,
        )
      : undefined;
  if (
    t.applicability.kind === "component" &&
    (!component ||
      component.kind !== "component" ||
      !component.installed ||
      !component.aircraftUuid ||
      !matchesComponent(component, t.applicability))
  )
    throw new Error("Choose an installed component of the template model.");
  const aircraftUuid =
    component && component.kind === "component"
      ? component.aircraftUuid
      : input.targetUuid;
  const aircraft = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (
    !aircraft ||
    !can(s, aircraftUuid, "maintenance") ||
    (t.applicability.kind === "aircraft" &&
      !matchesAircraft(aircraft, t.applicability))
  )
    throw new Error("Choose a matching aircraft with maintenance access.");
  const initial = input.mode === "initial";
  const h = initial ? t.initialHours : t.hours,
    cycles = initial ? t.initialCycles : t.cycles,
    landings = initial ? t.initialLandings : t.landings,
    calendar = initial ? undefined : t.calendarValue;
  if (
    h === undefined &&
    cycles === undefined &&
    landings === undefined &&
    calendar === undefined
  )
    throw new Error(
      "This schedule has no numeric limits. Add verified intervals to the template first.",
    );
  const sourceKey = `template:${t.uuid}:${input.mode}`;
  if (
    s.inspections.some(
      (i) => i.sourceKey === sourceKey && i.aircraftUuid === aircraftUuid,
    ) ||
    s.management?.some(
      (r) =>
        r.kind === "componentRequirement" &&
        r.sourceKey === sourceKey &&
        r.componentUuid === input.targetUuid,
    )
  )
    throw new Error(
      "This template schedule already exists for the selected target. Open the existing record to edit it.",
    );
  const nextState = structuredClone(s);
  const uuid = crypto.randomUUID();
  const common = {
    uuid,
    version: 0,
    sourceKey,
    aircraftUuid,
    manualReference: t.manualReference,
    lastSeconds: input.lastSeconds,
    lastCycles: input.lastCycles,
    lastLandings: input.lastLandings,
    lastDate: input.lastDate,
  };
  const absoluteHours = initial || t.hourMode === "ABSOLUTE",
    absoluteCycles = initial || t.cycleMode === "ABSOLUTE",
    absoluteLandings = initial || t.landingMode === "ABSOLUTE";
  const command = component
    ? {
        action: "record.save" as const,
        requestUuid: crypto.randomUUID(),
        reason: `Created from template ${t.name}, version ${t.version}.`,
        record: {
          ...common,
          kind: "componentRequirement" as const,
          componentUuid: component.uuid,
          requirementType: t.requirementType,
          description: t.name,
          notes: [input.description, t.conditions].filter(Boolean).join("\n\n"),
          intervalSeconds: h === undefined ? undefined : Math.round(h * 3600),
          intervalCycles: cycles,
          intervalLandings: landings,
          landingLimitMode: absoluteLandings
            ? ("ABSOLUTE" as const)
            : ("FROM_LAST_COMPLIED" as const),
          calendarIntervalValue: calendar,
          calendarIntervalUnit: t.calendarUnit,
          timeBasis: t.timeBasis,
          timeLimitMode: absoluteHours
            ? ("ABSOLUTE" as const)
            : ("FROM_LAST_COMPLIED" as const),
          cycleLimitMode: absoluteCycles
            ? ("ABSOLUTE" as const)
            : ("FROM_LAST_COMPLIED" as const),
          warningCalendarMonths: 1,
          warningSeconds: 36000,
          warningCycles: 10,
        },
      }
    : {
        action: "inspection.save" as const,
        requestUuid: crypto.randomUUID(),
        reason: `Created from template ${t.name}, version ${t.version}.`,
        record: {
          ...common,
          usageMeter: input.usageMeter,
          reference: t.name,
          description: input.description,
          materials: "",
          archived: false,
          intervalSeconds:
            absoluteHours || h === undefined ? undefined : Math.round(h * 3600),
          intervalCycles: absoluteCycles ? undefined : cycles,
          intervalLandings: absoluteLandings ? undefined : landings,
          dueLandings: absoluteLandings ? landings : undefined,
          intervalMonths:
            calendar === undefined
              ? undefined
              : calendar * (t.calendarUnit === "YEARS" ? 12 : 1),
          dueSeconds:
            absoluteHours && h !== undefined ? Math.round(h * 3600) : undefined,
          dueCycles: absoluteCycles ? cycles : undefined,
        },
      };
  const result = applyManagement(nextState, command);
  const tasks = t.tasks.map((task, index) =>
    saveTaskCard(nextState, {
      action: "save",
      uuid: crypto.randomUUID(),
      version: 0,
      fields: {
        ...taskCardDefaults(aircraftUuid),
        sourceKey: `${sourceKey}:task:${index}`,
        title: `${t.name} — ${task.itemCode || index + 1}`,
        cardNumber: "",
        description: task.instruction,
        itemCode: task.itemCode,
        applicability: taskApplicabilityText(task),
        maintenanceReference: taskSourceText(task),
        manualReference: task.manualReference,
        inspectionUuid: component ? "" : uuid,
        componentUuid: component?.uuid ?? "",
        requirementUuid: component ? uuid : "",
        steps: [],
      },
    }),
  );
  s.inspections = nextState.inspections;
  s.management = nextState.management;
  s.taskCards = nextState.taskCards;
  s.audit = nextState.audit;
  return { record: result.next, tasks, aircraftUuid };
}
