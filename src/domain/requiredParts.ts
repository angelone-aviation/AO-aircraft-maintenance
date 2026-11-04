/**
 * Responsibility: Parts planned for maintenance work: the required-parts list,
 *   the inventory it draws on, and how much of each part is on hand.
 * Layer: Domain. Zod schema, rules and one applier; no I/O, no React.
 * Dependencies: zod, ./model, ./programs, ./shelfLife, ./changeLog,
 *   ./rejection.
 *
 * Planning only: listing a part neither reserves nor issues stock.
 */
import { z } from "zod";
import { can, type Snapshot } from "./model";
import { ownsActive, recordProgram } from "./programs";
import { expiredForUse, usableQuantity } from "./shelfLife";
import { auditEntry } from "./changeLog";
import { Rejection } from "./rejection";

// A part listed by number counts only serviceable lots; a lot with no
// condition counts as new.
const SERVICEABLE_CONDITIONS = ["new", "overhauled"];

/**
 * The parts a discrepancy, inspection or component requirement needs: up to
 * 100 stock lots, each with its location and a positive whole quantity.
 *
 * @throws {z.ZodError} From `parse()` on a blank id or a bad quantity.
 */
export const requiredPartsSchema = z
  .array(
    z.object({
      locationUuid: z.string().min(1),
      stockUuid: z.string().min(1),
      quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }),
  )
  .max(100);

/**
 * A required part. A row listed by `partNumber` (as a parts-request line is)
 * asks for any serviceable lot of that number; `onOrder` and `shipped` (not
 * yet received) carry its purchasing progress.
 */
export type RequiredPart = z.infer<typeof requiredPartsSchema>[number] & {
  partNumber?: string;
  onOrder?: number;
  shipped?: number;
};

/** Locations and stock lots for parts planning, without purchasing details. */
export interface PartsInventory {
  locations: { uuid: string; name: string; programUuid?: string }[];
  stock: {
    uuid: string;
    locationUuid: string;
    programUuid?: string;
    partNumber: string;
    description: string;
    quantity: number;
    reservedQuantity?: number;
    condition?: string;
    oil?: boolean;
    expirationDate?: string;
  }[];
}

/**
 * Gets the active Flight Program's parts inventory.
 *
 * @param s - Snapshot; a scoped one already carries `partsInventory`.
 * @returns `s.partsInventory` when present; otherwise the program's locations
 *   and stock in record order, reserved quantity defaulting to 0.
 */
export function partsInventory(s: Snapshot): PartsInventory {
  if (s.partsInventory) return s.partsInventory;
  const records = (s.management ?? []).filter((r) =>
    ownsActive(s, recordProgram(s, r)),
  );
  return {
    locations: records
      .filter((r) => r.kind === "location")
      .map((r) => ({
        uuid: r.uuid,
        name: r.name,
        programUuid: recordProgram(s, r),
      })),
    stock: records
      .filter((r) => r.kind === "stock")
      .map((r) => ({
        uuid: r.uuid,
        locationUuid: r.locationUuid,
        programUuid: recordProgram(s, r),
        partNumber: r.partNumber,
        description: r.description,
        quantity: r.quantity,
        reservedQuantity: r.reservedQuantity ?? 0,
        condition: r.condition,
        oil: r.oil,
        expirationDate: r.expirationDate,
      })),
  };
}

/**
 * Checks a required-parts list before it is saved on a record.
 *
 * @param s - Snapshot holding the stock and location records.
 * @param parts - The list; undefined means none.
 * @param programUuid - The record's Flight Program.
 * @returns The parsed list ([] for undefined).
 * @throws {Rejection} "Select a part and inventory location in this Flight
 *   Program." for a lot not at that location or program; "This part is
 *   already listed. Update its quantity instead." for a repeated lot.
 * @throws {z.ZodError} When the list fails {@link requiredPartsSchema}.
 */
export function validateRequiredParts(
  s: Snapshot,
  parts: RequiredPart[] | undefined,
  programUuid?: string,
) {
  const parsed = requiredPartsSchema.parse(parts ?? []);
  const seen = new Set<string>();
  for (const part of parsed) {
    if (!isStockInProgram(s, part, programUuid))
      throw new Rejection(
        "Select a part and inventory location in this Flight Program.",
      );
    if (seen.has(part.stockUuid))
      throw new Rejection(
        "This part is already listed. Update its quantity instead.",
      );
    seen.add(part.stockUuid);
  }
  return parsed;
}

/**
 * Compares required parts with usable stock. Expired lots cannot be reserved
 * or issued, so they are not available and do not reduce a shortage; their
 * quantity is reported as `expired`.
 *
 * @param s - Snapshot, read through {@link partsInventory}.
 * @param parts - Rows for the same lot, or part number and location, add up.
 * @param now - When to judge shelf life.
 * @returns Per part, in order: `partNumber`, `location` name, `available`,
 *   `shortage` (never negative) and `expired`; the last three are undefined
 *   when a listed lot is no longer in stock.
 */
export function partsAvailability(
  s: Snapshot,
  parts: RequiredPart[] = [],
  now = Date.now(),
) {
  const inventory = partsInventory(s);
  return parts.map((part) =>
    part.partNumber
      ? countPartNumber(inventory, parts, part, part.partNumber, now)
      : countStockLot(inventory, parts, part, now),
  );
}

/**
 * Replaces an open discrepancy's required parts, at the next parts version,
 * and adds a "discrepancy.parts" change-log entry with the report before and
 * after.
 *
 * @param s - Working snapshot; the discrepancy changes in place.
 * @param uuid - The discrepancy.
 * @param version - The parts version the user opened.
 * @param parts - The new list, checked by {@link validateRequiredParts}.
 * @returns The changed discrepancy.
 * @throws {Rejection} "Report not found.", "Permission denied." (maintenance
 *   on an aircraft of the active program), "Resolved reports are read-only.",
 *   "Parts changed. Reopen the report and try again.", or a list refusal.
 */
export function saveDiscrepancyParts(
  s: Snapshot,
  uuid: string,
  version: number,
  parts: RequiredPart[],
) {
  const d = s.discrepancies.find((d) => d.uuid === uuid);
  if (!d) throw new Rejection("Report not found.");
  const a = s.aircraft.find((a) => a.uuid === d.aircraftUuid);
  if (!a || !ownsActive(s, a.programUuid) || !can(s, a.uuid, "maintenance"))
    throw new Rejection("Permission denied.");
  if (d.status !== "open")
    throw new Rejection("Resolved reports are read-only.");
  if ((d.partsVersion ?? 0) !== version)
    throw new Rejection("Parts changed. Reopen the report and try again.");
  const before = structuredClone(d);
  d.requiredParts = validateRequiredParts(s, parts, a.programUuid);
  d.partsVersion = version + 1;
  s.audit.unshift(
    auditEntry(s, {
      action: "discrepancy.parts",
      entityUuid: d.uuid,
      aircraftUuid: d.aircraftUuid,
      reason: "Required parts updated",
      before,
      after: d,
    }),
  );
  return d;
}

function isStockInProgram(
  s: Snapshot,
  part: RequiredPart,
  programUuid: string | undefined,
) {
  const stock = s.management?.find(
    (r) => r.kind === "stock" && r.uuid === part.stockUuid,
  );
  const location = s.management?.find(
    (r) => r.kind === "location" && r.uuid === part.locationUuid,
  );
  return (
    stock?.kind === "stock" &&
    !!location &&
    stock.locationUuid === location.uuid &&
    recordProgram(s, stock) === programUuid &&
    recordProgram(s, location) === programUuid
  );
}

function countPartNumber(
  inventory: PartsInventory,
  parts: RequiredPart[],
  part: RequiredPart,
  partNumber: string,
  now: number,
) {
  const matching = inventory.stock.filter(
    (r) =>
      r.partNumber === partNumber &&
      SERVICEABLE_CONDITIONS.includes(r.condition ?? "new") &&
      (!part.locationUuid || r.locationUuid === part.locationUuid),
  );
  const available = sum(matching, (r) => usableQuantity(r, now));
  const needed = sum(
    parts.filter(
      (p) =>
        p.partNumber === partNumber && p.locationUuid === part.locationUuid,
    ),
    (p) => p.quantity,
  );
  return {
    ...part,
    partNumber,
    location: part.locationUuid
      ? locationName(inventory, part.locationUuid)
      : "All locations",
    available,
    shortage: Math.max(0, needed - available),
    expired: sum(matching, (r) => expiredQuantity(r, now)),
  };
}

function countStockLot(
  inventory: PartsInventory,
  parts: RequiredPart[],
  part: RequiredPart,
  now: number,
) {
  const stock = inventory.stock.find(
    (r) => r.uuid === part.stockUuid && r.locationUuid === part.locationUuid,
  );
  const needed = sum(
    parts.filter((p) => p.stockUuid === part.stockUuid),
    (p) => p.quantity,
  );
  const available = stock ? usableQuantity(stock, now) : undefined;
  return {
    ...part,
    partNumber: stock?.partNumber ?? "Unavailable part",
    location: locationName(inventory, part.locationUuid),
    available,
    shortage:
      available === undefined ? undefined : Math.max(0, needed - available),
    expired: stock ? expiredQuantity(stock, now) : undefined,
  };
}

function locationName(inventory: PartsInventory, uuid: string) {
  return (
    inventory.locations.find((l) => l.uuid === uuid)?.name ??
    "Unavailable location"
  );
}

function expiredQuantity(stock: PartsInventory["stock"][number], now: number) {
  return expiredForUse(stock.expirationDate, now) ? stock.quantity : 0;
}

function sum<T>(items: T[], count: (item: T) => number) {
  return items.reduce((total, item) => total + count(item), 0);
}
