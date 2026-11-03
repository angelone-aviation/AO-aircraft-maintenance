// Shared by the Convex functions and the offline demo adapter so both refuse
// and answer account-administration requests the same way (issue #29).

// One message for every refused account creation, so the response does not
// depend on whether a guessed password matched the existing account.
export const EMAIL_UNAVAILABLE =
  "This email cannot be used for a new account. If the person already has an account, use Add existing user.";

// addExisting returns this whether or not an active account uses the email.
export const ADD_EXISTING_RESULT =
  "If an active account uses this email, it now has access to this Flight Program.";

// Per-actor budget for account creation and for addExisting lookups.
export const ACCOUNT_REQUESTS_PER_HOUR = 20;
export const ACCOUNT_REQUESTS_LIMITED =
  "Too many account requests. Try again within the hour.";

// Passwords an administrator sets (ADR-0009, NIST SP 800-63B): a length rule
// and no composition rules; passwordRules.ts also refuses common passwords.
// Sign-in does not check these, so a shorter existing password keeps working
// until the user's next reset.
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;
