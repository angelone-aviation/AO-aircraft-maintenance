/**
 * Responsibility: Sign-in for every method: the Convex Auth configuration,
 *   the rules that keep account creation with administrators, and the
 *   change-log entry for each sign-in.
 * Layer: Server. The library's public sign-in functions and its internal
 *   store; accounts are made in admin.ts and programUsers.ts.
 * Dependencies: @convex-dev/auth, @oslojs (crypto, encoding), convex/access,
 *   convex/ssoProviders, convex/identities.
 *
 * Refusals stay plain Errors, as the library's own wrong-password refusal is,
 * so production shows each as "Server Error" and a disabled account cannot be
 * told from a wrong password.
 */
import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { sha256 } from "@oslojs/crypto/sha2";
import { encodeHexLowerCase } from "@oslojs/encoding";
import { v, type GenericId } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { audit } from "./access";
import { ssoProviders } from "./ssoProviders";
import { userForIdentity } from "./identities";

/**
 * Failed password sign-ins allowed per account per hour before it is locked
 * (one more attempt then every 6 minutes). Counted per account in
 * `authRateLimits`; an administrator password reset clears it. See
 * docs/runbooks/accounts.md.
 */
export const MAX_FAILED_SIGN_INS_PER_HOUR = 10;

// A session ends a week after sign-in, however active it is.
const SESSION_TOTAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// Provisioning is only available through the administrator action. Blocking
// the provider's signup and reset flows here also blocks direct
// unauthenticated API calls.
const library = convexAuth({
  providers: [
    Password({
      profile(params) {
        if (params.flow !== "signIn")
          throw new Error("Accounts are managed by your administrator.");
        if (typeof params.email !== "string")
          throw new Error("Email is required.");
        return { email: params.email.trim().toLowerCase() };
      },
    }),
    // Google and Microsoft, each only when its credentials are set (ADR-0009).
    ...ssoProviders(),
  ],
  // The option name is the library's spelling.
  signIn: { maxFailedAttempsPerHour: MAX_FAILED_SIGN_INS_PER_HOUR },
  session: { totalDurationMs: SESSION_TOTAL_DURATION_MS },
  callbacks: {
    // Replaces the library's user creation and linking for every method.
    // Administrators create accounts through createAccount (admin.ts,
    // programUsers.ts), which arrives here as "credentials" and makes the
    // user from the profile they gave, as the library would. A Google or
    // Microsoft sign-in never creates a user: see userForIdentity.
    async createOrUpdateUser(ctx, args) {
      if (args.type === "credentials") {
        if (args.existingUserId) return args.existingUserId;
        const {
          emailVerified: _e,
          phoneVerified: _p,
          ...profile
        } = args.profile;
        return await ctx.db.insert("users", profile);
      }
      if (args.type !== "oauth")
        throw new Error("This sign-in method is not available.");
      return await userForIdentity(
        ctx as unknown as MutationCtx,
        args.provider.id,
        args.existingUserId as Id<"users"> | null,
        args.profile,
      );
    },
    // A disabled account gets no session from any sign-in method. The
    // Password provider's profile() cannot do this: it is called
    // synchronously, without database access, before the password is checked.
    // This callback runs inside the sign-in transaction for every provider, so
    // throwing here creates nothing.
    async beforeSessionCreation(ctx, { userId }) {
      const user = await ctx.db.get(userId as GenericId<"users">);
      if (user?.active !== true) throw new Error("Invalid credentials");
    },
  },
});

/**
 * Convex Auth's public functions: the session check (`auth`), the sign-in
 * and sign-out actions, and whether the caller is signed in.
 *
 * @throws {Error} From `signIn`: "Accounts are managed by your
 *   administrator." for a sign-up or reset; "Invalid credentials" for a
 *   disabled account.
 */
export const { auth, signIn, signOut, isAuthenticated } = library;

/** The library's own store, which {@link store} runs as a nested transaction. */
export const libraryStore = library.store;

/**
 * The library's internal read and write function ("auth:store"), with a
 * `user.signed_in` change-log entry naming the method for every successful
 * sign-in (ADR-0009). Token refreshes are not logged.
 *
 * @param args - The library's request; libraryStore checks it.
 * @returns What libraryStore returns; null, as for a wrong code, for a code
 *   exchange that names an email or phone.
 */
export const store = internalMutation({
  args: { args: v.any() },
  handler: async (ctx, { args }): Promise<unknown> => {
    if (namesEmailOrPhone(args)) return null;
    const method = await signInMethod(ctx, args);
    const result = await ctx.runMutation(internal.auth.libraryStore, { args });
    const signedIn = result as { userId?: Id<"users">; sessionId?: string };
    if (method && signedIn?.userId && signedIn.sessionId)
      await audit(ctx, signedIn.userId, "user.signed_in", signedIn.userId, {
        after: { method },
      });
    return result;
  },
});

type StoreRequest = {
  type?: unknown;
  params?: { code?: unknown; email?: unknown; phone?: unknown };
};

// The library counts a failed code exchange under the email or phone it
// names, storing a new authRateLimits row for each value, before any sign-in.
// No method here sends either (a Google or Microsoft code carries a
// verifier), so such a request would only let anyone fill the database.
function namesEmailOrPhone(args: StoreRequest): boolean {
  return (
    args?.type === "verifyCodeAndSignIn" &&
    (args.params?.email !== undefined || args.params?.phone !== undefined)
  );
}

// "signIn" creates the session after a password check (Password is the only
// credentials provider); "verifyCodeAndSignIn" redeems the one-time code a
// Google or Microsoft sign-in issued, whose row names the provider. Token
// refreshes are neither.
async function signInMethod(
  ctx: MutationCtx,
  args: StoreRequest,
): Promise<string | undefined> {
  if (args?.type === "signIn") return "password";
  if (
    args?.type !== "verifyCodeAndSignIn" ||
    typeof args.params?.code !== "string"
  )
    return undefined;
  // The library stores one-time codes as their SHA-256, hashed this way.
  const hash = encodeHexLowerCase(
    sha256(new TextEncoder().encode(args.params.code)),
  );
  const code = await ctx.db
    .query("authVerificationCodes")
    .withIndex("code", (q) => q.eq("code", hash))
    .unique();
  return code?.provider;
}
