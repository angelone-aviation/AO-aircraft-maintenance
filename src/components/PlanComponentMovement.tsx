import { useState } from "react";
import { localDate } from "../domain/model";
import { useWorkspace } from "../data/store";
import { can } from "../domain/model";
import { recordProgram } from "../domain/programs";
import { POSITIONS, type Component } from "../domain/components";
import { isOpenWorkOrder, type WorkOrderFields } from "../domain/workOrders";
import { AsyncForm, Field, value } from "./ui";
import { partsInventory } from "../domain/requiredParts";

export function PlanComponentMovement({
  c,
  onDone,
}: {
  c: Component;
  onDone: () => void;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const aircraft = s!.aircraft.filter(
    (a) =>
      can(s!, a.uuid, "maintenance") &&
      a.programUuid === recordProgram(s!, c) &&
      (!c.installed || a.uuid === c.aircraftUuid),
  );
  const [aircraftUuid, setAircraft] = useState(aircraft[0]?.uuid ?? "");
  const [orderUuid, setOrder] = useState("");
  const orders = (s!.workOrders ?? []).filter(
    (w) =>
      aircraft.some((a) => a.uuid === w.aircraftUuid) && isOpenWorkOrder(w),
  );
  const action = c.installed ? "remove" : "install";
  return (
    <AsyncForm
      disabled={!online || !connected || !aircraftUuid}
      submitLabel="Add movement to work order"
      onSubmit={async (d) => {
        const order = orders.find((w) => w.uuid === orderUuid);
        if (orderUuid && !order)
          throw new Error(
            "This work order is no longer open. Select another work order or create a new one.",
          );
        if (order?.componentWork?.some((w) => w.componentUuid === c.uuid))
          throw new Error(
            "This component is already included. Review its work in that work order.",
          );
        const taskUuid = crypto.randomUUID();
        const description = value(d, "description");
        const fields: WorkOrderFields = order ?? {
          aircraftUuid,
          number: "",
          dateOpened: localDate(),
          supervisor: "",
          scope: `${c.installed ? "Remove" : "Install"} ${c.componentType} P/N ${c.partNumber}; S/N ${c.serial}`,
          priority: "routine",
          status: "open",
          completionDate: "",
          releaseOutcome: "",
          finalReview: "",
        };
        await backend!.workOrder({
          action: "save",
          uuid: order?.uuid ?? crypto.randomUUID(),
          version: order?.version ?? 0,
          fields,
          componentUuids:
            order?.componentReadings.map((r) => r.componentUuid) ?? [],
          componentWork: [
            ...(order?.componentWork ?? []),
            {
              componentUuid: c.uuid,
              version: c.version,
              action,
              taskUuid,
              description,
              reference: value(d, "reference"),
              installPosition:
                action === "install"
                  ? (value(d, "position") as Component["installPosition"])
                  : undefined,
              locationUuid:
                action === "remove"
                  ? value(d, "location") || undefined
                  : undefined,
              partsLocation:
                action === "remove"
                  ? value(d, "shelf") || undefined
                  : undefined,
            },
          ],
          tasks: [
            ...(order?.tasks ?? []),
            {
              uuid: taskUuid,
              source: { kind: "manual", uuid: taskUuid },
              description: `${c.installed ? "Remove" : "Install"} ${c.componentType} P/N ${c.partNumber}; S/N ${c.serial}. ${description}`,
              status: "requested",
              notes: "",
              partsDelay: "",
            },
          ],
        });
        onDone();
      }}
    >
      <Field label="Work order">
        <select
          name="order"
          value={orderUuid}
          onChange={(e) => {
            const selected = e.target.value;
            setOrder(selected);
            const order = orders.find((w) => w.uuid === selected);
            if (order) setAircraft(order.aircraftUuid);
          }}
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
      <p>
        The component stays in its current location until this work order is
        completed. Complete its task and review the component work at closeout
        to record the movement in the logbook.
      </p>
      <Field label="Movement aircraft">
        <select
          value={aircraftUuid}
          disabled={!!orderUuid}
          onChange={(e) => setAircraft(e.target.value)}
          required
        >
          {aircraft.map((a) => (
            <option key={a.uuid} value={a.uuid}>
              {a.registration}
            </option>
          ))}
        </select>
      </Field>
      {action === "install" ? (
        <Field label="Installation position">
          <select name="position">
            {POSITIONS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
      ) : (
        <>
          <Field label="Removal inventory location">
            <select
              name="location"
              required={partsInventory(s!).locations.length > 0}
            >
              <option value="">Select location</option>
              {partsInventory(s!).locations.map((l) => (
                <option key={l.uuid} value={l.uuid}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Shelf / bin">
            <input
              name="shelf"
              maxLength={150}
              required={!partsInventory(s!).locations.length}
            />
          </Field>
        </>
      )}
      <Field label="Movement description / reason">
        <textarea name="description" required maxLength={10000} />
      </Field>
      <Field label="Supporting document / reference">
        <input name="reference" maxLength={2000} />
        <small>
          Attach an 8130 or other supporting document in the inventory item’s
          attachments.
        </small>
      </Field>
    </AsyncForm>
  );
}
