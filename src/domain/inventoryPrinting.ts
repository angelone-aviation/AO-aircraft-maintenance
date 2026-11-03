import type { Component } from "./components";
import type { Stock } from "./management";
import type { Snapshot } from "./model";
export type PrintableItem = Stock | Component;
export type InventoryPrintKind = "tag" | "label";
export function inventoryPrintBase(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(
      "Enter the shared app’s full website address, including https:// or http://.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTP or HTTPS app address without a sign-in token, query or fragment.",
    );
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    /^127\./.test(host)
  )
    throw new Error(
      "Use your shared website or network address. localhost cannot open this app from a phone.",
    );
  if (url.pathname !== "/")
    throw new Error(
      "Enter the app’s base address only, without /inventory or another page path.",
    );
  return url.origin;
}
export function inventoryItemUrl(
  base: string,
  item: PrintableItem,
  programUuid?: string,
) {
  const url = new URL("/inventory", inventoryPrintBase(base));
  url.searchParams.set("item", item.uuid);
  if (programUuid) url.searchParams.set("program", programUuid);
  if (url.href.length > 300)
    throw new Error(
      "This address is too long for a small label. Use a shorter app address.",
    );
  return url.href;
}
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
export type TagFields = Record<keyof typeof tagFieldLabels, string>;
export function inventoryTagFields(s: Snapshot, c: Component): TagFields {
  const removals = (s.management ?? [])
    .filter((r) => r.kind === "componentMovement")
    .filter(
      (r) =>
        r.componentUuid === c.uuid &&
        r.action === "REMOVE" &&
        !r.supersededByCorrection,
    )
    .sort((a, b) => b.at - a.at);
  const removal = removals[0];
  const aircraft = s.aircraft.find(
    (a) =>
      a.uuid === (removal?.aircraftUuid ?? (c.installed ? c.aircraftUuid : "")),
  );
  const saved = removal?.aircraftSnapshot;
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
    nha: saved
      ? `${saved.make} ${saved.model}`
      : aircraft
        ? `${aircraft.make} ${aircraft.model}`
        : "",
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
    ...(!removal
      ? Object.fromEntries(
          Object.entries(c.incomingTag ?? {}).filter(([, v]) => v),
        )
      : {}),
  };
}
