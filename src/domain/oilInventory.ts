import type { FlightInput, Snapshot } from "./model";
import { can } from "./model";
import { oilSchema } from "./flightFluids";
import { recordProgram } from "./programs";
import type { Stock } from "./management";
import { assertNotExpired } from "./shelfLife";
export function oilInventoryDeductions(
  s: Snapshot,
  input: FlightInput,
  now = Date.now(),
): { before: Stock; after: Stock }[] {
  const oil = oilSchema.parse(input.oil ?? []);
  const uses = oil.flatMap((o) => (o.inventory ? [o.inventory] : []));
  if (!uses.length) return [];
  if (!can(s, input.aircraftUuid, "flight"))
    throw new Error("Flight permission is required to issue oil.");
  const program = s.aircraft.find(
    (a) => a.uuid === input.aircraftUuid,
  )?.programUuid;
  const quantities = new Map<string, { stock: Stock; quantity: number }>();
  for (const use of uses) {
    const stock = s.management?.find((r) => r.uuid === use.stockUuid);
    const location = s.management?.find((r) => r.uuid === use.locationUuid);
    if (
      !stock ||
      stock.kind !== "stock" ||
      !location ||
      location.kind !== "location" ||
      stock.locationUuid !== location.uuid ||
      recordProgram(s, stock) !== program ||
      recordProgram(s, location) !== program
    )
      throw new Error(
        "Select an oil stock item and location in this Flight Program.",
      );
    if (stock.oil !== true)
      throw new Error(
        `${stock.partNumber} is not marked as oil. Flight-line usage can only draw down oil stock.`,
      );
    // Same shelf-life rule as Issue stock and parts requests.
    assertNotExpired(stock, now);
    const quantity = (quantities.get(stock.uuid)?.quantity ?? 0) + use.quantity;
    if (
      !Number.isSafeInteger(quantity) ||
      quantity > stock.quantity - (stock.reservedQuantity ?? 0)
    )
      throw new Error(
        `Insufficient stock for ${stock.partNumber}. Available: ${stock.quantity - (stock.reservedQuantity ?? 0)}; requested: ${quantity}.`,
      );
    quantities.set(stock.uuid, { stock, quantity });
  }
  return [...quantities.values()].map(({ stock, quantity }) => ({
    before: stock,
    after: {
      ...stock,
      quantity: stock.quantity - quantity,
      version: stock.version + 1,
    },
  }));
}
// The change-log entry for a flight-line deduction. Flight users can read it,
// so it carries only the stock id and quantity, never the admin-only stock
// record (cost, vendor, invoice, PO, location).
export function oilUsageAudit(change: { before: Stock; after: Stock }) {
  return {
    before: { stockUuid: change.before.uuid, quantity: change.before.quantity },
    after: { stockUuid: change.after.uuid, quantity: change.after.quantity },
  };
}
export function preserveOilInventory(before: FlightInput, after: FlightInput) {
  const links = (f: FlightInput) =>
    JSON.stringify(
      (f.oil ?? [])
        .filter((o) => o.inventory)
        .map((o) => [
          o.engine,
          o.inventory!.stockUuid,
          o.inventory!.locationUuid,
          o.inventory!.quantity,
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  if (links(before) !== links(after))
    throw new Error(
      "A flight review cannot change posted oil inventory usage. Correct stock through an inventory adjustment.",
    );
}
