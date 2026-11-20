/**
 * Responsibility: What printed inventory labels and removal tags carry: the
 *   app address a label's QR code opens, and a component tag's fields.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./components, ./management, ./model, ./rejection.
 */
import type { Component } from "./components";
import type { Stock } from "./management";
import type { Snapshot } from "./model";
import { Rejection } from "./rejection";

// Longer addresses make a QR code too dense to scan on a small label.
const MAX_LABEL_URL_LENGTH = 300;

/** A stock lot or a component that can be labelled. */
export type PrintableItem = Stock | Component;

/** A removal tag (components) or a small label (any item). */
export type InventoryPrintKind = "tag" | "label";

/**
 * Checks the shared app address a label's QR code will open from a phone.
 *
 * @param raw - The address as typed.
 * @returns The address's origin, such as "https://app.example.org".
 * @throws {Rejection} When it is not a full HTTP or HTTPS address, carries
 *   credentials, a query or a fragment, names this device (localhost), or has
 *   a page path.
 */
export function inventoryPrintBase(raw: string) {
  const url = parseAppAddress(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Rejection(
      "Use an HTTP or HTTPS app address without a sign-in token, query or fragment.",
    );
  if (isLoopbackHost(url.hostname.toLowerCase()))
    throw new Rejection(
      "Use your shared website or network address. localhost cannot open this app from a phone.",
    );
  if (url.pathname !== "/")
    throw new Rejection(
      "Enter the app’s base address only, without /inventory or another page path.",
    );
  return url.origin;
}

/**
 * Builds the address a label's QR code opens: the item on the Inventory page.
 *
 * @param base - The shared app address, checked by {@link inventoryPrintBase}.
 * @param item - The item.
 * @param programUuid - Its Flight Program, if known.
 * @returns "<origin>/inventory?item=<uuid>[&program=<uuid>]".
 * @throws {Rejection} A {@link inventoryPrintBase} refusal, or "This address
 *   is too long for a small label. …" over 300 characters.
 */
export function inventoryItemUrl(
  base: string,
  item: PrintableItem,
  programUuid?: string,
) {
  const url = new URL("/inventory", inventoryPrintBase(base));
  url.searchParams.set("item", item.uuid);
  if (programUuid) url.searchParams.set("program", programUuid);
  if (url.href.length > MAX_LABEL_URL_LENGTH)
    throw new Rejection(
      "This address is too long for a small label. Use a shorter app address.",
    );
  return url.href;
}

/** The fields of a removal tag, with the caption printed for each. */
export const tagFieldLabels = {
  company: "Company / Flight Program",
  description: "Description",
  manufacturer: "Manufacturer",
  reference: "Reference / PO No.",
  lastOperator: "Last operator / aircraft",
  nha: "NHA",
  nhaSerial: "NHA serial no.",
  position: "Position",
  removalDate: "Removal date",
  reason: "Reason",
  condition: "Condition",
  removedBy: "Removed by",
  mechanic: "Mechanic / A&P No.",
  tagNumber: "Tag No.",
} as const;

/** A removal tag's text, by field. */
export type TagFields = Record<keyof typeof tagFieldLabels, string>;

/**
 * Prefills a component's removal tag from its latest removal that no
 * correction superseded, and the aircraft as recorded at that removal.
 * Condition and tag number are left for the person filling it in.
 *
 * @param s - The program, members, aircraft, movements and work orders.
 * @param c - The component.
 * @returns The fields; for a component never removed, those its incoming tag
 *   fills in replace the rest.
 */
export function inventoryTagFields(s: Snapshot, c: Component): TagFields {
  const removal = findLatestRemoval(s, c);
  const aircraft = s.aircraft.find(
    (a) =>
      a.uuid === (removal?.aircraftUuid ?? (c.installed ? c.aircraftUuid : "")),
  );
  const saved = removal?.aircraftSnapshot;
  const nha = saved ?? aircraft;
  return {
    company:
      s.programs?.find((p) => p.uuid === s.activeProgramUuid)?.name ?? "",
    description: c.componentType,
    manufacturer: c.manufacturer,
    reference: removal?.workOrderUuid
      ? (s.workOrders?.find((w) => w.uuid === removal.workOrderUuid)?.number ??
        "")
      : "",
    lastOperator: saved?.registration ?? aircraft?.registration ?? "",
    nha: nha ? `${nha.make} ${nha.model}` : "",
    nhaSerial: saved?.serial ?? aircraft?.serial ?? "",
    position: removal?.installPosition ?? c.installPosition ?? "",
    removalDate: removal?.date ?? c.removedDate ?? "",
    reason: removal?.note ?? "",
    condition: "",
    removedBy:
      saved?.removedBy ??
      s.members.find((m) => m.id === removal?.actorId)?.name ??
      "",
    mechanic: saved?.mechanic ?? "",
    tagNumber: "",
    ...(removal ? {} : filledIncomingTag(c)),
  };
}

function parseAppAddress(raw: string) {
  try {
    return new URL(raw.trim());
  } catch {
    throw new Rejection(
      "Enter the shared app’s full website address, including https:// or http://.",
    );
  }
}

function isLoopbackHost(host: string) {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    /^127\./.test(host)
  );
}

/**
 * The work order a component's removal tag names: the one its latest
 * removal that no correction superseded was recorded under.
 *
 * @param s - The program's movements.
 * @param c - The component.
 * @returns Its uuid; undefined for no removal, or one under no work order.
 */
export function tagWorkOrderUuid(
  s: Pick<Snapshot, "management">,
  c: Component,
): string | undefined {
  return findLatestRemoval(s, c)?.workOrderUuid || undefined;
}

function findLatestRemoval(s: Pick<Snapshot, "management">, c: Component) {
  return (s.management ?? [])
    .filter((r) => r.kind === "componentMovement")
    .filter(
      (r) =>
        r.componentUuid === c.uuid &&
        r.action === "REMOVE" &&
        !r.supersededByCorrection,
    )
    .sort((a, b) => b.at - a.at)[0];
}

function filledIncomingTag(c: Component) {
  return Object.fromEntries(
    Object.entries(c.incomingTag ?? {}).filter(([, v]) => v),
  );
}
