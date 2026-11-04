/**
 * Responsibility: Turns a scanned inventory label or a typed code into the
 *   stock item or component it names.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/programs.ts, rejection.ts; model.ts (types).
 *
 * Labels carry the URL inventoryPrinting.ts prints:
 * <app>/inventory?item=<uuid>&program=<uuid>, on any host.
 */
import type { Snapshot } from "./model";
import { programPermission } from "./programs";
import { Rejection } from "./rejection";

const LABEL_PATH = "/inventory";
const NOT_A_LABEL = "This QR code is not an Angel One inventory label.";

/** The inventory record a scan resolved to. */
export interface ScanTarget {
  kind: "stock" | "component";
  uuid: string;
}

/**
 * Reads a printed label URL or a typed code.
 *
 * @param raw - The scanned or typed text; surrounding spaces are ignored.
 * @returns The item code, the label's Flight Program if it names one, and
 *   whether the text was a label URL.
 * @throws {Rejection} "Scan a label or enter a code." for blank text, or
 *   "This QR code is not an Angel One inventory label." for an http(s) URL
 *   that is not a label with an item.
 */
export function parseInventoryCode(raw: string) {
  const code = raw.trim();
  if (!code) throw new Rejection("Scan a label or enter a code.");
  if (!/^https?:\/\//i.test(code))
    return { code, program: undefined, label: false };
  const url = parseUrl(code);
  const item = url.searchParams.get("item");
  if (url.pathname !== LABEL_PATH || !item) throw new Rejection(NOT_A_LABEL);
  return {
    code: item,
    program: url.searchParams.get("program") ?? undefined,
    label: true,
  };
}

/**
 * Resolves a scanned label or typed code (item id, serial number or part
 * number, ignoring case) to an item in the user's visible snapshot; stock is
 * visible to program administrators only.
 *
 * @param s - The user's snapshot.
 * @param raw - The scanned or typed text.
 * @returns The one matching item.
 * @throws {Rejection} When the code is malformed or ambiguous, the label is
 *   another known program's ("This label belongs to …"), or nothing matches.
 */
export function resolveInventoryCode(s: Snapshot, raw: string): ScanTarget {
  const { code, program, label } = parseInventoryCode(raw);
  const matches = findMatches(s, code, label);
  if (matches.length > 1)
    throw new Rejection(
      `${matches.length} items match “${code}”. Enter the serial number, or search the inventory list.`,
    );
  if (matches.length) return { kind: matches[0].kind, uuid: matches[0].uuid };
  const other = program && program !== s.activeProgramUuid;
  const name = other && s.programs?.find((p) => p.uuid === program)?.name;
  if (name)
    throw new Rejection(
      `This label belongs to ${name}. Switch to that Flight Program, then scan again.`,
    );
  throw new Rejection(
    label
      ? "This label’s item is not available to you in the active Flight Program."
      : `No inventory item you can access matches “${code}”.`,
  );
}

function parseUrl(code: string) {
  try {
    return new URL(code);
  } catch {
    // An unparseable http(s) address is a foreign QR code, not a fault.
    throw new Rejection(NOT_A_LABEL);
  }
}

function findMatches(s: Snapshot, code: string, label: boolean) {
  const admin = programPermission(s, "admin");
  const items = (s.management ?? []).flatMap((r) =>
    r.kind === "component" || (r.kind === "stock" && admin) ? [r] : [],
  );
  const byUuid = items.find((r) => r.uuid === code);
  if (byUuid) return [byUuid];
  // A label names one item; it never falls back to part or serial numbers.
  if (label) return [];
  const key = code.toUpperCase();
  return items.filter(
    (r) =>
      r.partNumber.toUpperCase() === key ||
      (r.kind === "component" && r.serial.toUpperCase() === key),
  );
}
