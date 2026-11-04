/**
 * Responsibility: The form that creates an aircraft inspection or a component
 *   requirement from an inspection template, with a next-due preview.
 * Layer: UI. React component; the schedule saves through the workspace backend.
 * Dependencies: react, @tanstack/react-router, src/data/store.ts, src/domain
 *   (model, manualDiscovery, inspectionTemplates, activateTemplate,
 *   components), ./ui, ./ManagementShared, ./InspectionTemplates.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import { can, type Snapshot } from "../domain/model";
import { matchesAircraft, matchesComponent } from "../domain/manualDiscovery";
import type { InspectionTemplate } from "../domain/inspectionTemplates";
import {
  TEMPLATE_DESCRIPTION_MAX_LENGTH,
  templateActivationIssue,
  templateLimits,
  templateNextDue,
  templateScheduleExists,
  type ActivateTemplateInput,
} from "../domain/activateTemplate";
import type { Component } from "../domain/components";
import { AsyncForm, Field, value } from "./ui";
import { NumberField, num, secs, today } from "./ManagementShared";
import { TemplateIntervals } from "./InspectionTemplates";

type Mode = "" | "initial" | "recurring";
type Draft = ReturnType<typeof useActivationDraft>;
/** Which last compliance a schedule asks for. */
type Schedule = {
  lastHours: boolean;
  lastCycles: boolean;
  lastLandings: boolean;
  lastDate: boolean;
};
type FieldsProps = { template: InspectionTemplate; schedule: Schedule };

/**
 * Creates a schedule from an inspection template: an aircraft inspection, or
 * a component requirement for a component template, with the template's job
 * card templates linked. The template itself stays unchanged.
 *
 * @param props.onDone - Called once the schedule is saved.
 * @returns The form. Saving needs a connection, and refuses with "Choose an
 *   initial or recurring schedule." or "Review applicability before saving.".
 */
export function ActivateTemplate({
  template: t,
  onDone,
}: {
  template: InspectionTemplate;
  onDone: () => void;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const draft = useActivationDraft(t);
  const issue = templateActivationIssue(t);
  const duplicate =
    !!draft.mode && templateScheduleExists(s!, t, draft.mode, draft.target);
  const targetCount = matchingTargets(s!, t).length;
  return (
    <>
      <ActivationNotices
        template={t}
        issue={issue}
        targetCount={targetCount}
        duplicate={duplicate}
      />
      <AsyncForm
        submitLabel={
          t.applicability.kind === "component"
            ? "Create component requirement"
            : "Save inspection"
        }
        disabled={!online || !connected || !!issue || duplicate || !targetCount}
        onChange={(d) => draft.setPreview(nextDuePreview(d, t, draft.mode))}
        onSubmit={async (d) => {
          await backend!.activateTemplate(activationInput(d, t, draft));
          onDone();
        }}
      >
        <ActivationFields s={s!} template={t} draft={draft} />
      </AsyncForm>
    </>
  );
}

// Choosing a target or mode remounts the last-compliance fields, so the
// preview computed from them is cleared too.
function useActivationDraft(t: InspectionTemplate) {
  const [mode, setMode] = useState<Mode>(
    hasInitialLimits(t) ? "" : "recurring",
  );
  const [target, setTarget] = useState("");
  const [preview, setPreview] = useState("");
  return {
    mode,
    target,
    preview,
    setPreview,
    chooseMode: (next: Mode) => {
      setMode(next);
      setPreview("");
    },
    chooseTarget: (uuid: string) => {
      setTarget(uuid);
      setPreview("");
    },
  };
}

function ActivationNotices(props: {
  template: InspectionTemplate;
  issue: string;
  targetCount: number;
  duplicate: boolean;
}) {
  const { template: t } = props;
  const component = t.applicability.kind === "component";
  return (
    <>
      <h3>{t.name}</h3>
      <TemplateIntervals record={t} />
      {t.conditions && <p>{t.conditions}</p>}
      <p>
        The template remains unchanged. This creates a separate{" "}
        {component ? "component requirement" : "aircraft inspection"} and{" "}
        {t.tasks.length} linked job card templates.
      </p>
      {!!props.issue && <p role="alert">{props.issue}</p>}
      {!props.targetCount && (
        <p>
          No matching {component ? "installed components" : "aircraft"} with
          maintenance access. Check that the manufacturer and model match the
          template.
        </p>
      )}
      {props.duplicate && (
        <p>
          This schedule already exists.{" "}
          <Link to={component ? "/components" : "/inspections"}>
            Open existing schedules
          </Link>
          .
        </p>
      )}
    </>
  );
}

function ActivationFields(props: {
  s: Snapshot;
  template: InspectionTemplate;
  draft: Draft;
}) {
  const { template: t, draft } = props;
  const schedule = scheduleFor(t, draft.mode);
  const component = t.applicability.kind === "component";
  return (
    <>
      <TargetField
        s={props.s}
        template={t}
        target={draft.target}
        onChange={draft.chooseTarget}
      />
      {hasInitialLimits(t) && (
        <ModeField mode={draft.mode} onChange={draft.chooseMode} />
      )}
      {!component && <UsageMeterField />}
      <LastComplianceFields
        key={`${draft.target}:${draft.mode}`}
        template={t}
        schedule={schedule}
      />
      {draft.preview && (
        <p role="status">Next due: {draft.preview} (first reached).</p>
      )}
      {schedule.lastDate && !component && (
        <p>Calendar deadlines fall at the end of the due month.</p>
      )}
      <DescriptionFields template={t} />
    </>
  );
}

function TargetField(props: {
  s: Snapshot;
  template: InspectionTemplate;
  target: string;
  onChange: (uuid: string) => void;
}) {
  const { s, template: t } = props;
  const component = t.applicability.kind === "component";
  return (
    <Field label={component ? "Target installed component" : "Target aircraft"}>
      <select
        required
        value={props.target}
        onChange={(e) => props.onChange(e.target.value)}
      >
        <option value="">
          Select a matching {component ? "component" : "aircraft"}
        </option>
        {component
          ? matchingComponents(s, t).map((c) => (
              <option key={c.uuid} value={c.uuid}>
                {`${c.componentType} · ${c.model} · ${c.serial} · ${s.aircraft.find((a) => a.uuid === c.aircraftUuid)?.registration}`}
              </option>
            ))
          : matchingAircraft(s, t).map((a) => (
              <option key={a.uuid} value={a.uuid}>
                {a.registration} · {a.make} {a.model}
              </option>
            ))}
      </select>
    </Field>
  );
}

function ModeField(props: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <>
      <Field label="Schedule to create">
        <select
          required
          value={props.mode}
          onChange={(e) => props.onChange(e.target.value as Mode)}
        >
          <option value="">Choose a schedule</option>
          <option value="initial">Initial one-time requirement</option>
          <option value="recurring">
            Recurring schedule after initial compliance
          </option>
        </select>
      </Field>
      <p>
        Initial and recurring schedules are created separately. Completing the
        initial schedule does not activate the recurring schedule.
      </p>
    </>
  );
}

function UsageMeterField() {
  return (
    <Field label="Inspection time source">
      <select name="usageMeter" defaultValue="aircraft">
        <option value="aircraft">Aircraft total time</option>
        <option value="collective">Helicopter collective hourmeter</option>
      </select>
    </Field>
  );
}

function LastComplianceFields({ template: t, schedule }: FieldsProps) {
  const hours =
    t.applicability.kind === "component"
      ? `${t.timeBasis} hours`
      : "selected time source hours";
  return (
    <div className="form-grid">
      {schedule.lastHours && (
        <NumberField
          name="lastHours"
          label={`Last complied at (${hours})`}
          decimal
          required
        />
      )}
      {schedule.lastCycles && (
        <NumberField
          name="lastCycles"
          label="Last complied at (cycles)"
          required
        />
      )}
      {schedule.lastLandings && (
        <NumberField
          name="lastLandings"
          label="Last complied at (aircraft total landings)"
          required
        />
      )}
      {schedule.lastDate && (
        <Field label="Last compliance date">
          <input name="lastDate" type="date" required max={today()} />
        </Field>
      )}
    </div>
  );
}

function DescriptionFields({ template: t }: { template: InspectionTemplate }) {
  const description = [t.description || t.name, t.conditions]
    .filter(Boolean)
    .join("\n\n");
  return (
    <>
      <Field label="Inspection description">
        <textarea
          name="description"
          defaultValue={description}
          maxLength={TEMPLATE_DESCRIPTION_MAX_LENGTH}
          required
        />
      </Field>
      {description.length > TEMPLATE_DESCRIPTION_MAX_LENGTH && (
        <p>
          Shorten the description to 2,000 characters before saving. The full
          definition remains in the template.
        </p>
      )}
      <label>
        <input name="reviewed" type="checkbox" required /> I reviewed model
        applicability, conditions, intervals and compliance history.
      </label>
    </>
  );
}

function hasInitialLimits(t: InspectionTemplate) {
  return (
    t.initialHours !== undefined ||
    t.initialCycles !== undefined ||
    t.initialLandings !== undefined
  );
}

function matchingTargets(s: Snapshot, t: InspectionTemplate) {
  return t.applicability.kind === "component"
    ? matchingComponents(s, t)
    : matchingAircraft(s, t);
}

function matchingAircraft(s: Snapshot, t: InspectionTemplate) {
  return s.aircraft.filter(
    (a) => can(s, a.uuid, "maintenance") && matchesAircraft(a, t.applicability),
  );
}

function matchingComponents(s: Snapshot, t: InspectionTemplate) {
  return (s.management ?? []).filter(
    (c): c is Component =>
      c.kind === "component" &&
      c.installed &&
      can(s, c.aircraftUuid, "maintenance") &&
      matchesComponent(c, t.applicability),
  );
}

// A one-time initial schedule and absolute limits need no last compliance;
// recurring limits counted from it do.
function scheduleFor(t: InspectionTemplate, mode: Mode): Schedule {
  const recurring = mode === "recurring";
  const limits = templateLimits(t, mode === "initial");
  return {
    lastHours: recurring && limits.hours !== undefined && !limits.absoluteHours,
    lastCycles:
      recurring && limits.cycles !== undefined && !limits.absoluteCycles,
    lastLandings:
      recurring && limits.landings !== undefined && !limits.absoluteLandings,
    lastDate: recurring && limits.calendar !== undefined,
  };
}

function nextDuePreview(d: FormData, t: InspectionTemplate, mode: Mode) {
  const due = templateNextDue(t, mode === "initial", {
    hours: num(d, "lastHours"),
    cycles: num(d, "lastCycles"),
    landings: num(d, "lastLandings"),
    date: value(d, "lastDate"),
  });
  return [
    due.hours !== undefined && `${due.hours} hours`,
    due.cycles !== undefined && `${due.cycles} cycles`,
    due.landings !== undefined && `${due.landings} aircraft landings`,
    due.date,
  ]
    .filter(Boolean)
    .join(" or ");
}

function activationInput(
  d: FormData,
  t: InspectionTemplate,
  { mode, target }: Draft,
): ActivateTemplateInput {
  if (!mode) throw new Error("Choose an initial or recurring schedule.");
  const sc = scheduleFor(t, mode);
  if (d.get("reviewed") !== "on")
    throw new Error("Review applicability before saving.");
  return {
    usageMeter:
      t.applicability.kind === "component"
        ? undefined
        : (value(d, "usageMeter") as ActivateTemplateInput["usageMeter"]),
    templateUuid: t.uuid,
    templateVersion: t.version,
    targetUuid: target,
    mode,
    description: value(d, "description"),
    reviewed: true,
    lastSeconds: sc.lastHours ? secs(d, "lastHours") : undefined,
    lastCycles: sc.lastCycles ? num(d, "lastCycles") : undefined,
    lastLandings: sc.lastLandings ? num(d, "lastLandings") : undefined,
    lastDate: sc.lastDate ? value(d, "lastDate") || undefined : undefined,
  };
}
