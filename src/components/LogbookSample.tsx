import { memberLicense } from "../domain/certifications";
import {
  componentWorkLabels,
  type ComponentWork,
} from "../domain/workOrderComponentWork";
import { useState } from "react";
import { componentTotals } from "../domain/components";
import { logbookText } from "../domain/logbook";
import { totalSeconds, type Snapshot } from "../domain/model";
import {
  installedComponents,
  type WorkOrder,
  type WorkTask,
} from "../domain/workOrders";
import { Field } from "./ui";

export function LogbookSample({
  s,
  initial,
  uuid,
  aircraftUuid,
  componentUuids,
  tasks,
  status,
  fields,
  releaseOutcome,
  componentWork,
}: {
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
}) {
  const [includePlanned, setIncludePlanned] = useState(true);
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (!a) return null;
  const field = (name: string, fallback: string) =>
    String(fields?.get(name) ?? fallback);
  const reading = (name: string, fallback: number, scale = 3600) => {
    const raw = fields?.get(name);
    return status === "completed" &&
      raw !== null &&
      raw !== undefined &&
      raw !== "" &&
      Number.isFinite(Number(raw))
      ? Number(raw) * scale
      : fallback;
  };
  const opening = initial?.aircraft ?? {
    ...a,
    totalSeconds: totalSeconds(a),
    hobbs: a.currentHobbs,
    tach: a.currentTach,
    cyclicHobbs: a.currentCyclicHobbs,
    flightTimeLog: a.currentFlightTimeLog,
  };
  const order: WorkOrder = {
    uuid,
    version: initial?.version ?? 0,
    createdBy: initial?.createdBy ?? "",
    recordedAt: initial?.recordedAt ?? Date.now(),
    aircraftUuid,
    status,
    number: field("number", initial?.number ?? "") || "[assigned when saved]",
    dateOpened: field("dateOpened", initial?.dateOpened ?? ""),
    completionDate:
      field("completionDate", initial?.completionDate ?? "") ||
      "[completion date]",
    supervisor: field("supervisor", initial?.supervisor ?? ""),
    scope: field("scope", initial?.scope ?? ""),
    priority: initial?.priority ?? "routine",
    releaseOutcome: releaseOutcome || "[release outcome]",
    finalReview: field("finalReview", initial?.finalReview ?? ""),
    aircraft: {
      ...opening,
      totalSeconds: reading(
        "completionTotalHours",
        status === "completed" ? totalSeconds(a) : opening.totalSeconds,
      ),
      hobbs: reading(
        "completionHobbs",
        status === "completed" ? a.currentHobbs : opening.hobbs,
      ),
      tach: reading(
        "completionTach",
        status === "completed" ? a.currentTach : opening.tach,
      ),
      cyclicHobbs:
        a.currentCyclicHobbs === undefined
          ? opening.cyclicHobbs
          : reading(
              "completionCyclicHobbs",
              status === "completed"
                ? a.currentCyclicHobbs
                : (opening.cyclicHobbs ?? 0),
            ),
      flightTimeLog:
        a.currentFlightTimeLog === undefined
          ? opening.flightTimeLog
          : reading(
              "completionFlightTimeLog",
              status === "completed"
                ? a.currentFlightTimeLog
                : (opening.flightTimeLog ?? 0),
            ),
      landings: reading(
        "completionLandings",
        status === "completed" ? a.landings : (opening.landings ?? a.landings),
        1,
      ),
      cycles: reading(
        "completionCycles",
        status === "completed" ? a.cycles : opening.cycles,
        1,
      ),
    },
    componentReadings: componentUuids.flatMap((id) => {
      const prior = initial?.componentReadings.find(
        (c) => c.componentUuid === id,
      );
      if (prior) return [prior];
      const c = installedComponents(s, aircraftUuid).find((c) => c.uuid === id);
      return c
        ? [
            {
              ...componentTotals(c, a),
              componentUuid: id,
              label: c.componentType,
              serial: c.serial,
              partNumber: c.partNumber,
              recordedAt: Date.now(),
            },
          ]
        : [];
    }),
    tasks,
  };
  const previewSnapshot = includePlanned
    ? s
    : {
        ...s,
        taskCards: s.taskCards?.filter((card) => card.status === "completed"),
      };
  const generated = logbookText(
    previewSnapshot,
    {
      ...order,
      tasks: includePlanned
        ? tasks
        : tasks.map((task) =>
            task.status === "completed"
              ? task
              : { ...task, status: "cancelled" },
          ),
    },
    "maintenance",
    {
      name: s.user.name,
      licenseNumber: memberLicense(s.user, order.completionDate || undefined)
        .licenseNumber,
      certificateType: memberLicense(s.user, order.completionDate || undefined)
        .certificateType,
    },
    undefined,
    undefined,
    true,
  );
  const componentSummary =
    status === "completed"
      ? componentWork
          .filter((item) => item.action !== "service")
          .map((item) => {
            const c = s.management?.find(
              (r) => r.kind === "component" && r.uuid === item.componentUuid,
            );
            if (c?.kind !== "component") return "";
            return `${c.componentType} (P/N ${c.partNumber}; S/N ${c.serial}): ${componentWorkLabels[item.action]} on ${order.completionDate}. ${item.description}${item.reference ? ` IAW ${item.reference}` : ""}.${item.action === "repair" || item.action === "both" ? " TSR resets to 0.0 h." : ""}${item.action === "overhaul" || item.action === "both" ? " TSO resets to 0.0 h." : ""}`;
          })
          .filter(Boolean)
          .join("\n")
      : "";
  const text = componentSummary
    ? generated.replace(
        "Work performed:\n",
        `Work performed:\n${componentSummary}\n\n`,
      )
    : generated;
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
        component readings use the selected header. Compliance results are added
        at closeout.
      </p>
      <Field label="Sample log book entry text">
        <textarea readOnly rows={18} value={text} />
      </Field>
    </section>
  );
}
