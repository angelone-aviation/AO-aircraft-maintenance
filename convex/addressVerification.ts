/**
 * Responsibility: Geoapify address lookups: who may run them, their daily
 *   allowances, the request itself, and the system administrator's saved API
 *   key.
 * Layer: Server. A public query and actions over internal steps; the key is
 *   stored sealed and never returned.
 * Dependencies: convex/access, convex/programContext, convex/secrets,
 *   convex/secretsMigration, convex/rateLimits, src/domain/model,
 *   src/domain/programs, src/domain/addressLookup, src/domain/rejection, zod.
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
import { STALE_RECORD_MESSAGE } from "../src/domain/rejection";
import { admin, audit } from "./access";
import { checkContext } from "./programContext";
import { SEALED_V2, sealSecret, type SecretContext } from "./secrets";
import { openStoredSecret } from "./secretsMigration";
import { consume, DAY, programShare } from "./rateLimits";
import { can, type Snapshot } from "../src/domain/model";
import { programPermission } from "../src/domain/programs";
import {
  ADDRESS_SUGGESTION_LIMIT,
  addressLookupSchema,
  parseAddressSuggestions,
  type AddressLookupInput,
  type AddressSuggestion,
} from "../src/domain/addressLookup";
import { z } from "zod";

const SECOND = 1000;
const GEOAPIFY_SEARCH_URL = "https://api.geoapify.com/v1/geocode/search";
const LOOKUP_TIMEOUT_MS = 15 * SECOND;

// Geoapify's free plan gives a key 3,000 credits a day; the rest is headroom
// for setKey's checks (docs/address-verification.md).
const GLOBAL_DAILY_LOOKUPS = 2900;

// Shares of the global allowance, so one user or Flight Program cannot spend
// it for everyone else. A program's share is an equal split between the
// programs (programShare), never below the floor.
const USER_DAILY_LOOKUPS = 200;
const PROGRAM_DAILY_LOOKUPS_FLOOR = 100;

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
 * user, 2,900 a UTC day in all, the user's 200, and the Flight Program's
 * equal share of the 2,900 (at least 100).
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
    await consumeAllowances(ctx, s, args.programUuid, used);
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
 * @returns Suggestions, as `parseAddressSuggestions` reads Geoapify's reply.
 * @throws {z.ZodError} For an invalid address.
 * @throws {ConvexError} As {@link reserve}; "Address lookup could not
 *   connect. …" on a network failure or after 15 seconds; "The Geoapify key
 *   was not accepted. …" on HTTP 401 or 403; "Address lookup quota reached.
 *   …" on 429; "The address service is unavailable. …" on any other HTTP
 *   error; "The address service returned an unexpected response. …". None
 *   quotes the key.
 * @throws As `openStoredSecret`.
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
    return fetchAddressSuggestions(input, key);
  },
});

/**
 * Saves a sealed key for {@link setKey}, which has already checked it, and
 * audits the change without the key.
 *
 * @param key - The key, sealed.
 * @param version - The settings version the administrator last read.
 * @throws {ConvexError} "Administrator permission required.";
 *   STALE_RECORD_MESSAGE when `version` is stale.
 * @throws {z.ZodError} After the version check, for a key that is not sealed
 *   (v2) or too long.
 */
export const commit = internalMutation({
  args: { key: v.string(), version: v.number() },
  handler: async (ctx, args) => {
    const user = await admin(ctx);
    const saved = await ctx.db.query("addressVerificationSettings").unique();
    if ((saved?.version ?? 0) !== args.version)
      throw new ConvexError(STALE_RECORD_MESSAGE);
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
 * @throws {ConvexError} The lookup failures of {@link lookup}.
 * @throws As `sealSecret` and {@link commit}.
 * @throws {z.ZodError} For a malformed key.
 */
export const setKey = action({
  args: { key: v.string(), version: v.number() },
  handler: async (ctx, args): Promise<null> => {
    await ctx.runQuery(internal.addressVerification.authorizeAdmin, {});
    const key = keySchema.parse(args.key);
    const sealed = await sealSecret(key, GEOAPIFY_SECRET);
    await fetchAddressSuggestions(KEY_CHECK_ADDRESS, key);
    await ctx.runMutation(internal.addressVerification.commit, {
      key: sealed,
      version: args.version,
    });
    return null;
  },
});

// The one request to Geoapify, made on the server so the browser never holds
// the key.
async function fetchAddressSuggestions(
  input: AddressLookupInput,
  key: string,
): Promise<AddressSuggestion[]> {
  const url = buildSearchUrl(addressLookupSchema.parse(input), key);
  const response = await requestSuggestions(url);
  if (!response.ok) throw new ConvexError(describeHttpFailure(response.status));
  try {
    return parseAddressSuggestions(await response.json());
  } catch {
    // A reply that is not JSON, or not shaped like Geoapify's, is the
    // service's failure, not the address's.
    throw new ConvexError(
      "The address service returned an unexpected response. Your address has not been changed.",
    );
  }
}

function buildSearchUrl(input: AddressLookupInput, key: string): URL {
  const url = new URL(GEOAPIFY_SEARCH_URL);
  url.search = new URLSearchParams({
    text: [
      input.street,
      input.city,
      input.region,
      input.postalCode,
      input.country,
    ]
      .filter(Boolean)
      .join(", "),
    format: "json",
    limit: String(ADDRESS_SUGGESTION_LIMIT),
    lang: "en",
    bias: "countrycode:none",
    apiKey: key,
  }).toString();
  return url;
}

async function requestSuggestions(url: URL): Promise<Response> {
  try {
    return await fetch(url, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    // The network error can quote the request URL, and with it the key.
    throw new ConvexError(
      "Address lookup could not connect. Your address has not been changed.",
    );
  }
}

function describeHttpFailure(status: number): string {
  if (status === 401 || status === 403)
    return "The Geoapify key was not accepted. Ask a system administrator to check Address verification in Settings → System.";
  if (status === 429) return "Address lookup quota reached. Try again later.";
  return "The address service is unavailable. Your address has not been changed.";
}

function assertMayLookUp(s: Snapshot): void {
  if (s.user.isAdmin || programPermission(s, "admin")) return;
  if (s.aircraft.some((a) => can(s, a.uuid, "maintenance"))) return;
  throw new ConvexError("Maintenance access required for address lookups.");
}

async function consumeAllowances(
  ctx: MutationCtx,
  s: Snapshot,
  programUuid: string | undefined,
  usedToday: number,
): Promise<void> {
  await consume(
    ctx,
    `address:user-second:${s.user.id}`,
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
    `address:user:${s.user.id}`,
    USER_DAILY_LOOKUPS,
    DAY,
    "Your address lookup allowance for today is used. Try again tomorrow.",
  );
  await consume(
    ctx,
    `address:program:${programUuid ?? ""}`,
    programShare(
      GLOBAL_DAILY_LOOKUPS,
      s.programs?.length ?? 0,
      PROGRAM_DAILY_LOOKUPS_FLOOR,
    ),
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
