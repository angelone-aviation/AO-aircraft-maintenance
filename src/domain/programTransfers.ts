import type { Snapshot } from "./model";
import { activeProgram, ownsActive, recordProgram } from "./programs";
import { requestStatus } from "./partsRequests";
import { outstanding } from "./purchaseOrders";
import type { Stock } from "./management";
export interface ProgramTransfer {
  kind: "aircraft" | "component" | "location";
  uuid: string;
  destination: string;
  reason: string;
}
// Reservations and open orders point at this program's requests and vendors,
// so a location stays while its stock is reserved or an issued purchase-order
// line still delivers into it, as aircraft wait for open parts requests.
function assertLocationUncommitted(s: Snapshot, locationUuid: string) {
  const stock = (s.management ?? []).filter(
    (x): x is Stock => x.kind === "stock" && x.locationUuid === locationUuid,
  );
  const stockIds = new Set(stock.map((x) => x.uuid));
  const reserved = stock.flatMap((x) => {
    const requests = (s.partsRequests ?? [])
      .filter((r) =>
        r.reservations.some((a) => a.stockUuid === x.uuid && a.quantity > 0),
      )
      .map((r) => r.number);
    if (!requests.length && !x.reservedQuantity) return [];
    return [
      requests.length
        ? `${x.partNumber} for ${requests.join(", ")}`
        : x.partNumber,
    ];
  });
  const ordered = (s.purchaseOrders ?? [])
    .filter((p) => p.phase === "issued")
    .flatMap((p) =>
      p.lines
        .filter(
          (l) =>
            (l.locationUuid === locationUuid || stockIds.has(l.stockUuid)) &&
            outstanding(p, l) > 0,
        )
        .map((l) => `${l.partNumber} on ${p.number}`),
    );
  if (!reserved.length && !ordered.length) return;
  const release = `release reserved stock (${reserved.join(", ")})`;
  const receive = `receive or cancel open purchase order lines (${ordered.join(", ")})`;
  const steps = [
    ...(reserved.length ? [release] : []),
    ...(ordered.length ? [receive] : []),
  ].join(" and ");
  throw new Error(
    `${steps[0].toUpperCase()}${steps.slice(1)} before transferring this location.`,
  );
}
// Returns the transferred entity ids. Existing change-log rows are never
// re-tagged (ADR-0005): History follows each record's current owner instead.
export function transferProgram(s: Snapshot, input: ProgramTransfer) {
  if (!s.user.active || !s.user.isAdmin)
    throw new Error(
      "System administrator required for Flight Program transfers.",
    );
  if (!input.reason.trim()) throw new Error("A transfer reason is required.");
  if (!s.programs?.some((p) => p.uuid === input.destination))
    throw new Error("Destination Flight Program not found.");
  const source = activeProgram(s);
  if (source === input.destination)
    throw new Error("Select a different Flight Program.");
  const records = s.management ?? [];
  const components = new Set<string>();
  const entities = new Set<string>([input.uuid]);
  if (input.kind === "aircraft") {
    const a = s.aircraft.find((a) => a.uuid === input.uuid);
    if (!a || !ownsActive(s, a.programUuid))
      throw new Error("Aircraft not found in active Flight Program.");
    // Reservations and orders point at this program's stock and vendors.
    if (
      (s.partsRequests ?? []).some(
        (r) =>
          r.aircraftUuid === a.uuid &&
          !["Cancelled", "Fulfilled"].includes(requestStatus(s, r)),
      )
    )
      throw new Error(
        "Cancel or fulfill this aircraft's open parts requests before transferring it.",
      );
    a.programUuid = input.destination;
    a.program = s.programs.find((p) => p.uuid === input.destination)!.name;
    a.version++;
    for (const r of records)
      if (r.kind === "component" && r.aircraftUuid === a.uuid)
        components.add(r.uuid);
    for (const i of s.inspections)
      if (i.aircraftUuid === a.uuid) {
        i.programUuid = input.destination;
        i.version = (i.version ?? 0) + 1;
      }
    for (const c of s.checklists ?? [])
      if (c.aircraftUuid === a.uuid) {
        c.programUuid = input.destination;
        c.version++;
        entities.add(c.uuid);
      }
    for (const d of s.componentSetups ?? [])
      if (d.aircraftUuid === a.uuid) {
        d.programUuid = input.destination;
        entities.add(d.uuid);
      }
  } else {
    const r = records.find(
      (r) => r.kind === input.kind && r.uuid === input.uuid,
    );
    if (!r || !ownsActive(s, recordProgram(s, r)))
      throw new Error("Record not found in active Flight Program.");
    if (r.kind === "component") {
      if (r.installed)
        throw new Error(
          "Remove the component before transferring it, or transfer its aircraft.",
        );
      if (s.inspections.some((i) => i.componentUuid === r.uuid))
        throw new Error(
          "Transfer the associated aircraft while this component has linked inspection schedules.",
        );
      components.add(r.uuid);
    }
    if (
      r.kind === "location" &&
      records.some((c) => c.kind === "component" && c.locationUuid === r.uuid)
    )
      throw new Error(
        "Move tracked components to another inventory location before transferring this location.",
      );
    if (r.kind === "location") assertLocationUncommitted(s, r.uuid);
    if (r.kind === "location")
      for (const stock of records)
        if (stock.kind === "stock" && stock.locationUuid === r.uuid)
          entities.add(stock.uuid);
  }
  for (const r of records) {
    if (
      components.has(r.uuid) ||
      ("componentUuid" in r && components.has(r.componentUuid))
    )
      entities.add(r.uuid);
    if (!entities.has(r.uuid)) continue;
    if (r.kind === "component" && r.locationUuid) {
      const priorLocation = records.find(
        (l) => l.kind === "location" && l.uuid === r.locationUuid,
      );
      r.partsLocation =
        r.partsLocation ||
        (priorLocation?.kind === "location"
          ? priorLocation.name
          : "Previous inventory location");
      r.locationUuid = undefined;
    }
    r.programUuid = input.destination;
    r.version++;
    if (input.kind === "component" && "aircraftUuid" in r) r.aircraftUuid = "";
  }
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
  return entities;
}
