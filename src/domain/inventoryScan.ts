import type { Snapshot } from "./model";
import { programPermission } from "./programs";
export interface ScanTarget {
  kind: "stock" | "component";
  uuid: string;
}
/** Reads a printed label URL (/inventory?item=…&program=…) or a typed code. */
export function parseInventoryCode(raw: string) {
  const code = raw.trim();
  if (!code) throw new Error("Scan a label or enter a code.");
  if (/^https?:\/\//i.test(code)) {
    let url: URL;
    try {
      url = new URL(code);
    } catch {
      throw new Error("This QR code is not an Angel One inventory label.");
    }
    const item = url.searchParams.get("item");
    if (url.pathname !== "/inventory" || !item)
      throw new Error("This QR code is not an Angel One inventory label.");
    return {
      code: item,
      program: url.searchParams.get("program") ?? undefined,
      label: true,
    };
  }
  return { code, program: undefined, label: false };
}
/**
 * Resolves a scanned label or typed code (item id, serial number or part
 * number) to an item in the user's visible snapshot. Throws a user-facing
 * message when nothing, or more than one item, matches.
 */
export function resolveInventoryCode(s: Snapshot, raw: string): ScanTarget {
  const { code, program, label } = parseInventoryCode(raw);
  const admin = programPermission(s, "admin");
  const key = code.toUpperCase();
  const items = (s.management ?? []).flatMap((r) =>
    r.kind === "component" || (r.kind === "stock" && admin) ? [r] : [],
  );
  const byUuid = items.find((r) => r.uuid === code);
  const matches = byUuid
    ? [byUuid]
    : label
      ? []
      : items.filter(
          (r) =>
            r.partNumber.toUpperCase() === key ||
            (r.kind === "component" && r.serial.toUpperCase() === key),
        );
  if (matches.length > 1)
    throw new Error(
      `${matches.length} items match “${code}”. Enter the serial number, or search the inventory list.`,
    );
  if (matches.length) return { kind: matches[0].kind, uuid: matches[0].uuid };
  const other = program && program !== s.activeProgramUuid;
  const name = other && s.programs?.find((p) => p.uuid === program)?.name;
  if (name)
    throw new Error(
      `This label belongs to ${name}. Switch to that Flight Program, then scan again.`,
    );
  throw new Error(
    label
      ? "This label’s item is not available to you in the active Flight Program."
      : `No inventory item you can access matches “${code}”.`,
  );
}
