/**
 * Responsibility: Searching FAA DRS for a Flight Program's ADs: who may search
 *   and the daily allowances shared by every program on the one FAA key.
 * Layer: Server. A public action over internal steps; maintenance permission
 *   on the aircraft searches.
 * Dependencies: convex/rateLimits, convex/faaCredentials,
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
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { checkContext, managementDocs } from "./programContext";
import { exposeRejections } from "./userErrors";
import { can } from "../src/domain/model";
import { recordSchema } from "../src/domain/management";
import {
  faaSearchSchema,
  searchAssets,
  searchFAA,
  type FaaSearchResult,
} from "../src/domain/faaSearch";
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
export const FAA_PROGRAM_DAILY = 500;
export const FAA_GLOBAL_DAILY = 5000;
// FAA requests per UTC day, shared by searches and monitoring runs.
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
// Shares one FAA key across tenants; keep each user and program to a fair slice.
export const reserve = internalMutation({
  args: { programUuid: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const s = await checkContext(ctx, args.programUuid);
    await consume(
      ctx,
      `faa:user:${s.user.id}`,
      10,
      MINUTE,
      "Too many FAA searches. Wait a minute and try again.",
    );
    await chargeFaaAllowance(ctx, args.programUuid ?? "");
    return null;
  },
});
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
    await ctx.runQuery(internal.faaSearch.authorize, args);
    return result;
  },
});
