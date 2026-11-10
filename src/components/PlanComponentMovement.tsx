/**
 * Responsibility: Plans a component's installation or removal as work on a
 *   new or open work order; the component moves when that order closes.
 * Layer: UI. React component; work order rules live in src/domain.
 * Dependencies: src/data/store.ts, src/domain (model, programs, components,
 *   workOrders, requiredParts), ./ui.tsx.
 */
import { useState } from "react";
import { useWorkspace } from "../data/store";
import { can, localDate, type Snapshot } from "../domain/model";
import { recordProgram } from "../domain/programs";
import { POSITIONS, type Component } from "../domain/components";
import {
  isOpenWorkOrder,
  type WorkOrder,
  type WorkOrderCommand,
  type WorkOrderFields,
} from "../domain/workOrders";
import { partsInventory } from "../domain/requiredParts";
import { AsyncForm, Field, value } from "./ui";

// The limits componentWorkSchema sets.
const SHELF_MAX_LENGTH = 150;
const DESCRIPTION_MAX_LENGTH = 10000;
const REFERENCE_MAX_LENGTH = 2000;

type SaveCommand = Extract<WorkOrderCommand, { action: "save" }>;
type MovementWork = NonNullable<SaveCommand["componentWork"]>[number];
type Target = ReturnType<typeof useMovementTarget>;

/**
 * Adds a component's installation, or its removal when installed, to a new
 * or open work order as component work and a requested task. Needs a
 * connection and the maintenance permission on an aircraft of the
 * component's Flight Program; an installed component leaves only its own.
 *
 * @param props.c - The component to move.
 * @param props.onDone - Called once the work order is saved.
 * @returns A form that shows "This work order is no longer open. …" or
 *   "This component is already included. …" instead of saving.
 */
export function PlanComponentMovement({
  c,
  onDone,
}: {
  c: Component;
  onDone: () => void;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const target = useMovementTarget(s!, c);
  const { aircraftUuid, orderUuid, orders } = target;
  return (
    <AsyncForm
      disabled={!online || !connected || !aircraftUuid}
      submitLabel="Add movement to work order"
      onSubmit={async (d) => {
        const order = orders.find((w) => w.uuid === orderUuid);
        assertCanAdd(c, orderUuid, order);
        await backend!.workOrder(movementCommand(c, d, aircraftUuid, order));
        onDone();
      }}
    >
      <OrderField target={target} />
      <p>
        The component stays in its current location until this work order is
        completed. Complete its task and review the component work at closeout
        to record the movement in the logbook.
      </p>
      <AircraftField target={target} />
      {c.installed ? <RemovalFields s={s!} /> : <InstallFields />}
      <MovementNotes />
    </AsyncForm>
  );
}

function useMovementTarget(s: Snapshot, c: Component) {
  const aircraft = s.aircraft.filter(
    (a) =>
      can(s, a.uuid, "maintenance") &&
      a.programUuid === recordProgram(s, c) &&
      (!c.installed || a.uuid === c.aircraftUuid),
  );
  const [aircraftUuid, setAircraft] = useState(aircraft[0]?.uuid ?? "");
  const [orderUuid, setOrder] = useState("");
  const orders = (s.workOrders ?? []).filter(
    (w) =>
      aircraft.some((a) => a.uuid === w.aircraftUuid) && isOpenWorkOrder(w),
  );
  // An open order fixes the aircraft; a new order keeps the one chosen.
  const pickOrder = (uuid: string) => {
    setOrder(uuid);
    const order = orders.find((w) => w.uuid === uuid);
    if (order) setAircraft(order.aircraftUuid);
  };
  return { aircraft, orders, aircraftUuid, setAircraft, orderUuid, pickOrder };
}

function assertCanAdd(c: Component, orderUuid: string, order?: WorkOrder) {
  if (orderUuid && !order)
    throw new Error(
      "This work order is no longer open. Select another work order or create a new one.",
    );
  if (order?.componentWork?.some((w) => w.componentUuid === c.uuid))
    throw new Error(
      "This component is already included. Review its work in that work order.",
    );
}

function movementCommand(
  c: Component,
  data: FormData,
  aircraftUuid: string,
  order?: WorkOrder,
): SaveCommand {
  const taskUuid = crypto.randomUUID();
  const description = value(data, "description");
  return {
    action: "save",
    uuid: order?.uuid ?? crypto.randomUUID(),
    version: order?.version ?? 0,
    fields: order ?? newOrderFields(c, aircraftUuid),
    componentUuids: order?.componentReadings.map((r) => r.componentUuid) ?? [],
    componentWork: [
      ...(order?.componentWork ?? []),
      movementWork(c, data, taskUuid, description),
    ],
    tasks: [
      ...(order?.tasks ?? []),
      {
        uuid: taskUuid,
        source: { kind: "manual", uuid: taskUuid },
        description: `${movementTitle(c)}. ${description}`,
        status: "requested",
        notes: "",
        partsDelay: "",
      },
    ],
  };
}

function newOrderFields(c: Component, aircraftUuid: string): WorkOrderFields {
  return {
    aircraftUuid,
    number: "",
    dateOpened: localDate(),
    supervisor: "",
    scope: movementTitle(c),
    priority: "routine",
    status: "open",
    completionDate: "",
    releaseOutcome: "",
    finalReview: "",
  };
}

function movementWork(
  c: Component,
  data: FormData,
  taskUuid: string,
  description: string,
): MovementWork {
  const removal = !!c.installed;
  return {
    componentUuid: c.uuid,
    version: c.version,
    action: removal ? "remove" : "install",
    taskUuid,
    description,
    reference: value(data, "reference"),
    installPosition: removal
      ? undefined
      : (value(data, "position") as Component["installPosition"]),
    locationUuid: removal ? value(data, "location") || undefined : undefined,
    partsLocation: removal ? value(data, "shelf") || undefined : undefined,
  };
}

function movementTitle(c: Component) {
  const verb = c.installed ? "Remove" : "Install";
  return `${verb} ${c.componentType} P/N ${c.partNumber}; S/N ${c.serial}`;
}

function OrderField({ target }: { target: Target }) {
  const { orders, aircraft, orderUuid, pickOrder } = target;
  return (
    <>
      <Field label="Work order">
        <select
          name="order"
          value={orderUuid}
          onChange={(e) => pickOrder(e.target.value)}
        >
          <option value="">Create a new work order</option>
          <optgroup label="Open work orders">
            {orders.map((w) => (
              <option key={w.uuid} value={w.uuid}>
                {w.number} ·{" "}
                {aircraft.find((a) => a.uuid === w.aircraftUuid)?.registration}{" "}
                · {w.scope}
              </option>
            ))}
          </optgroup>
        </select>
      </Field>
      {!orders.length && (
        <p className="muted">
          No open work orders are available. Create a new work order below.
        </p>
      )}
    </>
  );
}

function AircraftField({ target }: { target: Target }) {
  return (
    <Field label="Movement aircraft">
      <select
        value={target.aircraftUuid}
        disabled={!!target.orderUuid}
        onChange={(e) => target.setAircraft(e.target.value)}
        required
      >
        {target.aircraft.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration}
          </option>
        ))}
      </select>
    </Field>
  );
}

function InstallFields() {
  return (
    <Field label="Installation position">
      <select name="position">
        {POSITIONS.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
    </Field>
  );
}

// Without inventory locations, the removed part needs a shelf or bin.
function RemovalFields({ s }: { s: Snapshot }) {
  const { locations } = partsInventory(s);
  return (
    <>
      <Field label="Removal inventory location">
        <select name="location" required={locations.length > 0}>
          <option value="">Select location</option>
          {locations.map((l) => (
            <option key={l.uuid} value={l.uuid}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Shelf / bin">
        <input
          name="shelf"
          maxLength={SHELF_MAX_LENGTH}
          required={!locations.length}
        />
      </Field>
    </>
  );
}

function MovementNotes() {
  return (
    <>
      <Field label="Movement description / reason">
        <textarea
          name="description"
          required
          maxLength={DESCRIPTION_MAX_LENGTH}
        />
      </Field>
      <Field
        label="Supporting document / reference"
        hint="Attach an 8130 or other supporting document in the inventory item’s attachments."
      >
        <input name="reference" maxLength={REFERENCE_MAX_LENGTH} />
      </Field>
    </>
  );
}
