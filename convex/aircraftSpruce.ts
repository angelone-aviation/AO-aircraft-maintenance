/**
 * Responsibility: A Flight Program's Aircraft Spruce account as stored: its
 *   status, sealed login, catalog file, synced PO orders and hourly allowances.
 * Layer: Server. Queries and mutations for program administrators; the calls
 *   that reach Aircraft Spruce are in aircraftSpruceActions.ts.
 * Dependencies: convex/programContext, convex/access, convex/rateLimits,
 *   convex/secrets, src/domain (aircraftSpruce, programs, purchaseOrders), zod.
 *
 * `version` changes on every link and disconnect, so a write prepared against
 * an older account is refused and orders synced under it stop showing.
 */
import { writeAudit } from "./access";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { checkContext } from "./programContext";
import { programPermission } from "../src/domain/programs";
import { poSchema } from "../src/domain/purchaseOrders";
import { spruceCredentials } from "../src/domain/aircraftSpruce";
import { consume, HOUR } from "./rateLimits";
import { SEALED_V2 } from "./secrets";
import { z } from "zod";

// link checks plaintext lengths with spruceCredentials before sealing; 500
// characters of plaintext is at most 1,500 UTF-8 bytes, about 2,100 sealed.
const MAX_SEALED_LENGTH = 2200;

const sealedValue = z.string().max(MAX_SEALED_LENGTH).regex(SEALED_V2);
const sealedSpruceCredentials = z.object({
  userid: sealedValue,
  password: sealedValue,
  apikey: sealedValue,
  currency: spruceCredentials.shape.currency,
});

/**
 * Per-program hourly allowances for the calls that contact Aircraft Spruce,
 * with the words the refusal uses for each.
 */
export const SPRUCE_RATE_LIMITS = {
  link: { limit: 5, label: "account checks" },
  refresh: { limit: 4, label: "catalog refreshes" },
  sync: { limit: 30, label: "order syncs" },
} as const;

/**
 * Shows the program's account as settings show it, without credentials.
 *
 * @param programUuid - The active Flight Program.
 * @returns Whether a login is linked, the version (0 before the first link),
 *   and the currency and catalog details when set.
 * @throws {Error} As `checkContext`; "Flight Program inventory administrator
 *   access required."
 */
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

/**
 * Loads the account, and optionally a PO's number, for an action about to
 * contact Aircraft Spruce.
 *
 * @param programUuid - The active Flight Program.
 * @param poUuid - A purchase order of that program, when syncing its orders.
 * @returns The stored account (sealed credentials included) or null, and the
 *   PO's number when `poUuid` is given.
 * @throws {Error} The {@link status} refusals; "PO not found in this Flight
 *   Program."
 */
export const access = internalQuery({
  args: { programUuid: v.string(), poUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const a = await account(ctx, args.programUuid);
    if (!args.poUuid) return { account: a, poNumber: undefined };
    const doc = await findProgramPo(ctx, args.programUuid, args.poUuid);
    if (!doc) throw new Error("PO not found in this Flight Program.");
    const po = poSchema.parse(JSON.parse(doc.payload));
    return { account: a, poNumber: po.number };
  },
});

/**
 * Authorizes the program administrator, then spends one of the program's
 * hourly allowances of `kind`.
 *
 * @param programUuid - The active Flight Program.
 * @param kind - Which allowance, from {@link SPRUCE_RATE_LIMITS}.
 * @returns null.
 * @throws {Error} The {@link status} refusals.
 * @throws {ConvexError} "Too many Aircraft Spruce <label> for this Flight
 *   Program. Try again within the hour."
 */
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

/**
 * Stores a verified login, or none, as the next account version, dropping the
 * catalog, and audits `spruce.account.linked` or `.disconnected`.
 *
 * @param programUuid - The active Flight Program.
 * @param version - The version the change was prepared against.
 * @param credentials - The login, each field sealed; omit to disconnect.
 * @throws {Error} The {@link status} refusals; "Account changed. Reload before
 *   saving."; a ZodError for a value that is not sealed (v2) or too long.
 */
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
      throw new Error("Account changed. Reload before saving.");
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
      await deleteCatalog(ctx, a);
      await ctx.db.replace(a._id, fields);
    } else await ctx.db.insert("spruceAccounts", fields);
    await logAccount(
      ctx,
      args.programUuid,
      credentials ? "spruce.account.linked" : "spruce.account.disconnected",
    );
  },
});

/**
 * Unlinks the program's login and drops its catalog, as the next account
 * version, and audits `spruce.account.disconnected`.
 *
 * @param programUuid - The active Flight Program.
 * @param version - The version settings showed.
 * @throws {Error} The {@link status} refusals; "Account changed. Reload before
 *   disconnecting." when there is no account or the version moved on.
 */
export const disconnect = mutation({
  args: { programUuid: v.string(), version: v.number() },
  handler: async (ctx, args) => {
    const a = await account(ctx, args.programUuid);
    if (!a || a.version !== args.version)
      throw new Error("Account changed. Reload before disconnecting.");
    await deleteCatalog(ctx, a);
    await ctx.db.replace(a._id, {
      programUuid: args.programUuid,
      version: a.version + 1,
    });
    await logAccount(ctx, args.programUuid, "spruce.account.disconnected");
  },
});

/**
 * Makes a downloaded catalog file the program's catalog, deleting the one it
 * replaces. Writes no audit entry.
 *
 * @param programUuid - The active Flight Program.
 * @param version - The account version the catalog was downloaded under.
 * @param storageId - The stored catalog file.
 * @param count - How many products it holds.
 * @param at - When the download started (epoch ms).
 * @throws {Error} The {@link status} refusals; "Account changed. Refresh
 *   again."; "A newer catalog is already available."
 */
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
      throw new Error("Account changed. Refresh again.");
    if (a.catalogAt && a.catalogAt > args.at)
      throw new Error("A newer catalog is already available.");
    await deleteCatalog(ctx, a);
    await ctx.db.patch(a._id, {
      catalogId: args.storageId,
      catalogCount: args.count,
      catalogAt: args.at,
    });
  },
});

/**
 * Shows a purchase order's last synced supplier order lines.
 *
 * @param programUuid - The active Flight Program.
 * @param poUuid - The purchase order.
 * @returns When they were fetched, the order number asked for and the lines;
 *   null when none were synced under the current linked account.
 * @throws {Error} The {@link status} refusals.
 */
export const orders = query({
  args: { programUuid: v.string(), poUuid: v.string() },
  handler: async (ctx, args) => {
    const a = await account(ctx, args.programUuid);
    const saved = await findSavedOrders(ctx, args.programUuid, args.poUuid);
    return a?.credentials && saved?.accountVersion === a.version
      ? { fetchedAt: saved.fetchedAt, order: saved.order, rows: saved.rows }
      : null;
  },
});

/**
 * Saves a purchase order's synced order lines, replacing the previous sync.
 * Writes no audit entry and changes neither inventory nor the PO.
 *
 * @param programUuid - The active Flight Program.
 * @param poUuid - The purchase order.
 * @param version - The account version the lines were fetched under.
 * @param fetchedAt - When the fetch started (epoch ms).
 * @param order - The order number asked for, or "" for the PO number.
 * @param rows - The order lines.
 * @throws {Error} The {@link status} refusals; "Account changed. Sync again.";
 *   "PO not found."; "A newer sync is already available."
 */
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
      throw new Error("Account changed. Sync again.");
    if (!(await findProgramPo(ctx, args.programUuid, args.poUuid)))
      throw new Error("PO not found.");
    const old = await findSavedOrders(ctx, args.programUuid, args.poUuid);
    if (old && old.fetchedAt > args.fetchedAt)
      throw new Error("A newer sync is already available.");
    const { version, ...rest } = args;
    const data = { ...rest, accountVersion: version };
    if (old) await ctx.db.replace(old._id, data);
    else await ctx.db.insert("spruceOrders", data);
  },
});

async function authorize(ctx: QueryCtx | MutationCtx, programUuid: string) {
  const s = await checkContext(ctx, programUuid);
  if (!programUuid || !programPermission(s, "admin"))
    throw new Error("Flight Program inventory administrator access required.");
  return s;
}

async function account(ctx: QueryCtx | MutationCtx, programUuid: string) {
  await authorize(ctx, programUuid);
  return ctx.db
    .query("spruceAccounts")
    .withIndex("program", (q) => q.eq("programUuid", programUuid))
    .unique();
}

async function findProgramPo(
  ctx: QueryCtx,
  programUuid: string,
  poUuid: string,
): Promise<Doc<"purchaseOrders"> | null> {
  const doc = await ctx.db
    .query("purchaseOrders")
    .withIndex("uuid", (q) => q.eq("uuid", poUuid))
    .unique();
  return doc?.programUuid === programUuid ? doc : null;
}

function findSavedOrders(ctx: QueryCtx, programUuid: string, poUuid: string) {
  return ctx.db
    .query("spruceOrders")
    .withIndex("po", (q) =>
      q.eq("programUuid", programUuid).eq("poUuid", poUuid),
    )
    .unique();
}

async function deleteCatalog(
  ctx: MutationCtx,
  a: Doc<"spruceAccounts">,
): Promise<void> {
  if (a.catalogId) await ctx.storage.delete(a.catalogId);
}

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
