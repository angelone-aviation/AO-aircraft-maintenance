// Sign-in methods (ADR-0009, GLOSSARY): every user signs in with a password;
// a Google or Microsoft account becomes a linked identity the first time it is
// used with a verified email that matches exactly one active user, and is
// matched by the provider's account id from then on. Shared by convex/ and
// the screens.

export const GOOGLE = "google";
// Auth.js's id for Microsoft Entra ID; also the last part of its redirect URI.
export const MICROSOFT = "microsoft-entra-id";
export const SSO_PROVIDERS = [GOOGLE, MICROSOFT] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];
export const isSsoProvider = (id: unknown): id is SsoProvider =>
  (SSO_PROVIDERS as readonly unknown[]).includes(id);

export const signInMethodLabels: Record<string, string> = {
  password: "Password",
  [GOOGLE]: "Google",
  [MICROSOFT]: "Microsoft",
};

export const ACCOUNTS_MANAGED = "Accounts are managed by your administrator.";

/** A linked identity as Settings and Administration list it. `email` is the
 * one the provider last verified. */
export type LinkedIdentity = {
  id: string;
  provider: string;
  email: string | null;
  linkedAt: number;
};

// Personal Microsoft accounts (Outlook.com, Hotmail, Live) sign in through
// this tenant; Microsoft verifies their email addresses itself.
export const MICROSOFT_PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** What a provider's profile() hands to the sign-in callback: the provider's
 * account id, the lower-cased email and whether the provider vouches for it. */
export type SsoProfile = { id: string; email?: string; emailVerified: boolean };

function subject(claims: Record<string, unknown>) {
  if (typeof claims.sub !== "string" || !claims.sub)
    throw new Error("The sign-in provider returned no account id.");
  return claims.sub;
}
function email(claims: Record<string, unknown>) {
  return typeof claims.email === "string" && claims.email.trim()
    ? claims.email.trim().toLowerCase()
    : undefined;
}

/** Google's ID token: the email counts only when `email_verified` is true. */
export function googleProfile(claims: Record<string, unknown>): SsoProfile {
  return {
    id: subject(claims),
    email: email(claims),
    emailVerified: claims.email_verified === true,
  };
}

/** Microsoft's `email` claim alone proves nothing (any tenant administrator can
 * set it), so it counts only for a personal account or when the optional
 * `xms_edov` claim says the email's domain is verified by its tenant. */
export function microsoftProfile(claims: Record<string, unknown>): SsoProfile {
  return {
    id: subject(claims),
    email: email(claims),
    emailVerified:
      claims.tid === MICROSOFT_PERSONAL_TENANT || claims.xms_edov === true,
  };
}

/** Why a Google or Microsoft sign-in was refused, as the change log records
 * it. The sign-in screen is told less (signInErrorCode). */
export type SsoRefusalReason =
  "no_account" | "disabled" | "ambiguous" | "email_not_verified";
// ConvexError code thrown by the sign-in callback for a refusal.
export const SSO_REFUSED = "SSO_REFUSED";

// Query parameters the sign-in redirect carries back when nobody was signed in.
export const SIGN_IN_ERROR_PARAM = "signInError";
export const SIGN_IN_PROVIDER_PARAM = "signInProvider";
export type SignInErrorCode = "account" | "unverified" | "failed";
export const signInErrorCode = (reason?: SsoRefusalReason): SignInErrorCode =>
  reason === undefined
    ? "failed"
    : reason === "email_not_verified"
      ? "unverified"
      : "account";

export function signInErrorMessage(
  code: string | null,
  provider: string | null,
): { title: string; detail: string } | undefined {
  const label = isSsoProvider(provider)
    ? signInMethodLabels[provider]
    : "Google or Microsoft";
  switch (code) {
    case "account":
      return {
        title: ACCOUNTS_MANAGED,
        detail: `No active Angel One account uses the email of that ${label} account. Sign in with your password, or ask your administrator.`,
      };
    case "unverified":
      return {
        title: `${label} did not confirm that email address.`,
        detail: `A ${label} account is linked only by an email address ${label} has verified. Sign in with your password.`,
      };
    case "failed":
      return {
        title: `Sign-in with ${label} did not finish.`,
        detail: "Try again, or sign in with your password.",
      };
    default:
      return undefined;
  }
}
