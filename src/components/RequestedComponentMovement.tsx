/**
 * Responsibility: The "Install/remove component" panel on the work order
 *   form, which adds a requested component movement to the order's work.
 * Layer: UI. Hands the movement to its parent; saving the order stores it.
 * Dependencies: react, src/domain (model, programs, components, requiredParts,
 *   componentInventory, workOrderComponentWork), ./ui.
 */
import { useState } from "react";
import { can, type Snapshot } from "../domain/model";
import { recordProgram } from "../domain/programs";
import { POSITIONS, type Component } from "../domain/components";
import { partsInventory } from "../domain/requiredParts";
import { componentStorage } from "../domain/componentInventory";
import type { ComponentWork } from "../domain/workOrderComponentWork";
import { Field } from "./ui";

const BLANK_DRAFT = {
  selected: "",
  position: "MAIN" as Component["installPosition"],
  location: "",
  shelf: "",
  description: "",
};

type Draft = typeof BLANK_DRAFT;
type MovementProps = {
  s: Snapshot;
  aircraftUuid: string;
  choices: ComponentWork[];
  onAdd: (component: Component, work: ComponentWork) => void;
};
type Locations = ReturnType<typeof partsInventory>["locations"];
type DraftProps = { draft: Draft; patch: (next: Partial<Draft>) => void };
type DetailProps = DraftProps & {
  component: Component;
  registration?: string;
  locations: Locations;
  onAdd: (work: ComponentWork) => void;
};

/**
 * A toggle and panel for requesting a component's removal from the aircraft
 * or installation from inventory, with where it goes and why.
 *
 * @param props.choices - The order's component work; a component already
 *   given work other than a service is not offered again.
 * @param props.onAdd - Receives the component and its movement (with a new
 *   task uuid); the panel then closes and clears its choice.
 * @returns The section. Adding needs a reason and, for a removal, a known
 *   inventory location, or a shelf when the program has no locations.
 */
export function RequestedComponentMovement(props: MovementProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(BLANK_DRAFT);
  const patch = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));
  const add = (component: Component, work: ComponentWork) => {
    props.onAdd(component, work);
    patch({ selected: "", description: "" });
    setOpen(false);
  };
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
        <MovementPanel {...props} draft={draft} patch={patch} onAdd={add} />
      )}
    </section>
  );
}

function MovementPanel(props: MovementProps & DraftProps) {
  const { s, draft, patch } = props;
  const registration = s.aircraft.find(
    (a) => a.uuid === props.aircraftUuid,
  )?.registration;
  const components = eligibleComponents(s, props.aircraftUuid, props.choices);
  const component = components.find((c) => c.uuid === draft.selected);
  return (
    <div className="panel">
      <ComponentChoice
        s={s}
        registration={registration}
        components={components}
        value={component ? draft.selected : ""}
        onChange={(selected) => patch({ selected })}
      />
      {!components.length && (
        <p>
          No eligible components are available. Receive new components into
          inventory first.
        </p>
      )}
      {component && (
        <MovementDetails
          draft={draft}
          patch={patch}
          component={component}
          onAdd={(work) => props.onAdd(component, work)}
          registration={registration}
          locations={partsInventory(s).locations}
        />
      )}
    </div>
  );
}

function ComponentChoice(props: {
  s: Snapshot;
  registration?: string;
  components: Component[];
  value: string;
  onChange: (uuid: string) => void;
}) {
  return (
    <Field label="Component to install or remove">
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        <option value="">Select a component</option>
        {[true, false].map((installed) => (
          <optgroup
            key={String(installed)}
            label={
              installed
                ? `Remove from ${props.registration ?? "this aircraft"}`
                : "Install from inventory"
            }
          >
            {props.components
              .filter((c) => c.installed === installed)
              .map((c) => (
                <option key={c.uuid} value={c.uuid}>
                  {c.model || c.componentType} · P/N {c.partNumber} · S/N{" "}
                  {c.serial} ·{" "}
                  {installed ? c.installPosition : componentStorage(props.s, c)}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}

function MovementDetails(props: DetailProps) {
  const { component, draft, patch } = props;
  return (
    <>
      <p>
        {component.installed
          ? "Remove this component to inventory."
          : `Install this component on ${props.registration}.`}{" "}
        The movement takes effect when the work order is finished.
      </p>
      {component.installed ? (
        <RemovalFields {...props} />
      ) : (
        <InstallField draft={draft} patch={patch} />
      )}
      <Field label="Component movement description / reason">
        <textarea
          value={draft.description}
          maxLength={9000}
          onChange={(e) => patch({ description: e.target.value })}
        />
      </Field>
      <button
        type="button"
        className="button"
        disabled={missingDetails(component, draft, props.locations)}
        onClick={() => props.onAdd(movementWork(component, draft))}
      >
        Add component movement
      </button>
      <p className="muted">Save the work order to keep this requested work.</p>
    </>
  );
}

function RemovalFields({ draft, patch, locations }: DetailProps) {
  return (
    <>
      <Field label="Removal inventory location">
        <select
          value={draft.location}
          onChange={(e) => patch({ location: e.target.value })}
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
          value={draft.shelf}
          maxLength={150}
          onChange={(e) => patch({ shelf: e.target.value })}
        />
      </Field>
    </>
  );
}

function InstallField({ draft, patch }: DraftProps) {
  return (
    <Field label="Installation position">
      <select
        value={draft.position}
        onChange={(e) =>
          patch({ position: e.target.value as Component["installPosition"] })
        }
      >
        {POSITIONS.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
    </Field>
  );
}

// Top-level components of the aircraft's program, in inventory or on this
// aircraft, that the user may maintain and that have no non-service work on
// this order yet.
function eligibleComponents(
  s: Snapshot,
  aircraftUuid: string,
  choices: ComponentWork[],
) {
  const program = s.aircraft.find((a) => a.uuid === aircraftUuid)?.programUuid;
  return (s.management ?? []).filter(
    (r): r is Component =>
      r.kind === "component" &&
      !r.parentComponentUuid &&
      recordProgram(s, r) === program &&
      (!r.installed || r.aircraftUuid === aircraftUuid) &&
      (!r.aircraftUuid || can(s, r.aircraftUuid, "maintenance")) &&
      !choices.some(
        (w) => w.componentUuid === r.uuid && w.action !== "service",
      ),
  );
}

function missingDetails(c: Component, draft: Draft, locations: Locations) {
  return (
    !draft.description.trim() ||
    (c.installed &&
      (locations.length
        ? !locations.some((l) => l.uuid === draft.location)
        : !draft.shelf.trim()))
  );
}

function movementWork(c: Component, draft: Draft): ComponentWork {
  return {
    componentUuid: c.uuid,
    version: c.version,
    action: c.installed ? "remove" : "install",
    description: draft.description.trim(),
    reference: "",
    taskUuid: crypto.randomUUID(),
    installPosition: c.installed ? undefined : draft.position,
    locationUuid: c.installed ? draft.location || undefined : undefined,
    partsLocation: c.installed ? draft.shelf.trim() || undefined : undefined,
  };
}
