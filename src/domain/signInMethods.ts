/**
 * Responsibility: Google and Microsoft sign-in: which providers exist, when
 *   their claims prove an email, and what a refused sign-in tells the user.
 * Layer: Domain. Pure constants and functions; no I/O, no React.
 * Dependencies: None.
 *
 * Every user keeps a password (ADR-0009). A Google or Microsoft account links,
 * on first use, to the one active user with its verified email; after that it
 * is matched by the provider's account id.
 */

/** Auth.js's provider id for Google. */
export const GOOGLE = "google";

/** Auth.js's id for Microsoft Entra ID, and the end of its redirect URI. */
export const MICROSOFT = "microsoft-entra-id";

/** Every provider the app can offer; each deployment enables its own. */
export const SSO_PROVIDERS = [GOOGLE, MICROSOFT] as const;

/** The id of a provider in {@link SSO_PROVIDERS}. */
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

/**
 * Tells whether a stored or untrusted provider id names a supported provider.
 *
 * @param id - Any value, such as an auth account's provider or a URL parameter.
 * @returns True only for an id in {@link SSO_PROVIDERS}.
 */
export const isSsoProvider = (id: unknown): id is SsoProvider =>
  (SSO_PROVIDERS as readonly unknown[]).includes(id);

/** The name shown for each sign-in method, by provider id and "password". */
export const signInMethodLabels: Record<string, string> = {
  password: "Password",
  [GOOGLE]: "Google",
  [MICROSOFT]: "Microsoft",
};

/** Refusal title: only an administrator creates accounts (ADR-0002). */
export const ACCOUNTS_MANAGED = "Accounts are managed by your administrator.";

/**
 * A linked identity as Settings and Administration list it. `email` is the one
 * the provider last verified.
 */
export type LinkedIdentity = {
  id: string;
  provider: string;
  email: string | null;
  linkedAt: number;
};

/**
 * The tenant personal Microsoft accounts (Outlook.com, Hotmail, Live) sign in
 * through; Microsoft verifies their email addresses itself.
 */
export const MICROSOFT_PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/**
 * What a provider's profile() hands to the sign-in callback: the provider's
 * account id, the email trimmed and lower-cased (undefined when blank), and
 * whether the provider vouches for it.
 */
export type SsoProfile = { id: string; email?: string; emailVerified: boolean };

/**
 * Reads Google's ID token: the email counts only when `email_verified` is true.
 *
 * @param claims - The ID token's claims.
 * @returns The {@link SsoProfile}.
 * @throws {Error} "The sign-in provider returned no account id." when `sub` is
 *   missing or empty.
 */
export function googleProfile(claims: Record<string, unknown>): SsoProfile {
  return {
    id: readAccountId(claims),
    email: readEmail(claims),
    emailVerified: claims.email_verified === true,
  };
}

/**
 * Reads Microsoft's ID token. Its `email` claim alone proves nothing (any
 * tenant administrator can set it), so it counts only for a personal account
 * or when the optional `xms_edov` claim says the email's domain is verified by
 * its tenant.
 *
 * @param claims - The ID token's claims.
 * @returns The {@link SsoProfile}.
 * @throws {Error} "The sign-in provider returned no account id." when `sub` is
 *   missing or empty.
 */
export function microsoftProfile(claims: Record<string, unknown>): SsoProfile {
  return {
    id: readAccountId(claims),
    email: readEmail(claims),
    emailVerified:
      claims.tid === MICROSOFT_PERSONAL_TENANT || claims.xms_edov === true,
  };
}

/** Why a Google or Microsoft sign-in was refused, for the change log. */
export type SsoRefusalReason =
  "no_account" | "disabled" | "ambiguous" | "email_not_verified";

/** The ConvexError code the sign-in callback throws for a refusal. */
export const SSO_REFUSED = "SSO_REFUSED";

/** Redirect query parameter for the {@link SignInErrorCode}. */
export const SIGN_IN_ERROR_PARAM = "signInError";

/** Redirect query parameter for the provider id. */
export const SIGN_IN_PROVIDER_PARAM = "signInProvider";

/** What the sign-in screen learns about a sign-in that signed nobody in. */
export type SignInErrorCode = "account" | "unverified" | "failed";

/**
 * Reduces a refusal to what the sign-in screen may learn, so it cannot tell a
 * missing account from a disabled or ambiguous one.
 *
 * @param reason - The refusal, or undefined when the sign-in failed otherwise.
 * @returns "unverified" for an unverified email, "account" for any other
 *   refusal, and "failed" without one.
 */
export function signInErrorCode(reason?: SsoRefusalReason): SignInErrorCode {
  if (reason === undefined) return "failed";
  return reason === "email_not_verified" ? "unverified" : "account";
}

/**
 * Explains, on the sign-in screen, the error code a sign-in redirect carried
 * back. Both values come from the address bar.
 *
 * @param code - The {@link SIGN_IN_ERROR_PARAM} value.
 * @param provider - The {@link SIGN_IN_PROVIDER_PARAM} value; one that is not
 *   a supported provider is named "Google or Microsoft".
 * @returns The title and detail to show, or undefined for an unknown code.
 */
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

function readAccountId(claims: Record<string, unknown>): string {
  if (typeof claims.sub !== "string" || !claims.sub)
    throw new Error("The sign-in provider returned no account id.");
  return claims.sub;
}

function readEmail(claims: Record<string, unknown>): string | undefined {
  return typeof claims.email === "string" && claims.email.trim()
    ? claims.email.trim().toLowerCase()
    : undefined;
}
