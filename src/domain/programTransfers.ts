/**
 * Responsibility: Moves an aircraft, component or storage location, with the
 *   records that belong to it, from the active Flight Program to another.
 * Layer: Domain. Applier on a working snapshot; no I/O, no React.
 * Dependencies: src/domain/programs.ts, partsRequests.ts, purchaseOrders.ts,
 *   changeLog.ts, rejection.ts; model.ts, fleet.ts, management.ts,
 *   components.ts (types).
 *
 * Existing change-log rows are never re-tagged (ADR-0005): History follows
 * each record's current owner instead.
 */
import type { AuditEntry, Snapshot } from "./model";
import type { Program } from "./fleet";
import type { ManagedRecord, Stock } from "./management";
import type { Component } from "./components";
import { activeProgram, ownsActive, recordProgram } from "./programs";
import { requestStatus } from "./partsRequests";
import { outstanding, type POLine, type PurchaseOrder } from "./purchaseOrders";
import { Rejection } from "./rejection";
import { auditEntry } from "./changeLog";

/**
 * The longest transfer reason, as other change-log reasons allow; the form
 * caps it and {@link transferProgram} refuses a longer one.
 */
export const TRANSFER_REASON_MAX_LENGTH = 2000;

/** A request to move one record to another Flight Program. */
export interface ProgramTransfer {
  kind: "aircraft" | "component" | "location";
  uuid: string;
  /** The destination Flight Program's uuid. */
  destination: string;
  reason: string;
}

// The records a transfer moves: components carry their child records along.
interface Moving {
  components: Set<string>;
  entities: Set<string>;
}

/**
 * Moves a record to another Flight Program and appends one
 * "program.transferred" change-log row, first in `s.audit`. An aircraft
 * takes its components, inspections, checklists, component setups and the
 * program's expiring dates for it (one "expiring-date.transferred" row
 * each, after the transfer's row); a component leaves its aircraft; a
 * location takes its stock. Each moved record's version goes up.
 *
 * @param s - The working snapshot; mutated in place.
 * @param input - The record, destination and reason.
 * @returns The uuids whose change-log rows the destination must now reach:
 *   the record, its checklists, setups, expiring dates, components and their
 *   child records, or a location's stock. Moved inspections are not listed.
 * @throws {Rejection} When the user is not an active system administrator,
 *   the reason is blank or longer than {@link TRANSFER_REASON_MAX_LENGTH}
 *   ("Keep the transfer reason to 2000 characters or fewer."), the destination is missing or is the active program,
 *   the record is not in the active program, or open parts requests, an
 *   installed component, linked inspections, tracked components, reserved
 *   stock, open purchase-order lines, or a component's repair (out for
 *   repair, or an open repair request or order) still tie it here. The last
 *   three name the requests and orders to settle.
 */
export function transferProgram(s: Snapshot, input: ProgramTransfer) {
  if (!s.user.active || !s.user.isAdmin)
    throw new Rejection(
      "System administrator required for Flight Program transfers.",
    );
  if (!input.reason.trim())
    throw new Rejection("A transfer reason is required.");
  if (input.reason.length > TRANSFER_REASON_MAX_LENGTH)
    throw new Rejection(
      `Keep the transfer reason to ${TRANSFER_REASON_MAX_LENGTH} characters or fewer.`,
    );
  const destination = s.programs?.find((p) => p.uuid === input.destination);
  if (!destination)
    throw new Rejection("Destination Flight Program not found.");
  const source = activeProgram(s);
  if (source === input.destination)
    throw new Rejection("Select a different Flight Program.");
  const moving: Moving = {
    components: new Set(),
    entities: new Set([input.uuid]),
  };
  if (input.kind === "aircraft") claimAircraft(s, input, destination, moving);
  else claimRecord(s, input, moving);
  moveRecords(s.management ?? [], input, moving);
  s.audit.unshift({
    uuid: crypto.randomUUID(),
    actorId: s.user.id,
    at: Date.now(),
    action: "program.transferred",
    entityUuid: input.uuid,
    programUuid: input.destination,
    aircraftUuid: input.kind === "aircraft" ? input.uuid : undefined,
    reason: input.reason,
    before: JSON.stringify({ programUuid: source }),
    after: JSON.stringify({ programUuid: input.destination }),
  });
  return moving.entities;
}

function claimAircraft(
  s: Snapshot,
  input: ProgramTransfer,
  destination: Program,
  moving: Moving,
) {
  const aircraft = s.aircraft.find((a) => a.uuid === input.uuid);
  if (!aircraft || !ownsActive(s, aircraft.programUuid))
    throw new Rejection("Aircraft not found in active Flight Program.");
  assertAircraftUncommitted(s, aircraft.uuid);
  aircraft.programUuid = destination.uuid;
  aircraft.program = destination.name;
  aircraft.version++;
  for (const r of s.management ?? []) {
    if (r.kind !== "component" || r.aircraftUuid !== aircraft.uuid) continue;
    assertComponentUncommitted(s, r);
    moving.components.add(r.uuid);
  }
  for (const i of s.inspections) {
    if (i.aircraftUuid !== aircraft.uuid) continue;
    i.programUuid = destination.uuid;
    i.version = (i.version ?? 0) + 1;
  }
  for (const c of s.checklists ?? []) {
    if (c.aircraftUuid !== aircraft.uuid) continue;
    c.programUuid = destination.uuid;
    c.version++;
    moving.entities.add(c.uuid);
  }
  for (const d of s.componentSetups ?? []) {
    if (d.aircraftUuid !== aircraft.uuid) continue;
    d.programUuid = destination.uuid;
    moving.entities.add(d.uuid);
  }
  moveExpiringItems(s, input, moving);
}

// An expiring date names its aircraft (registration, insurance), and only
// its program's administrators may edit it, so it moves with the aircraft;
// each move is its own change-log row, as the item's earlier rows are.
function moveExpiringItems(
  s: Snapshot,
  input: ProgramTransfer,
  moving: Moving,
) {
  const source = activeProgram(s);
  const rows: AuditEntry[] = [];
  s.expiringItems = (s.expiringItems ?? []).map((item) => {
    if (item.aircraftUuid !== input.uuid || item.programUuid !== source)
      return item;
    const next = {
      ...item,
      programUuid: input.destination,
      version: item.version + 1,
    };
    moving.entities.add(item.uuid);
    rows.push(
      auditEntry(s, {
        action: "expiring-date.transferred",
        entityUuid: item.uuid,
        aircraftUuid: item.aircraftUuid,
        programUuid: input.destination,
        reason: input.reason,
        before: item,
        after: next,
      }),
    );
    return next;
  });
  s.audit.unshift(...rows);
}

// Reservations and orders point at this program's stock and vendors, and an
// issued order can only be received in the program that issued it.
function assertAircraftUncommitted(s: Snapshot, aircraftUuid: string) {
  if (hasOpenPartsRequests(s, aircraftUuid))
    throw new Rejection(
      "Cancel or fulfill this aircraft's open parts requests before transferring it.",
    );
  const ordered = describeOpenOrderLines(
    s,
    (l) => l.aircraftUuid === aircraftUuid,
  );
  if (ordered.length)
    throw new Rejection(
      `Receive or cancel open purchase order lines (${ordered.join(", ")}) before transferring this aircraft.`,
    );
}

// A component sent for repair comes back on the order that shipped it, in the
// program that issued it; its repair request and order stay behind too.
function assertComponentUncommitted(s: Snapshot, component: Component) {
  const label = `${component.partNumber} S/N ${component.serial}`;
  const orders = s.purchaseOrders ?? [];
  if (component.outForRepair) {
    const shippedOn = orders.find(
      (p) => p.uuid === component.outForRepair?.poUuid,
    );
    throw new Rejection(
      `Receive ${label} back from repair on ${shippedOn?.number ?? "its purchase order"} before transferring it.`,
    );
  }
  const open = [
    ...openRepairRequests(s, component.uuid),
    ...orders
      .filter((p) => isRepairing(p, component.uuid))
      .map((p) => p.number),
  ];
  if (open.length)
    throw new Rejection(
      `Cancel or complete the open repair requests and orders for ${label} (${open.join(", ")}) before transferring it.`,
    );
}

function openRepairRequests(s: Snapshot, componentUuid: string) {
  return (s.partsRequests ?? [])
    .filter(
      (r) =>
        r.lines.some((l) => l.componentUuid === componentUuid) &&
        !["Cancelled", "Fulfilled"].includes(requestStatus(s, r)),
    )
    .map((r) => r.number);
}

function isRepairing(p: PurchaseOrder, componentUuid: string) {
  return (
    ["draft", "issued"].includes(p.phase) &&
    p.lines.some(
      (l) => l.repairComponentUuid === componentUuid && outstanding(p, l) > 0,
    )
  );
}

function hasOpenPartsRequests(s: Snapshot, aircraftUuid: string) {
  return (s.partsRequests ?? []).some(
    (r) =>
      r.aircraftUuid === aircraftUuid &&
      !["Cancelled", "Fulfilled"].includes(requestStatus(s, r)),
  );
}

function claimRecord(s: Snapshot, input: ProgramTransfer, moving: Moving) {
  const records = s.management ?? [];
  const record = records.find(
    (r) => r.kind === input.kind && r.uuid === input.uuid,
  );
  if (!record || !ownsActive(s, recordProgram(s, record)))
    throw new Rejection("Record not found in active Flight Program.");
  if (record.kind === "component") {
    if (record.installed)
      throw new Rejection(
        "Remove the component before transferring it, or transfer its aircraft.",
      );
    if (s.inspections.some((i) => i.componentUuid === record.uuid))
      throw new Rejection(
        "Transfer the associated aircraft while this component has linked inspection schedules.",
      );
    assertComponentUncommitted(s, record);
    moving.components.add(record.uuid);
  }
  if (record.kind === "location") claimLocation(s, record.uuid, moving);
}

function claimLocation(s: Snapshot, locationUuid: string, moving: Moving) {
  const records = s.management ?? [];
  if (
    records.some(
      (c) => c.kind === "component" && c.locationUuid === locationUuid,
    )
  )
    throw new Rejection(
      "Move tracked components to another inventory location before transferring this location.",
    );
  assertLocationUncommitted(s, locationUuid);
  for (const r of records)
    if (r.kind === "stock" && r.locationUuid === locationUuid)
      moving.entities.add(r.uuid);
}

// Reservations and open orders point at this program's requests and vendors,
// so a location stays while its stock is reserved or an issued purchase-order
// line still delivers into it, as aircraft wait for open parts requests.
function assertLocationUncommitted(s: Snapshot, locationUuid: string) {
  const stock = (s.management ?? []).filter(
    (x): x is Stock => x.kind === "stock" && x.locationUuid === locationUuid,
  );
  const reserved = stock.flatMap((x) => describeReservation(s, x));
  const stockIds = new Set(stock.map((x) => x.uuid));
  const ordered = describeOpenOrderLines(
    s,
    (l) => l.locationUuid === locationUuid || stockIds.has(l.stockUuid),
  );
  if (!reserved.length && !ordered.length) return;
  const release = `release reserved stock (${reserved.join(", ")})`;
  const receive = `receive or cancel open purchase order lines (${ordered.join(", ")})`;
  const steps = [
    ...(reserved.length ? [release] : []),
    ...(ordered.length ? [receive] : []),
  ].join(" and ");
  throw new Rejection(
    `${steps[0].toUpperCase()}${steps.slice(1)} before transferring this location.`,
  );
}

function describeReservation(s: Snapshot, stock: Stock): string[] {
  const requests = (s.partsRequests ?? [])
    .filter((r) =>
      r.reservations.some((a) => a.stockUuid === stock.uuid && a.quantity > 0),
    )
    .map((r) => r.number);
  if (requests.length)
    return [`${stock.partNumber} for ${requests.join(", ")}`];
  return stock.reservedQuantity ? [stock.partNumber] : [];
}

// The lines of issued orders, not yet fully received or cancelled, that
// point at the record being moved.
function describeOpenOrderLines(
  s: Snapshot,
  pointsAtRecord: (l: POLine) => boolean,
): string[] {
  return (s.purchaseOrders ?? [])
    .filter((p) => p.phase === "issued")
    .flatMap((p) =>
      p.lines
        .filter((l) => pointsAtRecord(l) && outstanding(p, l) > 0)
        .map((l) => `${l.partNumber} on ${p.number}`),
    );
}

function moveRecords(
  records: ManagedRecord[],
  input: ProgramTransfer,
  { components, entities }: Moving,
) {
  for (const r of records) {
    if (
      components.has(r.uuid) ||
      ("componentUuid" in r && components.has(r.componentUuid))
    )
      entities.add(r.uuid);
    if (!entities.has(r.uuid)) continue;
    if (r.kind === "component") detachFromLocation(records, r);
    r.programUuid = input.destination;
    r.version++;
    if (input.kind === "component" && "aircraftUuid" in r) r.aircraftUuid = "";
  }
}

// The old program's location can't hold the record, so its name stays as
// free text unless the component already names a parts location.
function detachFromLocation(
  records: ManagedRecord[],
  component: Extract<ManagedRecord, { kind: "component" }>,
) {
  if (!component.locationUuid) return;
  const prior = records.find(
    (l) => l.kind === "location" && l.uuid === component.locationUuid,
  );
  component.partsLocation =
    component.partsLocation ||
    (prior?.kind === "location" ? prior.name : "Previous inventory location");
  component.locationUuid = undefined;
}
