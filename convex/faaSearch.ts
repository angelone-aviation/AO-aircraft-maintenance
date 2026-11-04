/**
 * Responsibility: Searching FAA DRS for a Flight Program's ADs: who may search
 *   and the daily allowances shared by every program on the one FAA key.
 * Layer: Server. A public action over internal steps; maintenance permission
 *   on the aircraft searches.
 * Dependencies: convex/rateLimits, convex/faaCredentials, convex/faaDrs,
 *   convex/programContext, convex/userErrors, src/domain (model, management,
 *   faaSearch).
 */
import {
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { consume, DAY, MINUTE } from "./rateLimits";
import { faaSecret } from "./faaCredentials";
import { searchFAA } from "./faaDrs";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { checkContext, managementDocs } from "./programContext";
import { exposeRejections } from "./userErrors";
import { can } from "../src/domain/model";
import { recordSchema } from "../src/domain/management";
import {
  faaSearchSchema,
  searchAssets,
  type FaaSearchResult,
} from "../src/domain/faaSearch";

/** FAA requests one Flight Program may make per UTC day. */
export const FAA_PROGRAM_DAILY = 500;

/** FAA requests all Flight Programs together may make per UTC day. */
export const FAA_GLOBAL_DAILY = 5000;

const USER_SEARCHES_PER_MINUTE = 10;

/**
 * Checks a search before the FAA is asked: maintenance permission on the
 * aircraft, and every selected component still installed on it.
 *
 * @param payload - JSON, as `faaSearchSchema`.
 * @param programUuid - The caller's active Flight Program.
 * @returns The parsed search.
 * @throws {ConvexError} "Aircraft maintenance permission required."; "A
 *   selected component is no longer installed on this aircraft. Refresh the
 *   search form."
 * @throws As `checkContext`, first; a ZodError for an invalid payload.
 */
export const authorize = internalQuery({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    const input = faaSearchSchema.parse(JSON.parse(args.payload));
    if (!can(s, input.aircraftUuid, "maintenance"))
      throw new ConvexError("Aircraft maintenance permission required.");
    const management = (await managementDocs(ctx, args.programUuid)).map((d) =>
      recordSchema.parse(JSON.parse(d.payload)),
    );
    const assets = searchAssets({ ...s, management }, input.aircraftUuid);
    for (const a of input.assets)
      if (!assets.some((x) => x.id === a.id))
        throw new ConvexError(
          "A selected component is no longer installed on this aircraft. Refresh the search form.",
        );
    return input;
  },
});

/**
 * Spends `requests` of the program's daily FAA allowance, then of the global
 * one; searches and monitoring runs share both.
 *
 * @param programUuid - The program charged.
 * @param requests - How many FAA requests to count.
 * @throws {ConvexError} "This Flight Program's FAA search allowance for today
 *   is used. Try again tomorrow."; "Today's FAA search allowance is used. Try
 *   again tomorrow."
 */
export async function chargeFaaAllowance(
  ctx: MutationCtx,
  programUuid: string,
  requests = 1,
) {
  await consume(
    ctx,
    `faa:program:${programUuid}`,
    FAA_PROGRAM_DAILY,
    DAY,
    "This Flight Program's FAA search allowance for today is used. Try again tomorrow.",
    requests,
  );
  await consume(
    ctx,
    "faa:global",
    FAA_GLOBAL_DAILY,
    DAY,
    "Today's FAA search allowance is used. Try again tomorrow.",
    requests,
  );
}

/**
 * Admits one search: at most 10 a minute per user, then one request of the
 * daily allowances. Every program shares the one FAA key, so each user and
 * program is kept to a fair slice.
 *
 * @param programUuid - The caller's active Flight Program.
 * @returns null.
 * @throws {ConvexError} "Too many FAA searches. Wait a minute and try
 *   again."; the {@link chargeFaaAllowance} refusals.
 * @throws As `checkContext`, first.
 */
export const reserve = internalMutation({
  args: { programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    await consume(
      ctx,
      `faa:user:${s.user.id}`,
      USER_SEARCHES_PER_MINUTE,
      MINUTE,
      "Too many FAA searches. Wait a minute and try again.",
    );
    await chargeFaaAllowance(ctx, args.programUuid ?? "");
    return null;
  },
});

/**
 * Searches FAA DRS for ADs matching the aircraft and its selected components.
 *
 * @param payload - JSON, as `faaSearchSchema`.
 * @param programUuid - The caller's active Flight Program.
 * @returns The matching ADs, as `searchFAA` merges them.
 * @throws {ConvexError} In order: {@link authorize}'s refusals; "Configure the
 *   FAA API key …"; "Renew the FAA API key before searching." from its expiry
 *   date on; {@link reserve}'s; `searchFAA`'s; {@link authorize}'s again.
 * @throws As `searchFAA`, for an FAA failure.
 */
export const search = action({
  args: { payload: v.string(), programUuid: v.optional(v.string()) },
  handler: async (ctx, args): Promise<FaaSearchResult[]> => {
    const input = await ctx.runQuery(internal.faaSearch.authorize, args);
    const credential = await faaSecret(ctx);
    if (!credential.key)
      throw new ConvexError(
        "Configure the FAA API key in FAA connection and renewal settings before searching.",
      );
    if (
      credential.expiresOn &&
      credential.expiresOn <= new Date().toISOString().slice(0, 10)
    )
      throw new ConvexError("Renew the FAA API key before searching.");
    await ctx.runMutation(internal.faaSearch.reserve, {
      programUuid: args.programUuid,
    });
    const result = await exposeRejections(searchFAA(credential.key, input));
    // The search can take many FAA requests; access or the installed
    // components may have changed meanwhile.
    await ctx.runQuery(internal.faaSearch.authorize, args);
    return result;
  },
});
