import { z } from "zod";
import { can, type Snapshot } from "./model";
import { ownsActive, recordProgram } from "./programs";
import { expiredForUse, usableQuantity } from "./shelfLife";

export const requiredPartsSchema = z
  .array(
    z.object({
      locationUuid: z.string().min(1),
      stockUuid: z.string().min(1),
      quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }),
  )
  .max(100);
export type RequiredPart = z.infer<typeof requiredPartsSchema>[number] & {
  partNumber?: string;
  onOrder?: number;
  shipped?: number;
};
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
export function validateRequiredParts(
  s: Snapshot,
  parts: RequiredPart[] | undefined,
  programUuid?: string,
) {
  const parsed = requiredPartsSchema.parse(parts ?? []);
  const seen = new Set<string>();
  for (const part of parsed) {
    const stock = s.management?.find(
      (r) => r.kind === "stock" && r.uuid === part.stockUuid,
    );
    const location = s.management?.find(
      (r) => r.kind === "location" && r.uuid === part.locationUuid,
    );
    if (
      !stock ||
      stock.kind !== "stock" ||
      !location ||
      stock.locationUuid !== location.uuid ||
      recordProgram(s, stock) !== programUuid ||
      recordProgram(s, location) !== programUuid
    )
      throw new Error(
        "Select a part and inventory location in this Flight Program.",
      );
    if (seen.has(part.stockUuid))
      throw new Error(
        "This part is already listed. Update its quantity instead.",
      );
    seen.add(part.stockUuid);
  }
  return parsed;
}
// Expired lots are neither available nor counted against a shortage: they
// cannot be reserved or issued (assertNotExpired). Their on-hand quantity is
// reported separately as `expired`.
export function partsAvailability(
  s: Snapshot,
  parts: RequiredPart[] = [],
  now = Date.now(),
) {
  const inventory = partsInventory(s);
  const expired = (r: PartsInventory["stock"][number]) =>
    expiredForUse(r.expirationDate, now) ? r.quantity : 0;
  return parts.map((part) => {
    if (part.partNumber) {
      const matching = inventory.stock.filter(
        (r) =>
          r.partNumber === part.partNumber &&
          ["new", "overhauled"].includes(r.condition ?? "new") &&
          (!part.locationUuid || r.locationUuid === part.locationUuid),
      );
      const available = matching.reduce(
        (n, r) => n + usableQuantity(r, now),
        0,
      );
      const needed = parts
        .filter(
          (p) =>
            p.partNumber === part.partNumber &&
            p.locationUuid === part.locationUuid,
        )
        .reduce((n, p) => n + p.quantity, 0);
      return {
        ...part,
        partNumber: part.partNumber,
        location: part.locationUuid
          ? (inventory.locations.find((l) => l.uuid === part.locationUuid)
              ?.name ?? "Unavailable location")
          : "All locations",
        available,
        shortage: Math.max(0, needed - available),
        expired: matching.reduce((n, r) => n + expired(r), 0),
      };
    }
    const stock = inventory.stock.find(
      (r) => r.uuid === part.stockUuid && r.locationUuid === part.locationUuid,
    );
    const location = inventory.locations.find(
      (r) => r.uuid === part.locationUuid,
    );
    const needed = parts
      .filter((p) => p.stockUuid === part.stockUuid)
      .reduce((n, p) => n + p.quantity, 0);
    const available = stock ? usableQuantity(stock, now) : undefined;
    return {
      ...part,
      partNumber: stock?.partNumber ?? "Unavailable part",
      location: location?.name ?? "Unavailable location",
      available,
      shortage:
        available === undefined ? undefined : Math.max(0, needed - available),
      expired: stock ? expired(stock) : undefined,
    };
  });
}
export function saveDiscrepancyParts(
  s: Snapshot,
  uuid: string,
  version: number,
  parts: RequiredPart[],
) {
  const d = s.discrepancies.find((d) => d.uuid === uuid);
  if (!d) throw new Error("Report not found.");
  const a = s.aircraft.find((a) => a.uuid === d.aircraftUuid);
  if (!a || !ownsActive(s, a.programUuid) || !can(s, a.uuid, "maintenance"))
    throw new Error("Permission denied.");
  if (d.status !== "open") throw new Error("Resolved reports are read-only.");
  if ((d.partsVersion ?? 0) !== version)
    throw new Error("Parts changed. Reopen the report and try again.");
  d.requiredParts = validateRequiredParts(s, parts, a.programUuid);
  d.partsVersion = version + 1;
  return d;
}
