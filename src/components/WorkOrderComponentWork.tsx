/**
 * Responsibility: The component work section of a work order: what was done
 *   to each included component, with the tracking it will reset at closeout.
 * Layer: UI. React component; tracking and labels come from src/domain.
 * Dependencies: src/domain (model, components, requiredParts,
 *   workOrderComponentWork), ./ui.tsx.
 */
import { partsInventory } from "../domain/requiredParts";
import {
  aircraftMeterReading,
  localDate,
  totalSeconds,
  type Aircraft,
  type Snapshot,
} from "../domain/model";
import {
  POSITIONS,
  componentTotals,
  type Component,
} from "../domain/components";
import {
  componentWorkLabels,
  type ComponentWork,
} from "../domain/workOrderComponentWork";
import { Field } from "./ui";

const SECONDS_PER_HOUR = 3600;
// The limits componentWorkSchema sets.
const SHELF_MAX_LENGTH = 150;
const DESCRIPTION_MAX_LENGTH = 10000;
const REFERENCE_MAX_LENGTH = 2000;
// Movements come only from a planned movement task (PlanComponentMovement).
const MOVEMENTS: readonly string[] = ["install", "remove"];

type WorkProps = {
  closing: boolean;
  s: Snapshot;
  ids: string[];
  aircraftUuid: string;
  fields?: FormData;
  choices: ComponentWork[];
  onChange: (choices: ComponentWork[]) => void;
};
type EntryProps = Pick<WorkProps, "choices" | "onChange"> & {
  id: string;
  completion: Completion;
};
type Completion = {
  s: Snapshot;
  closing: boolean;
  date: string;
  aircraft: Aircraft;
};
type ItemProps = {
  c: Component;
  label: string;
  choice?: ComponentWork;
  patch: (changes: Partial<ComponentWork>) => void;
  completion: Completion;
};
type ChosenProps = ItemProps & { choice: ComponentWork };

/**
 * The work performed on each component a work order includes: serviced,
 * repaired, overhauled, or the movement its task plans, with a preview of
 * the TSO and TSR the closeout resets. While closing, the readings and date
 * come from the completion fields and the work is required.
 *
 * @param props.aircraftUuid - The order's aircraft, which must be in `s`.
 * @param props.ids - The included components; nothing renders without any.
 * @param props.fields - The work order form, read for completion readings
 *   while `closing`.
 * @param props.choices - The saved choices; `onChange` receives them with
 *   the changed component's choice moved to the end.
 */
export function WorkOrderComponentWork({
  s,
  ids,
  aircraftUuid,
  fields,
  choices,
  onChange,
  closing,
}: WorkProps) {
  const current = s.aircraft.find((a) => a.uuid === aircraftUuid)!;
  const aircraft = completionAircraft(current, closing ? fields : undefined);
  const date = String(
    (closing && fields?.get("completionDate")) || localDate(),
  );
  if (!ids.length) return null;
  const completion = { s, closing, date, aircraft };
  return (
    <section className="panel" aria-label="Component work performed">
      <h3>Component work performed</h3>
      <p>
        Choose the work planned or performed for each component. Save the work
        order to keep your choices. Tracking changes apply only when the order
        closes, using its completion date and verified readings. Lifetime totals
        are retained.
      </p>
      {ids.map((id) => (
        <ComponentEntry
          key={id}
          id={id}
          choices={choices}
          onChange={onChange}
          completion={completion}
        />
      ))}
    </section>
  );
}

// Completion fields hold hours; a blank one keeps the current reading.
function completionAircraft(aircraft: Aircraft, fields?: FormData) {
  const number = (name: string, fallback: number, scale = SECONDS_PER_HOUR) => {
    const raw = fields?.get(name);
    return raw !== null && raw !== undefined && raw !== ""
      ? Number(raw) * scale
      : fallback;
  };
  const meters = {
    currentHobbs: number("completionHobbs", aircraft.currentHobbs),
    currentTach: number("completionTach", aircraft.currentTach),
    currentCyclicHobbs:
      aircraft.currentCyclicHobbs === undefined
        ? undefined
        : number("completionCyclicHobbs", aircraft.currentCyclicHobbs),
    currentFlightTimeLog:
      aircraft.currentFlightTimeLog === undefined
        ? undefined
        : number("completionFlightTimeLog", aircraft.currentFlightTimeLog),
  };
  return {
    ...aircraft,
    ...meters,
    cycles: number("completionCycles", aircraft.cycles, 1),
    landings: number("completionLandings", aircraft.landings, 1),
    adjustmentSeconds:
      number("completionTotalHours", totalSeconds(aircraft)) -
      aircraftMeterReading({ ...aircraft, ...meters }),
  };
}

function patchChoice(
  choices: ComponentWork[],
  c: Component,
  changes: Partial<ComponentWork>,
): ComponentWork[] {
  const choice = choices.find((item) => item.componentUuid === c.uuid);
  return [
    ...choices.filter((item) => item.componentUuid !== c.uuid),
    {
      componentUuid: c.uuid,
      version: c.version,
      action: "service",
      description: "",
      reference: "",
      ...choice,
      ...changes,
    },
  ];
}

function componentLabel(c: Component) {
  const position = c.installPosition ? ` · ${c.installPosition}` : "";
  return `${c.componentType}${position} · ${c.serial}`;
}

function ComponentEntry({ id, choices, onChange, completion }: EntryProps) {
  const c = completion.s.management?.find(
    (r): r is Component => r.kind === "component" && r.uuid === id,
  );
  if (!c)
    return (
      <p role="alert">
        An included component is unavailable. Review the component selection.
      </p>
    );
  return (
    <ComponentWorkItem
      c={c}
      label={componentLabel(c)}
      choice={choices.find((item) => item.componentUuid === id)}
      patch={(changes) => onChange(patchChoice(choices, c, changes))}
      completion={completion}
    />
  );
}

const repairs = (choice?: ComponentWork) =>
  choice?.action === "repair" || choice?.action === "both";
const overhauls = (choice?: ComponentWork) =>
  choice?.action === "overhaul" || choice?.action === "both";

function ComponentWorkItem(props: ItemProps) {
  const { c, label, choice, patch } = props;
  const moving = choice?.action === "install" || choice?.action === "remove";
  return (
    <div className="panel">
      <h4>{label}</h4>
      <p>P/N {c.partNumber || "Not recorded"}</p>
      <WorkSelect {...props} />
      <TrackingPreview {...props} />
      {choice?.action === "install" && (
        <InstallPosition {...props} choice={choice} />
      )}
      {choice?.action === "remove" && (
        <RemovalLocation {...props} choice={choice} />
      )}
      {choice && choice.version !== c.version && (
        <button type="button" onClick={() => patch({ version: c.version })}>
          Confirm current component readings
        </button>
      )}
      {(repairs(choice) || overhauls(choice) || moving) && (
        <WorkDetails {...props} choice={choice!} />
      )}
    </div>
  );
}

// A movement's action is fixed by its task; other work cannot become one.
function WorkSelect({ label, choice, patch, completion }: ItemProps) {
  const offered = Object.entries(componentWorkLabels).filter(([value]) =>
    choice?.taskUuid ? value === choice.action : !MOVEMENTS.includes(value),
  );
  return (
    <Field label={`${label} work performed`}>
      <select
        required={completion.closing}
        value={choice?.action ?? ""}
        onChange={(e) =>
          patch({ action: e.target.value as ComponentWork["action"] })
        }
      >
        <option value="">Select work performed</option>
        {offered.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function TrackingPreview({ c, choice, completion }: ItemProps) {
  const totals = tryComponentTotals(c, completion);
  if (!totals)
    return (
      <p role="alert">
        Completion readings or date precede this component’s baseline. Review
        the completion fields.
      </p>
    );
  return (
    <p>
      {completion.closing ? "At completion" : "Current readings (preview)"}: TSN{" "}
      {hoursText(totals.timeSinceNew)}; cycles {totals.cyclesSinceNew}. TSO{" "}
      {hoursText(totals.timeSinceOverhaul)} →{" "}
      {hoursText(overhauls(choice) ? 0 : totals.timeSinceOverhaul)}; TSR{" "}
      {hoursText(totals.timeSinceRepair)} →{" "}
      {hoursText(repairs(choice) ? 0 : totals.timeSinceRepair)}.
    </p>
  );
}

// componentTotals refuses readings before the component's baseline; the
// preview then asks the user to review the completion fields instead.
function tryComponentTotals(c: Component, { aircraft, date }: Completion) {
  try {
    return componentTotals(c, aircraft, date);
  } catch {
    return undefined;
  }
}

function hoursText(seconds: number | null) {
  if (seconds === null) return "Not recorded";
  return `${(seconds / SECONDS_PER_HOUR).toFixed(1)} h`;
}

function InstallPosition({ label, choice, patch }: ChosenProps) {
  return (
    <Field label={`${label} installation position`}>
      <select
        value={choice.installPosition ?? ""}
        onChange={(e) =>
          patch({
            installPosition: e.target.value as Component["installPosition"],
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
  );
}

function RemovalLocation({ label, choice, patch, completion }: ChosenProps) {
  return (
    <>
      <Field label={`${label} inventory location`}>
        <select
          value={choice.locationUuid ?? ""}
          onChange={(e) => patch({ locationUuid: e.target.value || undefined })}
        >
          <option value="">Select location</option>
          {partsInventory(completion.s).locations.map((l) => (
            <option key={l.uuid} value={l.uuid}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`${label} shelf / bin`}>
        <input
          maxLength={SHELF_MAX_LENGTH}
          value={choice.partsLocation ?? ""}
          onChange={(e) => patch({ partsLocation: e.target.value })}
        />
      </Field>
    </>
  );
}

function WorkDetails({ label, choice, patch, completion }: ChosenProps) {
  const { closing, date } = completion;
  return (
    <>
      <Field label={`${label} work description`}>
        <textarea
          required={closing}
          maxLength={DESCRIPTION_MAX_LENGTH}
          value={choice.description ?? ""}
          onChange={(e) => patch({ description: e.target.value })}
        />
      </Field>
      <Field
        label={`${label} supporting document / reference`}
        hint="Optional; attachments can be added to the work order."
      >
        <input
          maxLength={REFERENCE_MAX_LENGTH}
          value={choice.reference ?? ""}
          onChange={(e) => patch({ reference: e.target.value })}
        />
      </Field>
      <p className="notice">
        {closing ? "Closing this order records" : "Planned for closeout:"}{" "}
        {componentWorkLabels[choice.action].toLowerCase()}
        {closing ? ` on ${date}` : ""}
        {overhauls(choice)
          ? " and renews applicable overhaul requirements"
          : ""}
        .
      </p>
    </>
  );
}
