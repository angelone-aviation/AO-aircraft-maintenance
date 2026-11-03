import { useState } from "react";
import { can, type Snapshot } from "../domain/model";
import { recordProgram } from "../domain/programs";
import { POSITIONS, type Component } from "../domain/components";
import { partsInventory } from "../domain/requiredParts";
import { componentStorage } from "../domain/componentInventory";
import type { ComponentWork } from "../domain/workOrderComponentWork";
import { Field } from "./ui";

export function RequestedComponentMovement({
  s,
  aircraftUuid,
  choices,
  onAdd,
}: {
  s: Snapshot;
  aircraftUuid: string;
  choices: ComponentWork[];
  onAdd: (component: Component, work: ComponentWork) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [position, setPosition] =
    useState<Component["installPosition"]>("MAIN");
  const [location, setLocation] = useState("");
  const [shelf, setShelf] = useState("");
  const [description, setDescription] = useState("");
  const aircraft = s.aircraft.find((a) => a.uuid === aircraftUuid);
  const components = (s.management ?? []).filter(
    (r): r is Component =>
      r.kind === "component" &&
      !r.parentComponentUuid &&
      recordProgram(s, r) === aircraft?.programUuid &&
      (!r.installed || r.aircraftUuid === aircraftUuid) &&
      (!r.aircraftUuid || can(s, r.aircraftUuid, "maintenance")) &&
      !choices.some(
        (w) => w.componentUuid === r.uuid && w.action !== "service",
      ),
  );
  const component = components.find((c) => c.uuid === selected);
  const locations = partsInventory(s).locations;
  return (
    <section aria-label="Requested component movement">
      <button
        type="button"
        className="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Install/remove component
      </button>
      {open && (
        <div className="panel">
          <Field label="Component to install or remove">
            <select
              value={component ? selected : ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Select a component</option>
              {[true, false].map((installed) => (
                <optgroup
                  key={String(installed)}
                  label={
                    installed
                      ? `Remove from ${aircraft?.registration ?? "this aircraft"}`
                      : "Install from inventory"
                  }
                >
                  {components
                    .filter((c) => c.installed === installed)
                    .map((c) => (
                      <option key={c.uuid} value={c.uuid}>
                        {c.model || c.componentType} · P/N {c.partNumber} · S/N{" "}
                        {c.serial} ·{" "}
                        {installed ? c.installPosition : componentStorage(s, c)}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
          {!components.length && (
            <p>
              No eligible components are available. Receive new components into
              inventory first.
            </p>
          )}
          {component && (
            <>
              <p>
                {component.installed
                  ? "Remove this component to inventory."
                  : `Install this component on ${aircraft?.registration}.`}{" "}
                The movement takes effect when the work order is finished.
              </p>
              {component.installed ? (
                <>
                  <Field label="Removal inventory location">
                    <select
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                    >
                      <option value="">Select location</option>
                      {locations.map((l) => (
                        <option key={l.uuid} value={l.uuid}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Removal shelf / bin">
                    <input
                      value={shelf}
                      maxLength={150}
                      onChange={(e) => setShelf(e.target.value)}
                    />
                  </Field>
                </>
              ) : (
                <Field label="Installation position">
                  <select
                    value={position}
                    onChange={(e) =>
                      setPosition(
                        e.target.value as Component["installPosition"],
                      )
                    }
                  >
                    {POSITIONS.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Component movement description / reason">
                <textarea
                  value={description}
                  maxLength={9000}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
              <button
                type="button"
                className="button"
                disabled={
                  !description.trim() ||
                  (component.installed &&
                    (locations.length
                      ? !locations.some((l) => l.uuid === location)
                      : !shelf.trim()))
                }
                onClick={() => {
                  onAdd(component, {
                    componentUuid: component.uuid,
                    version: component.version,
                    action: component.installed ? "remove" : "install",
                    description: description.trim(),
                    reference: "",
                    taskUuid: crypto.randomUUID(),
                    installPosition: component.installed ? undefined : position,
                    locationUuid: component.installed
                      ? location || undefined
                      : undefined,
                    partsLocation: component.installed
                      ? shelf.trim() || undefined
                      : undefined,
                  });
                  setSelected("");
                  setDescription("");
                  setOpen(false);
                }}
              >
                Add component movement
              </button>
              <p className="muted">
                Save the work order to keep this requested work.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
