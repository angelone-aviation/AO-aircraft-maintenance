// Rules for a password an administrator sets on create or reset (ADR-0009,
// following NIST SP 800-63B for a password used as a single factor): 15 to
// 128 characters, no composition rules, and not a common or easily guessed
// one. Shared by the Convex functions and the offline demo. Sign-in never
// applies them, so a shorter existing password works until its next reset.
// The bundled list is large; the screens import the lengths from
// accountRules.ts instead of this module.
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./accountRules";
import { COMMON_PASSWORDS } from "./commonPasswords";

export const PASSWORD_LENGTH_MESSAGE = `Use a password of ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`;
export const PASSWORD_COMMON_MESSAGE =
  "This password is too common or easy to guess. Choose a longer, less predictable phrase.";

let common: Set<string> | undefined;

/** Why the password cannot be set, or undefined when it can. `email` is the
 * account's, so the password cannot simply contain it. */
export function passwordProblem(
  password: string,
  email?: string,
): string | undefined {
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH)
    return PASSWORD_LENGTH_MESSAGE;
  const folded = password.normalize("NFKC").toLowerCase();
  common ??= new Set(COMMON_PASSWORDS.split("\n").filter(Boolean));
  const account = email?.trim().toLowerCase();
  if (
    common.has(folded) ||
    // One shorter phrase repeated, such as "aaaaaaaaaaaaaaa" or a 9-character
    // password typed twice to reach the length.
    /^(.+?)\1+$/su.test(folded) ||
    (account && folded.includes(account))
  )
    return PASSWORD_COMMON_MESSAGE;
  return undefined;
}

export function assertPassword(password: string, email?: string) {
  const problem = passwordProblem(password, email);
  if (problem) throw new Error(problem);
}
