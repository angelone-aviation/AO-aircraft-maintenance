import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import type { GenericId } from "convex/values";

// Failed password sign-ins allowed per account per hour before it is locked
// (one more attempt then every 6 minutes). Counted per account in
// `authRateLimits`; an administrator password reset clears it. See
// docs/runbooks/accounts.md.
export const MAX_FAILED_SIGN_INS_PER_HOUR = 10;

// Provisioning is only available through the administrator action. Blocking the
// provider's signup/reset flows here also blocks direct unauthenticated API calls.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
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
  ],
  // The option name is the library's spelling.
  signIn: { maxFailedAttempsPerHour: MAX_FAILED_SIGN_INS_PER_HOUR },
  session: { totalDurationMs: 7 * 24 * 60 * 60 * 1000 },
  callbacks: {
    // A disabled account gets no session from any sign-in method. The
    // Password provider's profile() cannot do this: it is called synchronously,
    // without database access, before the password is checked. This callback
    // runs inside the sign-in transaction for every provider, so throwing
    // here creates nothing.
    async beforeSessionCreation(ctx, { userId }) {
      const user = await ctx.db.get(userId as GenericId<"users">);
      if (user?.active !== true) throw new Error("Invalid credentials");
    },
  },
});
