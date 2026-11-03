"use node";
import { action, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import {
  spruceCredentials,
  csvRecords,
  catalogSearch,
  orderFields,
  parseOrders,
  type SpruceProduct,
} from "../src/domain/aircraftSpruce";
import { downloadSpruce } from "./spruceHttp";
import { sealSecret, type SecretContext } from "./secrets";
import { openStoredSecret } from "./secretsMigration";
type StoredCredentials = {
  userid: string;
  password: string;
  apikey: string;
  currency: string;
};
const spruceSecret = (programUuid: string, field: string): SecretContext => ({
  table: "spruceAccounts",
  programUuid,
  field,
});
const openCredentials = async (
  ctx: ActionCtx,
  programUuid: string,
  c: StoredCredentials,
) => ({
  userid: await openStoredSecret(
    ctx,
    c.userid,
    spruceSecret(programUuid, "userid"),
  ),
  password: await openStoredSecret(
    ctx,
    c.password,
    spruceSecret(programUuid, "password"),
  ),
  apikey: await openStoredSecret(
    ctx,
    c.apikey,
    spruceSecret(programUuid, "apikey"),
  ),
  currency: c.currency,
});

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
    const sealed = {
      userid: await sealSecret(
        credentials.userid,
        spruceSecret(args.programUuid, "userid"),
      ),
      password: await sealSecret(
        credentials.password,
        spruceSecret(args.programUuid, "password"),
      ),
      apikey: await sealSecret(
        credentials.apikey,
        spruceSecret(args.programUuid, "apikey"),
      ),
      currency: credentials.currency,
    };
    const date = new Date();
    const format = (d: Date) =>
      `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
    const end = new Date(date);
    end.setUTCDate(end.getUTCDate() + 1);
    const csv = await downloadSpruce("orders", credentials, {
      order_from: format(date),
      order_to: format(end),
      fields: ["ORN"],
    });
    // Empty results are valid; the provider must still supply the requested header.
    for (const _row of csvRecords(csv, ["ORN"])) {
      /* Validate response. */
    }
    await ctx.runMutation(internal.aircraftSpruce.commitAccount, {
      programUuid: args.programUuid,
      version: args.version,
      credentials: sealed,
    });
    return null;
  },
});
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
    let count = 0;
    for (const row of csvRecords(csv, [
      "PN",
      "DESCRIPTION",
      "NETPRICE",
      "UOM",
    ])) {
      if (!row.PN)
        throw new ConvexError("Catalog contains an empty part number.");
      count++;
    }
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
      await ctx.storage.delete(storageId);
      throw e;
    }
    return count;
  },
});
// Catalog blobs are immutable per storage id (refresh stores a new one), so a
// warm isolate can reuse the last download instead of fetching up to 50 MB.
// ponytail: one entry; the CSV is still parsed per search inside catalogSearch.
let catalogCache: { id: string; text: string } | undefined;
async function catalogText(ctx: ActionCtx, id: Id<"_storage">) {
  if (catalogCache?.id === id) return catalogCache.text;
  const file = await ctx.storage.get(id);
  if (!file)
    throw new ConvexError("Catalog unavailable. Refresh under Vendors.");
  catalogCache = { id, text: await file.text() };
  return catalogCache.text;
}
export const search = action({
  args: { programUuid: v.string(), search: v.string() },
  handler: async (ctx, args): Promise<SpruceProduct[]> => {
    if (args.search.trim().length < 2 || args.search.length > 200)
      throw new ConvexError("Enter 2–200 characters.");
    const { account } = await ctx.runQuery(internal.aircraftSpruce.access, {
      programUuid: args.programUuid,
    });
    if (!account?.credentials || !account.catalogId)
      throw new ConvexError(
        "Refresh this program's Aircraft Spruce catalog under Vendors first.",
      );
    const result = catalogSearch(
      await catalogText(ctx, account.catalogId),
      args.search,
      account.credentials.currency,
      account.catalogAt!,
    );
    const latest = await ctx.runQuery(internal.aircraftSpruce.access, {
      programUuid: args.programUuid,
    });
    if (latest.account?.version !== account.version)
      throw new ConvexError("Account changed. Search again.");
    return result;
  },
});
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
    const order = args.order.trim();
    if (order.length > 100 || /[%_]/.test(order))
      throw new ConvexError("Enter an exact order number.");
    const fetchedAt = Date.now();
    const csv = await downloadSpruce(
      "orders",
      await openCredentials(ctx, args.programUuid, account.credentials),
      {
        fields: orderFields,
        ...(order ? { order } : { po: poNumber }),
      },
    );
    const rows = parseOrders(csv, poNumber, order);
    if (!rows.length)
      throw new ConvexError(
        "No matching orders found. Existing sync retained. Check the PO number or enter the Aircraft Spruce order number.",
      );
    if (JSON.stringify(rows).length > 500000)
      throw new ConvexError(
        "Order export is too large. Select an individual order.",
      );
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
