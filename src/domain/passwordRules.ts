/**
 * Responsibility: Decides whether a password an administrator sets on create
 *   or reset is acceptable, and says why not.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/accountRules.ts, src/domain/commonPasswords.ts,
 *   src/domain/rejection.ts.
 *
 * ADR-0009, following NIST SP 800-63B for a single-factor password: a length
 * rule, no composition rules, and nothing easily guessed. Sign-in never applies
 * these rules, so a shorter existing password works until its next reset. The
 * list is large, so screens import the lengths from accountRules.ts instead.
 */
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./accountRules";
import { COMMON_PASSWORDS } from "./commonPasswords";
import { Rejection } from "./rejection";

// One shorter phrase repeated, such as "aaaaaaaaaaaaaaa" or a 9-character
// password typed twice to reach the length.
const REPEATED_PHRASE = /^(.+?)\1+$/su;

let commonPasswordSet: Set<string> | undefined;

/** The refusal for a password outside the length limits, naming them. */
export const PASSWORD_LENGTH_MESSAGE = `Use a password of ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`;

/** The refusal for a common, repetitive or email-based password. */
export const PASSWORD_COMMON_MESSAGE =
  "This password is too common or easy to guess. Choose a longer, less predictable phrase.";

/**
 * Says why a password cannot be set: it must be 15 to 128 characters (code
 * points), and must not be on the common list, be one phrase repeated, or
 * contain the account's email, ignoring case and Unicode compatibility forms.
 *
 * @param password - The new password, as typed.
 * @param email - The account's email, if known; trimmed before comparing.
 * @returns {@link PASSWORD_LENGTH_MESSAGE}, checked first, or
 *   {@link PASSWORD_COMMON_MESSAGE}; undefined when the password can be set.
 */
export function passwordProblem(
  password: string,
  email?: string,
): string | undefined {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH)
    return PASSWORD_LENGTH_MESSAGE;
  return isGuessable(password, email) ? PASSWORD_COMMON_MESSAGE : undefined;
}

/**
 * Refuses a password that {@link passwordProblem} rejects.
 *
 * @param password - The new password, as typed.
 * @param email - The account's email, if known.
 * @throws {Rejection} With the {@link passwordProblem} message.
 */
export function assertPassword(password: string, email?: string): void {
  const problem = passwordProblem(password, email);
  if (problem) throw new Rejection(problem);
}

function isGuessable(password: string, email?: string): boolean {
  const folded = password.normalize("NFKC").toLowerCase();
  const account = email?.trim().toLowerCase();
  return (
    loadCommonPasswords().has(folded) ||
    REPEATED_PHRASE.test(folded) ||
    Boolean(account && folded.includes(account))
  );
}

function loadCommonPasswords(): Set<string> {
  commonPasswordSet ??= new Set(COMMON_PASSWORDS.split("\n").filter(Boolean));
  return commonPasswordSet;
}
