import { writeAudit } from "./access";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { checkContext } from "./programContext";
import { programPermission } from "../src/domain/programs";
import { poSchema } from "../src/domain/purchaseOrders";
import { spruceCredentials } from "../src/domain/aircraftSpruce";
import { consume, HOUR } from "./rateLimits";
import { SEALED_V2 } from "./secrets";
import { z } from "zod";

async function authorize(ctx: QueryCtx | MutationCtx, programUuid: string) {
  const s = await checkContext(ctx, programUuid);
  if (!programUuid || !programPermission(s, "admin"))
    throw Error("Flight Program inventory administrator access required.");
  return s;
}
async function account(ctx: QueryCtx | MutationCtx, programUuid: string) {
  await authorize(ctx, programUuid);
  return ctx.db
    .query("spruceAccounts")
    .withIndex("program", (q) => q.eq("programUuid", programUuid))
    .unique();
}
export const status = query({
  args: { programUuid: v.string() },
  handler: async (ctx, { programUuid }) => {
    const a = await account(ctx, programUuid);
    return {
      configured: !!a?.credentials,
      version: a?.version ?? 0,
      currency: a?.credentials?.currency,
      catalogAt: a?.catalogAt,
      catalogCount: a?.catalogCount,
    };
  },
});
export const access = internalQuery({
  args: { programUuid: v.string(), poUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const a = await account(ctx, args.programUuid);
    let po;
    if (args.poUuid) {
      const doc = await ctx.db
        .query("purchaseOrders")
        .withIndex("uuid", (q) => q.eq("uuid", args.poUuid!))
        .unique();
      if (!doc || doc.programUuid !== args.programUuid)
        throw Error("PO not found in this Flight Program.");
      po = poSchema.parse(JSON.parse(doc.payload));
    }
    return { account: a, poNumber: po?.number };
  },
});
// Per-program hourly allowances for calls that contact Aircraft Spruce.
export const SPRUCE_RATE_LIMITS = {
  link: { limit: 5, label: "account checks" },
  refresh: { limit: 4, label: "catalog refreshes" },
  sync: { limit: 30, label: "order syncs" },
} as const;
// Authorizes the program administrator, then charges the program's allowance.
export const reserve = internalMutation({
  args: {
    programUuid: v.string(),
    kind: v.union(v.literal("link"), v.literal("refresh"), v.literal("sync")),
  },
  handler: async (ctx, args) => {
    await authorize(ctx, args.programUuid);
    const { limit, label } = SPRUCE_RATE_LIMITS[args.kind];
    await consume(
      ctx,
      `spruce:${args.kind}:program:${args.programUuid}`,
      limit,
      HOUR,
      `Too many Aircraft Spruce ${label} for this Flight Program. Try again within the hour.`,
    );
    return null;
  },
});
// link validates plaintext lengths with spruceCredentials before sealing; the
// stored values are sealed (v2), so they are checked against sealed lengths.
// 500 characters of plaintext is at most 1,500 UTF-8 bytes, about 2,100 sealed.
const sealedValue = z.string().max(2200).regex(SEALED_V2);
const sealedSpruceCredentials = z.object({
  userid: sealedValue,
  password: sealedValue,
  apikey: sealedValue,
  currency: spruceCredentials.shape.currency,
});
export const commitAccount = internalMutation({
  args: {
    programUuid: v.string(),
    version: v.number(),
    credentials: v.optional(
      v.object({
        userid: v.string(),
        password: v.string(),
        apikey: v.string(),
        currency: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const a = await account(ctx, args.programUuid);
    if ((a?.version ?? 0) !== args.version)
      throw Error("Account changed. Reload before saving.");
    const credentials = args.credentials
      ? sealedSpruceCredentials.parse(args.credentials)
      : undefined;
    const fields = {
      programUuid: args.programUuid,
      version: args.version + 1,
      credentials,
      catalogId: undefined,
      catalogAt: undefined,
      catalogCount: undefined,
    };
    if (a) {
      if (a.catalogId) await ctx.storage.delete(a.catalogId);
      await ctx.db.replace(a._id, fields);
    } else await ctx.db.insert("spruceAccounts", fields);
    await logAccount(
      ctx,
      args.programUuid,
      credentials ? "spruce.account.linked" : "spruce.account.disconnected",
    );
  },
});
// Records who linked or disconnected the account; never the credentials.
async function logAccount(
  ctx: MutationCtx,
  programUuid: string,
  action: "spruce.account.linked" | "spruce.account.disconnected",
) {
  await writeAudit(ctx, {
    uuid: crypto.randomUUID(),
    programUuid,
    at: Date.now(),
    actorId: (await checkContext(ctx, programUuid)).user.id,
    action,
    entityUuid: programUuid,
  });
}
export const disconnect = mutation({
  args: { programUuid: v.string(), version: v.number() },
  handler: async (ctx, args) => {
    const a = await account(ctx, args.programUuid);
    if (!a || a.version !== args.version)
      throw Error("Account changed. Reload before disconnecting.");
    if (a.catalogId) await ctx.storage.delete(a.catalogId);
    await ctx.db.replace(a._id, {
      programUuid: args.programUuid,
      version: a.version + 1,
    });
    await logAccount(ctx, args.programUuid, "spruce.account.disconnected");
  },
});
export const commitCatalog = internalMutation({
  args: {
    programUuid: v.string(),
    version: v.number(),
    storageId: v.id("_storage"),
    count: v.number(),
    at: v.number(),
  },
  handler: async (ctx, args) => {
    const a = await account(ctx, args.programUuid);
    if (!a?.credentials || a.version !== args.version)
      throw Error("Account changed. Refresh again.");
    if (a.catalogAt && a.catalogAt > args.at)
      throw Error("A newer catalog is already available.");
    if (a.catalogId) await ctx.storage.delete(a.catalogId);
    await ctx.db.patch(a._id, {
      catalogId: args.storageId,
      catalogCount: args.count,
      catalogAt: args.at,
    });
  },
});
export const orders = query({
  args: { programUuid: v.string(), poUuid: v.string() },
  handler: async (ctx, args) => {
    const a = await account(ctx, args.programUuid);
    const saved = await ctx.db
      .query("spruceOrders")
      .withIndex("po", (q) =>
        q.eq("programUuid", args.programUuid).eq("poUuid", args.poUuid),
      )
      .unique();
    return a?.credentials && saved?.accountVersion === a.version
      ? { fetchedAt: saved.fetchedAt, order: saved.order, rows: saved.rows }
      : null;
  },
});
export const commitOrders = internalMutation({
  args: {
    programUuid: v.string(),
    poUuid: v.string(),
    version: v.number(),
    fetchedAt: v.number(),
    order: v.string(),
    rows: v.array(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => {
    const a = await account(ctx, args.programUuid);
    if (!a?.credentials || a.version !== args.version)
      throw Error("Account changed. Sync again.");
    const po = await ctx.db
      .query("purchaseOrders")
      .withIndex("uuid", (q) => q.eq("uuid", args.poUuid))
      .unique();
    if (!po || po.programUuid !== args.programUuid)
      throw Error("PO not found.");
    const old = await ctx.db
      .query("spruceOrders")
      .withIndex("po", (q) =>
        q.eq("programUuid", args.programUuid).eq("poUuid", args.poUuid),
      )
      .unique();
    if (old && old.fetchedAt > args.fetchedAt)
      throw Error("A newer sync is already available.");
    const { version, ...rest } = args;
    const data = { ...rest, accountVersion: version };
    if (old) await ctx.db.replace(old._id, data);
    else await ctx.db.insert("spruceOrders", data);
  },
});
