import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import { can } from "../domain/model";
import { matchesAircraft, matchesComponent } from "../domain/manualDiscovery";
import type { InspectionTemplate } from "../domain/inspectionTemplates";
import {
  templateActivationIssue,
  type ActivateTemplateInput,
} from "../domain/activateTemplate";
import { endOfDueMonth } from "../domain/maintenance";
import { calendarDue } from "../domain/components";
import { AsyncForm, Field, value } from "./ui";
import { NumberField, num, secs, today } from "./ManagementShared";
import { TemplateIntervals } from "./InspectionTemplates";
export function ActivateTemplate({
  template: t,
  onDone,
}: {
  template: InspectionTemplate;
  onDone: () => void;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const component = t.applicability.kind === "component";
  const hasInitial =
    t.initialHours !== undefined ||
    t.initialCycles !== undefined ||
    t.initialLandings !== undefined;
  const [mode, setMode] = useState<"" | "initial" | "recurring">(
    hasInitial ? "" : "recurring",
  );
  const [target, setTarget] = useState("");
  const [preview, setPreview] = useState("");
  const aircraft = s!.aircraft.filter(
    (a) =>
      can(s!, a.uuid, "maintenance") && matchesAircraft(a, t.applicability),
  );
  const components = (s!.management ?? []).filter(
    (c) =>
      c.kind === "component" &&
      c.installed &&
      can(s!, c.aircraftUuid, "maintenance") &&
      matchesComponent(c, t.applicability),
  );
  const sourceKey = `template:${t.uuid}:${mode}`;
  const duplicate = component
    ? s!.management?.some(
        (r) =>
          r.kind === "componentRequirement" &&
          r.componentUuid === target &&
          r.sourceKey === sourceKey,
      )
    : s!.inspections.some(
        (i) => i.aircraftUuid === target && i.sourceKey === sourceKey,
      );
  const initial = mode === "initial";
  const h = initial ? t.initialHours : t.hours,
    cy = initial ? t.initialCycles : t.cycles,
    landings = initial ? t.initialLandings : t.landings;
  const recurringL =
    !!mode &&
    !initial &&
    landings !== undefined &&
    t.landingMode !== "ABSOLUTE";
  const recurringH =
    !!mode &&
    !initial &&
    h !== undefined &&
    t.hourMode === "FROM_LAST_COMPLIED";
  const recurringC =
    !!mode &&
    !initial &&
    cy !== undefined &&
    t.cycleMode === "FROM_LAST_COMPLIED";
  const calendar = !!mode && !initial && t.calendarValue !== undefined;
  const issue = templateActivationIssue(t);
  const description = [t.description || t.name, t.conditions]
    .filter(Boolean)
    .join("\n\n");
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
      {!!issue && <p role="alert">{issue}</p>}
      {!(component ? components.length : aircraft.length) && (
        <p>
          No matching {component ? "installed components" : "aircraft"} with
          maintenance access. Check that the manufacturer and model match the
          template.
        </p>
      )}
      {duplicate && (
        <p>
          This schedule already exists.{" "}
          <Link to={component ? "/components" : "/inspections"}>
            Open existing schedules
          </Link>
          .
        </p>
      )}
      <AsyncForm
        submitLabel={
          component ? "Create component requirement" : "Save inspection"
        }
        disabled={
          !online ||
          !connected ||
          !!issue ||
          !!duplicate ||
          !(component ? components.length : aircraft.length)
        }
        onChange={(d) => {
          const parts: string[] = [];
          const last = num(d, "lastHours"),
            cycles = num(d, "lastCycles"),
            date = value(d, "lastDate");
          if (
            h !== undefined &&
            (initial || t.hourMode === "ABSOLUTE" || last !== undefined)
          )
            parts.push(
              `${initial || t.hourMode === "ABSOLUTE" ? h : Number(((last ?? 0) + h).toFixed(1))} hours`,
            );
          if (
            cy !== undefined &&
            (initial || t.cycleMode === "ABSOLUTE" || cycles !== undefined)
          )
            parts.push(
              `${initial || t.cycleMode === "ABSOLUTE" ? cy : (cycles ?? 0) + cy} cycles`,
            );
          const lastLandings = num(d, "lastLandings");
          if (
            landings !== undefined &&
            (!recurringL || lastLandings !== undefined)
          )
            parts.push(
              `${landings + (recurringL ? lastLandings! : 0)} aircraft landings`,
            );
          try {
            if (calendar && date)
              parts.push(
                component
                  ? calendarDue(date, t.calendarValue!, t.calendarUnit)
                  : endOfDueMonth(
                      date,
                      t.calendarValue! * (t.calendarUnit === "YEARS" ? 12 : 1),
                    ),
              );
          } catch {
            /* Date entry incomplete. */
          }
          setPreview(parts.join(" or "));
        }}
        onSubmit={async (d) => {
          if (!mode)
            throw new Error("Choose an initial or recurring schedule.");
          const input: ActivateTemplateInput = {
            usageMeter: component
              ? undefined
              : (value(d, "usageMeter") as ActivateTemplateInput["usageMeter"]),
            templateUuid: t.uuid,
            templateVersion: t.version,
            targetUuid: target,
            mode,
            description: value(d, "description"),
            reviewed:
              d.get("reviewed") === "on"
                ? true
                : (() => {
                    throw new Error("Review applicability before saving.");
                  })(),
            lastSeconds: recurringH ? secs(d, "lastHours") : undefined,
            lastCycles: recurringC ? num(d, "lastCycles") : undefined,
            lastLandings: recurringL ? num(d, "lastLandings") : undefined,
            lastDate: calendar ? value(d, "lastDate") || undefined : undefined,
          };
          await backend!.activateTemplate(input);
          onDone();
        }}
      >
        <Field
          label={component ? "Target installed component" : "Target aircraft"}
        >
          <select
            required
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setPreview("");
            }}
          >
            <option value="">
              Select a matching {component ? "component" : "aircraft"}
            </option>
            {component
              ? components.map((c) => (
                  <option key={c.uuid} value={c.uuid}>
                    {c.kind === "component"
                      ? `${c.componentType} · ${c.model} · ${c.serial} · ${s!.aircraft.find((a) => a.uuid === c.aircraftUuid)?.registration}`
                      : ""}
                  </option>
                ))
              : aircraft.map((a) => (
                  <option key={a.uuid} value={a.uuid}>
                    {a.registration} · {a.make} {a.model}
                  </option>
                ))}
          </select>
        </Field>
        {hasInitial && (
          <>
            <Field label="Schedule to create">
              <select
                required
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value as typeof mode);
                  setPreview("");
                }}
              >
                <option value="">Choose a schedule</option>
                <option value="initial">Initial one-time requirement</option>
                <option value="recurring">
                  Recurring schedule after initial compliance
                </option>
              </select>
            </Field>
            <p>
              Initial and recurring schedules are created separately. Completing
              the initial schedule does not activate the recurring schedule.
            </p>
          </>
        )}
        {!component && (
          <Field label="Inspection time source">
            <select name="usageMeter" defaultValue="aircraft">
              <option value="aircraft">Aircraft total time</option>
              <option value="collective">
                Helicopter collective hourmeter
              </option>
            </select>
          </Field>
        )}
        <div className="form-grid" key={`${target}:${mode}`}>
          {recurringH && (
            <NumberField
              name="lastHours"
              label={
                component
                  ? `Last complied at (${t.timeBasis} hours)`
                  : "Last complied at (selected time source hours)"
              }
              decimal
              required
            />
          )}
          {recurringC && (
            <NumberField
              name="lastCycles"
              label="Last complied at (cycles)"
              required
            />
          )}
          {recurringL && (
            <NumberField
              name="lastLandings"
              label="Last complied at (aircraft total landings)"
              required
            />
          )}
          {calendar && (
            <Field label="Last compliance date">
              <input name="lastDate" type="date" required max={today()} />
            </Field>
          )}
        </div>
        {preview && <p role="status">Next due: {preview} (first reached).</p>}
        {calendar && !component && (
          <p>Calendar deadlines fall at the end of the due month.</p>
        )}
        <Field label="Inspection description">
          <textarea
            name="description"
            defaultValue={description}
            maxLength={2000}
            required
          />
        </Field>
        {description.length > 2000 && (
          <p>
            Shorten the description to 2,000 characters before saving. The full
            definition remains in the template.
          </p>
        )}
        <label>
          <input name="reviewed" type="checkbox" required /> I reviewed model
          applicability, conditions, intervals and compliance history.
        </label>
      </AsyncForm>
    </>
  );
}
