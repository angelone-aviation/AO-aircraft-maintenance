/**
 * Responsibility: The calls that reach Aircraft Spruce: link a Flight
 *   Program's login, refresh and search its catalog, sync a PO's order lines.
 * Layer: Server. Public actions; aircraftSpruce.ts authorizes, charges the
 *   hourly allowances and stores every result.
 * Dependencies: convex/aircraftSpruce, convex/spruceHttp, convex/secrets,
 *   convex/secretsMigration, convex/userErrors, src/domain/aircraftSpruce,
 *   convex/values.
 *
 * A Rejection from the domain's CSV, catalog and order checks reaches the
 * user as a ConvexError.
 */
"use node";
import { action, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import type { z } from "zod";
import {
  spruceCredentials,
  csvRecords,
  catalogSearch,
  orderFields,
  parseOrders,
  type SpruceOrderRow,
  type SpruceProduct,
} from "../src/domain/aircraftSpruce";
import { downloadSpruce } from "./spruceHttp";
import { sealSecret, type SecretContext } from "./secrets";
import { openStoredSecret } from "./secretsMigration";
import { exposeRejections } from "./userErrors";

type SpruceCredentials = z.infer<typeof spruceCredentials>;
// The same fields, each sealed by convex/secrets.
type StoredCredentials = SpruceCredentials;
type SecretField = "userid" | "password" | "apikey";

const MIN_SEARCH_LENGTH = 2;
const MAX_SEARCH_LENGTH = 200;
const MAX_ORDER_NUMBER_LENGTH = 100;

// The synced lines are stored in one spruceOrders document, and Convex limits
// a document to 1 MiB.
const MAX_ORDER_ROWS_JSON_LENGTH = 500_000;

// Catalog blobs are immutable per storage id (refresh stores a new one), so a
// warm isolate can reuse the last download instead of fetching up to 50 MB.
// ponytail: one entry; the CSV is still parsed per search inside catalogSearch.
let catalogCache: { id: string; text: string } | undefined;

/**
 * Links a Flight Program to an Aircraft Spruce login, once a small export
 * proves the login works. Replaces any earlier login and drops its catalog.
 *
 * @param programUuid - The active Flight Program.
 * @param version - The account version the form was loaded with.
 * @param userid - The login's user id; `password`, `apikey` and `currency`
 *   complete it, as `spruceCredentials` accepts them.
 * @returns null. Spends one of the program's hourly account checks, stores the
 *   credentials sealed and audits `spruce.account.linked`.
 * @throws {ConvexError} "Account changed. Reload before saving." for a stale
 *   version, before anything is spent; the allowance's or the download's
 *   refusal. Access and validation errors from aircraftSpruce.ts and zod.
 */
export const link = action({
  args: {
    programUuid: v.string(),
    version: v.number(),
    userid: v.string(),
    password: v.string(),
    apikey: v.string(),
    currency: v.string(),
  },
  handler: async (ctx, args): Promise<null> => {
    const current = await ctx.runQuery(internal.aircraftSpruce.access, {
      programUuid: args.programUuid,
    });
    if ((current.account?.version ?? 0) !== args.version)
      throw new ConvexError("Account changed. Reload before saving.");
    const credentials = spruceCredentials.parse(args);
    await ctx.runMutation(internal.aircraftSpruce.reserve, {
      programUuid: args.programUuid,
      kind: "link",
    });
    // Fail closed before contacting the provider if encryption is unavailable.
    const sealed = await sealCredentials(args.programUuid, credentials);
    await exposeRejections(assertLoginWorks(credentials));
    await ctx.runMutation(internal.aircraftSpruce.commitAccount, {
      programUuid: args.programUuid,
      version: args.version,
      credentials: sealed,
    });
    return null;
  },
});

/**
 * Downloads the linked account's full catalog and makes it the program's
 * searchable catalog.
 *
 * @param programUuid - The active Flight Program.
 * @returns How many products the catalog holds. Spends one of the program's
 *   hourly catalog refreshes and replaces the stored catalog file.
 * @throws {ConvexError} "Link Aircraft Spruce for this Flight Program first.";
 *   "Catalog contains an empty part number."; "Catalog is empty. Previous
 *   catalog retained."; the allowance's or the download's refusal. A refused
 *   commit deletes the new file and keeps the previous catalog.
 */
export const refresh = action({
  args: { programUuid: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const { account } = await ctx.runQuery(
      internal.aircraftSpruce.access,
      args,
    );
    if (!account?.credentials)
      throw new ConvexError(
        "Link Aircraft Spruce for this Flight Program first.",
      );
    await ctx.runMutation(internal.aircraftSpruce.reserve, {
      programUuid: args.programUuid,
      kind: "refresh",
    });
    const at = Date.now();
    const csv = await downloadSpruce(
      "products",
      await openCredentials(ctx, args.programUuid, account.credentials),
    );
    const count = exposeRejections(() => countCatalogProducts(csv));
    if (!count)
      throw new ConvexError("Catalog is empty. Previous catalog retained.");
    const storageId = await ctx.storage.store(
      new Blob([csv], { type: "text/csv" }),
    );
    try {
      await ctx.runMutation(internal.aircraftSpruce.commitCatalog, {
        programUuid: args.programUuid,
        version: account.version,
        storageId,
        count,
        at,
      });
    } catch (e) {
      // File storage is outside the mutation's transaction.
      await ctx.storage.delete(storageId);
      throw e;
    }
    return count;
  },
});

/**
 * Searches the program's stored catalog; it never contacts Aircraft Spruce.
 *
 * @param programUuid - The active Flight Program.
 * @param search - 2–200 characters, at least 2 once trimmed.
 * @returns Up to 30 matching products, as `catalogSearch` finds them.
 * @throws {ConvexError} "Enter 2–200 characters.", checked first; "Refresh
 *   this program's Aircraft Spruce catalog under Vendors first."; "Catalog
 *   unavailable. Refresh under Vendors."; "Account changed. Search again."
 *   when the account was relinked or disconnected during the search.
 */
export const search = action({
  args: { programUuid: v.string(), search: v.string() },
  handler: async (ctx, args): Promise<SpruceProduct[]> => {
    if (
      args.search.trim().length < MIN_SEARCH_LENGTH ||
      args.search.length > MAX_SEARCH_LENGTH
    )
      throw new ConvexError(
        `Enter ${MIN_SEARCH_LENGTH}–${MAX_SEARCH_LENGTH} characters.`,
      );
    const { account } = await ctx.runQuery(internal.aircraftSpruce.access, {
      programUuid: args.programUuid,
    });
    if (!account?.credentials || !account.catalogId)
      throw new ConvexError(
        "Refresh this program's Aircraft Spruce catalog under Vendors first.",
      );
    const catalog = await readCatalog(ctx, account.catalogId);
    const { currency } = account.credentials;
    const result = exposeRejections(() =>
      catalogSearch(catalog, args.search, currency, account.catalogAt!),
    );
    const latest = await ctx.runQuery(internal.aircraftSpruce.access, {
      programUuid: args.programUuid,
    });
    if (latest.account?.version !== account.version)
      throw new ConvexError("Account changed. Search again.");
    return result;
  },
});

/**
 * Fetches a purchase order's supplier order lines, by an exact order number
 * or else by the PO number, and saves them as the PO's latest sync.
 *
 * @param programUuid - The active Flight Program.
 * @param poUuid - The purchase order.
 * @param order - A supplier order number, or blank to match the PO number.
 * @returns How many lines were saved. Spends one of the program's hourly order
 *   syncs right after the access check; inventory and the PO stay unchanged.
 * @throws {ConvexError} "Link an Aircraft Spruce account first."; "Enter an
 *   exact order number."; "No matching orders found. Existing sync retained.
 *   …"; "Order export is too large. Select an individual order."; the
 *   allowance's or the download's refusal.
 */
export const sync = action({
  args: { programUuid: v.string(), poUuid: v.string(), order: v.string() },
  handler: async (ctx, args): Promise<number> => {
    // Authorizes the program administrator before charging the allowance.
    await ctx.runMutation(internal.aircraftSpruce.reserve, {
      programUuid: args.programUuid,
      kind: "sync",
    });
    const { account, poNumber } = await ctx.runQuery(
      internal.aircraftSpruce.access,
      { programUuid: args.programUuid, poUuid: args.poUuid },
    );
    if (!account?.credentials || !poNumber)
      throw new ConvexError("Link an Aircraft Spruce account first.");
    const order = parseOrderNumber(args.order);
    const fetchedAt = Date.now();
    const csv = await downloadSpruce(
      "orders",
      await openCredentials(ctx, args.programUuid, account.credentials),
      { fields: orderFields, ...(order ? { order } : { po: poNumber }) },
    );
    const rows = exposeRejections(() => parseOrders(csv, poNumber, order));
    assertOrderRowsStorable(rows);
    await ctx.runMutation(internal.aircraftSpruce.commitOrders, {
      programUuid: args.programUuid,
      poUuid: args.poUuid,
      version: account.version,
      fetchedAt,
      order,
      rows,
    });
    return rows.length;
  },
});

function spruceSecret(programUuid: string, field: SecretField): SecretContext {
  return { table: "spruceAccounts", programUuid, field };
}

async function sealCredentials(
  programUuid: string,
  credentials: SpruceCredentials,
): Promise<StoredCredentials> {
  const seal = (field: SecretField) =>
    sealSecret(credentials[field], spruceSecret(programUuid, field));
  return {
    userid: await seal("userid"),
    password: await seal("password"),
    apikey: await seal("apikey"),
    currency: credentials.currency,
  };
}

async function openCredentials(
  ctx: ActionCtx,
  programUuid: string,
  stored: StoredCredentials,
): Promise<SpruceCredentials> {
  const open = (field: SecretField) =>
    openStoredSecret(ctx, stored[field], spruceSecret(programUuid, field));
  return {
    userid: await open("userid"),
    password: await open("password"),
    apikey: await open("apikey"),
    currency: stored.currency,
  };
}

// Downloads today's order numbers, the smallest real export. The export's
// upper date bound is exclusive, hence tomorrow. An empty export is valid,
// but its header and rows must read cleanly.
async function assertLoginWorks(credentials: SpruceCredentials): Promise<void> {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const csv = await downloadSpruce("orders", credentials, {
    order_from: formatSpruceDate(today),
    order_to: formatSpruceDate(tomorrow),
    fields: ["ORN"],
  });
  for (const _row of csvRecords(csv, ["ORN"])) {
    // csvRecords checks the header and each row as it reads them.
  }
}

// MM/DD/YYYY, in UTC.
function formatSpruceDate(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}/${day}/${date.getUTCFullYear()}`;
}

function countCatalogProducts(csv: string): number {
  let count = 0;
  for (const row of csvRecords(csv, ["PN", "DESCRIPTION", "NETPRICE", "UOM"])) {
    if (!row.PN)
      throw new ConvexError("Catalog contains an empty part number.");
    count++;
  }
  return count;
}

async function readCatalog(
  ctx: ActionCtx,
  id: Id<"_storage">,
): Promise<string> {
  if (catalogCache?.id === id) return catalogCache.text;
  const file = await ctx.storage.get(id);
  if (!file)
    throw new ConvexError("Catalog unavailable. Refresh under Vendors.");
  catalogCache = { id, text: await file.text() };
  return catalogCache.text;
}

// % is the provider's partial-match wildcard
// (docs/aircraft-spruce-api-review.md) and _ is SQL's one-character one:
// either could match other orders.
function parseOrderNumber(input: string): string {
  const order = input.trim();
  if (order.length > MAX_ORDER_NUMBER_LENGTH || /[%_]/.test(order))
    throw new ConvexError("Enter an exact order number.");
  return order;
}

function assertOrderRowsStorable(rows: SpruceOrderRow[]): void {
  if (!rows.length)
    throw new ConvexError(
      "No matching orders found. Existing sync retained. Check the PO number or enter the Aircraft Spruce order number.",
    );
  if (JSON.stringify(rows).length > MAX_ORDER_ROWS_JSON_LENGTH)
    throw new ConvexError(
      "Order export is too large. Select an individual order.",
    );
}
