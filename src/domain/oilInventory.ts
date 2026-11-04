/**
 * Responsibility: Oil a flight adds from inventory: the stock it draws down,
 *   its change-log entry, and keeping posted usage fixed through a review.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./model, ./flightFluids, ./programs, ./management, ./shelfLife,
 *   ./rejection.
 */
import { can, type FlightInput, type Snapshot } from "./model";
import { oilSchema } from "./flightFluids";
import { recordProgram } from "./programs";
import type { Stock } from "./management";
import { Rejection } from "./rejection";
import { assertNotExpired } from "./shelfLife";

type StockChange = { before: Stock; after: Stock };

/**
 * Works out the stock a flight's oil from inventory draws down. Uses of one
 * stock item add up and must fit its unreserved quantity.
 *
 * @param s - The snapshot holding the stock, its locations and the user.
 * @param input - The flight as logged.
 * @param now - The time to judge shelf life at.
 * @returns One change per stock item (quantity reduced, version + 1); none
 *   when no oil comes from inventory.
 * @throws {Rejection} "Flight permission is required to issue oil.", "Select an
 *   oil stock item and location in this Flight Program.", "<part> is not marked
 *   as oil. …", "Insufficient stock for <part>. Available: <n>; requested:
 *   <n>.", or as assertNotExpired.
 * @throws {z.ZodError} When the oil readings are invalid.
 */
export function oilInventoryDeductions(
  s: Snapshot,
  input: FlightInput,
  now = Date.now(),
): StockChange[] {
  const oil = oilSchema.parse(input.oil ?? []);
  const uses = oil.flatMap((o) => (o.inventory ? [o.inventory] : []));
  if (!uses.length) return [];
  if (!can(s, input.aircraftUuid, "flight"))
    throw new Rejection("Flight permission is required to issue oil.");
  const program = s.aircraft.find(
    (a) => a.uuid === input.aircraftUuid,
  )?.programUuid;
  const quantities = new Map<string, { stock: Stock; quantity: number }>();
  for (const use of uses) {
    const stock = findOilStock(s, use, program, now);
    const quantity = (quantities.get(stock.uuid)?.quantity ?? 0) + use.quantity;
    assertAvailable(stock, quantity);
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

/**
 * The change-log entry for a flight-line deduction. Flight users can read it,
 * so it carries only the stock id and quantity, never the admin-only stock
 * record (cost, vendor, invoice, PO, location).
 *
 * @param change - A deduction from {@link oilInventoryDeductions}.
 */
export function oilUsageAudit(change: StockChange) {
  return {
    before: { stockUuid: change.before.uuid, quantity: change.before.quantity },
    after: { stockUuid: change.after.uuid, quantity: change.after.quantity },
  };
}

/**
 * Refuses a flight review that changes the oil drawn from inventory: posted
 * stock is corrected only through an inventory adjustment. Readings compare
 * by engine, stock, location and quantity, in any order.
 *
 * @param before - The flight as stored.
 * @param after - The flight as reviewed.
 * @throws {Rejection} "A flight review cannot change posted oil inventory
 *   usage. Correct stock through an inventory adjustment."
 */
export function preserveOilInventory(before: FlightInput, after: FlightInput) {
  if (oilLinks(before) !== oilLinks(after))
    throw new Rejection(
      "A flight review cannot change posted oil inventory usage. Correct stock through an inventory adjustment.",
    );
}

function findOilStock(
  s: Snapshot,
  use: { stockUuid: string; locationUuid: string },
  program: string | undefined,
  now: number,
) {
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
    throw new Rejection(
      "Select an oil stock item and location in this Flight Program.",
    );
  if (stock.oil !== true)
    throw new Rejection(
      `${stock.partNumber} is not marked as oil. Flight-line usage can only draw down oil stock.`,
    );
  // Same shelf-life rule as Issue stock and parts requests.
  assertNotExpired(stock, now);
  return stock;
}

function assertAvailable(stock: Stock, quantity: number) {
  const available = stock.quantity - (stock.reservedQuantity ?? 0);
  if (!Number.isSafeInteger(quantity) || quantity > available)
    throw new Rejection(
      `Insufficient stock for ${stock.partNumber}. Available: ${available}; requested: ${quantity}.`,
    );
}

function oilLinks(f: FlightInput) {
  return JSON.stringify(
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
}
