import {
  action,
  query,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { admin, audit } from "./access";
import { checkContext } from "./programContext";
import { sealSecret, type SecretContext } from "./secrets";
import { openStoredSecret } from "./secretsMigration";
import { consume, DAY } from "./rateLimits";
const USER_DAILY_LOOKUPS = 200;
const PROGRAM_DAILY_LOOKUPS = 1000;
import { can } from "../src/domain/model";
import { programPermission } from "../src/domain/programs";
import {
  addressLookupSchema,
  fetchAddressSuggestions,
  type AddressSuggestion,
} from "../src/domain/addressLookup";
import { z } from "zod";
const keySchema = z
  .string()
  .trim()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
export const status = query({
  args: {},
  handler: async (ctx) => {
    await admin(ctx);
    const saved = await ctx.db.query("addressVerificationSettings").unique();
    return {
      configured: Boolean(saved?.key || process.env.GEOAPIFY_API_KEY),
      version: saved?.version ?? 0,
    };
  },
});
export const authorizeAdmin = internalQuery({
  args: {},
  handler: async (ctx) => {
    await admin(ctx);
    return null;
  },
});
export const reserve = internalMutation({
  args: { programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    if (
      !s.user.isAdmin &&
      !programPermission(s, "admin") &&
      !s.aircraft.some((a) => can(s, a.uuid, "maintenance"))
    )
      throw Error("Maintenance access required for address lookups.");
    const saved = await ctx.db.query("addressVerificationSettings").unique();
    const key = saved?.key || process.env.GEOAPIFY_API_KEY;
    if (!key)
      throw Error(
        "Address lookup is not enabled. A system administrator must add a free Geoapify API key in Settings → System → Address verification.",
      );
    const now = Date.now(),
      day = new Date(now).toISOString().slice(0, 10);
    // One lookup per second per user, so one user cannot block the others.
    await consume(
      ctx,
      `address:user-second:${s.user.id}`,
      1,
      1000,
      "Please wait a second before another address lookup.",
    );
    const used = saved?.day === day ? saved.used : 0;
    if (used >= 2900)
      throw Error(
        "Today's address lookup allowance is used. Try again tomorrow.",
      );
    // Per-user and per-program shares so one tenant cannot drain the global quota.
    await consume(
      ctx,
      `address:user:${s.user.id}`,
      USER_DAILY_LOOKUPS,
      DAY,
      "Your address lookup allowance for today is used. Try again tomorrow.",
    );
    await consume(
      ctx,
      `address:program:${args.programUuid ?? ""}`,
      PROGRAM_DAILY_LOOKUPS,
      DAY,
      "This Flight Program's address lookup allowance for today is used. Try again tomorrow.",
    );
    if (saved)
      await ctx.db.patch(saved._id, { day, used: used + 1, lastLookupAt: now });
    else
      await ctx.db.insert("addressVerificationSettings", {
        version: 0,
        day,
        used: 1,
        lastLookupAt: now,
      });
    // The saved key arrives sealed; the environment key is the fallback.
    return { stored: saved?.key || "" };
  },
});
const GEOAPIFY_SECRET: SecretContext = {
  table: "addressVerificationSettings",
  programUuid: "",
  field: "key",
};
export const lookup = action({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args): Promise<AddressSuggestion[]> => {
    const input = addressLookupSchema.parse(JSON.parse(args.payload));
    const { stored } = await ctx.runMutation(
      internal.addressVerification.reserve,
      { programUuid: args.programUuid },
    );
    const key = stored
      ? await openStoredSecret(ctx, stored, GEOAPIFY_SECRET)
      : process.env.GEOAPIFY_API_KEY || "";
    return fetchAddressSuggestions(input, key);
  },
});
export const commit = internalMutation({
  args: { key: v.string(), version: v.number() },
  // `key` arrives sealed; setKey validated the plaintext before sealing.
  handler: async (ctx, args) => {
    const user = await admin(ctx),
      key = args.key;
    const saved = await ctx.db.query("addressVerificationSettings").unique();
    if ((saved?.version ?? 0) !== args.version)
      throw Error("Address settings changed. Reload before saving.");
    if (saved)
      await ctx.db.patch(saved._id, { key, version: args.version + 1 });
    else
      await ctx.db.insert("addressVerificationSettings", {
        key,
        version: 1,
        day: "",
        used: 0,
        lastLookupAt: 0,
      });
    await audit(
      ctx,
      user._id,
      "addressVerification.key.updated",
      "address-verification",
      { after: { configured: true, version: args.version + 1 } },
    );
    return null;
  },
});
export const setKey = action({
  args: { key: v.string(), version: v.number() },
  handler: async (ctx, args): Promise<null> => {
    await ctx.runQuery(internal.addressVerification.authorizeAdmin, {});
    const key = keySchema.parse(args.key);
    const sealed = await sealSecret(key, GEOAPIFY_SECRET);
    // Public sample address; never send contact details or persist keys in audit records.
    await fetchAddressSuggestions(
      {
        street: "1600 Pennsylvania Avenue NW",
        city: "Washington",
        region: "DC",
        postalCode: "20500",
        country: "United States",
      },
      key,
    );
    await ctx.runMutation(internal.addressVerification.commit, {
      key: sealed,
      version: args.version,
    });
    return null;
  },
});
