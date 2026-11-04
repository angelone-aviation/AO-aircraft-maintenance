/**
 * Responsibility: Aircraft Spruce supplier data: the account and linked-part
 *   schemas, and parsing of the catalog and order CSV exports.
 * Layer: Domain. Pure zod schemas and functions; no I/O, no React.
 * Dependencies: zod, ./rejection.
 */
import { z } from "zod";
import { Rejection } from "./rejection";

const ISO_CURRENCY_CODE = /^[A-Z]{3}$/;
const BYTE_ORDER_MARK = 0xfeff;
const SEARCH_MIN_LENGTH = 2;

// The product picker tells users it shows "up to 30 matches".
const SEARCH_RESULT_LIMIT = 30;

// Product links are rendered, so only https links to the supplier's own sites
// are kept.
const PRODUCT_LINK_HOSTS: readonly string[] = [
  "www.aircraftspruce.com",
  "www.aircraftspruce.ca",
];

// The catalog's stock-location codes, as in its "<code>-AVAIL" and
// "<code>-DUE" columns, in display order.
const STOCK_LOCATIONS = ["GA", "CA", "CANADA", "IL", "TX", "PA", "AZ"];

// The money limit on purchase-order and parts-request lines: $1 billion
// (costs.ts MAX_CENTS).
const MAX_PRICE_CENTS = 100_000_000_000;

const MAX_ORDER_LINES = 1000;

/**
 * The supplier export-API login linked to a Flight Program, with the account's
 * catalog currency (ISO 4217). Trims the user id and API key but not the
 * password, whose spaces may be part of it.
 *
 * @throws {z.ZodError} From `parse()` on a blank or over-long field, or a
 *   currency that is not three capital letters.
 */
export const spruceCredentials = z.object({
  userid: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(500),
  apikey: z.string().trim().min(1).max(500),
  currency: z.string().regex(ISO_CURRENCY_CODE),
});

/**
 * The catalog product an order or request line is linked to: its supplier
 * part number, unit of measure, catalog currency, and when that catalog was
 * fetched (epoch ms).
 *
 * @throws {z.ZodError} From `parse()` on a blank or over-long part number, an
 *   over-long unit, or a currency that is not three capital letters.
 */
export const sprucePartSchema = z.object({
  partNumber: z.string().min(1).max(2000),
  uom: z.string().max(100),
  currency: z.string().regex(ISO_CURRENCY_CODE),
  catalogAt: z.number(),
});

/** A linked catalog product, as stored on a line. */
export type SprucePart = z.infer<typeof sprucePartSchema>;

/**
 * A catalog search result. `netPrice` is the catalog's text (see
 * {@link priceCents}), `url` is "" unless it is a safe supplier link, and each
 * location's quantity and due text are the supplier's, with "" for unknown.
 */
export type SpruceProduct = SprucePart & {
  description: string;
  netPrice: string;
  url: string;
  availability: { location: string; quantity: string; due: string }[];
};

/**
 * A program's supplier account as settings show it, without credentials.
 * `version` (0 before the first link) changes on every link and disconnect, so
 * a change made against an older one is refused.
 */
export type SpruceStatus = {
  configured: boolean;
  version: number;
  currency?: string;
  catalogAt?: number;
  catalogCount?: number;
};

/** One order-export line, keyed by {@link orderFields} column. */
export type SpruceOrderRow = Record<string, string>;

/**
 * The order lines last synced for a purchase order: when they were fetched,
 * the order number asked for ("" when matched by PO number), and the lines.
 */
export type SpruceOrderSnapshot = {
  fetchedAt: number;
  order: string;
  rows: SpruceOrderRow[];
};

/** Columns requested from the order export; its header must hold them all. */
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

/**
 * Splits CSV text into rows of fields, one row at a time, so a full catalog
 * (about 126,000 rows) never becomes one array. Handles quoted commas, doubled
 * quotes and line breaks, a leading byte-order mark, and \n, \r\n or \r line
 * ends. Skips lines whose fields are all empty, but keeps such a last line
 * when it has a comma and no line break.
 *
 * @param text - The whole export.
 * @returns A generator of rows, each the list of its fields' text.
 * @throws {Error} "Incomplete CSV download." when a quoted field never closes,
 *   once the rows before it have been read.
 */
export function* csvRows(text: string): Generator<string[]> {
  let row: string[] = [];
  let value = "";
  let quoted = false;
  const start = text.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === '"' && text[i + 1] === '"') {
      value += '"';
      i++;
      continue;
    }
    if (ch === '"' && (quoted || !value)) {
      quoted = !quoted;
      continue;
    }
    // A quote inside an unquoted field is text: supplier descriptions use
    // bare inch marks.
    if (quoted || !isFieldEnd(ch)) {
      value += ch;
      continue;
    }
    row.push(value);
    value = "";
    if (ch === ",") continue;
    if (ch === "\r" && text[i + 1] === "\n") i++;
    if (row.some(Boolean)) yield row;
    row = [];
  }
  if (quoted) throw Error("Incomplete CSV download.");
  if (value || row.length) yield [...row, value];
}

/**
 * Reads an Aircraft Spruce export as records keyed by its header row, one at a
 * time. Errors surface only as iteration reaches them.
 *
 * @param text - The whole export.
 * @param required - Columns the header must include; other columns are kept.
 * @returns A generator of records mapping each header to the row's field.
 * @throws {Error} "Unexpected Aircraft Spruce CSV columns." for an empty export
 *   or a missing required column; "Unexpected Aircraft Spruce CSV row." for a
 *   row whose field count differs from the header's; {@link csvRows}' error.
 */
export function* csvRecords(text: string, required: string[]) {
  const rows = csvRows(text);
  const headers: string[] | undefined = rows.next().value;
  if (!headers || required.some((column) => !headers.includes(column)))
    throw Error("Unexpected Aircraft Spruce CSV columns.");
  for (const row of rows) {
    if (row.length !== headers.length)
      throw Error("Unexpected Aircraft Spruce CSV row.");
    yield Object.fromEntries(headers.map((header, i) => [header, row[i]]));
  }
}

/**
 * Finds catalog products whose part number and description, joined by a
 * space, contain the search text, ignoring case.
 *
 * @param text - The stored catalog export.
 * @param search - Search text; at least two characters once trimmed.
 * @param currency - The account's catalog currency, copied onto each product.
 * @param catalogAt - When the catalog was fetched (epoch ms), copied likewise.
 * @returns The first 30 matches, in catalog order.
 * @throws {Rejection} "Enter at least two characters." for a shorter search.
 * @throws {Error} The {@link csvRecords} errors for rows read before the 30th
 *   match.
 */
export function catalogSearch(
  text: string,
  search: string,
  currency: string,
  catalogAt: number,
): SpruceProduct[] {
  const query = search.trim().toLowerCase();
  if (query.length < SEARCH_MIN_LENGTH)
    throw new Rejection("Enter at least two characters.");
  const products: SpruceProduct[] = [];
  for (const row of csvRecords(text, [
    "PN",
    "DESCRIPTION",
    "NETPRICE",
    "UOM",
  ])) {
    if (!`${row.PN} ${row.DESCRIPTION}`.toLowerCase().includes(query)) continue;
    products.push(buildProduct(row, currency, catalogAt));
    if (products.length === SEARCH_RESULT_LIMIT) break;
  }
  return products;
}

/**
 * Converts a catalog net price to cents for a document line.
 *
 * @param value - The catalog's price text, such as "1.25".
 * @returns Whole cents, or undefined unless the text is a plain non-negative
 *   number with at most two decimals and at most $1 billion.
 */
export function priceCents(value: string): number | undefined {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return undefined;
  const cents = Math.round(Number(value) * 100);
  return cents <= MAX_PRICE_CENTS ? cents : undefined;
}

/**
 * Picks a purchase order's lines from an order export: those with exactly the
 * order number when one is given, otherwise exactly the PO number. Repeated
 * lines for a part are kept, not summed.
 *
 * @param text - The order export, with every {@link orderFields} column.
 * @param po - The purchase order's number.
 * @param order - A supplier order number, already trimmed, or "" to use `po`.
 * @returns The matching lines, in export order.
 * @throws {Rejection} "Too many order lines. Select an individual order."
 *   when the export has over 1,000 lines, matching or not.
 * @throws {Error} The {@link csvRecords} errors.
 */
export function parseOrders(
  text: string,
  po: string,
  order: string,
): SpruceOrderRow[] {
  const rows = [...csvRecords(text, orderFields)];
  if (rows.length > MAX_ORDER_LINES)
    throw new Rejection("Too many order lines. Select an individual order.");
  // The provider's PO search matches partially ("%"), so its result is never
  // trusted as an authorization or an exact link.
  return rows.filter((row) =>
    order ? row.ORN.trim() === order : row.PONO.trim() === po,
  );
}

function isFieldEnd(ch: string): boolean {
  return ch === "," || ch === "\n" || ch === "\r";
}

function buildProduct(
  row: Record<string, string>,
  currency: string,
  catalogAt: number,
): SpruceProduct {
  return {
    partNumber: row.PN,
    description: row.DESCRIPTION,
    netPrice: row.NETPRICE,
    uom: row.UOM,
    currency,
    catalogAt,
    url: sanitizeProductUrl(row.URL),
    availability: STOCK_LOCATIONS.map((location) => ({
      location,
      quantity: row[`${location}-AVAIL`] ?? "",
      due: row[`${location}-DUE`] ?? "",
    })),
  };
}

function sanitizeProductUrl(value: string | undefined): string {
  try {
    const url = new URL(value ?? "");
    const safe =
      url.protocol === "https:" && PRODUCT_LINK_HOSTS.includes(url.hostname);
    return safe ? url.href : "";
  } catch {
    // A missing or malformed URL leaves the product without a link.
    return "";
  }
}
