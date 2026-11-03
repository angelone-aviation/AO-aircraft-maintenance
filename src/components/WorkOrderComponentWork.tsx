import { partsInventory } from "../domain/requiredParts";
import { localDate } from "../domain/model";
import {
  POSITIONS,
  componentTotals,
  type Component,
} from "../domain/components";
import {
  aircraftMeterReading,
  totalSeconds,
  type Snapshot,
} from "../domain/model";
import {
  componentWorkLabels,
  type ComponentWork,
} from "../domain/workOrderComponentWork";
import { Field } from "./ui";

export function WorkOrderComponentWork({
  s,
  ids,
  aircraftUuid,
  fields,
  choices,
  onChange,
  closing,
}: {
  closing: boolean;
  s: Snapshot;
  ids: string[];
  aircraftUuid: string;
  fields?: FormData;
  choices: ComponentWork[];
  onChange: (choices: ComponentWork[]) => void;
}) {
  const aircraft = s.aircraft.find((a) => a.uuid === aircraftUuid)!;
  const number = (name: string, fallback: number, scale = 3600) => {
    const raw = closing ? fields?.get(name) : undefined;
    return raw !== null && raw !== undefined && raw !== ""
      ? Number(raw) * scale
      : fallback;
  };
  const hobbs = number("completionHobbs", aircraft.currentHobbs);
  const tach = number("completionTach", aircraft.currentTach);
  const cyclic =
    aircraft.currentCyclicHobbs === undefined
      ? undefined
      : number("completionCyclicHobbs", aircraft.currentCyclicHobbs);
  const flightTimeLog =
    aircraft.currentFlightTimeLog === undefined
      ? undefined
      : number("completionFlightTimeLog", aircraft.currentFlightTimeLog);
  const atCompletion = {
    ...aircraft,
    currentHobbs: hobbs,
    currentTach: tach,
    currentCyclicHobbs: cyclic,
    currentFlightTimeLog: flightTimeLog,
    cycles: number("completionCycles", aircraft.cycles, 1),
    landings: number("completionLandings", aircraft.landings, 1),
    adjustmentSeconds:
      number("completionTotalHours", totalSeconds(aircraft)) -
      aircraftMeterReading({
        ...aircraft,
        currentHobbs: hobbs,
        currentTach: tach,
        currentCyclicHobbs: cyclic,
        currentFlightTimeLog: flightTimeLog,
      }),
  };
  const date = String(
    (closing && fields?.get("completionDate")) || localDate(),
  );
  const hours = (seconds: number | null) =>
    seconds === null ? "Not recorded" : `${(seconds / 3600).toFixed(1)} h`;
  if (!ids.length) return null;
  return (
    <section className="panel" aria-label="Component work performed">
      <h3>Component work performed</h3>
      <p>
        Choose the work planned or performed for each component. Save the work
        order to keep your choices. Tracking changes apply only when the order
        closes, using its completion date and verified readings. Lifetime totals
        are retained.
      </p>
      {ids.map((id) => {
        const c = s.management?.find(
          (r): r is Component => r.kind === "component" && r.uuid === id,
        );
        if (!c)
          return (
            <p role="alert" key={id}>
              An included component is unavailable. Review the component
              selection.
            </p>
          );
        const choice = choices.find((item) => item.componentUuid === id);
        const patch = (changes: Partial<ComponentWork>) =>
          onChange([
            ...choices.filter((item) => item.componentUuid !== id),
            {
              componentUuid: id,
              version: c.version,
              action: "service",
              description: "",
              reference: "",
              ...choice,
              ...changes,
            },
          ]);
        let totals;
        try {
          totals = componentTotals(c, atCompletion, date);
        } catch {
          /* Validation below explains invalid readings. */
        }
        const repair = choice?.action === "repair" || choice?.action === "both";
        const overhaul =
          choice?.action === "overhaul" || choice?.action === "both";
        const label = `${c.componentType}${c.installPosition ? ` · ${c.installPosition}` : ""} · ${c.serial}`;
        return (
          <div className="panel" key={id}>
            <h4>{label}</h4>
            <p>P/N {c.partNumber || "Not recorded"}</p>
            <Field label={`${label} work performed`}>
              <select
                required={closing}
                value={choice?.action ?? ""}
                onChange={(e) =>
                  patch({ action: e.target.value as ComponentWork["action"] })
                }
              >
                <option value="">Select work performed</option>
                {Object.entries(componentWorkLabels)
                  .filter(([value]) =>
                    choice?.taskUuid
                      ? value === choice.action
                      : !["install", "remove"].includes(value),
                  )
                  .map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
              </select>
            </Field>
            {totals ? (
              <p>
                {closing ? "At completion" : "Current readings (preview)"}: TSN{" "}
                {hours(totals.timeSinceNew)}; cycles {totals.cyclesSinceNew}.
                TSO {hours(totals.timeSinceOverhaul)} →{" "}
                {hours(overhaul ? 0 : totals.timeSinceOverhaul)}; TSR{" "}
                {hours(totals.timeSinceRepair)} →{" "}
                {hours(repair ? 0 : totals.timeSinceRepair)}.
              </p>
            ) : (
              <p role="alert">
                Completion readings or date precede this component’s baseline.
                Review the completion fields.
              </p>
            )}
            {choice?.action === "install" && (
              <Field label={`${label} installation position`}>
                <select
                  value={choice.installPosition ?? ""}
                  onChange={(e) =>
                    patch({
                      installPosition: e.target
                        .value as Component["installPosition"],
                    })
                  }
                  required
                >
                  <option value="">Select position</option>
                  {POSITIONS.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </Field>
            )}
            {choice?.action === "remove" && (
              <>
                <Field label={`${label} inventory location`}>
                  <select
                    value={choice.locationUuid ?? ""}
                    onChange={(e) =>
                      patch({ locationUuid: e.target.value || undefined })
                    }
                  >
                    <option value="">Select location</option>
                    {partsInventory(s).locations.map((l) => (
                      <option key={l.uuid} value={l.uuid}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`${label} shelf / bin`}>
                  <input
                    maxLength={150}
                    value={choice.partsLocation ?? ""}
                    onChange={(e) => patch({ partsLocation: e.target.value })}
                  />
                </Field>
              </>
            )}
            {choice && choice.version !== c.version && (
              <button
                type="button"
                onClick={() => patch({ version: c.version })}
              >
                Confirm current component readings
              </button>
            )}
            {(repair ||
              overhaul ||
              choice?.action === "install" ||
              choice?.action === "remove") && (
              <>
                <Field label={`${label} work description`}>
                  <textarea
                    required={closing}
                    maxLength={10000}
                    value={choice?.description ?? ""}
                    onChange={(e) => patch({ description: e.target.value })}
                  />
                </Field>
                <Field
                  label={`${label} supporting document / reference`}
                  hint="Optional; attachments can be added to the work order."
                >
                  <input
                    maxLength={2000}
                    value={choice?.reference ?? ""}
                    onChange={(e) => patch({ reference: e.target.value })}
                  />
                </Field>
                <p className="notice">
                  {closing
                    ? "Closing this order records"
                    : "Planned for closeout:"}{" "}
                  {componentWorkLabels[choice!.action].toLowerCase()}
                  {closing ? ` on ${date}` : ""}
                  {overhaul
                    ? " and renews applicable overhaul requirements"
                    : ""}
                  .
                </p>
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}
