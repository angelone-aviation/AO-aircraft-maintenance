/**
 * Responsibility: The limits and fixed answers of account administration.
 * Layer: Domain. Constants only; no I/O, no React.
 * Dependencies: None.
 *
 * Shared by the Convex functions and the offline demo adapter so both refuse
 * and answer account-administration requests the same way (issue #29).
 */

/**
 * The one message for every refused account creation, so the response does
 * not depend on whether a guessed password matched the existing account.
 */
export const EMAIL_UNAVAILABLE =
  "This email cannot be used for a new account. If the person already has an account, use Add existing user.";

/**
 * The answer to adding an existing user, the same whether or not an active
 * account uses the email.
 */
export const ADD_EXISTING_RESULT =
  "If an active account uses this email, it now has access to this Flight Program.";

/**
 * Requests one user may make per hour, counted separately for account
 * creation and for adding an existing user.
 */
export const ACCOUNT_REQUESTS_PER_HOUR = 20;

/** The refusal once a user has spent {@link ACCOUNT_REQUESTS_PER_HOUR}. */
export const ACCOUNT_REQUESTS_LIMITED =
  "Too many account requests. Try again within the hour.";

/**
 * Shortest password an administrator may set (ADR-0009, NIST SP 800-63B): a
 * length rule and no composition rules; passwordRules.ts also refuses common
 * passwords. Sign-in does not check the limits, so a shorter existing password
 * keeps working until the user's next reset.
 */
export const PASSWORD_MIN_LENGTH = 15;

/** Longest password an administrator may set. */
export const PASSWORD_MAX_LENGTH = 128;
