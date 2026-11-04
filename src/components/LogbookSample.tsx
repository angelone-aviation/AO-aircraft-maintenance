/**
 * Responsibility: The live sample log book entry on the work order form: the
 *   maintenance entry the order would generate with the values entered so far.
 * Layer: UI. A read-only preview; saves nothing.
 * Dependencies: react, src/domain (certifications, logbook, model, readings,
 *   workOrders, workOrderCloseout, workOrderComponentWork types), ./ui.
 */
import { memberLicense } from "../domain/certifications";
import type { ComponentWork } from "../domain/workOrderComponentWork";
import { useState } from "react";
import { logbookSampleText } from "../domain/logbook";
import {
  localDate,
  totalSeconds,
  type Aircraft,
  type Snapshot,
} from "../domain/model";
import {
  componentReading,
  installedComponents,
  openingReading,
  type WorkOrder,
  type WorkTask,
} from "../domain/workOrders";
import { previewComponentCloseout } from "../domain/workOrderCloseout";
import { SECONDS_PER_HOUR } from "../domain/readings";
import { Field } from "./ui";

type Header = WorkOrder["aircraft"];
type SampleProps = {
  s: Snapshot;
  initial?: WorkOrder;
  uuid: string;
  aircraftUuid: string;
  componentUuids: string[];
  tasks: WorkTask[];
  status: WorkOrder["status"];
  fields?: FormData;
  releaseOutcome: string;
  componentWork: ComponentWork[];
};

/**
 * The "Sample log book entry" panel: the maintenance entry this work order
 * would generate, redrawn as the form changes. Unfinished work is included
 * until the user unticks it. Readings and component lines come from the
 * functions saving and closing the order use. Completion readings appear
 * once the order's status is completed, and the close-out's component
 * readings and work once it would accept them; until then the opening header
 * is used.
 *
 * @param props.initial - The saved order, whose header and readings are kept.
 * @param props.fields - The form's current values, read by input name.
 * @returns The panel, or null when the aircraft is not in the snapshot.
 */
export function LogbookSample(props: SampleProps) {
  const [includePlanned, setIncludePlanned] = useState(true);
  const aircraft = props.s.aircraft.find((a) => a.uuid === props.aircraftUuid);
  if (!aircraft) return null;
  return (
    <section className="panel" aria-label="Sample log book entry">
      <h3>Sample log book entry</h3>
      <p>
        Adjust the task inclusion, wording, manual references and closeout
        fields above to update this sample immediately. Changes are saved with
        the work order.
      </p>
      <label className="block">
        <input
          type="checkbox"
          checked={includePlanned}
          onChange={(e) => setIncludePlanned(e.target.checked)}
        />{" "}
        Include unfinished work in sample
      </label>
      <p className="muted">
        Preview only. The final entry includes completed work only. Aircraft
        readings use the opening header until completion readings are entered;
        component readings use the selected header until the order is completed.
        Compliance results are added at closeout.
      </p>
      <Field label="Sample log book entry text">
        <textarea
          readOnly
          rows={18}
          value={sampleText(props, aircraft, includePlanned)}
        />
      </Field>
    </section>
  );
}

function sampleText(props: SampleProps, a: Aircraft, includePlanned: boolean) {
  const { s, tasks } = props;
  const sample = includePlanned ? s : withCompletedCardsOnly(s);
  const order = {
    ...sampleOrder(props, a),
    tasks: includePlanned ? tasks : cancelUnfinished(tasks),
  };
  const license = memberLicense(s.user, order.completionDate);
  const closing =
    props.status === "completed"
      ? previewComponentCloseout(sample, order, order.aircraft, Date.now())
      : null;
  return logbookSampleText(
    sample,
    order,
    { userId: s.user.id, name: s.user.name, ...license },
    closing,
  );
}

function sampleOrder(props: SampleProps, a: Aircraft): WorkOrder {
  const { initial, fields } = props;
  const field = (name: string, fallback = "") =>
    String(fields?.get(name) ?? fallback);
  return {
    uuid: props.uuid,
    version: initial?.version ?? 0,
    createdBy: initial?.createdBy ?? "",
    recordedAt: initial?.recordedAt ?? Date.now(),
    aircraftUuid: props.aircraftUuid,
    status: props.status,
    number: field("number", initial?.number) || "[assigned when saved]",
    dateOpened: field("dateOpened", initial?.dateOpened),
    completionDate:
      field("completionDate", initial?.completionDate) || "[completion date]",
    supervisor: field("supervisor", initial?.supervisor),
    scope: field("scope", initial?.scope),
    priority: initial?.priority ?? "routine",
    releaseOutcome: props.releaseOutcome || "[release outcome]",
    finalReview: field("finalReview", initial?.finalReview),
    aircraft: closingHeader(props, a, initial?.aircraft ?? openingReading(a)),
    componentReadings: headerComponents(props, a),
    componentWork: props.componentWork,
    tasks: props.tasks,
  };
}

// A completed order shows the entered completion readings, else the aircraft's
// current ones; any other status keeps the opening header. A meter the
// aircraft does not have keeps its opening value.
function closingHeader(props: SampleProps, a: Aircraft, opening: Header) {
  const done = props.status === "completed";
  const read = (name: string, current: number, open: number, scale = 1) =>
    done ? (enteredReading(props.fields, name, scale) ?? current) : open;
  const hours = (name: string, current: number, open: number) =>
    read(name, current, open, SECONDS_PER_HOUR);
  return {
    ...opening,
    totalSeconds: hours(
      "completionTotalHours",
      totalSeconds(a),
      opening.totalSeconds,
    ),
    hobbs: hours("completionHobbs", a.currentHobbs, opening.hobbs),
    tach: hours("completionTach", a.currentTach, opening.tach),
    cyclicHobbs:
      a.currentCyclicHobbs === undefined
        ? opening.cyclicHobbs
        : hours(
            "completionCyclicHobbs",
            a.currentCyclicHobbs,
            opening.cyclicHobbs ?? 0,
          ),
    flightTimeLog:
      a.currentFlightTimeLog === undefined
        ? opening.flightTimeLog
        : hours(
            "completionFlightTimeLog",
            a.currentFlightTimeLog,
            opening.flightTimeLog ?? 0,
          ),
    landings: read(
      "completionLandings",
      a.landings,
      opening.landings ?? a.landings,
    ),
    cycles: read("completionCycles", a.cycles, opening.cycles),
  };
}

function enteredReading(
  fields: FormData | undefined,
  name: string,
  scale: number,
) {
  const raw = fields?.get(name);
  if (raw === null || raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value * scale : undefined;
}

// Saving refuses a component not installed here; the sample leaves it out.
function headerComponents(props: SampleProps, a: Aircraft) {
  const { s, initial, aircraftUuid } = props;
  const now = Date.now();
  return props.componentUuids.flatMap((id) => {
    const prior = initial?.componentReadings.find(
      (c) => c.componentUuid === id,
    );
    if (prior) return [prior];
    const c = installedComponents(s, aircraftUuid).find((c) => c.uuid === id);
    return c ? [componentReading(c, a, localDate(now), now)] : [];
  });
}

function withCompletedCardsOnly(s: Snapshot): Snapshot {
  return {
    ...s,
    taskCards: s.taskCards?.filter((card) => card.status === "completed"),
  };
}

function cancelUnfinished(tasks: WorkTask[]): WorkTask[] {
  return tasks.map((task) =>
    task.status === "completed" ? task : { ...task, status: "cancelled" },
  );
}
