/**
 * Responsibility: Google and Microsoft identities linked to users (ADR-0009):
 *   who a sign-in belongs to, listing and removing links, logging refusals.
 * Layer: Server. Public queries and a mutation, plus helpers for the sign-in
 *   library (auth.ts) and route (http.ts).
 * Dependencies: convex/access, convex/accountGuards, convex/rateLimits,
 *   convex/ssoProviders, src/domain/signInMethods, convex/values.
 *
 * Sign-in never creates a user: it links an identity only to the one active
 * user with its verified email, then matches it by the provider's account id.
 * Setup and operation: docs/runbooks/accounts.md.
 */
import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { admin, audit, currentUser } from "./access";
import { normalizeEmail } from "./accountGuards";
import { consume, HOUR } from "./rateLimits";
import { enabledSsoProviders } from "./ssoProviders";
import {
  isSsoProvider,
  SSO_REFUSED,
  type LinkedIdentity,
  type SsoRefusalReason,
} from "../src/domain/signInMethods";

// Refused attempts come from people who are not signed in, so their change-log
// entries are capped: per identity, and for the whole deployment.
const REFUSALS_PER_IDENTITY_PER_HOUR = 10;
const REFUSALS_PER_HOUR = 300;

type Refusal = { reason: SsoRefusalReason; userId?: Id<"users"> };

/**
 * Lists the Google and Microsoft sign-in buttons the sign-in screen shows. The
 * one public function that checks no access: it reveals only configuration.
 *
 * @returns The enabled providers, Google first.
 */
export const providers = query({
  args: {},
  handler: async () => enabledSsoProviders(),
});

/**
 * Lists the signed-in user's own linked identities (Settings, My account).
 *
 * @returns Each Google or Microsoft link with its id, the email the provider
 *   last verified (or null) and when it was linked.
 * @throws {Error} "An active account and session are required."
 */
export const mine = query({
  args: {},
  handler: async (ctx) =>
    listLinkedIdentities(ctx, (await currentUser(ctx))._id),
});

/**
 * Lists a user's linked identities, for system administrators.
 *
 * @param userId - The user.
 * @returns As {@link mine}.
 * @throws {Error} "Administrator permission required."
 */
export const forUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await admin(ctx);
    return listLinkedIdentities(ctx, userId);
  },
});

/**
 * Detaches a Google or Microsoft account from a user, and audits
 * `user.identity_removed` with its provider, email and link time. The person
 * can link it again by signing in while its verified email still matches; to
 * stop every sign-in, disable the user.
 *
 * @param userId - The user the identity belongs to.
 * @param id - The identity, from {@link forUser}.
 * @throws {Error} "Administrator permission required."; "Linked identity not
 *   found." for another user's identity or a password login.
 */
export const remove = mutation({
  args: { userId: v.id("users"), id: v.id("authAccounts") },
  handler: async (ctx, { userId, id }) => {
    const actor = await admin(ctx);
    const account = await ctx.db.get(id);
    if (
      !account ||
      account.userId !== userId ||
      !isSsoProvider(account.provider)
    )
      throw new Error("Linked identity not found.");
    // A one-time code from a sign-in still in progress dies with it.
    const codes = await ctx.db
      .query("authVerificationCodes")
      .withIndex("accountId", (q) => q.eq("accountId", id))
      .collect();
    for (const code of codes) await ctx.db.delete(code._id);
    await ctx.db.delete(id);
    await audit(ctx, actor._id, "user.identity_removed", userId, {
      before: {
        provider: account.provider,
        email: account.emailVerified ?? null,
        linkedAt: account._creationTime,
      },
    });
  },
});

/**
 * Reads the refusal out of an error {@link userForIdentity} threw.
 *
 * @param error - Anything the sign-in mutation threw.
 * @returns The reason and the refused user, if known; undefined for any other
 *   error.
 */
export function refusalOf(error: unknown): Refusal | undefined {
  if (!(error instanceof ConvexError)) return undefined;
  const data = error.data as Record<string, unknown> | null;
  return data?.code === SSO_REFUSED
    ? {
        reason: data.reason as SsoRefusalReason,
        userId: (data.userId ?? undefined) as Id<"users"> | undefined,
      }
    : undefined;
}

/**
 * Finds the user a Google or Microsoft sign-in belongs to. The sign-in library
 * calls it inside its transaction, before anything is written.
 *
 * @param ctx - Mutation context; audits `user.identity_linked` on a new link.
 * @param provider - The sign-in provider's id.
 * @param existingUserId - The user already linked to this provider account.
 * @param profile - The provider's profile; read only for a new link.
 * @returns The linked user, or the one active user with the verified email.
 * @throws {ConvexError} An `SSO_REFUSED` refusal ({@link refusalOf}):
 *   "disabled", "email_not_verified", "ambiguous" or "no_account".
 */
export async function userForIdentity(
  ctx: MutationCtx,
  provider: string,
  existingUserId: Id<"users"> | null,
  profile: { email?: unknown; emailVerified?: unknown },
): Promise<Id<"users">> {
  // Matched by the provider's account id; the email sent now is not consulted.
  if (existingUserId) {
    const user = await ctx.db.get(existingUserId);
    if (user?.active !== true) refuse("disabled", existingUserId);
    return existingUserId;
  }
  const email =
    typeof profile.email === "string" ? normalizeEmail(profile.email) : "";
  if (profile.emailVerified !== true || !email) refuse("email_not_verified");
  const users = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .take(10);
  const active = users.filter((u) => u.active === true);
  if (active.length > 1) refuse("ambiguous");
  if (!active.length)
    refuse(users.length ? "disabled" : "no_account", users[0]?._id);
  const user: Doc<"users"> = active[0];
  await audit(ctx, user._id, "user.identity_linked", user._id, {
    after: { provider, email },
  });
  return user._id;
}

/**
 * Logs a sign-in the route caught {@link userForIdentity} refusing: audits
 * `user.sign_in_refused` as "system", under the refused user or else
 * `<provider>:<providerAccountId>`. Past 10 an hour for one identity, or 300
 * for the deployment, it only warns on the console.
 *
 * @param provider - The sign-in provider's id.
 * @param providerAccountId - The provider's account id for the person.
 * @param email - The email the provider sent, if any.
 * @param reason - The refusal reason.
 * @param userId - The refused user, when one matched.
 */
export const recordRefusal = internalMutation({
  args: {
    provider: v.string(),
    providerAccountId: v.string(),
    email: v.optional(v.string()),
    reason: v.string(),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    try {
      await consume(
        ctx,
        `sso-refused:${args.provider}:${args.providerAccountId}`,
        REFUSALS_PER_IDENTITY_PER_HOUR,
        HOUR,
        "",
      );
      await consume(ctx, "sso-refused", REFUSALS_PER_HOUR, HOUR, "");
    } catch {
      // Over a cap: the sign-in is refused either way; only the entry is lost.
      console.warn(
        `Refused ${args.provider} sign-in not logged: over the cap.`,
      );
      return;
    }
    await audit(
      ctx,
      "system",
      "user.sign_in_refused",
      args.userId ?? `${args.provider}:${args.providerAccountId}`,
      {
        after: {
          method: args.provider,
          reason: args.reason,
          email: args.email ?? null,
        },
      },
    );
  },
});

async function listLinkedIdentities(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<(LinkedIdentity & { id: Id<"authAccounts"> })[]> {
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .collect();
  return accounts
    .filter((a) => isSsoProvider(a.provider))
    .map((a) => ({
      id: a._id,
      provider: a.provider,
      // The library records the email the provider last verified.
      email: a.emailVerified ?? null,
      linkedAt: a._creationTime,
    }));
}

// The sign-in route catches this and logs it in its own transaction
// (recordRefusal), because this one is rolled back.
function refuse(reason: SsoRefusalReason, userId?: Id<"users">): never {
  throw new ConvexError({
    code: SSO_REFUSED,
    reason,
    ...(userId && { userId }),
  });
}
