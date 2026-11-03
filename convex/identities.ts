// Linked identities: Google and Microsoft accounts attached to users
// (ADR-0009). Sign-in never creates a user; it links an identity only to the
// one active user with its verified email, and afterwards matches it by the
// provider's account id. Every link, sign-in, refusal and removal is in the
// change log. Setup and operation: docs/runbooks/accounts.md.
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

/** The Google and Microsoft sign-in buttons the sign-in screen shows. */
export const providers = query({
  args: {},
  handler: async () => enabledSsoProviders(),
});

async function linked(
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

/** The signed-in user's own linked identities (Settings → My account). */
export const mine = query({
  args: {},
  handler: async (ctx) => linked(ctx, (await currentUser(ctx))._id),
});

/** A user's linked identities, for system administrators. */
export const forUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await admin(ctx);
    return linked(ctx, userId);
  },
});

/** Detach a Google or Microsoft account from a user. The person can link it
 * again by signing in with it while its verified email still matches; to stop
 * every sign-in, disable the user. The password login cannot be removed. */
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
    for (const code of await ctx.db
      .query("authVerificationCodes")
      .withIndex("accountId", (q) => q.eq("accountId", id))
      .collect())
      await ctx.db.delete(code._id);
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

/** Refuse a Google or Microsoft sign-in. The sign-in route catches this and
 * records the refusal in its own transaction (recordRefusal), because this
 * one is rolled back. */
function refuse(reason: SsoRefusalReason, userId?: Id<"users">): never {
  throw new ConvexError({
    code: SSO_REFUSED,
    reason,
    ...(userId && { userId }),
  });
}
export function refusalOf(
  error: unknown,
): { reason: SsoRefusalReason; userId?: Id<"users"> } | undefined {
  if (!(error instanceof ConvexError)) return undefined;
  const data = error.data as Record<string, unknown> | null;
  return data?.code === SSO_REFUSED
    ? {
        reason: data.reason as SsoRefusalReason,
        userId: (data.userId ?? undefined) as Id<"users"> | undefined,
      }
    : undefined;
}

/** The user a Google or Microsoft sign-in belongs to; called by the sign-in
 * library inside its transaction before anything is written. */
export async function userForIdentity(
  ctx: MutationCtx,
  provider: string,
  existingUserId: Id<"users"> | null,
  profile: { email?: unknown; emailVerified?: unknown },
): Promise<Id<"users">> {
  // Already linked: matched by the provider's account id; the email the
  // provider sends now is not consulted.
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

// Refused attempts come from people who are not signed in, so their change-log
// entries are capped: per identity, and for the whole deployment.
const REFUSALS_PER_IDENTITY_PER_HOUR = 10;
const REFUSALS_PER_HOUR = 300;
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
