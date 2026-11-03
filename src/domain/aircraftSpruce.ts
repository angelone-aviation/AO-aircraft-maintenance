import { z } from "zod";

export const spruceCredentials = z.object({
  userid: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(500),
  apikey: z.string().trim().min(1).max(500),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export const sprucePartSchema = z.object({
  partNumber: z.string().min(1).max(2000),
  uom: z.string().max(100),
  currency: z.string().regex(/^[A-Z]{3}$/),
  catalogAt: z.number(),
});
export type SprucePart = z.infer<typeof sprucePartSchema>;
export type SpruceProduct = SprucePart & {
  description: string;
  netPrice: string;
  url: string;
  availability: { location: string; quantity: string; due: string }[];
};
export type SpruceStatus = {
  configured: boolean;
  version: number;
  currency?: string;
  catalogAt?: number;
  catalogCount?: number;
};
export type SpruceOrderRow = Record<string, string>;
export type SpruceOrderSnapshot = {
  fetchedAt: number;
  order: string;
  rows: SpruceOrderRow[];
};
export const orderFields = [
  "ORN",
  "PONO",
  "STATUS",
  "DATEORDER",
  "DATESHIP",
  "INVOICE",
  "CARRIER",
  "TRACKING",
  "PARTS",
  "DESCS",
  "QOS",
  "QPS",
  "QSS",
  "QBOS",
  "NPS",
  "INVAMOUNT",
];

// CSV fields may contain commas, doubled quotes and embedded newlines.
// Iterate rows so a full catalog does not become an array of 126,000 objects.
export function* csvRows(text: string): Generator<string[]> {
  let row: string[] = [],
    value = "",
    quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (quoted || !value) quoted = !quoted;
      else value += ch; // Supplier descriptions include bare inch marks in unquoted fields.
    } else if (!quoted && ch === ",") {
      row.push(value);
      value = "";
    } else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(value);
      if (row.some(Boolean)) yield row;
      row = [];
      value = "";
    } else value += ch;
  }
  if (quoted) throw Error("Incomplete CSV download.");
  if (value || row.length) {
    row.push(value);
    yield row;
  }
}
export function* csvRecords(text: string, required: string[]) {
  const rows = csvRows(text),
    headers = rows.next().value as string[] | undefined;
  if (!headers || required.some((k) => !headers.includes(k)))
    throw Error("Unexpected Aircraft Spruce CSV columns.");
  for (const row of rows) {
    if (row.length !== headers.length)
      throw Error("Unexpected Aircraft Spruce CSV row.");
    yield Object.fromEntries(headers.map((h, i) => [h, row[i]]));
  }
}
export function catalogSearch(
  text: string,
  search: string,
  currency: string,
  catalogAt: number,
): SpruceProduct[] {
  const query = search.trim().toLowerCase();
  if (query.length < 2) throw Error("Enter at least two characters.");
  const result: SpruceProduct[] = [];
  for (const row of csvRecords(text, [
    "PN",
    "DESCRIPTION",
    "NETPRICE",
    "UOM",
  ])) {
    if (!`${row.PN} ${row.DESCRIPTION}`.toLowerCase().includes(query)) continue;
    let url = "";
    try {
      const u = new URL(row.URL);
      if (
        u.protocol === "https:" &&
        ["www.aircraftspruce.com", "www.aircraftspruce.ca"].includes(u.hostname)
      )
        url = u.href;
    } catch {
      /* No product URL. */
    }
    result.push({
      partNumber: row.PN,
      description: row.DESCRIPTION,
      netPrice: row.NETPRICE,
      uom: row.UOM,
      currency,
      catalogAt,
      url,
      availability: ["GA", "CA", "CANADA", "IL", "TX", "PA", "AZ"].map(
        (location) => ({
          location,
          quantity: row[`${location}-AVAIL`] ?? "",
          due: row[`${location}-DUE`] ?? "",
        }),
      ),
    });
    if (result.length === 30) break;
  }
  return result;
}
export function priceCents(value: string): number | undefined {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return undefined;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) && cents <= 100000000000
    ? cents
    : undefined;
}
export function parseOrders(
  text: string,
  po: string,
  order: string,
): SpruceOrderRow[] {
  const rows = [...csvRecords(text, orderFields)];
  if (rows.length > 1000)
    throw Error("Too many order lines. Select an individual order.");
  // Never trust provider wildcard matching as an authorization or exact link.
  return rows.filter((r) =>
    order ? r.ORN.trim() === order : r.PONO.trim() === po,
  );
}
