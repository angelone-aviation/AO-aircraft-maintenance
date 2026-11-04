/**
 * Responsibility: Saving locations, vendors, stock lots, components and their
 *   requirements, and moving stock in, out or to a counted quantity.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ../addresses, ../programs, ../components, ../requiredParts,
 *   ../shelfLife, ../model, ../rejection, ./schemas, ./context.
 */
import { formatAddress } from "../addresses";
import { activeProgram, recordProgram } from "../programs";
import {
  saveRequirement,
  validateComponent,
  type Component,
  type ComponentRequirement,
} from "../components";
import { validateRequiredParts } from "../requiredParts";
import { assertNotExpired } from "../shelfLife";
import type { Snapshot } from "../model";
import { Rejection } from "../rejection";
import type { CommandOf, ManagedRecord, Stock } from "./schemas";
import { existingOfKind, type Context } from "./context";

/**
 * Saves a location, vendor, stock lot, component or component requirement,
 * one version on. A location's address and contact come from its address
 * details.
 *
 * @throws {Rejection} In order: "A vendor with this name already exists.";
 *   "Record type cannot change."; "Initial aircraft setup is only for a new,
 *   already-installed component."; a component's repair or installation
 *   refusals; "Movement history is immutable. Use component actions."; a
 *   requirement's changed component; a stock lot's reservation or location
 *   refusals; as {@link validateComponent}, {@link saveRequirement} and
 *   {@link validateRequiredParts}.
 */
export function saveRecord(
  s: Snapshot,
  c: CommandOf<"record.save">,
  ctx: Context,
): ManagedRecord {
  const r = c.record;
  assertUniqueVendor(s, ctx.records, r);
  if (r.kind === "location" && r.addressDetails) {
    r.address = formatAddress(r.addressDetails);
    r.contact = r.addressDetails.contactName;
  }
  const { existing, now } = ctx;
  if (existing && (!("kind" in existing) || existing.kind !== r.kind))
    throw new Rejection("Record type cannot change.");
  if (
    c.initialAircraftSetup &&
    (existing || r.kind !== "component" || !r.installed)
  )
    throw new Rejection(
      "Initial aircraft setup is only for a new, already-installed component.",
    );
  if (r.kind === "component")
    prepareComponent(s, r, existingOfKind(existing, r.kind), c, now);
  if (r.kind === "componentMovement")
    throw new Rejection(
      "Movement history is immutable. Use component actions.",
    );
  if (r.kind === "componentRequirement")
    prepareRequirement(s, r, existingOfKind(existing, r.kind), now);
  if (r.kind === "stock")
    prepareStock(r, existingOfKind(existing, r.kind), ctx.records);
  return { ...r, version: r.version + 1 };
}

/**
 * Receives, issues or counts (adjusts to) a stock lot's quantity.
 *
 * @throws {Rejection} "Stock item not found."; "Movement quantity must be
 *   positive." for a receipt or issue of 0; as {@link assertNotExpired} for
 *   an issue; "Insufficient stock or invalid quantity." below the reserved
 *   quantity.
 */
export function moveStock(c: CommandOf<"stock.move">, ctx: Context): Stock {
  const existing = existingOfKind(ctx.existing, "stock");
  if (!existing) throw new Rejection("Stock item not found.");
  if (c.operation !== "adjust" && c.quantity === 0)
    throw new Rejection("Movement quantity must be positive.");
  if (c.operation === "issue") assertNotExpired(existing, ctx.now);
  const quantity = movedQuantity(c, existing.quantity);
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < (existing.reservedQuantity ?? 0)
  )
    throw new Rejection("Insufficient stock or invalid quantity.");
  return { ...existing, quantity, version: c.version + 1 };
}

function assertUniqueVendor(
  s: Snapshot,
  records: ManagedRecord[],
  r: ManagedRecord,
) {
  if (r.kind !== "vendor") return;
  const program = activeProgram(s);
  const name = r.name.toLowerCase();
  const taken = records.some(
    (other) =>
      other.kind === "vendor" &&
      other.uuid !== r.uuid &&
      recordProgram(s, other) === program &&
      other.name.toLowerCase() === name,
  );
  if (taken) throw new Rejection("A vendor with this name already exists.");
}

// Installation and repair state change only through work orders and
// purchase orders, which record the movement.
function prepareComponent(
  s: Snapshot,
  r: Component,
  prior: Component | undefined,
  c: CommandOf<"record.save">,
  now: number,
) {
  if (prior) {
    r.calendarSinceNewUnknown ??= prior.calendarSinceNewUnknown;
    if (r.calendarOverhaulDaysBase === undefined)
      r.calendarOverhaulDaysBase = prior.calendarOverhaulDaysBase;
    r.calendarOverhaulDate ??= prior.calendarOverhaulDate;
  }
  if (prior?.outForRepair)
    throw new Rejection("Receive the component from repair before editing it.");
  if (r.outForRepair)
    throw new Rejection(
      "Ship components for repair through their purchase order.",
    );
  if (!prior && r.installed && !c.initialAircraftSetup)
    throw new Rejection(
      "Add the component to inventory, then install it through a work order.",
    );
  validateComponent(s, r, prior, now);
  r.createdAt = prior ? prior.createdAt : now;
}

function prepareRequirement(
  s: Snapshot,
  r: ComponentRequirement,
  prior: ComponentRequirement | undefined,
  now: number,
) {
  if (prior && prior.componentUuid !== r.componentUuid)
    throw new Rejection("The linked component cannot change.");
  if (r.requiredParts === undefined && prior && "requiredParts" in prior)
    r.requiredParts = prior.requiredParts;
  validateRequiredParts(s, r.requiredParts, r.programUuid);
  const computed = saveRequirement(s, r, now);
  Object.assign(r, computed, { version: r.version });
}

// Reserved quantities belong to parts requests; a lot keeps its identity and
// location while any of it is reserved or stored.
function prepareStock(
  r: Stock,
  prior: Stock | undefined,
  records: ManagedRecord[],
) {
  const reserved = prior?.reservedQuantity ?? 0;
  if (r.reservedQuantity !== undefined && r.reservedQuantity !== reserved)
    throw new Rejection("Change reservations through Parts requests.");
  const reidentified =
    !!prior &&
    (r.partNumber !== prior.partNumber || r.condition !== prior.condition);
  if (reserved > 0 && (r.quantity < reserved || reidentified))
    throw new Rejection(
      "Release stock reservations before changing part identity, condition or reducing stock below its reserved quantity.",
    );
  r.reservedQuantity = reserved;
  if (!records.some((l) => l.kind === "location" && l.uuid === r.locationUuid))
    throw new Rejection("Select an existing stock location.");
  if (prior && r.locationUuid !== prior.locationUuid)
    throw new Rejection("Location is fixed for each stock lot.");
}

function movedQuantity(c: CommandOf<"stock.move">, onHand: number) {
  if (c.operation === "adjust") return c.quantity;
  return onHand + (c.operation === "receive" ? c.quantity : -c.quantity);
}
