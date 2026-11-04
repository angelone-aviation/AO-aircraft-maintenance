/**
 * Responsibility: Geoapify address lookups: who may run them, their daily
 *   allowances, and the system administrator's saved API key.
 * Layer: Server. A public query and actions over internal steps; the key is
 *   stored sealed and never returned.
 * Dependencies: convex/access, convex/programContext, convex/secrets,
 *   convex/secretsMigration, convex/rateLimits, convex/userErrors,
 *   src/domain/model, src/domain/programs, src/domain/addressLookup, zod.
 */
import {
  action,
  query,
  internalQuery,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { admin, audit } from "./access";
import { checkContext } from "./programContext";
import { SEALED_V2, sealSecret, type SecretContext } from "./secrets";
import { openStoredSecret } from "./secretsMigration";
import { consume, DAY } from "./rateLimits";
import { exposeRejections } from "./userErrors";
import { can, type Snapshot } from "../src/domain/model";
import { programPermission } from "../src/domain/programs";
import {
  addressLookupSchema,
  fetchAddressSuggestions,
  type AddressSuggestion,
} from "../src/domain/addressLookup";
import { z } from "zod";

const SECOND = 1000;

// Geoapify's free plan gives a key 3,000 credits a day; the rest is headroom
// for setKey's checks (docs/address-verification.md).
const GLOBAL_DAILY_LOOKUPS = 2900;

// Shares of the global allowance, so one user or Flight Program cannot spend
// it for everyone else.
const USER_DAILY_LOOKUPS = 200;
const PROGRAM_DAILY_LOOKUPS = 1000;

const keySchema = z
  .string()
  .trim()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

// keySchema caps the key at 256 ASCII characters, at most 405 sealed under the
// longest key id.
const MAX_SEALED_KEY_LENGTH = 405;
const sealedKey = z.string().max(MAX_SEALED_KEY_LENGTH).regex(SEALED_V2);

const GEOAPIFY_SECRET: SecretContext = {
  table: "addressVerificationSettings",
  programUuid: "",
  field: "key",
};

// A public landmark, so checking a key never sends anyone's own address.
const KEY_CHECK_ADDRESS = {
  street: "1600 Pennsylvania Avenue NW",
  city: "Washington",
  region: "DC",
  postalCode: "20500",
  country: "United States",
};

type Settings = Doc<"addressVerificationSettings">;

/**
 * Tells a system administrator whether lookups have a key, without the key.
 *
 * @returns `configured` when a key is saved or set on the deployment
 *   (GEOAPIFY_API_KEY), and the settings version {@link setKey} expects.
 * @throws {ConvexError} "Administrator permission required."
 */
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

/**
 * Refuses anyone but a system administrator, for actions to call first.
 *
 * @throws {ConvexError} "Administrator permission required."
 */
export const authorizeAdmin = internalQuery({
  args: {},
  handler: async (ctx) => {
    await admin(ctx);
    return null;
  },
});

/**
 * Admits one lookup and counts it against every allowance: one a second per
 * user, 2,900 a UTC day in all, and the user's and the Flight Program's daily
 * shares.
 *
 * @param programUuid - The caller's active Flight Program.
 * @returns The saved key, still sealed, or "" to use GEOAPIFY_API_KEY.
 * @throws {ConvexError} "Maintenance access required for address lookups."
 *   for a non-administrator who maintains none of the aircraft; "Address
 *   lookup is not enabled. …"; "Today's address lookup allowance …"; the
 *   per-second and daily shares' refusals from `consume`.
 * @throws As `checkContext`, first.
 */
export const reserve = internalMutation({
  args: { programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    assertMayLookUp(s);
    const saved = await ctx.db.query("addressVerificationSettings").unique();
    if (!saved?.key && !process.env.GEOAPIFY_API_KEY)
      throw new ConvexError(
        "Address lookup is not enabled. A system administrator must add a free Geoapify API key in Settings → System → Address verification.",
      );
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const used = saved?.day === day ? saved.used : 0;
    await consumeAllowances(ctx, s.user.id, args.programUuid, used);
    await countLookup(ctx, saved, { day, used: used + 1, lastLookupAt: now });
    return { stored: saved?.key || "" };
  },
});

/**
 * Suggests postal addresses matching the input, as Geoapify finds them. Only
 * the fields `addressLookupSchema` keeps are sent; contact details never are.
 *
 * @param payload - JSON of the address, as `addressLookupSchema`.
 * @param programUuid - The caller's active Flight Program.
 * @returns Suggestions, as `fetchAddressSuggestions`.
 * @throws {z.ZodError} For an invalid address.
 * @throws As {@link reserve}, `openStoredSecret` and
 *   `fetchAddressSuggestions` (its Rejections as ConvexError).
 */
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
    return exposeRejections(fetchAddressSuggestions(input, key));
  },
});

/**
 * Saves a sealed key for {@link setKey}, which has already checked it, and
 * audits the change without the key.
 *
 * @param key - The key, sealed.
 * @param version - The settings version the administrator last read.
 * @throws {ConvexError} "Administrator permission required."; "Address
 *   settings changed. Reload before saving." when `version` is stale.
 * @throws {z.ZodError} After the version check, for a key that is not sealed
 *   (v2) or too long.
 */
export const commit = internalMutation({
  args: { key: v.string(), version: v.number() },
  handler: async (ctx, args) => {
    const user = await admin(ctx);
    const saved = await ctx.db.query("addressVerificationSettings").unique();
    if ((saved?.version ?? 0) !== args.version)
      throw new ConvexError("Address settings changed. Reload before saving.");
    const key = sealedKey.parse(args.key);
    const version = args.version + 1;
    if (saved) await ctx.db.patch(saved._id, { key, version });
    else
      await ctx.db.insert("addressVerificationSettings", {
        key,
        version,
        day: "",
        used: 0,
        lastLookupAt: 0,
      });
    await audit(
      ctx,
      user._id,
      "addressVerification.key.updated",
      "address-verification",
      { after: { configured: true, version } },
    );
    return null;
  },
});

/**
 * Replaces the Geoapify key once a test lookup of a public address succeeds
 * with it, so a key Geoapify refuses is never saved.
 *
 * @param key - The new key, in plain text; it is saved sealed.
 * @param version - The settings version from {@link status}.
 * @throws {ConvexError} "Administrator permission required.", before the key
 *   is read.
 * @throws As `sealSecret`, `fetchAddressSuggestions` (its Rejections as
 *   ConvexError) and {@link commit}.
 * @throws {z.ZodError} For a malformed key.
 */
export const setKey = action({
  args: { key: v.string(), version: v.number() },
  handler: async (ctx, args): Promise<null> => {
    await ctx.runQuery(internal.addressVerification.authorizeAdmin, {});
    const key = keySchema.parse(args.key);
    const sealed = await sealSecret(key, GEOAPIFY_SECRET);
    await exposeRejections(fetchAddressSuggestions(KEY_CHECK_ADDRESS, key));
    await ctx.runMutation(internal.addressVerification.commit, {
      key: sealed,
      version: args.version,
    });
    return null;
  },
});

function assertMayLookUp(s: Snapshot): void {
  if (s.user.isAdmin || programPermission(s, "admin")) return;
  if (s.aircraft.some((a) => can(s, a.uuid, "maintenance"))) return;
  throw new ConvexError("Maintenance access required for address lookups.");
}

async function consumeAllowances(
  ctx: MutationCtx,
  userId: string,
  programUuid: string | undefined,
  usedToday: number,
): Promise<void> {
  await consume(
    ctx,
    `address:user-second:${userId}`,
    1,
    SECOND,
    "Please wait a second before another address lookup.",
  );
  if (usedToday >= GLOBAL_DAILY_LOOKUPS)
    throw new ConvexError(
      "Today's address lookup allowance is used. Try again tomorrow.",
    );
  await consume(
    ctx,
    `address:user:${userId}`,
    USER_DAILY_LOOKUPS,
    DAY,
    "Your address lookup allowance for today is used. Try again tomorrow.",
  );
  await consume(
    ctx,
    `address:program:${programUuid ?? ""}`,
    PROGRAM_DAILY_LOOKUPS,
    DAY,
    "This Flight Program's address lookup allowance for today is used. Try again tomorrow.",
  );
}

async function countLookup(
  ctx: MutationCtx,
  saved: Settings | null,
  usage: Pick<Settings, "day" | "used" | "lastLookupAt">,
): Promise<void> {
  if (saved) await ctx.db.patch(saved._id, usage);
  else
    await ctx.db.insert("addressVerificationSettings", {
      version: 0,
      ...usage,
    });
}
